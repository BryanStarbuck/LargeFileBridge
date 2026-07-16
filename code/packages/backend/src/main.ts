// LargeFileBridge backend — lean Express + TypeScript (code_plan.mdx §3). Run via tsx.
import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import crypto from "node:crypto";
import v8 from "node:v8";
import { getAppConfig, updateAppConfig } from "./modules/store-model/config.service.js";
import { buildAuthFrontend, allowedRedirectOrigins } from "./modules/auth/auth-frontend.js";
import { identify } from "./modules/auth/identify.js";
import { authRouter } from "./modules/auth/auth.router.js";
import { reposRouter } from "./modules/repos/repos.router.js";
import { companyRouter } from "./modules/repos/company.router.js";
import { fsRouter } from "./modules/fs/fs.router.js";
import { entityRouter } from "./modules/entity/entity.router.js";
import { mediaRouter } from "./modules/media/media.router.js";
import { settingsRouter } from "./modules/settings/settings.router.js";
import { jobsRouter } from "./modules/pin/jobs.router.js";
import { sessionsRouter } from "./modules/sessions/sessions.router.js";
import { peersRouter } from "./modules/peers/peers.router.js";
import { devicesRouter } from "./modules/peers/devices.router.js";
import { ipfsRouter } from "./modules/ipfs/ipfs.router.js";
import { storagesRouter } from "./modules/storage/storage.router.js";
import { communitiesRouter } from "./modules/communities/communities.router.js";
import { compressRouter } from "./modules/compress/compression.router.js";
import { transcribeRouter } from "./modules/transcribe/transcribe.router.js";
import { describeRouter } from "./modules/describe/describe.router.js";
import { gitRouter } from "./modules/git/gitignore.router.js";
import { todoRouter } from "./modules/todo/todo.router.js";
import { healthRouter } from "./modules/health/health.router.js";
import { progressRouter } from "./modules/progress/progress.router.js";
import { securityRouter } from "./modules/security/security.router.js";
import { internalRouter } from "./modules/internal/internal.router.js";
import { clientLogRouter } from "./modules/clientlog/clientlog.router.js";
import * as ipfs from "./modules/ipfs/ipfs.service.js";
import { reconcileWorkerSchedules, ensureDeviceWorkerDefaultOn } from "./modules/schedule/schedule.service.js";
import { startWatchdog } from "./modules/schedule/watchdog.service.js";
import { acquireSingleInstanceLock } from "./shared/single-instance.js";
import { startWatcher, stopWatcher } from "./modules/watcher/watcher.service.js";
import { resolveStateDir } from "./config/state-dir.js";
import { migrateSyncToPin } from "./config/migrate-sync-to-pin.js";
import { migrateDecisionsToLedger } from "./config/migrate-decisions-to-ledger.js";
import { migrateSdlLfbridge } from "./config/migrate-sdl-lfbridge.js";
import { log, flushLogs, logError } from "./shared/logging.js";
import { txnBoot, txnShutdown, startHeartbeat, stopHeartbeat, txnBegin, txnEnd, readPreviousSessionEnd } from "./shared/transactions.js";
import { recordSessionStart } from "./shared/session.js";
import { startHeapWatch, stopHeapWatch } from "./shared/heap-watch.js";
import { restoreQueueOnBoot } from "./modules/jobqueue/queue-restore.js";
import { admitRestored, recordQuarantined } from "./modules/jobqueue/jobqueue.service.js";
import { readDescription } from "./modules/describe/describe.service.js";
import { readTranscript } from "./modules/transcribe/transcribe.service.js";

