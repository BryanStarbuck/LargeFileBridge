// loop-watch.ts — the missing perf log for the symptom nobody could name: "the app hangs".
//
// WHAT WAS MISSING. heap-watch.ts samples three memory layers well (V8 heap, child RSS, OS swap), and
// between them they explain why the machine gets SLOWER. They cannot explain why the app stops
// ANSWERING, because that is not a memory fact — it is an event-loop fact. Node serves every HTTP
// request, every stream chunk and every timer from one thread; a single synchronous stretch (a big
// JSON.parse, a readFileSync over a multi-megabyte store, a tight loop over a pinset) freezes all of
// them at once, and NOTHING in the fault trail said so.
//
// The evidence that this was the blind spot, all from the same logs and all previously unexplained:
//   • `[run-worker] no acknowledgement from the app within 15s over 3 attempts — but 127.0.0.1:8787 IS
//     accepting connections`. That sentence IS a blocked event loop, described from the outside: the
//     kernel completes the TCP handshake from the listen backlog with no help from us, so the port looks
//     alive while the thread that would answer has not run for 15 seconds. 47 of these since 2026-07-28.
//   • `[auth] Token verification failed: "exp" claim timestamp check failed` on ordinary endpoints. The
//     browser refuses to attach a Bearer with under TOKEN_HARD_FLOOR_S (10s) of life left, so a token
//     that verifies as EXPIRED at the backend spent longer than that between attach and verify — time it
//     could only have spent queued in front of a stalled loop.
//   • `[client:useLiveRefresh.stream] TypeError: network error` — a long-lived NDJSON stream dropped
//     because no chunk arrived for long enough that the browser gave up on it.
//
// Three different subsystems reporting the same underlying event in three vocabularies, and no single
// line saying "the loop was blocked for N ms". This file writes that line.
//
// HOW. `perf_hooks.monitorEventLoopDelay()` is a libuv-level histogram maintained in C++: it costs
// nothing measurable, keeps running while JS is blocked (which is the entire point — a JS timer cannot
// measure a stall that prevents timers from firing), and reports percentiles rather than one sample, so
// a rare 20-second freeze cannot hide behind a healthy mean.
//
// Node builtins only, best-effort, unref'd, and it swallows its own errors — the same contract as
// heap-watch: instrumentation must never be the thing that takes the server down.
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { log } from "./logging.js";

const NS_PER_MS = 1e6;

/**
 * How often we read and reset the histogram. One minute is deliberately coarse: this is a trend log, not
 * a profiler, and a shorter window would report the same stall repeatedly as it straddles boundaries.
 */
const WINDOW_MS = Math.max(5_000, Number(process.env.LFB_LOOP_WINDOW_MS) || 60_000);

/**
 * WARN above this worst-case delay in a window. 1s is far past anything a healthy loop produces (a busy
 * but well-behaved Node process sits in single-digit milliseconds), and far below the 15s at which
 * run-worker gives up — so the warning arrives while the stall is still a slowdown rather than an
 * outage, which is the whole reason to have it.
 */
const WARN_MAX_MS = Math.max(100, Number(process.env.LFB_LOOP_WARN_MS) || 1_000);

/**
 * INFO the window even when it is healthy, but only when the loop was doing enough to be interesting.
 * Below this the line is pure noise — an idle app blocks for nobody.
 */
const INFO_P99_MS = Math.max(10, Number(process.env.LFB_LOOP_INFO_P99_MS) || 100);

let histogram: IntervalHistogram | null = null;
let timer: NodeJS.Timeout | null = null;

/** Last window's readings, for the diagnostics surface. Null until the first window closes. */
export interface LoopDelaySample {
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  windowMs: number;
  at: string;
}
let last: LoopDelaySample | null = null;

/** The most recent closed window, or null before the first one. Read-only snapshot for the UI/API. */
export function lastLoopDelay(): LoopDelaySample | null {
  return last;
}

function ms(ns: number): number {
  return Math.round((ns / NS_PER_MS) * 10) / 10;
}

function closeWindow(): void {
  const h = histogram;
  if (!h) return;
  const sample: LoopDelaySample = {
    meanMs: ms(h.mean),
    p50Ms: ms(h.percentile(50)),
    p99Ms: ms(h.percentile(99)),
    maxMs: ms(h.max),
    windowMs: WINDOW_MS,
    at: new Date().toISOString(),
  };
  h.reset();
  // A histogram with no recordings answers `mean` as Infinity/NaN rather than 0 — never let that reach
  // the log as a fake stall.
  if (!Number.isFinite(sample.meanMs) || !Number.isFinite(sample.maxMs)) return;
  last = sample;

  if (sample.maxMs >= WARN_MAX_MS) {
    log.warn(
      "loop-watch",
      `EVENT LOOP BLOCKED: the single thread that answers every HTTP request, stream chunk and timer ` +
        `stopped for up to ${sample.maxMs}ms in the last ${Math.round(WINDOW_MS / 1000)}s ` +
        `(p99=${sample.p99Ms}ms, p50=${sample.p50Ms}ms, mean=${sample.meanMs}ms). This is what "the app ` +
        `hangs" means from the inside: the port keeps accepting connections because the kernel does that ` +
        `for us, while nothing gets answered. Look for synchronous work on a hot path — a whole-store ` +
        `JSON.parse/stringify, a readFileSync over a multi-megabyte file, or an unbounded loop over a ` +
        `pinset. See performance.mdx T3.`,
    );
    return;
  }
  if (sample.p99Ms >= INFO_P99_MS) {
    log.info(
      "loop-watch",
      `event loop: p99=${sample.p99Ms}ms p50=${sample.p50Ms}ms max=${sample.maxMs}ms ` +
        `mean=${sample.meanMs}ms over ${Math.round(WINDOW_MS / 1000)}s`,
    );
  }
}

/**
 * Start measuring event-loop delay. Idempotent. Both the histogram and the timer are unref'd, so this can
 * never be the reason a finished process stays alive (`just stop` must keep working).
 */
export function startLoopWatch(): void {
  if (timer) return;
  try {
    // resolution: 20ms — the sampling interval libuv uses internally. Finer buys precision we do not need
    // and costs wakeups; this is a stall detector, not a profiler.
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    return; // no perf_hooks histogram on this runtime — run without it rather than fail to boot
  }
  log.info(
    "loop-watch",
    `Event-loop watch armed: warn above ${WARN_MAX_MS}ms of blockage in any ` +
      `${Math.round(WINDOW_MS / 1000)}s window.`,
  );
  timer = setInterval(() => {
    try {
      closeWindow();
    } catch {
      // Instrumentation must never crash the app it is instrumenting.
    }
  }, WINDOW_MS);
  timer.unref?.();
}

export function stopLoopWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  try {
    histogram?.disable();
  } catch {
    // Already disabled / never enabled — nothing to undo.
  }
  histogram = null;
}
