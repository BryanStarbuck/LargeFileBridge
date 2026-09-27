// A time-sliced loop must let queued work run within about one slice, however much each item costs
// (performance.mdx P-62) — the property a count of items never guaranteed.
import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { timeSlicer } from "./time-slice.js";

const spin = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* a synchronous item: a stat, a glob match */
  }
};

describe("timeSlicer", () => {
  it("answers a queued callback within a slice, not after the whole loop", async () => {
    const began = performance.now();
    let answeredAfter = -1;
    setImmediate(() => (answeredAfter = performance.now() - began)); // a request arriving now
    const slicer = timeSlicer(8);
    for (let i = 0; i < 300; i++) {
      const y = slicer.maybeYield();
      if (y) await y;
      spin(1); // 300 items × 1 ms: a count of 400 would never have yielded at all
    }
    expect(answeredAfter).toBeGreaterThanOrEqual(0);
    expect(answeredAfter).toBeLessThan(60);
  });

  it("costs nothing while the slice lasts — no promise, no yield", () => {
    const slicer = timeSlicer(1_000);
    for (let i = 0; i < 1000; i++) expect(slicer.maybeYield()).toBeUndefined();
  });
});
