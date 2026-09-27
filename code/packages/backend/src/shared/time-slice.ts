// TIME-SLICED YIELDING — hand the event loop back by ELAPSED TIME, never by a count of items.
//
// Every cooperative loop in this codebase used to yield "every N entries" (400 in the scanner walk, 200 in
// fs.service). A count bounds the stretch only if every item costs the same, and they do not: one entry is a
// synchronous `stat` plus gitignore and exclude-glob matching, which is microseconds on a small repo and a
// millisecond or more on a big one with many rules or a cloud mount. A live CPU profile of the backend during
// a forced scan (2026-09-27, performance.mdx P-62) put the scanner's `walkUnit` behind every remaining
// 1-second loop stall — 400 "cheap" entries at a time.
//
// A slice is measured, so the stretch is bounded whatever an item costs. And the yield is `setImmediate`
// (the check phase), NOT a resolved promise: `await` on an already-resolved promise only queues a microtask,
// which drains before the loop advances — a loop of synchronous-fast-path `await`s blocks exactly as hard as
// no await at all.
import { performance } from "node:perf_hooks";

/** Default slice: about half a 60 Hz frame — a request queued behind it waits a few milliseconds. */
export const DEFAULT_SLICE_MS = Math.max(1, Number(process.env.LFB_WALK_SLICE_MS) || 8);

export interface Yielder {
  /** Yield to the event loop if this slice is used up; otherwise return at once (no allocation). */
  maybeYield(): Promise<void> | void;
}

/** A per-loop yielder. Call `maybeYield()` once per item; `await` it only when it returns a promise. */
export function timeSlicer(sliceMs: number = DEFAULT_SLICE_MS): Yielder {
  let sliceStart = performance.now();
  return {
    maybeYield() {
      if (performance.now() - sliceStart < sliceMs) return;
      return new Promise<void>((resolve) =>
        setImmediate(() => {
          sliceStart = performance.now();
          resolve();
        }),
      );
    },
  };
}
