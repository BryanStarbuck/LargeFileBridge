import { Router } from "express";
import * as ipfs from "../ipfs/ipfs.service.js";
import { authConfig } from "../auth/auth.router.js";
import { isLoopback } from "../../shared/loopback.js";
import { buildState, runningStaleCode } from "../schedule/self-update.service.js";
import { databaseHealth } from "../../shared/persistence/boot.js";
import { log } from "../../shared/logging.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  // Never let an ipfs.health() rejection escape as an unhandled promise (Express 4 wouldn't forward
  // it to the global error handler, hanging the client) — report the node as down and still answer.
  try {
    // WHICH BUILD IS ACTUALLY RUNNING (git_backbone.mdx §6.7). Reported here because "which build is that
    // computer on?" had to be answered by hand during the 2026-07-29 churn incident, from the shape of a
    // YAML file. One curl against a machine now answers it, including whether the process is older than
    // its own checkout.
    const build = buildState();
    res.json({
      ok: true,
      data: {
        status: "ok",
        ipfs: await ipfs.health(),
        // WHICH STORAGE ENGINE IS ACTUALLY SERVING THIS MACHINE (database.mdx §7.2). Under the default
        // LFB_DB_MODE=auto an unreachable Postgres is a silent, correct fallback to the YAML path — which
        // is exactly why it needs a surface: "the app is fine but slow" and "the app is fine and on
        // Postgres" are indistinguishable from the outside otherwise. `reachable:false` here is the
        // one-line answer to why the ninth-pass performance work appears not to have landed.
        database: await databaseHealth(),
        build: {
          number: build.build,
          label: build.label,
          runningStaleCode: runningStaleCode(build),
          behindRemoteBy: build.behindBy,
        },
      },
    });
  } catch (e) {
    log.error("health", `health check failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: "health check failed" });
  }
});

// The database section on its own, so `just db-status` can ask the LIVE process what it sees instead of
// assembling a second opinion out of psql. It reports mode, reachability, the server's version and
// `listen_addresses`, the §7.1 loopback verdict, the schema ledger head, and the data-migration ledger's
// done/pending/failed counts. It NEVER reports a connection string that has not been through `safeUrl` —
// the URL carries the database password (pool.ts).
healthRouter.get("/database", async (_req, res) => {
  try {
    res.json({ ok: true, data: await databaseHealth() });
  } catch (e) {
    log.error("health", `database health read failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: "database health unavailable" });
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
