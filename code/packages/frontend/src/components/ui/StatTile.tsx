// A metric tile for the dashboard-style rows (use_cases.mdx §3.5) — replaces run-on metric
// sentences. Big value, small label, optional sub, optional health tint + click-through. Tiles sit
// in a responsive flex-wrap row.
import { type ReactNode } from "react";
import { healthColor, type Health } from "./health.js";
import { cn } from "../../lib/cn.js";

export function StatTileRow({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex flex-wrap gap-3">{children}</div>;
}

export function StatTile({
  label,
  value,
  sub,
  state = "neutral",
  onClick,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  state?: Health;
  onClick?: () => void;
  title?: string;
}) {
  const tinted = state !== "neutral";
  const color = healthColor(state);
  // A clickable tile is a real <button>: it was a div with role="button" + tabIndex, so Enter/Space
  // did nothing and the whole row was keyboard-dead.
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        "min-w-[8.5rem] flex-1 rounded-lg border border-[var(--lfb-border)] bg-white px-4 py-3 text-left shadow-[var(--lfb-shadow-sm)]",
        onClick &&
          "cursor-pointer transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-[var(--lfb-border-strong)] hover:shadow-[var(--lfb-shadow-md)] active:translate-y-0",
      )}
    >
      <div className="lfb-eyebrow truncate">{label}</div>
      <div
        className="mt-1 text-2xl font-bold tabular-nums tracking-tight"
        style={{ color: tinted ? color : "#000" }}
      >
        {value}
      </div>
      {sub != null && <div className="mt-0.5 text-xs text-black/50">{sub}</div>}
    </Tag>
  );
}
