// The shared three-state status/action icon (task_tabs.mdx §5/§6). It echoes the decision-toggle box
// grammar (decision_toggles.mdx §1) but is a STATUS indicator, not a two-axis decision, so a finished
// action reads in its own "done" color (blue for a transcript, green for a compression) and there are
// only THREE states:
//   • done — the action is complete → solid `doneColor` fill, white glyph.
//   • could — an actionable candidate → medium-orange normal-thickness edge, a 99%-white / 1%-orange
//             fill (a barely-there orange wash), orange glyph. Clicking it queues the action.
//   • na   — the task does not apply to this file kind → white fill, a very-thin very-light-grey edge,
//             a faint grey glyph; inert.
// It is a CONTROL CELL: it stops click propagation and never navigates the row.
import type { ReactNode } from "react";
import type { TaskStatus } from "@lfb/shared";

const ORANGE = "#c2410c"; // --lfb-decision-on (the "actionable" orange used by the decision toggles)
const COULD_FILL = "rgba(194,65,12,0.04)"; // ~99% white / 1% orange
const NA_EDGE = "#e5e7eb"; // very-light-grey hairline
const NA_GLYPH = "#d1d5db";

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
      ? { background: doneColor, border: "none", color: "#fff" }
      : state === "could"
        ? { background: COULD_FILL, border: `1px solid ${ORANGE}`, color: ORANGE }
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
