// The metrics-panel strip (task_tabs.mdx §2) — the "what could be done" boxes for the active tab, with
// the hover-info region docked to their right (§3). On the One-repo page these panels ARE the warning
// surface: there is NO separate warning banner (task_tabs.mdx §2.6) — clicking a panel opens that
// metric's educate-and-fix popup (§2.4) when it has one, else it re-tunes the view to the acting tab.
//
// PANEL LOOK (§2.1). Each panel is deliberately NARROW — as wide as its widest word — a small Title-Case
// label (wrapping onto as many lines as it needs) stacked over a big centered number:
//   • count 0  → a light-green rounded rectangle with a big 0 (the all-clear state).
//   • count >0 → health-tinted (red = at risk / owed, amber = action needed).
// Hovering a panel publishes its hint to the docked HoverInfoRegion.
//
// LAYOUT (§3). The panels occupy at most ~75% of the row so the hover-info region always keeps ≥25%.
// When the panels don't fit on one row they flow onto a second, balanced row — equal counts top and
// bottom, left-aligned — computed from the measured intrinsic panel widths.
import { useLayoutEffect, useRef, useState } from "react";
import { healthBg, healthColor, type Health } from "../../components/ui/health.js";
import { HoverInfoRegion, setHoverInfo } from "./HoverInfoRegion.js";
import { WarningPopup } from "../../components/ui/WarningPopup.js";
import type { WarningDef } from "../../components/ui/warnings/registry.js";
import type { MetricId } from "./metricWarnings.js";

export interface MetricView {
  id: MetricId;
  label: string;
  count: number;
  hint: string;
  /** Tint when count > 0. At 0 the panel is always the light-green all-clear state. */
  positive: Health;
  /** This metric's educate-and-fix popup (task_tabs.mdx §2.4), when it has one. Clicking the panel opens it. */
  warning?: WarningDef;
  /** Fallback when the metric has no popup: re-tune the view to the tab where the user acts on it. */
  onOpen: () => void;
}

function MetricPanel({ m, onClick }: { m: MetricView; onClick: () => void }) {
  const clear = m.count === 0;
  const style: React.CSSProperties = clear
    ? { background: "var(--lfb-ok-bg)", color: "var(--lfb-ok)", borderColor: "transparent" }
    : { background: healthBg(m.positive), color: healthColor(m.positive), borderColor: "var(--lfb-border)" };
  return (
    <button
      type="button"
      data-metric-panel
      onClick={onClick}
      onMouseEnter={() => setHoverInfo(m.hint)}
      onMouseLeave={() => setHoverInfo(null)}
      onFocus={() => setHoverInfo(m.hint)}
      onBlur={() => setHoverInfo(null)}
      style={style}
      // w-min → the box is only as wide as its widest word; the label wraps to as many lines as it needs.
      className="flex w-min min-w-[2.75rem] flex-col items-center justify-center gap-0.5 rounded-lg border px-2.5 py-1.5 text-center"
      aria-label={`${m.label}: ${m.count}. Open.`}
    >
      {/* Title Case (capitalize), NOT all-caps; small; wraps within the narrow box. */}
      <span className="text-[11px] font-medium capitalize leading-tight">{m.label}</span>
      <span className="text-2xl font-bold tabular-nums leading-none">{m.count}</span>
    </button>
  );
}

export function MetricsStrip({
  metrics,
  defaultHint,
  onApplied,
}: {
  metrics: MetricView[];
  defaultHint: string;
  /** Fired after a metric popup's fix lands so the page can refetch and the panel re-derives its count. */
  onApplied?: () => void;
}) {
  // The metric whose popup is open (null = none). Only one popup at a time.
  const [openWarning, setOpenWarning] = useState<WarningDef | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  // How many panels go on each row. Starts as "all on one row"; the measure pass below rebalances.
  const [perRow, setPerRow] = useState(Math.max(1, metrics.length));

  // §3 — measure the panels' intrinsic widths against the ≤75% area and rebalance into equal rows. A
  // panel's offsetWidth is layout-independent (w-min content), so measuring from the chunked layout is
  // safe and the computed perRow is a fixed point (no oscillation).
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => {
      const panels = Array.from(el.querySelectorAll<HTMLElement>("[data-metric-panel]"));
      const n = panels.length;
      if (n === 0) return;
      const cw = el.clientWidth;
      const GAP = 8; // gap-2
      let used = 0;
      let fit = 0;
      for (const p of panels) {
        used += p.offsetWidth + (fit > 0 ? GAP : 0);
        if (used <= cw || fit === 0) fit++;
        else break;
      }
      fit = Math.max(1, fit);
      const rows = Math.max(1, Math.ceil(n / fit));
      setPerRow(Math.ceil(n / rows)); // balanced: equal counts per row, left-aligned
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [metrics]);

  const rows: MetricView[][] = [];
  for (let i = 0; i < metrics.length; i += perRow) rows.push(metrics.slice(i, i + perRow));

  const handle = (m: MetricView) => {
    if (m.warning?.popup) setOpenWarning(m.warning);
    else m.onOpen();
  };

  return (
    <div className="mb-2 flex items-stretch gap-3">
      {/* Panels — capped at ~75% so the hover-info region keeps ≥25%; flow into balanced rows (§3). */}
      <div ref={areaRef} className="flex flex-col gap-2" style={{ maxWidth: "75%" }}>
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-stretch gap-2">
            {row.map((m) => (
              <MetricPanel key={m.id} m={m} onClick={() => handle(m)} />
            ))}
          </div>
        ))}
      </div>
      <HoverInfoRegion defaultHint={defaultHint} />
      {openWarning && (
        <WarningPopup
          warning={openWarning}
          onClose={() => setOpenWarning(null)}
          onApplied={onApplied}
        />
      )}
    </div>
  );
}
