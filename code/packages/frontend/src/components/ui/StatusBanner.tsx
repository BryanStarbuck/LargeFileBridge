// The page verdict row (use_cases.mdx §2 rows 1–2, §3.2). One plain-English line in the health
// language + at most one primary "fix" action. Fixed states stay quiet; Broken states are
// unmistakable. This is the first thing on every page (except Home) — the answer to "am I OK?".
import { type ReactNode } from "react";
import { healthColor, healthBg, healthIcon, type Health } from "./health.js";

export function StatusBanner({
  state,
  headline,
  sub,
  action,
  secondary,
}: {
  state: Health;
  headline: ReactNode;
  sub?: ReactNode; // one sentence: "what this means for you"
  action?: ReactNode; // the ONE primary fix (at most one per screen)
  secondary?: ReactNode; // an optional small link
}) {
  const Icon = healthIcon(state);
  const color = healthColor(state);
  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-lg border px-4 py-3"
      style={{ background: healthBg(state), borderColor: state === "neutral" ? "var(--lfb-border)" : color }}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" style={{ color }} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-black">{headline}</div>
        {sub && <div className="mt-0.5 text-sm text-black/60">{sub}</div>}
      </div>
      {(action || secondary) && (
        <div className="flex shrink-0 items-center gap-2">
          {secondary}
          {action}
        </div>
      )}
    </div>
  );
}

// The one primary fix button, styled by severity (red for a broken fix, brand blue otherwise).
export function FixButton({
  state = "bad",
  onClick,
  disabled,
  children,
}: {
  state?: Health;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const bg = state === "bad" ? "var(--lfb-bad)" : "var(--lfb-primary)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      style={{ background: bg }}
    >
      {children}
    </button>
  );
}
