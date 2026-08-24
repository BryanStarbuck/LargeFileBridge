// blocking.ts — WHO blocked the event loop, not just THAT it was blocked.
//
// loop-watch.ts (P-39) closed the first half of this gap: it reports `EVENT LOOP BLOCKED … up to 7310ms`,
// which is the sentence the user experiences as "the pages just spin". What it cannot say is WHICH piece of
// code held the thread, because a libuv histogram measures delay, not identity. Every investigation of a
// stall therefore started from zero: attach a CPU profiler to a live backend, catch a stall in the window,
// and attribute samples by hand. That is a fine way to find a bug once and a terrible way to run a product.
//
// So: name the sections. `blocking(label, fn)` wraps a SYNCHRONOUS stretch, measures its wall time, and
//   * WARNs on its own when one stretch alone exceeds `LFB_BLOCK_WARN_MS` (default 250 ms), and
//   * accumulates per-label totals for the current loop-watch window, so the stall WARN can print the
//     ranked list of what ran during it.
//
// The second half is what actually answers the question. A 7-second window is rarely ONE 7-second call; it
// is 105 repos × 70 ms, or 400 sidecar merges, and no single-call threshold would ever have fired. Totals
// per window make that shape visible: "mirror 4,180ms over 105 calls" is a diagnosis, "something blocked
// for 7s" is not.
//
// CONTRACT (the same one heap-watch and loop-watch keep): Node builtins only, never throws into the code it
// measures, and cheap enough to leave on in production — one `performance.now()` pair and one Map lookup per
// section, which is nothing next to the milliseconds-to-seconds stretches it exists to find.
import { performance } from "node:perf_hooks";
import { log } from "./logging.js";

/** WARN when ONE synchronous section alone holds the loop this long. Well under the 1 s at which
 *  loop-watch fires, so a single bad call is named before the window that contains it is. */
const WARN_MS = Math.max(25, Number(process.env.LFB_BLOCK_WARN_MS) || 250);

/** How many distinct labels to name in the per-window ranking. Beyond this it is noise, not a diagnosis. */
const TOP_N = 6;

interface Tally {
  totalMs: number;
  calls: number;
  worstMs: number;
  worstDetail: string | undefined;
}

/** Per-label totals since the last `takeBlockingTally()`. Reset by loop-watch when it closes a window. */
let tally = new Map<string, Tally>();

/** Depth guard: nested sections would double-count their parent's time in the window totals. Only the
 *  OUTERMOST section contributes to the tally; inner ones still get their own single-call WARN. */
let depth = 0;

function record(label: string, ms: number, detail?: string): void {
  const t = tally.get(label) ?? { totalMs: 0, calls: 0, worstMs: 0, worstDetail: undefined };
  t.totalMs += ms;
  t.calls += 1;
  if (ms > t.worstMs) {
    t.worstMs = ms;
    t.worstDetail = detail;
  }
  tally.set(label, t);
}

/**
 * Run `fn` and account for the time it holds the event loop.
 *
 * `label` is the SECTION (a coarse noun — "storage.mirror", "http GET /api/repos"); `detail` names the
 * particular one (a repo path, a URL) and is carried only on the worst call, so the log line can say which
 * repo without one line per repo.
 *
 * Returns whatever `fn` returns, and rethrows whatever it throws, having accounted for the time either way.
 * It is deliberately NOT async: an `await` inside would end the synchronous stretch we are measuring, and
 * measuring a promise's lifetime tells you nothing about who held the thread.
 */
export function blocking<T>(label: string, fn: () => T, detail?: string): T {
  const started = performance.now();
  const outermost = depth === 0;
  depth += 1;
  try {
    return fn();
  } finally {
    depth -= 1;
    const ms = performance.now() - started;
    if (outermost) record(label, ms, detail);
    if (ms >= WARN_MS) {
      log.warn(
        "blocking",
        `${label} held the event loop for ${Math.round(ms)}ms${detail ? ` (${detail})` : ""} — nothing else ` +
          `was answered while it ran: no HTTP response, no stream chunk, no timer. See performance.mdx T3.`,
      );
    }
  }
}

/** Account for a stretch that was measured by the caller (an async pass that knows its own synchronous
 *  cost, or a section whose timing is already taken). Same tally, no wrapper. */
export function recordBlocking(label: string, ms: number, detail?: string): void {
  record(label, ms, detail);
  if (ms >= WARN_MS) {
    log.warn(
      "blocking",
      `${label} held the event loop for ${Math.round(ms)}ms${detail ? ` (${detail})` : ""} — nothing else ` +
        `was answered while it ran. See performance.mdx T3.`,
    );
  }
}

/**
 * Account for work that ran COOPERATIVELY — a walk drained in short slices with the event loop handed back
 * between them. `ms` is the total SYNCHRONOUS time it accumulated, which still belongs in the window's
 * ranking (it is real CPU the loop spent, and it still delays things), but it must NEVER warn: 1.4 s taken
 * in 8 ms slices did not block anything, and warning about it would teach a reader to ignore the WARNs
 * that mean something. The label is suffixed so the two are never confused in the report.
 */
export function recordCooperative(label: string, ms: number, detail?: string): void {
  record(`${label} (yielded)`, ms, detail);
}

/**
 * Take and CLEAR the window's tally, rendered as one ranked line — the thing loop-watch appends to its
 * stall WARN so the report names a culprit instead of a symptom. Empty string when nothing was measured,
 * which is itself the answer: the stall came from code no section wraps yet.
 */
export function takeBlockingTally(): string {
  if (tally.size === 0) return "";
  const rows = [...tally.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, TOP_N);
  tally = new Map();
  return rows
    .map(([label, t]) => {
      // The DETAIL is printed whenever we have one, including for a single call. It was originally omitted
      // in the one-call case as redundant with the total — and the first real stall this tool caught after
      // that reasoning was `storage.mirror 2457ms/1 call` with no repo name, i.e. the exact fact the reader
      // needed, withheld. A tally that can say WHICH must always say which.
      const worst = t.calls > 1 ? `, worst ${Math.round(t.worstMs)}ms` : "";
      const on = t.worstDetail ? ` on ${t.worstDetail}` : "";
      return `${label} ${Math.round(t.totalMs)}ms/${t.calls} call${t.calls === 1 ? "" : "s"}${worst}${on}`;
    })
    .join(" · ");
}

/** TEST-ONLY: forget the current window's tally. */
export function resetBlockingTally(): void {
  tally = new Map();
  depth = 0;
}
