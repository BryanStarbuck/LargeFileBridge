// A lightweight hover/focus tooltip (tables.mdx — code-badge legend on hover). No dependency: it renders
// the floating label into a document.body PORTAL with position:fixed, so it is NEVER clipped by a table
// cell's or scroll region's `overflow:hidden` (the reason a plain absolutely-positioned tooltip fails
// inside our TanStack tables). Positioned from the trigger's bounding rect on open, re-hidden on scroll.
//
// Accessible: shows on mouseenter AND keyboard focus, hides on mouseleave/blur/Escape/scroll. The trigger
// keeps a native `title` fallback OFF (we render our own) so there is never a double tooltip.
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Coords = { top: number; left: number };

/** Where the bubble sits relative to the trigger. Default "top" (centered above). */
type Placement = "top" | "bottom";

export function Tooltip({
  content,
  placement = "top",
  children,
  className,
}: {
  content: ReactNode; // the phrase shown on hover — keep it short (a name + one line)
  placement?: Placement;
  children: ReactNode; // the trigger (a badge, an icon…)
  className?: string; // extra classes on the inline-flex trigger wrapper
}) {
  const [coords, setCoords] = useState<Coords | null>(null);
  const ref = useRef<HTMLSpanElement | null>(null);
  const id = useId();

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const GAP = 6;
    setCoords({
      left: r.left + r.width / 2,
      top: placement === "top" ? r.top - GAP : r.bottom + GAP,
    });
  }, [placement]);

  const hide = useCallback(() => setCoords(null), []);

  return (
    <span
      ref={ref}
      className={`inline-flex ${className ?? ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === "Escape") hide();
      }}
      // The trigger describes itself so screen-reader + keyboard users reach the same phrase.
      aria-describedby={coords ? id : undefined}
    >
      {children}
      {coords &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            style={{
              position: "fixed",
              left: coords.left,
              top: coords.top,
              transform: placement === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
            }}
            className="pointer-events-none z-[1000] max-w-[16rem] rounded-md bg-black/90 px-2 py-1 text-xs leading-snug text-white shadow-lg"
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}