async function bootstrapState(): Promise<void> {
  // Mint a stable computer id on first boot (storage.mdx §3).
  await updateAppConfig((c) => {
    if (!c.computer.id) c.computer.id = crypto.randomUUID();
    return c;
  });
  // Bring the IPFS node into only-our-content compliance (best effort — a missing/offline IPFS node
  // must not block boot, but the failure is worth a trail so a broken compliance run is visible).
  ipfs.enforceCompliance().catch((e) => log.warn("main", `IPFS compliance enforcement failed: ${(e as Error).message}`));
  const pid = await ipfs.peerId();
  if (pid) await updateAppConfig((c) => ((c.computer.ipfs_peer_id = pid), c));
  // The device-registration worker is ON BY DEFAULT (devices.mdx §11.1): auto-install + enable its
  // launchd job on first boot so device write-back runs every 10 min with no user action. One-time
  // (latched); if the user later turns it off it stays off. Best-effort — never blocks boot.
  await ensureDeviceWorkerDefaultOn().catch((e) =>
    log.warn("main", `device worker default-on provisioning failed: ${(e as Error).message}`),
  );
  // Re-render any installed worker LaunchAgent whose StartInterval drifted from the configured cadence
  // (e.g. the scan default dropped 4h → 2h). Best-effort — never blocks boot.
  await reconcileWorkerSchedules().catch((e) =>
    log.warn("main", `worker schedule reconcile failed: ${(e as Error).message}`),
  );
  // Start the in-process watchdog (backbone_resilience.mdx §3): while the app runs, it backstops a dead/stale
  // OS trigger by running any overdue worker in-process and repairing its launchd job — so the data flow
  // can never be silently halted by a broken trigger. Best-effort; a failure here never blocks boot.
  try {
    startWatchdog();
  } catch (e) {
    log.warn("main", `pin watchdog failed to start: ${(e as Error).message}`);
  }
}

function configuredOrigins(): string[] {
  const fromEnv = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fromCfg = getAppConfig().server.cors_origins;
  const merged = [...new Set([...fromEnv, ...fromCfg])];
  return merged.length ? merged : ["http://localhost:2222"];
}

// CORS origin gate (security audit finding 6). The web app defaults to :2222 but may increment past a
// foreign process (code_plan.mdx §2). We must NOT reflect ANY localhost origin with credentials — a
// hostile page on any other localhost port could otherwise drive credentialed calls. Instead we pin to
// an explicit allowlist: the configured origins PLUS, in local mode, the frontend port BAND
// (frontend_port..+16 on both loopback hostnames — the same set the auth redirect uses). Server mode
// fails closed to the configured origins only.
function corsOrigin(): cors.CorsOptions["origin"] {
  return (origin, cb) => {
    if (!origin) return cb(null, true); // no Origin header → same-origin or non-browser (curl); CORS is browser-only
    const allowlist = new Set([...configuredOrigins(), ...allowedRedirectOrigins()]);
    if (allowlist.has(origin)) return cb(null, true);
    cb(new Error(`origin not allowed: ${origin}`));
  };
}

