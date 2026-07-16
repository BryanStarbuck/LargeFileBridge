// The Processing page (/processing) — the full background-work view (processing.mdx §4). Three stacked
// regions, each shown only when it has content: Running now (the registry jobs), Waiting (the per-op
// pending backlog), and Batches (one card per "Compress inside" run, with a progress bar and — on finish
// — the ERROR LIST from compress_inside.mdx §4). Reads the single polled source via useProgress().
import { CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import type { ProcessingBatch, ProgressKind } from "@lfb/shared";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner } from "../../components/ui/StatusBanner.js";
import { useProgress, verb } from "../../progress/ProgressContext.js";
import { ProcessingItemsTable } from "./ProcessingItemsTable.js";
import { groupHalted, haltedWarningDef, type HaltedGroup } from "./haltedWarning.js";
import { sessionCopy } from "./sessionState.js";

// "compress" → "compressing", etc. — a lowercase gerund for the Waiting backlog line.
function backlogLabel(op: ProgressKind): string {
  return verb(op).toLowerCase();
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

/**
 * "All 1,440 files described." — the Finished state's headline (crash_recovery.mdx §5).
 *
 * Built from the recently-finished batches rather than a counter, so it reports what actually completed.
 * Returns undefined when there is nothing to summarize, and the caller falls back to generic copy.
 */
function summarizeFinished(finished: ProcessingBatch[]): string | undefined {
  if (finished.length === 0) return undefined;
  const done = finished.reduce((n, b) => n + b.done, 0);
  const failed = finished.reduce((n, b) => n + b.failed, 0);
  if (done === 0 && failed === 0) return undefined;
  const label = finished.length === 1 ? finished[0].label : "queued work";
  const head = done > 0 ? `${done.toLocaleString()} ${done === 1 ? "file" : "files"} finished` : "Finished";
  return failed > 0 ? `${head} — ${failed.toLocaleString()} failed (${label}).` : `${head} (${label}).`;
}

// The single "work stopped, here's why, here's the fix" banner for one open provider circuit (to_fix.mdx
// §2.4). Standard educate-and-fix surface: warn/amber banner + the blue arrow that opens the popup carrying
// Resume (warnings.mdx §3/§4).
function HaltedBanner({ group }: { group: HaltedGroup }) {
  const def = haltedWarningDef(group);
  return <StatusBanner state={def.state} headline={def.headline} sub={def.sub} warning={def} />;
}

export function ProcessingPage() {
  const { jobs, queuedByOp, batches, queuedItems, recentFailures, workers, session } = useProgress();
  const waiting = Object.entries(queuedByOp).filter(([, n]) => (n ?? 0) > 0) as [ProgressKind, number][];
  // The per-item table (processing.mdx §4.3) shows Running (jobs) + Pending (queuedItems) + Failed
  // (recentFailures) rows; it renders whenever any of those exist.
  const hasItems = jobs.length > 0 || queuedItems.length > 0 || recentFailures.length > 0;
  const nothing = !hasItems && waiting.length === 0 && batches.length === 0;

  // D2 (crash_recovery.mdx §5) — an empty queue is THREE states, and this page used to render all of them
  // as the calm one. "Did work finish in this session?" is answered by the batch registry: a finished batch
  // is retained ~30 min, which is exactly the window in which the question is worth asking.
  const finishedBatches = batches.filter((b) => b.finishedAt !== null);
  const didWorkThisSession = finishedBatches.length > 0;
  const finishedSummary = summarizeFinished(finishedBatches);
  const copy = sessionCopy(session, didWorkThisSession, finishedSummary);
  // The restore banner is NOT gated on `nothing`: an interrupted session must announce itself even while
  // the restored jobs are actively running above (§4.2 — it persists until the work completes, and a user
  // who walks up to a busy page still needs to know the app crashed and this is the recovery).
  const interrupted = copy.state === "interrupted";
  // Worker utilization — the parallelism read (processing.mdx §3a): how many core-slots of the mass-compute
  // budget are busy right now. Shown atop "Running now" so the user can SEE the mass parallelization working.
  const utilPct = workers && workers.budget > 0 ? Math.round((workers.busy / workers.budget) * 100) : 0;
  // ONE banner per open provider circuit, never one card per halted file (to_fix.mdx §2.4). The halted items
  // still carry their own "Not attempted" rows in the table below (§7.3) — this is the actionable summary.
  const halted = groupHalted(recentFailures);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Processing" subtitle="Background work — compression, transcriptions, and more." />

      {/* The RESTORE / INTERRUPTED banner (crash_recovery.mdx §4.2) — persistent, not a toast: a toast that
          fires while the user is asleep is the same as no notification at all. It sits above everything
          because "the app crashed and here is what happened to your work" outranks any running job. */}
      {interrupted && <StatusBanner state="warn" headline={copy.headline} sub={copy.sub} />}

      {halted.map((g) => (
        <HaltedBanner key={g.key} group={g} />
      ))}

      {nothing && !interrupted && (
        <div className="rounded-lg border border-dashed px-6 py-10 text-center text-black/50" style={{ borderColor: "var(--lfb-border)" }}>
          {/* Finished ≠ Empty. "All 1,440 files described." is a different fact from "nothing was ever
              queued", and rendering the second when the first is true is how the 2026-07-15 loss stayed
              invisible for six hours. */}
          <div>{copy.headline}</div>
          {copy.sub && <div className="mt-1 text-xs text-black/40">{copy.sub}</div>}
        </div>
      )}

      {hasItems && (
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-black/60">Running now</h2>
            {workers && workers.busy > 0 && (
              <span className="text-xs text-black/50" title="Cores in use by background compression & processing (parallelization.mdx §4)">
                {workers.busy} / {workers.budget} workers busy (~{utilPct}% of cores)
              </span>
            )}
          </div>
          {/* The per-item table (processing.mdx §4.3): Running / Pending / Failed rows with responsive
              priority-drop columns (reuses the house DataTable machinery). */}
          <ProcessingItemsTable jobs={jobs} queuedItems={queuedItems} recentFailures={recentFailures} />
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
