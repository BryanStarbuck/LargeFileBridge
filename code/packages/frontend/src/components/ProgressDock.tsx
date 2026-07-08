// The progress dock (webapp.mdx §10). A fixed bottom-left region, offset 272px to clear the 256px left
// bar, sitting ABOVE the toast stack (dock bottom: 88px, toasts bottom: 16px) so the two never collide.
// It renders ONE small card per ACTIVE job — spinner + "Verb target" + an optional determinate bar —
// and is ABSENT from the DOM while no job runs (no empty box). Cards stack newest-on-top and each leaves
// the instant its job finishes, so the stack drains unevenly. The offset tracks the left-bar width in
// config/left_bar.ts; if that changes, this and main.tsx's toast offset change with it.
import { RefreshCw } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { ProgressJob } from "@lfb/shared";
import { useProgress, verb } from "../progress/ProgressContext.js";
import { leftBar } from "../config/left_bar.js";

// 256px bar + 16px gutter. Parsed from the yaml-driven width so the dock never sits over the nav.
const DOCK_LEFT = `calc(${leftBar.sidebarWidth} + 16px)`;

function detail(job: ProgressJob): string | null {
  if (job.total === undefined || job.done === undefined) return null;
  const unit = job.unit ?? "";
  if (unit === "%") return `${Math.round(job.done)}%`;
  if (unit === "MB" || unit === "GB") return `${job.done} / ${job.total} ${unit}`;
  return `${job.done.toLocaleString()} / ${job.total.toLocaleString()} ${unit}`.trim();
}

function Card({ job }: { job: ProgressJob }) {
  const determinate = job.total !== undefined && job.done !== undefined && job.total > 0;
  const pct = determinate ? Math.min(100, Math.round((job.done! / job.total!) * 100)) : 0;
  const line = detail(job);
  return (
    <div
      className="min-w-[260px] max-w-[360px] rounded-lg border bg-white/95 px-3 py-2 shadow-md backdrop-blur"
      style={{ borderColor: "var(--lfb-border)" }}
      role={determinate ? "progressbar" : undefined}
      aria-valuenow={determinate ? pct : undefined}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
    >
      <div className="flex items-center gap-2 text-sm">
        <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-[var(--lfb-primary)]" aria-hidden />
        <span className="text-black/60">{verb(job.kind)}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-black">{job.target}</span>
        {line && <span className="shrink-0 text-xs text-black/50">{line}</span>}
      </div>
      {determinate && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-[var(--lfb-primary)] transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function ProgressDock() {
  const { jobs, queued } = useProgress();
  const navigate = useNavigate();
  if (jobs.length === 0 && queued <= 0) return null; // absent from the DOM while idle — no empty box
  // The whole dock is a shortcut into the Processing page (processing.mdx §3) — click or Enter/Space opens it.
  const openProcessing = () => void navigate({ to: "/processing" });
  return (
    <div
      className="fixed z-40 flex cursor-pointer flex-col-reverse gap-1.5"
      style={{ left: DOCK_LEFT, bottom: 88 }}
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
        <div
          className="min-w-[260px] rounded-lg border bg-white/95 px-3 py-1 text-xs text-black/50 shadow-md backdrop-blur"
          style={{ borderColor: "var(--lfb-border)" }}
        >
          + {queued.toLocaleString()} queued
        </div>
      )}
      {jobs.map((job) => (
        <Card key={job.id} job={job} />
      ))}
    </div>
  );
}
