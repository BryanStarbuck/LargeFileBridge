// The progress dock (webapp.mdx §10, processing.mdx §3). A fixed bottom-left region, offset 272px to clear
// the 256px left bar, sitting ABOVE the toast stack (dock bottom: 88px, toasts bottom: 16px) so the two
// never collide. It renders ONE small card per ACTIVE job — spinner + "Verb target" + an optional
// determinate bar — and is ABSENT from the DOM while no job runs (no empty box). Cards stack newest-on-top
// and each leaves the instant its job finishes, so the stack drains unevenly. The offset tracks the
// left-bar width in config/left_bar.ts; if that changes, this and main.tsx's toast offset change with it.
//
// CARD CAP (processing.mdx §3): the mass-compute queue runs MANY jobs at once (≈90% of cores, so a
// 16-core box transcodes ~14 files simultaneously). Showing a card per running job stacks a wall of
// cards up the screen. So the dock shows at most MAX_DOCK_CARDS live cards plus a single "+ N more
// running" summary line — the full picture stays one click away on the Processing page.
//
// COLLAPSE TO A PILL. The dock can fold down to one small pill — a spinner and the running count — so it
// can stay on screen through a long batch without covering the content under it. The choice is remembered
// per browser (localStorage; a blocked store just means it opens expanded).
//
// THE DISCOVERY SCAN lives here too. It used to have its own bottom-CENTER bar (ScanProgressBar) that
// duplicated the scan card this dock already shows; that bar is folded in: the dock owns the one
// ["scanStatus"] poller (fast only while a scan runs, woken by the `scans` topic otherwise), shows a scan
// card even before /progress has folded the scan in, and keeps the brief "Scan complete / Scan failed"
// result card for a few seconds after a run ends.
//
// UNKNOWN KINDS render, never vanish: the backend adds new progress kinds (background storage-sync cycles
// and the like) on its own schedule, and a card for a kind this build doesn't know reads "Working on
// <target>" (progress-context.ts verb()).
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, CheckCircle2, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import type { ProgressJob, ScanJob } from "@lfb/shared";
import { useProgress, verb } from "../progress/progress-context.js";
// The card's text rules — which piece truncates and which never does — live as pure functions so they can
// be tested without a DOM (cardText.ts).
import { metricText, cardTooltip } from "../progress/cardText.js";
import { leftBar } from "../config/left_bar.js";
import { api } from "../api/client.js";
import { useLiveRefresh } from "../lib/useLiveRefresh.js";
// The dock is mounted OUTSIDE <RouterProvider> (main.tsx renders it as a sibling so it overlays every
// screen), so router HOOKS are off-limits here — useNavigate() fired "useRouter must be used inside a
// <RouterProvider> component!" on every render with active jobs. Navigate through the router instance
// directly instead; it needs no React context.
import { router } from "../router.js";

// 256px bar + 16px gutter. Parsed from the yaml-driven width so the dock never sits over the nav.
const DOCK_LEFT = `calc(${leftBar.sidebarWidth} + 16px)`;

// The most live cards the dock ever shows at once. Beyond this, the rest collapse into a single
// "+ N more running" summary line (processing.mdx §3) so a mass compress-inside run never walls the screen.
const MAX_DOCK_CARDS = 3;

// Where the collapsed/expanded choice is remembered (a per-viewer convenience, never state that matters).
const COLLAPSED_KEY = "lfb.progressDock.collapsed";
// How long the "Scan complete / Scan failed" card lingers after a discovery scan ends (scan.mdx §10).
const SCAN_DONE_LINGER_MS = 4000;
// The id /api/progress gives the folded discovery scan (progress.router.ts) — de-dupes our own scan card.
const SCAN_JOB_ID = "scan-job";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(on: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, on ? "1" : "0");
  } catch {
    // private window / blocked storage — the dock simply forgets the choice next load
  }
}

// Poll fast (1s) ONLY while a scan is actively running (per-unit progress ticks don't ride the event
// stream); while idle there is NO interval — the `scans` topic on the event stream lights the card up the
// moment a run starts anywhere (a scheduled run, or Rescan on another tab) (performance.mdx Aspect 6b,
// P-07). This is the SINGLE source of truth for ["scanStatus"]; other pages read the shared cache.
function scanPollInterval(job: ScanJob | undefined): number | false {
  return job?.status === "running" ? 1000 : false;
}

