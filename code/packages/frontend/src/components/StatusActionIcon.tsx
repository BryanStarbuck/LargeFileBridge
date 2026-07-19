// The shared status/action icon (tables.mdx icon-columns / task_tabs.mdx §5/§6). It is the ONE visual
// grammar every icon control column uses (Pin, Ignore, Transcribe, AI description, OCR), so the five read
// as one system. A finished action reads in its own UNIQUE "done" color (blue pin, orange ignore, indigo
// transcript, teal description, violet OCR).
//
// JUST THE ICON — NO ROUNDED RECTANGLE (product owner, 2026-07-19). Earlier this rendered a filled/bordered
// rounded-rectangle BOX with the glyph inside; the owner asked for the bare glyph like the V1 pin. So the
// state now lives in the GLYPH itself — its color, and (for the Pin) whether it is filled — with no box,
// border, background, or ring around it. THREE states:
//   • done — complete / toggle ON → the glyph drawn in its unique `doneColor`. Pin (fillWhenDone) is a SOLID
//            filled glyph; the others are a colored stroke (filling their inner detail would blot it out).
//   • could — an actionable candidate / toggle OFF-but-settable → a light-grey OUTLINE glyph (fill none).
//            Clicking it performs the action (queue / toggle on).
//   • na   — the task does not apply to this file → a faint-grey glyph, inert.
// The GLYPH SHAPE + the icon-header tell the columns apart; the unique color appears only when done.
// It is a CONTROL CELL: it stops click propagation and never navigates the row.
import { cloneElement, isValidElement, type ReactNode } from "react";
import type { TaskStatus } from "@lfb/shared";

const COULD_GLYPH = "#6b7280"; // grey outline for an actionable not-done icon (the "white / not-set" look)
const NA_GLYPH = "#d1d5db"; // faint grey, inert

export interface StatusActionIconProps {
  state: TaskStatus;
  glyph: ReactNode;
  /** The unique color for the "done" state (blue pin, orange ignore, …). For the three-state Pin the caller
   *  overrides this per-row (blue = pinned here, red = decided but not on this machine — one_repo.mdx §4.9). */
  doneColor: string;
  /** Pin only: draw the "done" glyph as a SOLID FILL (the dark-blue / red filled pin the owner described).
   *  The other kinds keep a colored stroke so their inner detail (slash, captions bars, …) stays legible. */
  fillWhenDone?: boolean;
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
  fillWhenDone = false,
  title,
  onActivate,
  disabled = false,
  size = 16,
  onMouseEnter,
  onMouseLeave,
}: StatusActionIconProps) {
  const inert = state === "na" || disabled;
  const color = state === "done" ? doneColor : state === "could" ? COULD_GLYPH : NA_GLYPH;
  const fill = state === "done" && fillWhenDone ? doneColor : "none";
  // Color the glyph in place — no surrounding box. cloneElement injects the per-state stroke color and fill
  // onto the lucide element the caller passed (its className still sets the size).
  const painted = isValidElement(glyph)
    ? cloneElement(glyph as React.ReactElement<{ color?: string; fill?: string }>, { color, fill })
    : glyph;

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
        style={{ width: size, height: size }}
        className={`inline-flex items-center justify-center bg-transparent border-0 p-0 ${inert ? "cursor-default" : "cursor-pointer"}`}
      >
        {painted}
      </button>
    </span>
  );
}
