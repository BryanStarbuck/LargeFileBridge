// The Processing page (/processing) — the full background-work view (processing.mdx §4). Three stacked
// regions, each shown only when it has content: Running now (the registry jobs), Waiting (the per-op
// pending backlog), and Batches (one card per "Compress inside" run, with a progress bar and — on finish
// — the ERROR LIST from compress_inside.mdx §4). Reads the single polled source via useProgress().
import { CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import type { ProgressJob, ProcessingBatch, ProgressKind } from "@lfb/shared";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { useProgress, verb } from "../../progress/ProgressContext.js";

function jobDetail(job: ProgressJob): string | null {
  if (job.total === undefined || job.done === undefined) return null;
  const unit = job.unit ?? "";
  if (unit === "%") return `${Math.round(job.done)}%`;
  return `${job.done.toLocaleString()} / ${job.total.toLocaleString()} ${unit}`.trim();
}

// "compress" → "compressing", etc. — a lowercase gerund for the Waiting backlog line.
function backlogLabel(op: ProgressKind): string {
  return verb(op).toLowerCase();
}

function RunningRow({ job }: { job: ProgressJob }) {
  const determinate = job.total !== undefined && job.done !== undefined && job.total > 0;
  const pct = determinate ? Math.min(100, Math.round((job.done! / job.total!) * 100)) : 0;
  const line = jobDetail(job);
  return (
    <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--lfb-border)" }}>
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--lfb-primary)]" aria-hidden />
        <span className="text-black/60">{verb(job.kind)}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-black">{job.target}</span>
        {line && <span className="shrink-0 text-xs text-black/50">{line}</span>}
      </div>
      {determinate && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-[var(--lfb-primary)]" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function BatchCard({ b }: { b: ProcessingBatch }) {
  const processed = b.done + b.failed;
  const pct = b.total > 0 ? Math.min(100, Math.round((processed / b.total) * 100)) : 100;
  const finished = b.finishedAt !== null;
  const disposition = b.deleteOriginal === "hard" ? "hard-deleted" : "moved to LFBridge trash";
  return (
    <div className="rounded-lg border px-4 py-3" style={{ borderColor: "var(--lfb-border)" }}>
      <div className="flex items-center gap-2">
        {finished ? (
          b.failed > 0 ? (
            <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--lfb-bad)]" />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          )
        ) : (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--lfb-primary)]" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-black">{b.label}</span>
        <span className="shrink-0 text-xs text-black/50">
          {processed} / {b.total}
        </span>
      </div>
      <div className="mt-0.5 pl-6 text-xs text-black/40">Originals: {disposition}</div>

      {!finished && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-[var(--lfb-primary)] transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}

      {finished && b.failed === 0 && (
        <div className="mt-2 text-sm text-emerald-700">All {b.done} files compressed.</div>
      )}

      {finished && b.failed > 0 && (
        <div className="mt-2">
          <div className="text-sm text-black/70">
            Compressed {b.done} file{b.done === 1 ? "" : "s"} — {b.failed} had error{b.failed === 1 ? "" : "s"}:
          </div>
          <ul className="mt-1.5 space-y-1">
            {b.errors.map((e) => (
              <li key={e.path} className="rounded border border-[var(--lfb-border)] bg-red-50/40 px-2 py-1 text-xs">
                <span className="font-mono text-black/70">{e.path}</span>
                <span className="text-[var(--lfb-bad)]"> — {e.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ProcessingPage() {
  const { jobs, queuedByOp, batches } = useProgress();
  const waiting = Object.entries(queuedByOp).filter(([, n]) => (n ?? 0) > 0) as [ProgressKind, number][];
  const nothing = jobs.length === 0 && waiting.length === 0 && batches.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Processing" subtitle="Background work — compression, transcriptions, and more." />

      {nothing && (
        <div className="rounded-lg border border-dashed px-6 py-10 text-center text-black/50" style={{ borderColor: "var(--lfb-border)" }}>
          Nothing is processing right now.
        </div>
      )}

      {jobs.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-black/60">Running now</h2>
          <div className="flex flex-col gap-1.5">
            {jobs.map((j) => (
              <RunningRow key={j.id} job={j} />
            ))}
          </div>
        </section>
      )}

      {waiting.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-black/60">Waiting</h2>
          <div className="rounded-lg border px-4 py-3 text-sm text-black/70" style={{ borderColor: "var(--lfb-border)" }}>
            {waiting.map(([op, n], i) => (
              <span key={op}>
                {i > 0 && <span className="text-black/30"> · </span>}
                {n} {backlogLabel(op)}
              </span>
            ))}
            <span className="text-black/40"> waiting to start</span>
          </div>
        </section>
      )}

      {batches.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-black/60">Batches</h2>
          <div className="flex flex-col gap-2">
            {batches.map((b) => (
              <BatchCard key={b.id} b={b} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
