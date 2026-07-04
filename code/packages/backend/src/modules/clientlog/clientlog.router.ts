// Client→server log bridge. The React frontend runs in the browser and cannot write to error.err
// directly, so it POSTs error/warn events here and we funnel them through the same shared logger
// (shared/logging.ts) — WARN/ERROR/FATAL land in error.err exactly like backend faults. This keeps
// ONE fault trail for the whole app. Endpoint is best-effort and must never throw back at the client.
import { Router } from "express";
import { log } from "../../shared/logging.js";

export const clientLogRouter = Router();

type ClientLevel = "debug" | "info" | "warn" | "error" | "fatal";
const LEVELS: ReadonlySet<ClientLevel> = new Set(["debug", "info", "warn", "error", "fatal"]);
const MAX_CONTEXT = 80;
const MAX_MESSAGE = 4000;

// One entry (or a small batch) of client-side log events. We deliberately keep this permissive:
// a browser reporting an error must succeed even if some fields are missing/malformed.
clientLogRouter.post("/", (req, res) => {
  try {
    const body = req.body as unknown;
    const events = Array.isArray((body as { events?: unknown })?.events)
      ? ((body as { events: unknown[] }).events)
      : [body];
    for (const raw of events) {
      const e = (raw ?? {}) as { level?: unknown; context?: unknown; message?: unknown };
      const level: ClientLevel = LEVELS.has(e.level as ClientLevel) ? (e.level as ClientLevel) : "error";
      const rawCtx = typeof e.context === "string" && e.context.trim() ? e.context.trim() : "unknown";
      const context = `client:${rawCtx}`.slice(0, MAX_CONTEXT);
      const message = (typeof e.message === "string" ? e.message : JSON.stringify(e.message ?? "")).slice(
        0,
        MAX_MESSAGE,
      );
      log[level](context, message);
    }
    res.json({ ok: true, data: { received: events.length } });
  } catch (e) {
    // A malformed report must not surface as a 500 to the browser — record it and ack.
    log.warn("clientlog", `failed to ingest client log: ${(e as Error).message}`);
    res.json({ ok: true, data: { received: 0 } });
  }
});
