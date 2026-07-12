// The two-axis inline decision toggles (decision_toggles.mdx): an Add-to-IPFS (pin) checkbox and an
// Add-to-git-ignore (⊘) checkbox, side by side. ONE visual grammar, FOUR render states:
//   off         — white fill, thin medium-grey edge
//   on          — solid medium-dark-orange fill, no edge, white glyph
//   recommended — white fill, DASHED orange edge (a calc-engine suggestion, still Undecided)
//   na          — not rendered (a blank, width-reserved slot so columns stay aligned)
// Presentational only: a click calls onToggle; the caller writes the single axis (setFileDecisions).
import type { ReactNode } from "react";
import { Pin, CircleSlash } from "lucide-react";

export type ToggleState = "off" | "on" | "recommended" | "na";

const ORANGE = "#c2410c"; // --lfb-decision-on
const GREY = "#9ca3af"; // --lfb-toggle-off-edge

function boxStyle(state: ToggleState): React.CSSProperties {
  switch (state) {
    case "on":
      return { background: ORANGE, border: "none", color: "#fff" };
    case "recommended":
      return { background: "#fff", border: `1px dashed ${ORANGE}`, color: ORANGE };
    case "off":
    default:
      return { background: "#fff", border: `1px solid ${GREY}`, color: GREY };
  }
}

function DecisionToggle({
  state,
  glyph,
  title,
  disabled,
  onToggle,
}: {
  state: ToggleState;
  glyph: ReactNode;
  title: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  // N/A → a blank 16px spacer so the pair keeps a fixed footprint on every row (decision_toggles.mdx §1.1).
  if (state === "na") return <span aria-hidden className="inline-block h-4 w-4 shrink-0" />;
  return (
    <button
      type="button"
      title={title}
      aria-pressed={state === "on"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation(); // control cell — never navigate the row (decision_toggles.mdx §1.2)
        if (!disabled) onToggle();
      }}
      className="inline-grid h-4 w-4 shrink-0 place-items-center rounded-[3px] p-0 disabled:opacity-40"
      style={boxStyle(state)}
    >
      {glyph}
    </button>
  );
}

/** The pin + git-ignore pair for one file row. Pass "na" for an axis that doesn't apply here (the
 *  git-ignore axis is repo-scoped — pass "na" when the file is not under a repo). */
export function DecisionToggles({
  ipfs,
  gitignore,
  disabled,
  onIpfs,
  onGitignore,
}: {
  ipfs: ToggleState;
  gitignore: ToggleState;
  disabled?: boolean;
  onIpfs: () => void;
  onGitignore: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <DecisionToggle
        state={ipfs}
        title="Add to IPFS (pin)"
        disabled={disabled}
        onToggle={onIpfs}
        glyph={<Pin className="h-2.5 w-2.5" strokeWidth={2.5} />}
      />
      <DecisionToggle
        state={gitignore}
        title="Add to git ignore"
        disabled={disabled}
        onToggle={onGitignore}
        glyph={<CircleSlash className="h-2.5 w-2.5" strokeWidth={2.5} />}
      />
    </span>
  );
}

export { DecisionToggle };
