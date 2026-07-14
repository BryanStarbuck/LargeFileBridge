// LargeFileBridge backend — lean Express + TypeScript (code_plan.mdx §3). Run via tsx.
import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import crypto from "node:crypto";
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
import { log } from "./shared/logging.js";

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

  // One-time, idempotent compat migration (sync → pin): rewrite legacy on-disk state (the `sync/` unit
  // dirs, `sync_process`/`synced`/`sync:`/`last_sync_at` keys, and the old `com.largefilebridge.sync`
  // LaunchAgent) into the new `pin` shape BEFORE any config is read/written below. Best-effort; never
  // throws. Runs only in the instance that holds the single-instance lock.
  migrateSyncToPin(resolveStateDir());

  // One-time, idempotent backfill of the SHARED per-file decision ledger from the legacy machine-local
  // `decisions:` enum (decisions.mdx §13). Runs AFTER the sync→pin migration (it reads pin/r/<repo>/config.yaml)
  // and is consent-aware + best-effort (never throws).
  await migrateDecisionsToLedger();

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
  const shutdown = (sig: string) => {
    log.info("main", `${sig} received — stopping filesystem watcher and exiting.`);
    stopWatcher();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (r) => log.error("main", `unhandledRejection: ${String(r)}`));
  process.on("uncaughtException", (e) => log.fatal("main", `uncaughtException: ${e.stack || e}`));
}

main().catch((e) => {
  log.fatal("main", `boot failed: ${(e as Error).stack || e}`);
  process.exit(1);
});
