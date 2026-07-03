// Row windowing without a dependency (performance.mdx P-01). Given a total row count, a fixed row
// height, and a scroll container, it returns the slice of rows that intersect the viewport (plus a
// little overscan) and the top/bottom padding needed to keep the scrollbar honest. The caller renders
// only rows [start, end) inside a bounded-height scroll container, with two spacer <tr>s (padTop /
// padBottom) so a 5000-row table costs ~30 DOM rows instead of 5000.
import { useEffect, useState, type RefObject } from "react";

export interface RowWindow {
  start: number;
  end: number; // exclusive
  padTop: number;
  padBottom: number;
}

export function useWindowedRows(
  count: number,
  rowHeight: number,
  containerRef: RefObject<HTMLElement>,
  overscan = 10,
): RowWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const measure = () => setViewport(el.clientHeight);
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
    // Re-attach when the container node identity changes (e.g. table mounts after loading).
  }, [containerRef, count]);

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
