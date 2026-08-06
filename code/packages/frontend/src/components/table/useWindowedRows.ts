// Row windowing without a dependency (performance.mdx P-01). Given a total row count, a scroll container,
// and a fallback row height, it returns the slice of rows that intersect the viewport (plus a little
// overscan) and the top/bottom padding needed to keep the scrollbar honest. The caller renders only rows
// [start, end) inside a bounded-height scroll container, with two spacer <tr>s (padTop / padBottom) so a
// 5000-row table costs ~30 DOM rows instead of 5000.
//
// THE INVARIANT (performance.mdx P-38): the container's scrollHeight must NOT depend on the scroll
// position. Total height is `padTop + Σ(rendered row heights) + padBottom`, and only the middle term is
// real; the two spacers are computed from an assumed per-row height. When the assumption is wrong by δ,
// the total moves by δ × (rows rendered) EVERY time the window slides — so the browser re-clamps
// scrollTop, which moves the window, which moves the height again. At the top of a long list there is
// slack to absorb it; AT THE BOTTOM scrollTop is pinned to the maximum, so the loop has nowhere to settle
// and the rows visibly jitter under the cursor. That was the 2026-08-06 "the list flickers when the
// scroll is at the bottom" report, and the cause was a hard-coded ROW_H that no longer matched the CSS.
//
// So the height is MEASURED from a real rendered row instead of assumed. When it matches (it does, by
// construction, because it came off the DOM) the spacers and the rows agree, the total collapses to
// `count × height` regardless of `start`, and the feedback loop cannot form. The caller's `rowHeight`
// argument survives only as the first-paint estimate, used before any row exists to measure.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface RowWindow {
  start: number;
  end: number; // exclusive
  padTop: number;
  padBottom: number;
  /**
   * Attach to ANY rendered body row (the caller uses the first). Measuring one row is enough: the rows are
   * uniform by design — a fixed `height` and single-line, truncating cells — and a list whose rows genuinely
   * varied could not be windowed by this arithmetic at all.
   */
  measureRow: (el: HTMLElement | null) => void;
}

/** Below this the measurement is noise (sub-pixel layout, a fractional zoom) and re-rendering for it costs
 *  more than the accuracy is worth. */
const HEIGHT_EPSILON = 0.5;

export function useWindowedRows(
  count: number,
  rowHeight: number,
  containerRef: RefObject<HTMLElement | null>,
  overscan = 10,
): RowWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [measured, setMeasured] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const rowObserver = useRef<ResizeObserver | null>(null);

  // The row height in force. Once a row has been measured it is the truth; `rowHeight` is only the
  // estimate that gets the first slice on screen before one exists.
  const h = measured ?? rowHeight;

  const measureRow = useCallback((el: HTMLElement | null) => {
    rowObserver.current?.disconnect();
    rowObserver.current = null;
    if (!el) return;
    const apply = () => {
      const next = el.getBoundingClientRect().height;
      // A row can measure 0 while the table is display:none (a hidden tab) — that is not a height, and
      // adopting it would divide the whole window calculation by zero.
      if (next <= 0) return;
      setMeasured((prev) => (prev !== null && Math.abs(prev - next) < HEIGHT_EPSILON ? prev : next));
    };
    apply();
    // Re-measure when the row itself changes size — a density/zoom change, a font that finished loading,
    // a column shown or hidden by the responsive budget.
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    rowObserver.current = ro;
  }, []);

  useEffect(() => () => rowObserver.current?.disconnect(), []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Coalesce scroll updates to at most one per animation frame, and only re-render when the derived
    // start row actually changes — a fast scroll fires many events per frame, and most deltas stay
    // within a single row (performance.mdx P-18). setScrollTop's functional updater bails out (returns
    // the same reference) when the start index is unchanged, so React skips the re-render entirely.
    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const next = el.scrollTop;
        setScrollTop((prev) => (Math.floor(prev / h) === Math.floor(next / h) ? prev : next));
      });
    };
    const measure = () => setViewport(el.clientHeight);
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // Re-attach when the container node identity changes (e.g. table mounts after loading).
  }, [containerRef, count, h]);

  if (count === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, measureRow };

  // Before the container is measured, render a first slice so content shows immediately.
  const effectiveViewport = viewport || h * (overscan * 3);
  const visible = Math.ceil(effectiveViewport / h);
  const start = Math.max(0, Math.floor(scrollTop / h) - overscan);
  const end = Math.min(count, start + visible + overscan * 2);
  return {
    start,
    end,
    padTop: start * h,
    padBottom: Math.max(0, (count - end) * h),
    measureRow,
  };
}
