// Row windowing without a dependency (performance.mdx P-01). Given a total row count, a fixed row
// height, and a scroll container, it returns the slice of rows that intersect the viewport (plus a
// little overscan) and the top/bottom padding needed to keep the scrollbar honest. The caller renders
// only rows [start, end) inside a bounded-height scroll container, with two spacer <tr>s (padTop /
// padBottom) so a 5000-row table costs ~30 DOM rows instead of 5000.
import { useEffect, useRef, useState, type RefObject } from "react";

export interface RowWindow {
  start: number;
  end: number; // exclusive
  padTop: number;
  padBottom: number;
}

export function useWindowedRows(
  count: number,
  rowHeight: number,
  containerRef: RefObject<HTMLElement | null>,
  overscan = 10,
): RowWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const rafRef = useRef<number | null>(null);

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
        setScrollTop((prev) =>
          Math.floor(prev / rowHeight) === Math.floor(next / rowHeight) ? prev : next,
        );
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
  }, [containerRef, count, rowHeight]);

  if (count === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  // Before the container is measured, render a first slice so content shows immediately.
  const effectiveViewport = viewport || rowHeight * (overscan * 3);
  const visible = Math.ceil(effectiveViewport / rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, start + visible + overscan * 2);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (count - end) * rowHeight),
  };
}
