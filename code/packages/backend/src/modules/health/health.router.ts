import { Router } from "express";
import * as ipfs from "../ipfs/ipfs.service.js";
import { authConfig } from "../auth/auth.router.js";
import { isLoopback } from "../../shared/loopback.js";
import { log } from "../../shared/logging.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  // Never let an ipfs.health() rejection escape as an unhandled promise (Express 4 wouldn't forward
  // it to the global error handler, hanging the client) — report the node as down and still answer.
  try {
    res.json({ ok: true, data: { status: "ok", ipfs: await ipfs.health() } });
  } catch (e) {
    log.error("health", `health check failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: "health check failed" });
  }
});

healthRouter.get("/auth-config", (req, res) => {
  try {
    // Only a loopback caller (local first-run setup) sees the creds-file path + dev-bypass state.
    res.json({ ok: true, data: authConfig(isLoopback(req)) });
  } catch (e) {
    log.error("health", `auth-config read failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: "auth-config unavailable" });
  }
});
