// The metrics-panel strip (task_tabs.mdx §2) — the "what could be done" boxes for the active tab, with
// the hover-info region to their right (§3). Each panel is a TERSE label + number + right chevron:
//   • count 0  → a light-green rounded rectangle with a big 0 (the all-clear state).
//   • count >0 → health-tinted (red = at risk / owed, amber = action needed).
// The chevron opens that metric's action (the parent wires it — the metric's warning popup / the tab it
// belongs to). Hovering a panel publishes its hint to the docked HoverInfoRegion.
import { ChevronRight } from "lucide-react";
import { healthBg, healthColor, type Health } from "../../components/ui/health.js";
import { HoverInfoRegion, setHoverInfo } from "./HoverInfoRegion.js";
import type { MetricId } from "./metricWarnings.js";

export interface MetricView {
  id: MetricId;
  label: string;
  count: number;
  hint: string;
  /** Tint when count > 0. At 0 the panel is always the light-green all-clear state. */
  positive: Health;
  /** Fired by the panel's right chevron (and a click on the panel body). */
  onOpen: () => void;
}

function MetricPanel({ m }: { m: MetricView }) {
  const clear = m.count === 0;
  const style: React.CSSProperties = clear
    ? { background: "var(--lfb-ok-bg)", color: "var(--lfb-ok)", borderColor: "transparent" }
    : { background: healthBg(m.positive), color: healthColor(m.positive), borderColor: "var(--lfb-border)" };
  return (
    <button
      type="button"
      onClick={m.onOpen}
      onMouseEnter={() => setHoverInfo(m.hint)}
      onMouseLeave={() => setHoverInfo(null)}
      onFocus={() => setHoverInfo(m.hint)}
      onBlur={() => setHoverInfo(null)}
      style={style}
      className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left"
      aria-label={`${m.label}: ${m.count}. Open.`}
    >
      <span className="text-xs uppercase tracking-wide opacity-80">{m.label}</span>
      <span className="text-lg font-semibold tabular-nums leading-none">{m.count}</span>
      <ChevronRight className="h-4 w-4 opacity-60" />
    </button>
  );
}

export function MetricsStrip({ metrics, defaultHint }: { metrics: MetricView[]; defaultHint: string }) {
  return (
    <div className="mb-2 flex items-stretch gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {metrics.map((m) => (
          <MetricPanel key={m.id} m={m} />
        ))}
      </div>
      <HoverInfoRegion defaultHint={defaultHint} />
    </div>
  );
}
