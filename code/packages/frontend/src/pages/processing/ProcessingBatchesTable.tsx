// The BATCHES table — the top table of the Processing page (processing_batches.mdx §4, processing.mdx §4.1).
//
// One row per bulk run. It replaces the old `BatchCard` list, which was compress-only in both its data and
// its copy ("All {done} files compressed." / "Originals: {disposition}") — and, because only "Compress
// inside" ever opened a batch, a 1,440-file describe run rendered ZERO cards.
//
// The five-way taxonomy (§4) is the point of this table: ok / rejected / failed / halted / running. `done`
// is the name of `ok` ALONE — folding a refusal into it is the defect this closes.
import { CheckCircle2, Loader2, AlertTriangle, PauseCircle, Ban } from "lucide-react";
import type { ProcessingBatch } from "@lfb/shared";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";

/** A batch renders a Rejected number only where a provider RENDERS A VERDICT — today `describe` alone (§4.5). */
export function isProviderJudged(b: ProcessingBatch): boolean {
  return b.kind === "describe" || b.kind === "mixed";
}

/**
 * The rejection rate (§4.4) — `rejected / (ok + rejected)`.
 *
 * `failed` and `halted` are excluded from BOTH sides: they never got a verdict, so they can neither be a
 * rejection nor evidence of non-rejection. A file that timed out tells you nothing about whether the
 * provider would have refused it, and letting it vote either way corrupts the one number on the page that
 * describes the PROVIDER'S JUDGMENT rather than our plumbing.
 */
export function rejectionRate(b: ProcessingBatch): { answered: number; rate: number | null } {
  const answered = b.ok + b.rejected;
  // The SMALL-SAMPLE RULE (§4.4): a percentage over a handful of files is noise wearing a lab coat — the
  // first file coming back refused would read "100% rejected" and send the user to debug a healthy batch.
  // A display rule, not a measurement rule: `rejected` is counted from the first file either way.
  return { answered, rate: answered >= 20 ? b.rejected / answered : null };
}

const AMBER = "#b45309";

function StateIcon({ b }: { b: ProcessingBatch }) {
  if (!b.finishedAt) return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--lfb-primary)]" />;
  if (b.stoppedBy === "user") return <Ban className="h-4 w-4 shrink-0" style={{ color: AMBER }} />;
  if (b.failed > 0) return <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--lfb-bad)]" />;
  if (b.halted > 0) return <PauseCircle className="h-4 w-4 shrink-0" style={{ color: AMBER }} />;
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />;
}

function settledOf(b: ProcessingBatch): number {
  return b.ok + b.rejected + b.failed + b.halted;
}

