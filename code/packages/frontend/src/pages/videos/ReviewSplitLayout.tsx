// The shared 60/40 review layout (videos.mdx §3, LOCKED): both Videos children render a house table on
// the LEFT 60% of the content width and a reserved RIGHT review column on the remaining 40%. The right
// column is its OWN overflow-y scroll region — a group with many members scrolls through while the table
// stays put. The table slot is a full-height flex column so the DataTable's body scrolls inside it with
// the count/pagination footer pinned (charter table rule).
//
// The `controls` slot is the table's control row (search + ⇅ + ⛛ + ⚏), hoisted OUT of the table and
// rendered FULL WIDTH above the split (duplicates.mdx §3, revised 2026-07-22). The bar governs the whole
// page, so it spans the whole page; the right review column starts BENEATH it, never beside it.
import type { ReactNode } from "react";

export function ReviewSplitLayout({
  controls,
  table,
  review,
}: {
  /** Full-width slot above the split — the DataTable portals its control row in here. */
  controls?: ReactNode;
  table: ReactNode;
  review: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {controls && <div className="shrink-0">{controls}</div>}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Table slot — 60% of the content width (flex 3:2 = 60/40 of the area right of the left bar). */}
        <div className="flex min-h-0 min-w-0 flex-[3] flex-col">{table}</div>
        {/* Right review column — 40%, independently scrolling (its child owns the overflow-y region). */}
        <div className="flex min-h-0 min-w-0 flex-[2] flex-col border-l border-[var(--lfb-border)] pl-4">
          {review}
        </div>
      </div>
    </div>
  );
}
