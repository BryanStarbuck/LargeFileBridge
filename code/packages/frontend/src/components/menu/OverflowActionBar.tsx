// A full-width action bar that shows as many action buttons as FIT and folds the rest into a trailing
// "More" menu (media_viewer.mdx §4.1). Each item carries a PRIORITY: when the row is too narrow, the
// LOWEST-priority items overflow first, so the most important actions stay as buttons the longest. The
// same "More" menu also always holds a set of EXTRAS (flags, danger actions) that are never buttons.
//
// Measurement is done off-screen: a hidden mirror row renders every item at its natural width, and a
// ResizeObserver on the container tells us how much room we have. That avoids layout thrash and works
// no matter how wide the page is (the media viewer runs full-bleed, so this bar can be very wide).
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { MenuPortal, MenuList, type Action, type MenuPos } from "./EntityMenu";
import { clientLog } from "../../lib/clientLog.js";

export interface BarItem {
  key: string;
  priority: number; // higher = kept as a button longer; the lowest overflows into "More" first
  bar: ReactNode; // the inline button/compound rendered in the bar
  menu: Action[]; // how this item appears in the More menu when it overflows (1+ entries)
}

const GAP = 8; // matches the flex gap-2
const MORE_RESERVE = 108; // room kept for the trailing "More" button (always present)

/** Greedily keep items (in display order) until the row would overflow; drop lowest-priority first. */
function fit(items: BarItem[], widths: number[], avail: number): { visible: BarItem[]; overflow: BarItem[] } {
  if (!avail || widths.length !== items.length) return { visible: items, overflow: [] };
  const kept = items.map((it, i) => ({ it, w: widths[i], i }));
  const dropped: typeof kept = [];
  const total = () => kept.reduce((s, x) => s + x.w + GAP, 0);
  while (kept.length && total() + MORE_RESERVE > avail) {
    let idx = 0;
    for (let j = 1; j < kept.length; j++) {
      // lowest priority wins; on a tie, drop the one later in display order
      if (kept[j].it.priority <= kept[idx].it.priority) idx = j;
    }
    dropped.push(kept[idx]);
    kept.splice(idx, 1);
  }
  return {
    visible: kept.sort((a, b) => a.i - b.i).map((x) => x.it),
    overflow: dropped.sort((a, b) => a.i - b.i).map((x) => x.it),
  };
}

export function OverflowActionBar({ items, extras }: { items: BarItem[]; extras: Action[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  const [widths, setWidths] = useState<number[]>([]);

  // Re-measure each mirrored child whenever the item set changes.
  useLayoutEffect(() => {
    const row = measureRef.current;
    if (!row) return;
    setWidths(Array.from(row.children).map((c) => (c as HTMLElement).getBoundingClientRect().width));
  }, [items]);

  // Track the container's available width.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { visible, overflow } = useMemo(() => fit(items, widths, avail), [items, widths, avail]);
  const moreActions = useMemo(() => [...overflow.flatMap((o) => o.menu), ...extras], [overflow, extras]);

  return (
    <div ref={containerRef} className="relative mt-3 flex w-full items-center gap-2">
      {/* Hidden mirror row — every item at its natural width, for measurement only. */}
      <div ref={measureRef} aria-hidden className="pointer-events-none absolute -left-[9999px] -top-[9999px] flex gap-2 opacity-0">
        {items.map((it) => (
          <div key={it.key}>{it.bar}</div>
        ))}
      </div>

      {visible.map((it) => (
        <Fragment key={it.key}>{it.bar}</Fragment>
      ))}

      {moreActions.length > 0 && <MoreButton actions={moreActions} />}
    </div>
  );
}

function MoreButton({ actions }: { actions: Action[] }) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const run = (fn: () => void | Promise<void>) => async () => {
    setPos(null);
    try {
      await fn();
    } catch (e) {
      clientLog.error("OverflowActionBar.action", e);
    }
  };
  return (
    <>
      <button
        aria-haspopup="menu"
        title="More actions"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.right - 4, y: r.bottom + 4 });
        }}
        className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/70 hover:bg-slate-100"
      >
        <MoreHorizontal className="h-4 w-4" /> More
      </button>
      {pos && (
        <MenuPortal pos={pos} onClose={() => setPos(null)}>
          <MenuList actions={actions} run={run} />
        </MenuPortal>
      )}
    </>
  );
}
