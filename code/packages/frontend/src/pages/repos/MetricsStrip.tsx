// The metrics-panel strip (task_tabs.mdx §2) — the "what could be done" boxes for the active tab. On the
// One-repo page these panels ARE the warning surface: there is NO separate warning banner (task_tabs.mdx
// §2.6) — clicking a panel opens that metric's educate-and-fix popup (§2.4) when it has one, else it
// re-tunes the view to the acting tab.
//
// PANEL LOOK (§2.1). Each panel is deliberately NARROW — as wide as its widest word — a small label
// (rendered with the catalog's exact casing, wrapping inside the box onto as many lines as it needs)
// stacked over a big centered number:
//   • count 0  → a light-green rounded rectangle with a big 0 (the all-clear state).
//   • count >0 → health-tinted (red = at risk / owed, amber = action needed).
// Hovering a panel publishes its hint to the LEFT-BAR hover-info panel (one_repo.mdx §3.2).
//
// LAYOUT (one_repo.mdx §3.2). The strip gets the FULL page width and stays on ONE row. It used to share
// the row with a docked hover-info region that reserved ≥25% of the width, which forced the tiles to wrap
// onto a balanced second row; the explanation moved to the left-bar hover panel, so that reservation —
// and the wrapping it caused — is gone. The tiles never wrap: if they ever exceed the width, the row
// scrolls horizontally rather than breaking onto a second line.
import { useState } from "react";
import { healthBg, healthColor, type Health } from "../../components/ui/health.js";
import { setHoverInfo, useHoverDefault } from "./HoverInfoRegion.js";
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
      // w-min → the box is only as wide as its widest word; a multi-word label ("Add to IPFS", "AI
      // Describable") wraps INSIDE the tile onto as many lines as it needs. The tile itself never wraps
      // the STRIP — that is the rule the ≥25% hover reservation used to break (one_repo.mdx §3.2).
      className="flex w-min min-w-[2.75rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border px-2.5 py-1.5 text-center"
      aria-label={`${m.label}: ${m.count}. Open.`}
    >
      {/* Small label over a big number. NOT `capitalize` — that would lower-case nothing but would also
          fight labels that carry meaningful casing ("Add to IPFS", "AI Describable", "OCRable"); the
          catalog stores the exact string to render. */}
      <span className="text-[11px] font-medium leading-tight">{m.label}</span>
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

  // What the left-bar hover panel shows when nothing on this page is hovered — the active tab's hint
  // (one_repo.mdx §3.2). The panel itself is fed by the ONE global HoverInfoBridge in the app shell.
  useHoverDefault(defaultHint);

  const handle = (m: MetricView) => {
    if (m.warning?.popup) setOpenWarning(m.warning);
    else m.onOpen();
  };

  return (
    <div className="mb-2 w-full">
      {/* ONE full-width row of tiles — `flex-nowrap` + `shrink-0` tiles, so the strip can never break onto
          a second line; `overflow-x-auto` is the (rare) escape hatch on a very narrow window. */}
      <div className="flex w-full flex-nowrap items-stretch gap-2 overflow-x-auto">
        {metrics.map((m) => (
          <MetricPanel key={m.id} m={m} onClick={() => handle(m)} />
        ))}
      </div>
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