/** A dock card for a running discovery scan, for the moments /progress has not folded it in yet. */
function scanAsJob(scan: ScanJob): ProgressJob {
  const determinate = scan.phase !== "discovering" && scan.reposTotal > 0;
  return {
    id: SCAN_JOB_ID,
    kind: "scan",
    target:
      scan.currentUnit ??
      (scan.phase === "discovering" ? "— discovering repositories…" : scan.phase === "computer" ? "computer files" : "repos"),
    startedAt: scan.startedAt ?? new Date().toISOString(),
    ...(determinate ? { done: scan.reposDone, total: scan.reposTotal, unit: "repos" } : {}),
  };
}

function scanResultLabel(scan: ScanJob): string {
  if (scan.status === "error") return `Scan failed${scan.error ? ` — ${scan.error}` : ""}`;
  return `Scan complete — ${scan.candidatesFound} large file${scan.candidatesFound === 1 ? "" : "s"} found`;
}

/** The ["scanStatus"] poller + the brief post-run result linger (formerly ScanProgressBar). */
function useScanStatus(): { scan: ScanJob | undefined; showDone: boolean } {
  const { data: scan } = useQuery({
    queryKey: ["scanStatus"],
    queryFn: api.scanStatus,
    refetchInterval: (q) => scanPollInterval(q.state.data),
  });
  useLiveRefresh(["scans"], [["scanStatus"]]);

  // Keep the "complete/failed" card up briefly after a run finishes. We track the finishedAt we last
  // showed so a NEW completion re-triggers it.
  const [showDone, setShowDone] = useState(false);
  const lastFinishedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!scan) return;
    if ((scan.status === "done" || scan.status === "error") && scan.finishedAt) {
      if (lastFinishedAt.current !== scan.finishedAt) {
        lastFinishedAt.current = scan.finishedAt;
        setShowDone(true);
        const t = setTimeout(() => setShowDone(false), SCAN_DONE_LINGER_MS);
        return () => clearTimeout(t);
      }
    }
  }, [scan]);
  return { scan: scan as ScanJob | undefined, showDone };
}

const CARD_CLASS =
  "min-w-[260px] max-w-[360px] rounded-lg border bg-white/95 px-3 py-2 shadow-[var(--lfb-shadow-md)] backdrop-blur";
const LINE_CLASS =
  "min-w-[260px] rounded-lg border bg-white/95 px-3 py-1 text-xs text-black/50 shadow-[var(--lfb-shadow-md)] backdrop-blur";

function Card({ job }: { job: ProgressJob }) {
  const determinate = job.total !== undefined && job.done !== undefined && job.total > 0;
  const pct = determinate ? Math.min(100, Math.round((job.done! / job.total!) * 100)) : 0;
  const line = metricText(job);
  // A job with no target (a new server kind that only carries a verb) still names SOMETHING.
  const target = job.target || "background work";
  return (
    <div
      className={CARD_CLASS}
      style={{ borderColor: "var(--lfb-border)" }}
      // Hovering anywhere on the card reads back everything it shows, untruncated. The child titles below
      // are more specific and win when the pointer is over them.
      title={cardTooltip(job)}
      role={determinate ? "progressbar" : undefined}
      aria-valuenow={determinate ? pct : undefined}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
    >
      <div className="flex items-center gap-2 text-sm">
        <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-[var(--lfb-primary)]" aria-hidden />
        <span className="shrink-0 whitespace-nowrap text-black/60">{verb(job.kind)}</span>
        {/* The ONLY element that gives way. `min-w-0` is what lets it shrink below its content inside a
            flex row at all, and the tooltip is where the full name stays readable. */}
        <span className="min-w-0 flex-1 truncate font-medium text-black" title={target}>
          {target}
        </span>
        {line && (
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-black/50" title={line}>
            {line}
          </span>
        )}
      </div>
      {determinate && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--lfb-surface-sunken)]">
          <div
            className="h-full rounded-full bg-[var(--lfb-primary)] transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {/* THE PHASE LINE (webapp.mdx §10.2). "Pinning all" + a spinner cannot tell a pass that is reconciling
          a ledger from one that has wedged; this line says which step is running and, inside a big file, how
          far its bytes have got. Truncated to one line so the card keeps its short shape. */}
      {job.note && (
        <div className="mt-1 truncate text-xs text-black/45" title={job.note}>
          {job.note}
        </div>
      )}
    </div>
  );
}

