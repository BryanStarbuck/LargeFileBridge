// request-watch.ts — the fault trail for "the page just spins".
//
// WHAT WAS MISSING. The backend had no per-request timing of any kind. `loop-watch` could say the loop
// stopped for 7,310 ms and `heap-watch` could say memory was fine, but NOTHING said which endpoint the
// browser was still waiting on — and "waiting on a response that never comes" IS the spinner. The user's
// report ("the pages are spinning") and the server's fault trail had no line in common, so every
// investigation had to reproduce the hang by hand with a stopwatch.
//
// Three signals, all of them into error.err:
//
//   1. SLOW — a request that finished, but took longer than a person will wait (`LFB_SLOW_REQ_MS`, 1 s).
//      Logged with method, path, status, bytes and duration, so a slow ENDPOINT is separable from a slow
//      MOMENT: the same URL fast at 14:00 and slow at 14:05 is the loop being blocked by something else,
//      while one URL slow every time is that handler's own cost.
//   2. STILL OPEN — a sweep every few seconds naming requests that have been in flight past
//      `LFB_STUCK_REQ_MS` (10 s) and have not answered yet. This is the spinner, reported WHILE it is
//      spinning rather than after the fact — and it is the one signal that survives a request that never
//      completes at all, where a finish-time log by construction never runs.
//   3. NEVER FINISHED — a request whose socket the client gave up on (aborted/closed with no response).
//      A page the user navigated away from mid-spin leaves exactly this trace and no other.
//
// It also exports `inFlightSummary()`, which `loop-watch` appends to its stall WARN: the requests open
// ACROSS a stall are precisely the pages that were spinning during it, which is the join between the two
// halves of the story.
//
// CONTRACT: Node builtins + express types only, never throws into the request path, and O(1) per request
// (a Map insert and a delete). The sweep timer is unref'd, so it can never hold the process open.
import type { Request, Response, NextFunction } from "express";
import { performance } from "node:perf_hooks";
import { log } from "./logging.js";
import { blocking } from "./blocking.js";

/** A finished request slower than this is worth a line. One second is the threshold at which a person
 *  stops reading the page and starts looking at the spinner. */
const SLOW_MS = Math.max(100, Number(process.env.LFB_SLOW_REQ_MS) || 1_000);

/** An UNFINISHED request older than this is reported while it is still open. 10 s is chosen against a real
 *  number: `run-worker` gives up on the app at 15 s, so this fires while the app is still nominally alive. */
const STUCK_MS = Math.max(1_000, Number(process.env.LFB_STUCK_REQ_MS) || 10_000);

/** How often to sweep for stuck requests. */
const SWEEP_MS = Math.max(1_000, Number(process.env.LFB_STUCK_SWEEP_MS) || 5_000);

interface InFlight {
  method: string;
  path: string;
  startedAt: number;
  /** Set once we have reported it as stuck, so one hung request produces one line, not one per sweep. */
  reported: boolean;
}

let nextId = 1;
const inFlight = new Map<number, InFlight>();
let sweep: NodeJS.Timeout | null = null;

/** Streams are SUPPOSED to stay open — an NDJSON/SSE response is long-lived by design, and reporting one
 *  as "stuck" every sweep would bury the requests that really are hung. Matched on the path, because that
 *  is what we have before the handler has decided anything. */
const LONG_LIVED = /\/(stream|events)(\/|$)/;

/** One line describing the requests open right now, oldest first. Empty when nothing is in flight.
 *  Used by loop-watch: the requests open ACROSS a stall are the pages the user watched spin. */
export function inFlightSummary(now: number = performance.now()): string {
  if (inFlight.size === 0) return "";
  const rows = [...inFlight.values()]
    .filter((r) => !LONG_LIVED.test(r.path))
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, 8)
    .map((r) => `${r.method} ${r.path} (${Math.round(now - r.startedAt)}ms so far)`);
  return rows.join(", ");
}

/** How many requests are open right now — the diagnostics surface's cheap health number. */
export function inFlightCount(): number {
  return inFlight.size;
}

/**
 * Express middleware. Mount it FIRST, before body parsing and before every router, so the duration it
 * reports is the duration the BROWSER sees — a request that spends 4 s queued behind a blocked loop before
 * express ever calls the handler is a 4 s request to the person watching the spinner, and a timer started
 * inside the handler would report it as fast.
 */
