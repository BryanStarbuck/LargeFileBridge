// Client→server log bridge. The React frontend runs in the browser and cannot write to error.err
// directly, so it POSTs error/warn events here and we funnel them through the same shared logger
// (shared/logging.ts) — WARN/ERROR/FATAL land in error.err exactly like backend faults. This keeps
// ONE fault trail for the whole app. Endpoint is best-effort and must never throw back at the client.
import { Router } from "express";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { log } from "../../shared/logging.js";

export const clientLogRouter = Router();

type ClientLevel = "debug" | "info" | "warn" | "error" | "fatal";
const LEVELS: ReadonlySet<ClientLevel> = new Set(["debug", "info", "warn", "error", "fatal"]);
const MAX_CONTEXT = 80;
const MAX_MESSAGE = 4000;
// Security audit finding 7: bound the batch and rate so a caller cannot flood the shared fault trail
// (error.err) or forge unlimited "client:*" lines. A single browser only ever reports a handful.
const MAX_EVENTS = 50; // events accepted per request (extras dropped)
const RATE_WINDOW_MS = 60 * 1000; // fixed-window rate limit …
const RATE_MAX_REQUESTS = 60; // … max client-log POSTs per key per window

// Newlines/carriage-returns are stripped from caller text so a single event cannot inject forged
// extra log lines into the one-line-per-entry fault trail.
function oneLine(s: string): string {
  return s.replace(/[\r\n\u2028\u2029\u0085]+/g, " ");
}

// Per-principal fixed-window counter (in-process; the app is single-instance).
const rateHits = new Map<string, { count: number; resetAt: number }>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const cur = rateHits.get(key);
  if (!cur || now >= cur.resetAt) {
    rateHits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  cur.count += 1;
  return cur.count > RATE_MAX_REQUESTS;
}

// One entry (or a small batch) of client-side log events. Requires an allow-listed session; permissive
// about missing/malformed fields so a browser reporting an error still succeeds, but bounded + gated.
clientLogRouter.post("/", requireAllowListed, (req, res) => {
  try {
    const user = currentUser(req);
    const key = user.sessionId || user.email || req.ip || "anon";
    if (rateLimited(key)) {
      return res.status(429).json({ ok: false, error: "rate limited", code: "rate_limited" });
    }
    const body = req.body as unknown;
    const all = Array.isArray((body as { events?: unknown })?.events)
      ? ((body as { events: unknown[] }).events)
      : [body];
    const events = all.slice(0, MAX_EVENTS); // cap the batch — extras are dropped
    for (const raw of events) {
      const e = (raw ?? {}) as { level?: unknown; context?: unknown; message?: unknown };
      const level: ClientLevel = LEVELS.has(e.level as ClientLevel) ? (e.level as ClientLevel) : "error";
      const rawCtx = typeof e.context === "string" && e.context.trim() ? e.context.trim() : "unknown";
      const context = oneLine(`client:${rawCtx}`).slice(0, MAX_CONTEXT);
      const message = oneLine(
        typeof e.message === "string" ? e.message : JSON.stringify(e.message ?? ""),
      ).slice(0, MAX_MESSAGE);
      log[level](context, message);
    }
    res.json({ ok: true, data: { received: events.length, dropped: all.length - events.length } });
  } catch (e) {
    // A malformed report must not surface as a 500 to the browser — record it and ack.
    log.warn("clientlog", `failed to ingest client log: ${oneLine((e as Error).message)}`);
    res.json({ ok: true, data: { received: 0 } });
  }
});
