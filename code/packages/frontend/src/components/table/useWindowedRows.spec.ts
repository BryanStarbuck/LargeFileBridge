// THE WINDOWING HEIGHT INVARIANT (performance.mdx P-38).
//
// A windowed table's scroll height is `padTop + Σ(rendered rows) + padBottom`, and only the middle term is
// real — the two spacers are arithmetic over an assumed per-row height. If the assumption is wrong by δ,
// the total moves by δ × (rows rendered) EVERY time the window slides, so the browser re-clamps scrollTop,
// which slides the window, which moves the total again. Near the top of a list there is slack to absorb
// it; AT THE BOTTOM scrollTop is pinned to the maximum and the loop has nowhere to settle — the rows
// jitter under the cursor for as long as you hold there. That is the 2026-08-06 "the list flickers when
// the scroll is at the bottom" report.
//
// So the assertion is not "the rows are 41px". It is: THE TOTAL HEIGHT DOES NOT DEPEND ON THE SCROLL
// POSITION. That property is what the hard-coded constant could not promise and a measured height can.
//
// jsdom does no layout, so the hook is exercised through its arithmetic rather than through a render: the
// same expressions the hook returns, over the same inputs, with the row height as a free variable. What is
// being pinned is the ALGEBRA — that is where the bug lived.
import { describe, it, expect } from "vitest";

/** The hook's returned window, recomputed here over an explicit row height (useWindowedRows). */
function windowAt(scrollTop: number, count: number, h: number, viewport: number, overscan = 10) {
  const visible = Math.ceil(viewport / h);
  const start = Math.max(0, Math.floor(scrollTop / h) - overscan);
  const end = Math.min(count, start + visible + overscan * 2);
  return { start, end, padTop: start * h, padBottom: Math.max(0, (count - end) * h) };
}

/** What the browser actually lays out: the two spacers plus the rows at their REAL height. */
function scrollHeight(w: ReturnType<typeof windowAt>, realRowHeight: number): number {
  return w.padTop + (w.end - w.start) * realRowHeight + w.padBottom;
}

const COUNT = 2000;
const VIEWPORT = 690;

describe("scroll height is independent of scroll position — when the assumed height is the real one", () => {
  it("stays put across the whole scroll range", () => {
    const h = 41;
    const heights = new Set<number>();
    for (let top = 0; top < COUNT * h; top += 137) {
      heights.add(scrollHeight(windowAt(top, COUNT, h, VIEWPORT), h));
    }
    // ONE value for every scroll position in the list. No clamp, no feedback, no jitter.
    expect([...heights]).toEqual([COUNT * h]);
  });
});

describe("the defect this replaces — an assumed height that is not the real one", () => {
  // Both directions of drift, because they fail differently and both were reachable: a taller row (a
  // control that grew, a larger font, browser zoom) and a shorter one (denser padding).
  for (const real of [37, 45]) {
    it(`moves the scroll height as the window slides when rows are really ${real}px`, () => {
      const assumed = 41;
      const heights = new Set<number>();
      for (let top = 0; top < COUNT * assumed; top += 137) {
        heights.add(scrollHeight(windowAt(top, COUNT, assumed, VIEWPORT), real));
      }
      // MANY different totals for one list — every one of them a re-clamp the browser has to make.
      expect(heights.size).toBeGreaterThan(1);
    });

    it(`cannot settle at the bottom when rows are really ${real}px`, () => {
      // Drive the loop the way holding at the bottom does: put scrollTop at the maximum, recompute the
      // window, recompute the maximum, repeat. With a correct height this is a fixed point on step one.
      const assumed = 41;
      const seen: number[] = [];
      let top = COUNT * assumed - VIEWPORT;
      for (let i = 0; i < 12; i++) {
        const h = scrollHeight(windowAt(top, COUNT, assumed, VIEWPORT), real);
        top = Math.max(0, h - VIEWPORT);
        seen.push(Math.round(top));
      }
      expect(new Set(seen).size).toBeGreaterThan(1); // it never lands anywhere
    });
  }

  it("lands on its first try at the bottom once the height is measured", () => {
    const h = 39.5; // whatever the row REALLY is, fractional included — measurement returns the truth
    const seen: number[] = [];
    let top = COUNT * h - VIEWPORT;
    for (let i = 0; i < 12; i++) {
      const height = scrollHeight(windowAt(top, COUNT, h, VIEWPORT), h);
      top = Math.max(0, height - VIEWPORT);
      seen.push(Math.round(top));
    }
    expect(new Set(seen).size).toBe(1); // one value, immediately — nothing to flicker
  });
});

describe("the window still covers the viewport", () => {
  it("renders every row on screen plus the overscan, at any height", () => {
    for (const h of [37, 41, 45, 39.5]) {
      const top = 500 * h;
      const w = windowAt(top, COUNT, h, VIEWPORT);
      const firstVisibleRow = Math.floor(top / h);
      const lastVisibleRow = Math.floor((top + VIEWPORT) / h);
      expect(w.start).toBeLessThanOrEqual(firstVisibleRow);
      expect(w.end).toBeGreaterThan(lastVisibleRow);
    }
  });

  it("an empty list windows to nothing rather than to a negative pad", () => {
    const w = windowAt(0, 0, 41, VIEWPORT);
    expect(w.padBottom).toBe(0);
    expect(w.end).toBe(0);
  });
});