async function main(): Promise<void> {
  // Single-instance guard BEFORE any config write: a second backend must never reach bootstrapState()
  // and race the store's per-process-only mutex (see single-instance.ts — this is what clobbered a
  // saved allow-list back to defaults during the dev-server swarm).
  const holder = await acquireSingleInstanceLock();
  if (holder !== null) {
    // Expected, healthy outcome of the guard during a normal dev-watch restart / double-start: another
    // live backend already holds the lock, so we cleanly stand down. Logged at info (not warn) so this
    // routine, non-fault stand-down does not pollute error.err.
    log.info(
      "main",
      `Another LargeFileBridge backend (pid ${holder}) already holds the lock — exiting so shared config is not corrupted. The guard is working as intended; stop the other instance first if this was unexpected.`,
    );
    process.exit(0);
  }

  // BOOT — the first thing the work ledger sees (transactions_log.mdx §5.9). It goes HERE, immediately
  // after the single-instance lock is won and before ANY migration or work runs, for two reasons:
  //   * Earlier would be a lie. The stand-down path above exits(0) when another backend holds the lock;
  //     a BOOT there would be a BOOT with no SHUTDOWN — which the ledger defines as a CRASH. A healthy
  //     double-start must never read as a crash, or the one inference this whole file buys us is worthless.
  //   * Later would be blind. The migrations below touch on-disk state; if one of them ever takes the
  //     process down, we want the ledger to already have an epoch marker for this attempt.
  // `heapLimitMB` is recorded once here so every subsequent heapUsedMB in the ledger has a denominator —
  // the number nobody could produce after the 2026-07-15 OOM, because the ~4 GB we hit was V8's default
  // that nobody chose (memory.mdx P-31). Reading the port is best-effort: an unreadable config must not
  // stop the marker, since a boot that then fails is exactly the boot worth having a marker for.
  let bootPort: number | undefined;
  try {
    bootPort = Number(process.env.PORT) || getAppConfig().server.backend_port;
  } catch {
    bootPort = undefined;
  }
  // How did the LAST session end? Read BEFORE txnBoot writes ours, or we would pair our own marker and
  // every session would look clean (crash_recovery.mdx §5.1 — BOOT without a following SHUTDOWN ⇒ the
  // previous session died). This ordering is load-bearing; do not move txnBoot above it.
  const previousSession = readPreviousSessionEnd();
  recordSessionStart(previousSession);
  if (previousSession.previousEnded === "abnormal") {
    log.warn(
      "main",
      `the previous session ended ABNORMALLY${previousSession.previousEndedAt ? ` (last sign of life ${previousSession.previousEndedAt})` : ""} — ` +
        `no SHUTDOWN marker followed its BOOT (crash_recovery.mdx §5.1).`,
    );
  }

  txnBoot({
    port: bootPort,
    heapLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024)),
    version: process.env.npm_package_version, // set by pnpm when launched via a package script; omitted otherwise
    previousEnded: previousSession.previousEnded,
  });

  // Watch the heap climb toward that ceiling and WARN before V8 aborts (memory.mdx P-32). Started before
  // any work is admitted; the timer is unref()'d, so it can never hold the process open.
  startHeapWatch();

  // One-time, idempotent compat migration (sync → pin): rewrite legacy on-disk state (the `sync/` unit
  // dirs, `sync_process`/`synced`/`sync:`/`last_sync_at` keys, and the old `com.largefilebridge.sync`
  // LaunchAgent) into the new `pin` shape BEFORE any config is read/written below. Best-effort; never
  // throws. Runs only in the instance that holds the single-instance lock.
  migrateSyncToPin(resolveStateDir());

  // One-time, idempotent backfill of the SHARED per-file decision ledger from the legacy machine-local
  // `decisions:` enum (decisions.mdx §13). Runs AFTER the sync→pin migration (it reads pin/r/<repo>/config.yaml)
  // and is consent-aware + best-effort (never throws).
  await migrateDecisionsToLedger();

  // One-time, idempotent on-disk migration of every SDL's `.lfbridge/` up to its ROOT
  // (artifact_placement_policy.mdx §0.3): a dedicated LFB file repo has NO `.lfbridge/` — its root IS the
  // tracking area. Merges rather than clobbers, `git mv`s so history follows, and never throws. Runs BEFORE
  // the app serves anything so readers see the migrated layout; whatever it can't move is still found by the
  // legacy read-fallback, so a partial run degrades to an extra path segment, never a missing artifact.
  migrateSdlLfbridge();

  await bootstrapState();
  const cfg = getAppConfig();
  const port = Number(process.env.PORT) || cfg.server.backend_port;

  const app = express();
  app.set("trust proxy", "loopback");
  const isLocal = cfg.server.mode === "local";
  // HSTS must NOT be sent over plain-http localhost dev: the browser caches the policy for the
  // `localhost` host (includeSubDomains, ~2 years) and then force-upgrades every http://localhost
  // request to https. That silently breaks the Google OAuth callback — Google redirects to
  // http://localhost:8787/api/v1/oauth_callback, the browser rewrites it to https://…:8787 where
  // no TLS server is listening — and poisons the whole app until the user clears HSTS state.
  // HSTS is only meaningful behind real TLS, so enable it in server mode only.
  app.use(helmet({ contentSecurityPolicy: false, hsts: isLocal ? false : undefined }));
  app.use(cors({ origin: corsOrigin(), credentials: true }));

  // OpenAuthFederated Frontend API (own namespace, before body parsing so it owns its routes).
  app.use("/api/v1", buildAuthFrontend());

  app.use(express.json({ limit: "1mb" }));
  app.use("/api", identify); // identify, don't gate (per-route gates enforce the allow-list)

  app.use("/api/auth", authRouter);
  app.use("/api/health", healthRouter);
  app.use("/api/progress", progressRouter); // the progress dock's server-side job set (webapp.mdx §12)
  app.use("/api/security", securityRouter); // first-run allow-list (unauthenticated; loopback-guarded)
  app.use("/api/repos", reposRouter);
  app.use("/api/company-mappings", companyRouter); // cross-member repo→company review & consent (repo_owner_propagation.mdx)
  app.use("/api/fs", fsRouter);
  app.use("/api/entity", entityRouter);
  app.use("/api/media", mediaRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/sessions", sessionsRouter); // web-session activity ping + stale-return auto-pin (sessions.mdx)
  app.use("/api/peers", peersRouter);
  app.use("/api/devices", devicesRouter); // the Devices / Peers table: self + peers + registry (devices.mdx §6)
  app.use("/api/ipfs", ipfsRouter);
  app.use("/api/storages", storagesRouter); // the Storages tab: discover/init/index/analyze (storages.mdx)
  app.use("/api/communities", communitiesRouter); // the Communities page: budget + subscribe (communities.mdx)
  app.use("/api/compress", compressRouter); // compression engine: tools/settings/check/file/batch (compression.mdx)
  app.use("/api/transcribe", transcribeRouter); // transcription engine: tools/file/batch/tree/storage (Transcribe.mdx)
  app.use("/api/describe", describeRouter); // AI description: providers/file/prompt (ai_description.mdx)
  app.use("/api/git", gitRouter); // Git Ignore engine: /ignore/plan + /ignore/apply (git_ignore.mdx §6)
  app.use("/api/todo", todoRouter); // To Do page: per-storage batches, dismiss, apply, transcribe-scan (to_do.mdx)
  app.use("/api/internal", internalRouter);
  app.use("/api/client-log", clientLogRouter); // browser fault trail -> shared logger -> error.err

  // Global error handler -> error.err.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error("http", err.stack || err.message);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: "internal error" });
  });

  // Bind loopback-only in local mode (security audit finding 1): the API must NOT be reachable from
  // the local network in the default offline posture. Server mode binds all interfaces (override with
  // HOST) because it is meant to be reached remotely — and it fails closed to real sign-in.
  const host = isLocal ? "127.0.0.1" : process.env.HOST || "0.0.0.0";
  const server = app.listen(port, host, () =>
    log.info("main", `LargeFileBridge API listening on ${host}:${port}`),
  );
  // With the single-instance lock held, an EADDRINUSE here means a FOREIGN process owns the port —
  // fail with a clear one-line message instead of an unhandled listen-error stack trace.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.fatal("main", `Port :${port} is held by another (non-LFB) process. Free it or set PORT, then restart.`);
    } else {
      log.fatal("main", `HTTP server error: ${err.stack || err.message}`);
    }
    process.exit(1);
  });

  // Start the live filesystem watcher (scan.mdx §2.2): subscribe to OS file-change events over the
  // scanner roots and, on a qualifying add/delete of a big or video/image/audio file, kick a coalesced
  // discovery rescan so tracking + the File System tree refresh in seconds. It lives WITH this process
  // — no scheduler — so release it cleanly on shutdown.
  startWatcher();

  // RESTORE THE BACKLOG the previous session left behind (crash_recovery.mdx §4). This is the line that
  // makes "I queued 1,440 files and walked away" a promise we can keep: the journal is folded, tasks that
  // already have their output are cheap no-ops (skip-already-done), and a task that has burned its strikes is
  // QUARANTINED rather than replayed into the same crash. Runs after the migrations (so the state root is in
  // its final shape) and before the heartbeat, so restored work is already counted by the first beat.
  // Best-effort: a corrupt journal must never stop the server from booting — the app coming up is worth more
  // than the backlog it lost.
  try {
    // The skip-already-done check is INJECTED here (crash_recovery.mdx §4.1 step 2) rather than imported
    // by queue-restore, which is deliberately a leaf. main.ts is the composition root and already owns
    // both halves, so this is where the op's own idempotence check meets the restore pass.
    const { tasks, summary } = restoreQueueOnBoot({
      isAlreadyDone: (task) =>
        task.overwrite
          ? false // an explicit overwrite means "do it again" — an existing output is not a reason to skip
          : task.op === "describe"
            ? readDescription(task.path) !== null
            : task.op === "transcribe"
              ? readTranscript(task.path) !== null
              : false, // compress has no cheap "already done" signal — let the runner's own guards decide
    });
    if (tasks.length) admitRestored(tasks);
    // A quarantined task must reach the USER, not just the log (crash_recovery.mdx §4.3, AC6). Without
    // this the file that crashed the app twice simply vanishes from the backlog in silence.
    if (summary.quarantinedTasks.length) recordQuarantined(summary.quarantinedTasks);
    if (summary.restored || summary.quarantined || summary.skipped || summary.vanished) {
      log.warn(
        "main",
        `previous session ended with work in flight — restored ${summary.restored} job(s), ` +
          `quarantined ${summary.quarantined}, skipped ${summary.skipped} already-done, dropped ${summary.vanished} vanished`,
      );
    }
  } catch (e) {
    logError({ file: "main.ts", operation: "restoreQueueOnBoot", error: e });
  }

  // The ledger's heartbeat (transactions_log.mdx §6): while work is in flight it writes queue depth and
  // heap every ~30s, and the LAST heartbeat before a gap is the crash's fingerprint. Started only now,
  // once the app is actually up. It self-silences when idle and is already unref()'d.
  startHeartbeat();

  const shutdown = (sig: string) => {
    log.info("main", `${sig} received — stopping filesystem watcher and exiting.`);
    // SHUTDOWN is the ledger's proof of a DELIBERATE exit, so it may only ever be written from here.
    // Its ABSENCE before the next BOOT is precisely what tells a reader the process died — which means
    // the marker's value is entirely in the cases where it does NOT appear. Emit it before the async
    // server.close() so a slow socket drain can't cost us the line (the write is synchronous).
    txnShutdown({ signal: sig });
    stopHeartbeat();
    stopHeapWatch();
    stopWatcher();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Durable fault trail for the two "the process is going down and nobody caught it" paths. These
  // COMPOSE with logging.ts's installLogShutdownFlush(), which registers its own flush-only
  // uncaughtException listener — Node runs every listener, so both fire; we deliberately do not touch
  // its flush-only semantics, and we flush again ourselves because ordering between listeners is not
  // ours to assume.
  //
  // Note what these CANNOT catch: a V8 out-of-memory abort. It is not an exception — the runtime prints
  // its banner and calls abort(3), and no JavaScript runs after that (memory.mdx P-32). That is why
  // heap-watch.ts warns on the APPROACH instead; these handlers cover ordinary fatal faults, and the
  // ledger line they write is what distinguishes "threw" from "vanished" the morning after.
  const fatal = (kind: string, err: unknown): void => {
    try {
      logError({ file: "main.ts", operation: kind, error: err });
      log.fatal("main", `${kind}: ${(err as Error)?.stack || String(err)}`);
      const t = txnBegin("process_fatal", { kind });
      txnEnd(t, "failed", { reason: kind });
    } catch {
      // A crash reporter that throws inside the crash is worse than no crash reporter.
    } finally {
      flushLogs();
    }
  };
  process.on("unhandledRejection", (r) => fatal("unhandledRejection", r));
  process.on("uncaughtException", (e) => fatal("uncaughtException", e));
}

main().catch((e) => {
  log.fatal("main", `boot failed: ${(e as Error).stack || e}`);
  process.exit(1);
});
