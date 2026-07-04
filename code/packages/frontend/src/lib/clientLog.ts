// Frontend fault trail. The browser cannot write to error.err, so we forward error/warn events to
// the backend's /client-log bridge, which funnels them through the SAME shared logger the backend
// uses — so a frontend failure ends up in error.err next to backend failures (one fault trail).
//
// Rules this util guarantees:
//  * It NEVER throws. Logging a failure must not create a second failure. All I/O is best-effort.
//  * It always mirrors to the devtools console so local debugging still works if the network is down.
//  * It fires-and-forgets: callers do not await it, so it never blocks a UI path.
//
// Usage in a catch block:
//   try { ... } catch (e) { clientLog.error("ReposPage.load", e); toast.error("Couldn't load repos"); }
import { http } from "../api/axios.js";

type Level = "warn" | "error" | "fatal";

// Turn anything a catch block hands us (Error, string, unknown) into a readable one-line message.
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function send(level: Level, context: string, err: unknown): void {
  const message = errMessage(err);
  // Mirror to the console first — this is synchronous and always works, even offline.
  const consoleFn = level === "warn" ? console.warn : console.error;
  try {
    consoleFn(`[${context}]`, err);
  } catch {
    /* console is unavailable in some embeddings — ignore */
  }
  // Ship to the backend bridge. Fire-and-forget; swallow any transport error so we never recurse.
  try {
    void http.post("/client-log", { level, context, message }).catch(() => {});
  } catch {
    /* http layer unavailable (e.g. during teardown) — the console mirror above is our fallback */
  }
}

export const clientLog = {
  warn: (context: string, err: unknown) => send("warn", context, err),
  error: (context: string, err: unknown) => send("error", context, err),
  fatal: (context: string, err: unknown) => send("fatal", context, err),
};