export function requestWatch(req: Request, res: Response, next: NextFunction): void {
  const id = nextId++;
  const startedAt = performance.now();
  // `originalUrl` before any router strips its mount path, and the query string dropped: a path with an
  // absolute filesystem path in it is unreadable in a log and is not the thing being identified.
  const path = (req.originalUrl || req.url || "").split("?")[0] ?? "";
  const method = req.method;
  inFlight.set(id, { method, path, startedAt, reported: false });

  let done = false;
  const finish = (how: "finish" | "close"): void => {
    if (done) return;
    done = true;
    const entry = inFlight.get(id);
    inFlight.delete(id);
    const ms = performance.now() - startedAt;
    try {
      if (how === "close" && !res.writableEnded && !LONG_LIVED.test(path)) {
        // The client hung up with nothing sent. This is the ONLY trace a page the user gave up on leaves.
        // Streams are excluded: a browser that navigates away from an open NDJSON/SSE response aborts it
        // with nothing written, which is the NORMAL end of a stream's life, not an unanswered request.
        log.warn(
          "request",
          `NEVER ANSWERED: ${method} ${path} — the client closed the connection after ${Math.round(ms)}ms ` +
            `with no response sent. From the browser's side this is a request that spun until the tab, the ` +
            `fetch timeout or the user ended it. See performance.mdx T3.`,
        );
        return;
      }
      if (ms >= SLOW_MS && !LONG_LIVED.test(path)) {
        log.warn(
          "request",
          `SLOW: ${method} ${path} -> ${res.statusCode} took ${Math.round(ms)}ms` +
            (entry?.reported ? " (it had already been reported as stuck)" : "") +
            `. Was the handler itself slow, or was it queued behind a blocked event loop? Compare with the ` +
            `loop-watch line for this window — same URL fast at other times means the loop, not the handler.`,
        );
      }
    } catch {
      // Instrumentation must never break the response it is measuring.
    }
  };
  res.on("finish", () => finish("finish"));
  res.on("close", () => finish("close"));
  // `next()` runs the WHOLE downstream chain — every middleware and the handler itself — synchronously up
  // to its first `await`. Wrapping it therefore measures exactly the part of a request that holds the event
  // loop, and attributes it to a route, which is what turns "something blocked for 4s" into "GET /api/repos
  // blocked for 4s". An async handler's later work is not counted here; that is correct, because after the
  // first await it is no longer holding the thread.
  blocking(`http ${method} ${routeLabel(path)}`, () => next());
}

/**
 * Collapse a URL to a ROUTE so the tally groups. `/api/repos/a1b2/files` and `/api/repos/c3d4/files` are one
 * route with two ids; keeping them apart would make every id its own row and rank none of them. Ids are
 * recognised structurally (hex/uuid/digits/anything path-like), which needs no route table to stay correct.
 */
function routeLabel(path: string): string {
  return path
    .split("/")
    .map((seg) =>
      seg.length > 0 && (/^[0-9a-f]{6,}$/i.test(seg) || /^\d+$/.test(seg) || seg.includes("%2F") || seg.includes("."))
        ? ":id"
        : seg,
    )
    .join("/");
}

/** Start the stuck-request sweep. Idempotent; the timer is unref'd. */
export function startRequestWatch(): void {
  if (sweep) return;
  sweep = setInterval(() => {
    try {
      const now = performance.now();
      for (const r of inFlight.values()) {
        if (r.reported || LONG_LIVED.test(r.path)) continue;
        const age = now - r.startedAt;
        if (age < STUCK_MS) continue;
        r.reported = true;
        // Deliberately NOT recorded into the blocking tally. That tally measures who HELD the loop; a stuck
        // request is the opposite — someone WAITING on it — and filing it as a 0 ms section would put a
        // meaningless row in a ranked list of milliseconds. The waiting side already reaches the same
        // report through `inFlightSummary()`, which loop-watch prints as "STILL WAITING".
        log.error(
          "request",
          `STILL OPEN after ${Math.round(age)}ms: ${r.method} ${r.path}. The browser is showing a spinner ` +
            `for this right now. ${inFlight.size} request(s) in flight: ${inFlightSummary(now)}. ` +
            `A request that is open this long is either blocked behind synchronous work on the event loop ` +
            `(check the loop-watch and blocking lines for this window) or waiting on a child process / ` +
            `network call with no timeout.`,
        );
      }
    } catch {
      /* never let the sweep take the app down */
    }
  }, SWEEP_MS);
  sweep.unref?.();
  log.info(
    "request",
    `Request watch armed: WARN a finished request over ${SLOW_MS}ms, ERROR one still open after ${STUCK_MS}ms.`,
  );
}

export function stopRequestWatch(): void {
  if (sweep) clearInterval(sweep);
  sweep = null;
  inFlight.clear();
}
