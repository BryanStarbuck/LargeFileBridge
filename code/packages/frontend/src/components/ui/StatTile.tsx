// A metric tile for the dashboard-style rows (use_cases.mdx §3.5) — replaces run-on metric
// sentences. Big value, small label, optional sub, optional health tint + click-through. Tiles sit
// in a responsive flex-wrap row.
import { type ReactNode } from "react";
import { healthColor, type Health } from "./health.js";

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
  const base =
    "min-w-[8.5rem] flex-1 rounded-lg border border-[var(--lfb-border)] bg-white px-4 py-3 text-left";
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      title={title}
      className={`${base} ${onClick ? "cursor-pointer hover:border-[var(--lfb-primary)]" : ""}`}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-black/40">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums" style={{ color: tinted ? color : "#000" }}>
        {value}
      </div>
      {sub != null && <div className="mt-0.5 text-xs text-black/50">{sub}</div>}
    </div>
  );
}
