// LargeFileBridge backend — lean Express + TypeScript (code_plan.mdx §3). Run via tsx.
import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import crypto from "node:crypto";
import { getAppConfig, updateAppConfig } from "./modules/store-model/config.service.js";
import { buildAuthFrontend } from "./modules/auth/auth-frontend.js";
import { identify } from "./modules/auth/identify.js";
import { authRouter } from "./modules/auth/auth.router.js";
import { reposRouter } from "./modules/repos/repos.router.js";
import { fsRouter } from "./modules/fs/fs.router.js";
import { entityRouter } from "./modules/entity/entity.router.js";
import { mediaRouter } from "./modules/media/media.router.js";
import { settingsRouter } from "./modules/settings/settings.router.js";
import { syncRouter } from "./modules/sync/sync.router.js";
import { sessionsRouter } from "./modules/sessions/sessions.router.js";
import { peersRouter } from "./modules/peers/peers.router.js";
import { ipfsRouter } from "./modules/ipfs/ipfs.router.js";
import { healthRouter } from "./modules/health/health.router.js";
import { securityRouter } from "./modules/security/security.router.js";
import { internalRouter } from "./modules/internal/internal.router.js";
import { clientLogRouter } from "./modules/clientlog/clientlog.router.js";
import * as ipfs from "./modules/ipfs/ipfs.service.js";
import { acquireSingleInstanceLock } from "./shared/single-instance.js";
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
}

function configuredOrigins(): string[] {
  const fromEnv = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fromCfg = getAppConfig().server.cors_origins;
  const merged = [...new Set([...fromEnv, ...fromCfg])];
  return merged.length ? merged : ["http://localhost:2222"];
}

// The web app defaults to :2222 but may increment past a foreign process (code_plan.mdx §2 port
// collision policy). In LOCAL mode we therefore accept ANY localhost origin so a moved web port
// still reaches the API; in SERVER mode we fail closed to the configured origin list only.
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function corsOrigin(): cors.CorsOptions["origin"] {
  const allowlist = new Set(configuredOrigins());
  const local = getAppConfig().server.mode === "local";
  return (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl — no browser origin to check
    if (allowlist.has(origin) || (local && LOCALHOST_ORIGIN.test(origin))) return cb(null, true);
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
  app.use("/api/security", securityRouter); // first-run allow-list (unauthenticated; loopback-guarded)
  app.use("/api/repos", reposRouter);
  app.use("/api/fs", fsRouter);
  app.use("/api/entity", entityRouter);
  app.use("/api/media", mediaRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/sync", syncRouter);
  app.use("/api/sessions", sessionsRouter); // web-session activity ping + stale-return auto-sync (sessions.mdx)
  app.use("/api/peers", peersRouter);
  app.use("/api/ipfs", ipfsRouter);
  app.use("/api/internal", internalRouter);
  app.use("/api/client-log", clientLogRouter); // browser fault trail -> shared logger -> error.err

  // Global error handler -> error.err.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error("http", err.stack || err.message);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: "internal error" });
  });

  const server = app.listen(port, () => log.info("main", `LargeFileBridge API listening on :${port}`));
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

  process.on("unhandledRejection", (r) => log.error("main", `unhandledRejection: ${String(r)}`));
  process.on("uncaughtException", (e) => log.fatal("main", `uncaughtException: ${e.stack || e}`));
}

main().catch((e) => {
  log.fatal("main", `boot failed: ${(e as Error).stack || e}`);
  process.exit(1);
});
