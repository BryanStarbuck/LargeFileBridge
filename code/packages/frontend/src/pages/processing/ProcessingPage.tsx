// The Processing page (/processing) — the full background-work view (processing.mdx §4).
//
// TWO STACKED TABLES (§4.0.1): the BATCHES table on top (one row per bulk run) over the ITEMS table
// (per-file rows). This replaced three regions — "Running now" / "Waiting" / "Batches"-as-cards. The
// Waiting region is gone: a queued file is a row in the items table with status Queued, not a prose line
// that says a number the table below it could already show.
import { useQueryClient } from "@tanstack/react-query";
import type { ProcessingBatch } from "@lfb/shared";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner } from "../../components/ui/StatusBanner.js";
import { useProgress } from "../../progress/ProgressContext.js";
import { ProcessingItemsTable } from "./ProcessingItemsTable.js";
import { ProcessingBatchesTable } from "./ProcessingBatchesTable.js";
import { api } from "../../api/client.js";
import { groupHalted, haltedWarningDef, type HaltedGroup } from "./haltedWarning.js";
import { sessionCopy } from "./sessionState.js";

/**
 * "All 1,440 files described." — the Finished state's headline (crash_recovery.mdx §5).
 *
 * Built from the recently-finished batches rather than a counter, so it reports what actually completed.
 * Returns undefined when there is nothing to summarize, and the caller falls back to generic copy.
 */
function summarizeFinished(finished: ProcessingBatch[]): string | undefined {
  if (finished.length === 0) return undefined;
  // `ok` alone is "finished" — a refusal is settled but NOT done (processing_batches.mdx §4), so it is
  // reported separately rather than inflating the success headline.
  const done = finished.reduce((n, b) => n + b.ok, 0);
  const rejected = finished.reduce((n, b) => n + b.rejected, 0);
  const failed = finished.reduce((n, b) => n + b.failed, 0);
  if (done === 0 && failed === 0 && rejected === 0) return undefined;
  const label = finished.length === 1 ? finished[0].label : "queued work";
  const head = done > 0 ? `${done.toLocaleString()} ${done === 1 ? "file" : "files"} finished` : "Finished";
  const tail: string[] = [];
  if (rejected > 0) tail.push(`${rejected.toLocaleString()} refused by the provider`);
  if (failed > 0) tail.push(`${failed.toLocaleString()} failed`);
  return tail.length > 0 ? `${head} — ${tail.join(", ")} (${label}).` : `${head} (${label}).`;
}

// The single "work stopped, here's why, here's the fix" banner for one open provider circuit (to_fix.mdx
// §2.4). Standard educate-and-fix surface: warn/amber banner + the blue arrow that opens the popup carrying
// Resume (warnings.mdx §3/§4).
function HaltedBanner({ group }: { group: HaltedGroup }) {
  const def = haltedWarningDef(group);
  return <StatusBanner state={def.state} headline={def.headline} sub={def.sub} warning={def} />;
}

export function ProcessingPage() {
  const { jobs, batches, queuedItems, recentFailures, workers, session } = useProgress();
  // The per-item table (processing.mdx §4.3) shows Running (jobs) + Pending (queuedItems) + Failed
  // (recentFailures) rows; it renders whenever any of those exist.
  const hasItems = jobs.length > 0 || queuedItems.length > 0 || recentFailures.length > 0;
  const nothing = !hasItems && batches.length === 0;

  // Stop a batch (processing_batches.mdx §6.2). Invalidate on settle so the row's "Not attempted" count
  // appears immediately instead of waiting out the poll interval.
  const qc = useQueryClient();
  const stop = (batchId: string): void => {
    void api.stopBatch(batchId).finally(() => void qc.invalidateQueries({ queryKey: ["progress"] }));
  };

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

      {/* The WORKERS read (processing.mdx §3a) — atop the page, above the batches table. It used to live
          inside the "Running now" header, so it vanished whenever a batch was active but no single item
          was running: the parallelism read disappeared exactly when the user wanted it. */}
      {workers && workers.busy > 0 && (
        <div className="text-xs text-black/50" title="Cores in use by background compression & processing (parallelization.mdx §4)">
          {workers.busy} / {workers.budget} workers busy (~{utilPct}% of cores)
        </div>
      )}

      {/* THE BATCHES TABLE — on top (§4.1). One row per bulk run; absent from the DOM at zero batches
          rather than rendering an empty frame. */}
      {batches.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-black/60">Batches</h2>
          <ProcessingBatchesTable batches={batches} onStop={stop} />
        </section>
      )}

      {/* THE ITEMS TABLE — per-file rows (processing.mdx §4.3). The old "Waiting" region is gone: a queued
          file is a ROW here with status Queued, not a prose line reciting a number the table already has. */}
      {hasItems && (
        <section>
          <ProcessingItemsTable jobs={jobs} queuedItems={queuedItems} recentFailures={recentFailures} />
        </section>
      )}
    </div>
  );
}
