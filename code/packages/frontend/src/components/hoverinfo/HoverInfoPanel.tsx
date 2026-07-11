// The non-intrusive hover-info panel (non_intrusive_tooltip.mdx §1/§3). Pinned to the bottom of the left
// bar, directly above the account slot, in a FIXED block of always-white space (~two nav-item rows tall).
// It reads the single active hover payload and renders its blocks top-to-bottom. FIT-OR-DROP: the panel has
// a fixed height and shows only what fits — a block that would overflow (and every block after it) is
// hidden. It never scrolls and never grows, so the account slot never moves. Blank white at rest.
import { useLayoutEffect, useRef } from "react";
import { useHoverInfo, type HoverInfoBlock } from "./HoverInfoContext.js";

// ~two Sidebar nav-item rows (each ~36px tall with its my-0.5 margins) — the reserved white block height.
const PANEL_H = 88;

export function HoverInfoPanel() {
  const info = useHoverInfo();
  const containerRef = useRef<HTMLDivElement>(null);
  const blocks = info?.blocks ?? [];

  // Fit-or-drop (§3.3): walk the rendered blocks top-to-bottom; once one would exceed the reserved height,
  // it and every block after it are hidden. visibility:hidden keeps each box's measured size, so re-fitting
  // on the next payload stays correct. Runs every render (cheap — a handful of children) so it re-fits when
  // the payload changes. overflow-hidden on the container is the belt-and-braces clip.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const max = container.clientHeight;
    let acc = 0;
    let dropping = false;
    for (const child of Array.from(container.children) as HTMLElement[]) {
      if (!dropping) {
        const h = child.offsetHeight;
        if (acc + h > max) dropping = true;
        else acc += h;
      }
      child.style.visibility = dropping ? "hidden" : "visible";
    }
  });

  return (
    <div
      ref={containerRef}
      className="overflow-hidden bg-white px-3 py-1.5"
      style={{ height: PANEL_H }}
      aria-live="polite"
    >
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}

function Block({ block }: { block: HoverInfoBlock }) {
  if (block.kind === "detail") {
    return (
      <div className="py-0.5">
        <div className="truncate text-xs font-semibold text-black/80">{block.title}</div>
        {block.lines.slice(0, 3).map((line, i) => (
          <div key={i} className="truncate text-[11px] leading-snug text-black/55">
            {line}
          </div>
        ))}
      </div>
    );
  }
  // code-key block — the exact chip from the list + bold name + optional muted one-liner.
  const { chip, name, line } = block;
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-[10px] font-bold leading-none select-none"
        style={{
          backgroundColor: chip.bg,
          color: chip.ink,
          border: chip.border ? `1px solid ${chip.border}` : undefined,
        }}
      >
        {chip.letter}
      </span>
      <span className="min-w-0 truncate text-xs text-black/70">
        <span className="font-semibold text-black/80">{name}</span>
        {line && <span className="text-black/55"> — {line}</span>}
      </span>
    </div>
  );
}
