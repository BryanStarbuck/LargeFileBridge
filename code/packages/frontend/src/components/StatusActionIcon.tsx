// The shared status/action icon (tables.mdx icon-columns / task_tabs.mdx §5/§6). It is the ONE visual
// grammar every icon control column uses (Pin, Ignore, Transcribe, AI description, OCR), so the five read
// as one system. A finished action reads in its own UNIQUE "done" color (blue pin, orange ignore, indigo
// transcript, teal description, violet OCR). THREE states:
//   • done — the action is complete / the toggle is ON → solid `doneColor` fill, WHITE glyph, and a subtle
//            inner white ring (the "white outline" the product owner asked for on a filled icon).
//   • could — an actionable candidate / the toggle is OFF-but-settable → WHITE background, a LIGHT-GREY
//             outline and a darker-grey "pen" glyph. Clicking it performs the action (queue / toggle on).
//   • na   — the task does not apply to this file → white fill, a very-thin very-light-grey edge, a faint
//            grey glyph; inert.
// The product owner's rule: the UNIQUE color appears ONLY when done — a not-done icon is uniformly grey
// (light-grey outline + pen glyph on white), and the GLYPH SHAPE + the icon-header tell the columns apart.
// It is a CONTROL CELL: it stops click propagation and never navigates the row.
import type { ReactNode } from "react";
import type { TaskStatus } from "@lfb/shared";

const COULD_EDGE = "#d1d5db"; // light-grey outline for an actionable not-done icon
const COULD_GLYPH = "#4b5563"; // the darker-grey "pen" glyph for an actionable not-done icon
const NA_EDGE = "#e5e7eb"; // very-thin very-light-grey hairline (inert)
const NA_GLYPH = "#d1d5db";
const DONE_RING = "inset 0 0 0 1.5px rgba(255,255,255,0.9)"; // the white outline on a filled icon

export interface StatusActionIconProps {
  state: TaskStatus;
  glyph: ReactNode;
  /** The solid fill for the "done" state (blue for transcribe, green for compress). */
  doneColor: string;
  title: string;
  /** Fired on click for the actionable ("could") and completed ("done") states; "na" is inert. */
  onActivate?: () => void;
  disabled?: boolean;
  size?: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function StatusActionIcon({
  state,
  glyph,
  doneColor,
  title,
  onActivate,
  disabled = false,
  size = 16,
  onMouseEnter,
  onMouseLeave,
}: StatusActionIconProps) {
  const box: React.CSSProperties =
    state === "done"
      ? { background: doneColor, border: "none", color: "#fff", boxShadow: DONE_RING }
      : state === "could"
        ? { background: "#fff", border: `1px solid ${COULD_EDGE}`, color: COULD_GLYPH }
        : { background: "#fff", border: `1px solid ${NA_EDGE}`, color: NA_GLYPH };

  const inert = state === "na" || disabled;

  return (
    <span
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="inline-flex"
    >
      <button
        type="button"
        title={title}
        aria-label={title}
        disabled={inert}
        onClick={() => {
          if (!inert) onActivate?.();
        }}
        style={{ width: size, height: size, ...box }}
        className={`inline-flex items-center justify-center rounded-[3px] ${inert ? "cursor-default" : "cursor-pointer"}`}
      >
        {glyph}
      </button>
    </span>
  );
}