/** The post-run "Scan complete / Scan failed" card (scan.mdx §10) — no spinner, it is a result. */
function ScanResultCard({ scan }: { scan: ScanJob }) {
  const failed = scan.status === "error";
  const label = scanResultLabel(scan);
  return (
    <div className={CARD_CLASS} style={{ borderColor: "var(--lfb-border)" }} title={label}>
      <div className="flex items-center gap-2 text-sm">
        {failed ? (
          <AlertCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-black">{label}</span>
      </div>
    </div>
  );
}

export function ProgressDock() {
  const { jobs: ctxJobs, queued } = useProgress();
  const { scan, showDone } = useScanStatus();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = (on: boolean) => {
    setCollapsed(on);
    writeCollapsed(on);
  };

  // A running scan always has a card — the server's folded one when /progress already carries it, our own
  // from ["scanStatus"] otherwise (the two polls are not in lock-step).
  const scanRunning = scan?.status === "running";
  const jobs =
    scanRunning && !ctxJobs.some((j) => j.id === SCAN_JOB_ID) ? [scanAsJob(scan), ...ctxJobs] : ctxJobs;
  const scanResult = !scanRunning && showDone && scan ? scan : null;

  if (jobs.length === 0 && queued <= 0 && !scanResult) return null; // absent from the DOM while idle
  // The whole card stack is a shortcut into the Processing page (processing.mdx §3).
  const openProcessing = () => void router.navigate({ to: "/processing" });

  if (collapsed) {
    const running = jobs.length;
    const label =
      running > 0
        ? `${running.toLocaleString()} running${queued > 0 ? ` · ${queued.toLocaleString()} queued` : ""}`
        : queued > 0
          ? `${queued.toLocaleString()} queued`
          : scanResult
            ? scanResultLabel(scanResult)
            : "";
    return (
      <div className="fixed z-40" style={{ left: DOCK_LEFT, bottom: 88 }} aria-live="polite">
        <button
          type="button"
          onClick={() => toggleCollapsed(false)}
          className="flex max-w-[360px] items-center gap-2 rounded-full border bg-white/95 px-3 py-1.5 text-xs text-black/70 shadow-[var(--lfb-shadow-md)] backdrop-blur hover:text-black"
          style={{ borderColor: "var(--lfb-border)" }}
          title="Background work in progress — click to expand"
          aria-label={`Background work: ${label}. Expand the progress dock.`}
        >
          {running > 0 || queued > 0 ? (
            <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--lfb-primary)]" aria-hidden />
          ) : scanResult?.status === "error" ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" aria-hidden />
          )}
          <span className="min-w-0 truncate tabular-nums">{label}</span>
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-black/40" aria-hidden />
        </button>
      </div>
    );
  }

  // Cap the live cards; the overflow becomes one summary line so the stack never covers the screen.
  const visible = jobs.slice(0, MAX_DOCK_CARDS);
  const moreRunning = jobs.length - visible.length;
  return (
    <div className="fixed z-40 flex flex-col items-start gap-1.5" style={{ left: DOCK_LEFT, bottom: 88 }}>
      {/* Collapse to a pill — sits above the stack, outside the "open Processing" button. */}
      <button
        type="button"
        onClick={() => toggleCollapsed(true)}
        className="self-end rounded-full border bg-white/95 p-1 text-black/40 shadow-[var(--lfb-shadow-md)] backdrop-blur hover:text-black"
        style={{ borderColor: "var(--lfb-border)" }}
        title="Collapse to a small pill"
        aria-label="Collapse the progress dock"
      >
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      <div
        className="flex cursor-pointer flex-col-reverse gap-1.5"
        role="button"
        tabIndex={0}
        onClick={openProcessing}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openProcessing();
          }
        }}
        aria-live="polite"
        aria-label="Background work in progress — open the Processing page"
      >
        {/* The pending backlog of the background job queue (job_queue.mdx §4). Rendered first so, in the
            column-reverse stack, it sits UNDER the live cards; drains to nothing as workers pick tasks up. */}
        {queued > 0 && (
          <div className={LINE_CLASS} style={{ borderColor: "var(--lfb-border)" }}>
            + {queued.toLocaleString()} queued
          </div>
        )}
        {/* Overflow beyond MAX_DOCK_CARDS collapses into one summary line. Rendered before the visible
            cards so, in the column-reverse stack, it sits directly UNDER them (and above the queued footer). */}
        {moreRunning > 0 && (
          <div className={LINE_CLASS} style={{ borderColor: "var(--lfb-border)" }}>
            + {moreRunning.toLocaleString()} more running
          </div>
        )}
        {scanResult && <ScanResultCard scan={scanResult} />}
        {visible.map((job) => (
          <Card key={job.id} job={job} />
        ))}
      </div>
    </div>
  );
}
