// The global scan progress bar (scan.mdx §10). Mounted once in the AppShell so it is present on
// EVERY page — the scan runs server-side, this only polls GET /api/repos/scan-status, so navigating
// away and back simply re-attaches to the same live job. Nothing here starts, owns, or cancels a scan.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import type { ScanJob } from "@lfb/shared";
import { api } from "../api/client.js";

// Poll fast (1s) only while a scan is actively running; poll slowly (15s) otherwise so a scan started
// elsewhere (a scheduled run, or Rescan on another tab) still lights the bar up within a few seconds
// — without hammering the status endpoint every 5s on every page forever (performance.mdx P-07). This
// component is mounted once in the AppShell, so it is the SINGLE source of truth for ["scanStatus"];
// other pages read the shared cache instead of adding their own interval.
function pollInterval(job: ScanJob | undefined): number {
  return job?.status === "running" ? 1000 : 15_000;
}

export function ScanProgressBar() {
  const { data: job } = useQuery({
    queryKey: ["scanStatus"],
    queryFn: api.scanStatus,
    refetchInterval: (q) => pollInterval(q.state.data),
  });

  // Keep the "complete/failed" banner up briefly after a run finishes, then fade it out. We track the
  // finishedAt we last showed so a NEW completion re-triggers the banner.
  const [showDone, setShowDone] = useState(false);
  const lastFinishedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!job) return;
    if ((job.status === "done" || job.status === "error") && job.finishedAt) {
      if (lastFinishedAt.current !== job.finishedAt) {
        lastFinishedAt.current = job.finishedAt;
        setShowDone(true);
        const t = setTimeout(() => setShowDone(false), 4000);
        return () => clearTimeout(t);
      }
    }
  }, [job]);

  if (!job) return null;
  const running = job.status === "running";
  if (!running && !showDone) return null;

  const pct =
    job.reposTotal > 0 ? Math.min(100, Math.round((job.reposDone / job.reposTotal) * 100)) : 0;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4">
      <div className="pointer-events-auto w-full max-w-2xl rounded-lg border border-[var(--lfb-border)] bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        <div className="flex items-center gap-3">
          {running ? (
            <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-[var(--lfb-primary)]" />
          ) : job.status === "error" ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate font-medium text-black">{label(job)}</span>
              {running && job.phase !== "discovering" && (
                <span className="shrink-0 tabular-nums text-black/50">
                  {job.reposDone} / {job.reposTotal}
                </span>
              )}
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              {running && job.phase === "discovering" ? (
                // Indeterminate: total not known yet (still discovering repos).
                <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--lfb-primary)]" />
              ) : (
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${
                    job.status === "error" ? "bg-red-500" : "bg-[var(--lfb-primary)]"
                  }`}
                  style={{ width: `${job.status === "done" ? 100 : pct}%` }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function label(job: ScanJob): string {
  if (job.status === "error") return `Scan failed${job.error ? ` — ${job.error}` : ""}`;
  if (job.status === "done") {
    return `Scan complete — ${job.candidatesFound} large file${job.candidatesFound === 1 ? "" : "s"} found`;
  }
  switch (job.phase) {
    case "discovering":
      return "Scanning — discovering repositories…";
    case "repos":
      return `Scanning ${job.currentUnit ?? "repos"}…`;
    case "computer":
      return "Scanning computer files…";
    default:
      return "Scanning…";
  }
}
