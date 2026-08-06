// The metrics-panel strip (task_tabs.mdx §2) — the "what could be done" boxes for the active tab. On the
// One-repo page these panels ARE the warning surface: there is NO separate warning banner (task_tabs.mdx
// §2.6) — clicking a panel opens that metric's educate-and-fix popup (§2.4) when it has one, else it
// re-tunes the view to the acting tab.
//
// PANEL LOOK (§2.1, revised). Every panel is the SAME width — they divide the strip evenly — with a small
// label (rendered with the catalog's exact casing, wrapping inside the box onto as many lines as it needs)
// stacked over a big centered number. They used to be sized to their own widest word, which made a
// nine-tile strip nine different widths:
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
import { RefreshCw } from "lucide-react";
import { healthBg, healthColor, type Health } from "../../components/ui/health.js";
import { useCensusPending } from "../../lib/useCensusPending.js";
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

function MetricPanel({
  m,
  onClick,
  pending,
  why,
}: {
  m: MetricView;
  onClick: () => void;
  pending: boolean;
  why: string;
}) {
  // THE ALL-CLEAR GREEN IS A CLAIM, AND IT IS ONLY EARNED BY A FINISHED COUNT (performance.mdx P-37/P-38).
  // While the detail is still streaming — or while a background pass is recomputing the census — every
  // number here is a rising SUBTOTAL, so a tile that happens to read 0 right now has not established that
  // there is nothing to do, and painting it green would say exactly that. `Pull down` is the tile that made
  // this concrete: it reads 0 until the backbone pull folds in the peers' manifests, and it read 0 IN GREEN.
  const clear = m.count === 0 && !pending;
  const style: React.CSSProperties = clear
    ? { background: "var(--lfb-ok-bg)", color: "var(--lfb-ok)", borderColor: "transparent" }
    : pending && m.count === 0
      ? { background: "transparent", color: "rgba(0,0,0,0.35)", borderColor: "var(--lfb-border)" }
      : { background: healthBg(m.positive), color: healthColor(m.positive), borderColor: "var(--lfb-border)" };
  return (
    <button
      type="button"
      data-metric-panel
      onClick={onClick}
      // Hovering a PENDING tile explains the number rather than the metric — "why does this say 0" is the
      // question the user actually has at that moment.
      onMouseEnter={() => setHoverInfo(pending ? why : m.hint)}
      onMouseLeave={() => setHoverInfo(null)}
      onFocus={() => setHoverInfo(pending ? why : m.hint)}
      onBlur={() => setHoverInfo(null)}
      title={pending ? why : undefined}
      style={style}
      // EQUAL WIDTHS (revises task_tabs.mdx §2.1, which sized each tile to its own widest word — nine
      // tiles then meant nine different widths and a visibly ragged strip). `flex-1 basis-0` gives every
      // tile the same share of the row, so the strip reads as one set of cards; a multi-word label
      // ("Add to IPFS", "AI Describable") still wraps INSIDE its tile. min-w keeps them legible on a
      // narrow window, where the strip's own overflow-x-auto is the escape hatch rather than a
      // second line (one_repo.mdx §3.2).
      className="flex min-w-[4.5rem] flex-1 basis-0 flex-col items-center justify-center gap-0.5 rounded-lg border px-2.5 py-1.5 text-center"
      aria-label={pending ? `${m.label}: ${m.count} so far, still counting. Open.` : `${m.label}: ${m.count}. Open.`}
    >
      {/* Small label over a big number. NOT `capitalize` — that would lower-case nothing but would also
          fight labels that carry meaningful casing ("Add to IPFS", "AI Describable", "OCRable"); the
          catalog stores the exact string to render. */}
      <span className="text-[11px] font-medium leading-tight">{m.label}</span>
      {/* THE PER-TILE CUE IS ON THE NUMBER, AND IT COSTS NO LAYOUT. A spinner in the label row read as
          noise at nine tiles at once, and — back when the tile was sized to its own widest word — the
          icon competed with the label for that width and pushed "Add to IPFS" onto a third line. The
          number is the thing that is provisional, so the number is what softens: a slow pulse, no glyph,
          no width. WHAT is still running is answered once, in the line under the strip. */}
      <span className={`text-2xl font-bold tabular-nums leading-none ${pending ? "animate-pulse" : ""}`}>
        {m.count}
      </span>
    </button>
  );
}

export function MetricsStrip({
  metrics,
  defaultHint,
  onApplied,
  pending = false,
}: {
  metrics: MetricView[];
  defaultHint: string;
  /** Fired after a metric popup's fix lands so the page can refetch and the panel re-derives its count. */
  onApplied?: () => void;
  /** The detail is still streaming, so every count is a running subtotal — see {@link MetricPanel}. */
  pending?: boolean;
}) {
  // The metric whose popup is open (null = none). Only one popup at a time.
  const [openWarning, setOpenWarning] = useState<WarningDef | null>(null);

  // The OTHER reason a count is provisional: a background pass is recomputing the census right now. The
  // page's own `pending` only covers its own fetch; this covers the scan/pin work that lands afterwards
  // and is what makes `Pull down` jump from 0 to its real value minutes later (useCensusPending).
  const census = useCensusPending();
  const provisional = pending || census.active;
  // Names the pass when there is one to name, because "Pinning charlie-kirk" tells the user how long this
  // is likely to last and the generic sentence does not. Plural: the caveat is about the whole strip.
  const why = census.label
    ? `${census.label} — these counts are still going up.`
    : "Still loading this repo — these counts are still going up.";

  // What the left-bar hover panel shows when nothing on this page is hovered — the active tab's hint
  // (one_repo.mdx §3.2). The panel itself is fed by the ONE global HoverInfoBridge in the app shell.
  useHoverDefault(defaultHint);

  const handle = (m: MetricView) => {
    if (m.warning?.popup) setOpenWarning(m.warning);
    else m.onOpen();
  };

  return (
    <div className="mb-2 w-full">
      {/* ONE full-width row of equal tiles — `flex-nowrap` + `flex-1 basis-0`, so the strip divides evenly
          and can never break onto a second line; `overflow-x-auto` is the (rare) escape hatch on a very
          narrow window, once every tile has hit its min width. */}
      <div className="flex w-full flex-nowrap items-stretch gap-2 overflow-x-auto">
        {metrics.map((m) => (
          <MetricPanel key={m.id} m={m} onClick={() => handle(m)} pending={provisional} why={why} />
        ))}
      </div>
      {/* ONE sentence, and the only spinner. The pulsing numbers say THAT the counts are moving; this says
          WHAT is moving them, without a trip to the progress dock in the opposite corner.
          The row is ALWAYS reserved (h-4), never conditionally added: a background pass can start long
          after the page settled, and a line that appeared then would shove the whole table down 20px while
          the user was reading it. */}
      <div className="mt-1 flex h-4 items-center" aria-live="polite">
        {provisional && (
          <p className="flex items-center gap-1.5 text-xs text-black/45">
            <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
            {why}
          </p>
        )}
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
