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
import { settingsRouter } from "./modules/settings/settings.router.js";
import { syncRouter } from "./modules/sync/sync.router.js";
import { peersRouter } from "./modules/peers/peers.router.js";
import { healthRouter } from "./modules/health/health.router.js";
import { internalRouter } from "./modules/internal/internal.router.js";
import * as ipfs from "./modules/ipfs/ipfs.service.js";
import { log } from "./shared/logging.js";

async function bootstrapState(): Promise<void> {
  // Mint a stable computer id on first boot (storage.mdx §3).
  await updateAppConfig((c) => {
    if (!c.computer.id) c.computer.id = crypto.randomUUID();
    return c;
  });
  // Bring the IPFS node into only-our-content compliance (best effort).
  ipfs.enforceCompliance().catch(() => {});
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
  await bootstrapState();
  const cfg = getAppConfig();
  const port = Number(process.env.PORT) || cfg.server.backend_port;

  const app = express();
  app.set("trust proxy", "loopback");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: corsOrigin(), credentials: true }));

  // OpenAuthFederated Frontend API (own namespace, before body parsing so it owns its routes).
  app.use("/api/v1", buildAuthFrontend());

  app.use(express.json({ limit: "1mb" }));
  app.use("/api", identify); // identify, don't gate (per-route gates enforce the allow-list)

  app.use("/api/auth", authRouter);
  app.use("/api/health", healthRouter);
  app.use("/api/repos", reposRouter);
  app.use("/api/fs", fsRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/sync", syncRouter);
  app.use("/api/peers", peersRouter);
  app.use("/api/internal", internalRouter);

  // Global error handler -> error.err.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error("http", err.stack || err.message);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: "internal error" });
  });

  app.listen(port, () => log.info("main", `LargeFileBridge API listening on :${port}`));

  process.on("unhandledRejection", (r) => log.error("main", `unhandledRejection: ${String(r)}`));
  process.on("uncaughtException", (e) => log.fatal("main", `uncaughtException: ${e.stack || e}`));
}

main().catch((e) => {
  log.fatal("main", `boot failed: ${(e as Error).stack || e}`);
  process.exit(1);
});