export function ProcessingBatchesTable({ batches, onStop }: { batches: ProcessingBatch[]; onStop?: (id: string) => void }) {
  const columns: LfbColumn<ProcessingBatch>[] = [
    {
      id: "batch",
      header: "Batch",
      kind: "text",
      accessor: (b) => b.label,
      minWidth: 220,
      cell: (b) => (
        <span className="flex min-w-0 items-center gap-2">
          <StateIcon b={b} />
          <span className="truncate font-medium text-black">{b.label}</span>
        </span>
      ),
    },
    {
      id: "progress",
      header: "Progress",
      kind: "text",
      priority: 2,
      minWidth: 130,
      // `total` is FIXED at Confirm and never moves (§2) — the number the user read on the button. A bar
      // whose denominator recomputed mid-run would go BACKWARDS and disagree with the toast.
      accessor: (b) => (b.total > 0 ? settledOf(b) / b.total : 1),
      cell: (b) => {
        const settled = settledOf(b);
        const pct = b.total > 0 ? Math.min(100, Math.round((settled / b.total) * 100)) : 100;
        return (
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-black/60">
              {settled.toLocaleString()} / {b.total.toLocaleString()}
            </span>
            {!b.finishedAt && (
              <span className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <span
                  className="block h-full rounded-full bg-[var(--lfb-primary)] transition-[width] duration-300"
                  style={{ width: `${pct}%` }}
                />
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "done",
      header: "Done",
      kind: "int",
      align: "right",
      priority: 3,
      minWidth: 70,
      // The plain success count — `ok` ALONE (§4). Never `ok + rejected`.
      accessor: (b) => b.ok,
      cell: (b) => <span className="text-emerald-700">{b.ok.toLocaleString()}</span>,
    },
    {
      id: "rejected",
      header: "Rejected",
      kind: "int",
      align: "right",
      priority: 3,
      minWidth: 96,
      accessor: (b) => (isProviderJudged(b) ? b.rejected : -1),
      cell: (b) => {
        // `—`, NOT `0` (§4.5). `0` is a measurement; `—` is "this question does not apply." A column of
        // zeros down every compress batch would imply we checked and found none, and would train the user
        // to ignore the column exactly where it carries the number they asked for.
        if (!isProviderJudged(b)) return <span className="text-black/25">—</span>;
        const { answered, rate } = rejectionRate(b);
        // AMBER, but never a pause (§4.4): a high rejection rate may mean nothing is wrong at all — a
        // folder of copyrighted slides refusing at 40% is the provider working exactly as designed, and
        // every refusal is settled, cheap and correct. Inform, never interrupt.
        const hot = rate !== null && rate > 0.2;
        return (
          <span
            title={`${b.rejected.toLocaleString()} of ${answered.toLocaleString()} answered`}
            // Slate/violet, NEVER red — a refusal is a verdict, not a fault (§4.2).
            style={{ color: hot ? AMBER : b.rejected > 0 ? "#475569" : undefined }}
          >
            {b.rejected.toLocaleString()}
            {rate !== null && <span className="text-xs"> · {Math.round(rate * 100)}%</span>}
          </span>
        );
      },
    },
    {
      id: "problems",
      header: "Problems",
      kind: "int",
      align: "right",
      priority: 4,
      minWidth: 96,
      accessor: (b) => b.failed + b.halted,
      cell: (b) => {
        if (b.failed === 0 && b.halted === 0) return <span className="text-black/30">0</span>;
        return (
          <span className="flex items-center justify-end gap-1.5">
            {b.failed > 0 && <span className="text-[var(--lfb-bad)]">{b.failed.toLocaleString()} failed</span>}
            {/* "Not attempted", amber — a halt costs nothing to re-run and must never read as a failure (§4.3). */}
            {b.halted > 0 && (
              <span style={{ color: AMBER }} title="Not attempted — costs nothing to re-run">
                {b.halted.toLocaleString()} not attempted
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "started",
      header: "Started",
      kind: "timestamp",
      priority: 5,
      minWidth: 110,
      accessor: (b) => b.startedAt,
      cell: (b) => <span className="text-black/50">{new Date(b.startedAt).toLocaleTimeString()}</span>,
    },
    {
      id: "stop",
      header: "",
      kind: "text",
      align: "right",
      minWidth: 64,
      accessor: () => "",
      cell: (b) =>
        b.finishedAt || !onStop ? null : (
          <button
            type="button"
            onClick={() => onStop(b.batchId)}
            title="Stop this batch — queued files are marked Not attempted and can be re-run for free"
            className="rounded px-2 py-0.5 text-xs text-black/60 hover:bg-slate-100"
          >
            Stop
          </button>
        ),
    },
  ];

  return (
    <DataTable
      data={batches}
      columns={columns}
      getRowId={(b) => b.batchId}
      searchKeys={(b) => `${b.label} ${b.scope} ${b.kind}`}
      itemNoun="batches"
      // Content (the items table) renders BELOW this table, so it keeps a bounded height rather than
      // filling the viewport — the charter's Tables exception (processing.mdx §4.1.1).
      fillHeight={false}
    />
  );
}
