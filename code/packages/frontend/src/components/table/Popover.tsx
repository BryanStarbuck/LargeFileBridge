// The control-row pop-up window shared by the Filter ⛛ / Sort / Columns dropdowns (tables.mdx §2–§3;
// product owner, 2026-07-21): a 1-pixel near-white light-gray edge line so the window's bounds are
// visible, click-anywhere-outside collapses it (changes are already applied live), and an optional
// Apply footer button that collapses it explicitly. Used by DataTable and the Full-paths page.
import { useEffect, useRef, type ReactNode } from "react";

export function Popover({
  children,
  wide,
  onClose,
  showApply,
}: {
  children: ReactNode;
  /** The §2.11 file-filter dropdown goes two columns wide instead of taller (tables.mdx §2.11.3). */
  wide?: boolean;
  /** Collapse the pop-up. Wired to clicks outside the window (and to Apply, when shown). */
  onClose?: () => void;
  /** Render the Apply footer button (the Filter window) — it simply collapses the pop-up. */
  showApply?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Click-outside collapses the window. Clicks on a [data-popover-toggle] element (the ⛛ / sort /
  // columns icon buttons) are ignored — their own onClick owns the toggle, and closing here first
  // would make the icon reopen the window it just closed.
  useEffect(() => {
    if (!onClose) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!panelRef.current || !t) return;
      if (panelRef.current.contains(t) || t.closest("[data-popover-toggle]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  return (
    <div className="relative">
      <div
        ref={panelRef}
        // max-h + its own scroll: the panel is absolutely positioned IN FLOW, so on a viewport-anchored
        // page (duplicates.mdx §3.0a) a dropdown taller than the space beneath it would be clipped by the
        // shell with no page scroll left to reveal it. Bounded here, the window scrolls inside itself and
        // stays fully reachable on any screen height; overscroll-contain keeps that from moving the page.
        className={`absolute right-0 z-10 mt-1 max-h-[70vh] overflow-y-auto overscroll-contain ${wide ? "w-[36rem] max-w-[90vw]" : "w-72"} lfb-popover py-1`}
      >
        {children}
        {showApply && onClose && (
          <div className="flex justify-end border-t border-[var(--lfb-border)] px-3 pb-1.5 pt-1.5">
            <button
              className="lfb-btn lfb-btn-primary lfb-btn-lg"
              onClick={onClose}
            >
              Apply
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
