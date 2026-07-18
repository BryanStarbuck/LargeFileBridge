// The per-item Processing table (processing.mdx §4.3) — the "Running now" region expanded so every item's
// state is explicit: RUNNING (in parallel), PENDING (queued, not started), FAILED (with reason), grouped
// and sorted Running → Pending → Failed. It reuses the house DataTable (components/table/DataTable.tsx) so
// its responsive priority-drop columns behave exactly like the repo files table (repos.mdx §3.2.1): the
// lowest-priority columns disappear first as the page narrows, the row never wraps.
//
// Rows are the union of three slices of the one GET /api/progress poll (processing.mdx §5):
//   * jobs           → Running  (with done/total/unit → a % where determinate)
//   * queuedItems    → Pending
//   * recentFailures → Failed   (+ reason)  — OR Halted, when the row carries `state: "halted"`
// NOTE: recent DONE rows are intentionally NOT included — the backend does not emit them yet (no `done`
// slice on GET /api/progress). When it does, add a fourth slice here and extend STATE_ORDER.
import { Loader2, Clock3, XCircle, PauseCircle, Ban } from "lucide-react";
import type { ProgressJob, ProgressKind, QueuedItemView, FailedItemView } from "@lfb/shared";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { formatBytes, relativeTime } from "../../lib/format.js";
import { verb } from "../../progress/ProgressContext.js";

// HALTED is its own state, never a flavour of Failed (to_fix.mdx §2.4/§7.3). A halted item was NEVER
// ATTEMPTED — the provider's circuit opened (credits depleted, key revoked) and the queue dropped it rather
// than burn a doomed upload. Rendering it red as "Failed" tells the user their files were tried and are bad,
// and they re-run 1,440 files believing they were attempted. It is a "needs your action" state, so it wears
// the warn/amber language (warnings.mdx §2), not the bad/red one.
//
// REJECTED is likewise its own state, and is the opposite mistake to halted: the provider DID look at this
// file and declined it (ai_description.mdx §2.3). It is a settled ANSWER, already recorded on disk in a
// `.ai_description_rejected` — so it wears SLATE (neutral), never red (nothing is broken) and never amber
// (nothing is owed). Re-running it spends a real provider call to be told the same thing.
type ItemState = "running" | "pending" | "halted" | "rejected" | "failed";

// One flat row for the table — the three server slices normalised into a common shape. Only the fields
// relevant to a given state are populated (a pending item has no progress; a failure has no startedAt).
interface ProcessingItem {
  id: string;
  state: ItemState;
  op: ProgressKind;
  path: string;
  mediaKind?: string | null; // audio / video / image (Kind column) — present for queued items
  sizeBytes?: number;
  durationSec?: number;
  coveredSec?: number; // truncated-transcript covered seconds (failures)
  reason?: string;
  // running-only progress
  done?: number;
  total?: number;
  unit?: string;
  startedAt?: string; // running: when it started
  at?: string; // failed: when it failed
}

// Group order for the default sort: Running (0) → Pending (1) → Halted (2) → Failed (3) (processing.mdx
// §4.3.1). Halted sits in its OWN group next to Pending — that is what it is, work still owed — and never
// inside the Failed group (to_fix.mdx §7.3).
const STATE_ORDER: Record<ItemState, number> = { running: 0, pending: 1, halted: 2, rejected: 3, failed: 4 };
const STATE_LABEL: Record<ItemState, string> = {
  running: "Running",
  pending: "Queued",
  halted: "Not attempted",
  rejected: "Rejected",
  failed: "Failed",
};

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : p;
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

// HH:MM:SS for a media/elapsed duration in seconds (processing.mdx §4.3.2 Duration column).
function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(ss)}`;
}

// Determinate % for a running job, else null (indeterminate / not running).
function jobPct(it: ProcessingItem): number | null {
  if (it.state !== "running") return null;
  if (it.total === undefined || it.done === undefined || it.total <= 0) return null;
  if (it.unit === "%") return Math.min(100, Math.round(it.done));
  return Math.min(100, Math.round((it.done / it.total) * 100));
}

function buildRows(
  jobs: ProgressJob[],
  queuedItems: QueuedItemView[],
  recentFailures: FailedItemView[],
): ProcessingItem[] {
  const rows: ProcessingItem[] = [];
  for (const j of jobs) {
    rows.push({
      id: `run-${j.id}`,
      state: "running",
      op: j.kind,
      path: j.target,
      done: j.done,
      total: j.total,
      unit: j.unit,
      startedAt: j.startedAt,
    });
  }
  queuedItems.forEach((q, i) => {
    rows.push({
      id: `pend-${i}-${q.path}`,
      state: "pending",
      op: q.op,
      path: q.path,
      mediaKind: q.kind,
      sizeBytes: q.sizeBytes,
    });
  });
  recentFailures.forEach((f, i) => {
    // Read the state the backend already sends instead of assuming "failed" (to_fix.mdx §7.3). Absent =
    // a real, attempted failure — that is the field's documented default (FailedItemView.state).
    rows.push({
      id: `fail-${i}-${f.path}`,
      state: f.state === "halted" ? "halted" : f.state === "rejected" ? "rejected" : "failed",
      op: f.op,
      path: f.path,
      reason: f.reason,
      coveredSec: f.coveredSec,
      durationSec: f.durationSec,
      at: f.at,
    });
  });
  // Default grouping Running → Pending → Failed (processing.mdx §4.3.1) — pre-sorted here so the table's
  // initial (empty-sort) order is already grouped; the user can still re-sort any column.
  return rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
}

function StatusChip({ state }: { state: ItemState }) {
  if (state === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--lfb-primary)]/10 px-2 py-0.5 text-xs font-medium text-[var(--lfb-primary)]">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Running
      </span>
    );
  }
  if (state === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-black/50">
        <Clock3 className="h-3 w-3" aria-hidden />
        Queued
      </span>
    );
  }
  if (state === "halted") {
    // Amber, paused, and worded as what happened: this file was never tried (to_fix.mdx §2.4/§7.3).
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-[var(--lfb-warn-bg)] px-2 py-0.5 text-xs font-medium text-[var(--lfb-warn)]"
        title="Never attempted — the AI provider stopped accepting work, so Large File Bridge halted this file instead of burning a doomed upload."
      >
        <PauseCircle className="h-3 w-3" aria-hidden />
        Not attempted
      </span>
    );
  }
  if (state === "rejected") {
    // Slate, and worded as a verdict rather than a fault: the provider looked and said no. Deliberately not
    // red (nothing is broken — a folder of copyrighted slides refusing is the provider working as designed)
    // and not amber (nothing is owed — the answer is already on disk).
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
        title="The AI provider considered this file and declined to describe it. The verdict is recorded beside the media in a .ai_description_rejected file. Re-running spends a real call to be told the same thing — use overwrite to ask it to reconsider."
      >
        <Ban className="h-3 w-3" aria-hidden />
        Rejected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--lfb-bad-bg)] px-2 py-0.5 text-xs font-medium text-[var(--lfb-bad)]">
      <XCircle className="h-3 w-3" aria-hidden />
      Failed
    </span>
  );
}

export function ProcessingItemsTable({
  jobs,
  queuedItems,
  recentFailures,
}: {
  jobs: ProgressJob[];
  queuedItems: QueuedItemView[];
  recentFailures: FailedItemView[];
}) {
  const rows = buildRows(jobs, queuedItems, recentFailures);
  // The Reason column pins itself open whenever a row carries one — failures AND halts both do (§7.3).
  const anyReason = recentFailures.length > 0;

  const columns: LfbColumn<ProcessingItem>[] = [
    {
      // Priority 1 (never dropped) — the state chip (processing.mdx §4.3.2).
      id: "status",
      header: "Status",
      kind: "enum",
      minWidth: 110,
      accessor: (it) => STATE_LABEL[it.state],
      // The vocabulary must carry EVERY state the table can render, or a user cannot isolate the one they
      // came for. `Rejected` is the value the product owner asked for (processing.mdx §4.3.1a).
      filterOptions: ["Running", "Queued", "Not attempted", "Rejected", "Failed"],
      cell: (it) => <StatusChip state={it.state} />,
    },
    {
      // Priority 2 (never dropped) — the item being processed: basename + muted dir path.
      id: "file",
      header: "File",
      kind: "text",
      minWidth: 200,
      accessor: (it) => it.path,
      cell: (it) => {
        const dir = dirname(it.path);
        return (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-black">{basename(it.path)}</span>
            {dir && <span className="truncate text-xs text-black/40">{dir}</span>}
          </span>
        );
      },
    },
    {
      // Priority 3 — determinate % bar (Running), "—" (Pending), fail marker (Failed).
      id: "progress",
      header: "Progress",
      kind: "int",
      priority: 3,
      minWidth: 120,
      // Sort key: running % (0–100); pending/failed sort below running.
      accessor: (it) => jobPct(it) ?? -1,
      sortable: true,
      filterable: false,
      cell: (it) => {
        if (it.state === "failed") return <span className="text-[var(--lfb-bad)]">failed</span>;
        // Halted made no progress because it never started — say so, in amber, not red (to_fix.mdx §7.3).
        if (it.state === "halted") return <span className="text-[var(--lfb-warn)]">not started</span>;
        if (it.state === "pending") return <span className="text-black/20">—</span>;
        const pct = jobPct(it);
        if (pct === null) {
          return (
            <span className="inline-flex items-center gap-1 text-xs text-black/50">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              working
            </span>
          );
        }
        return (
          <span className="flex items-center gap-2">
            <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-slate-100">
              <span className="block h-full rounded-full bg-[var(--lfb-primary)]" style={{ width: `${pct}%` }} />
            </span>
            <span className="shrink-0 text-xs tabular-nums text-black/50">{pct}%</span>
          </span>
        );
      },
    },
    {
      // Priority 4 — media Kind (audio / video / image) where known (transcribe/compress analog).
      id: "kind",
      header: "Kind",
      kind: "enum",
      priority: 4,
      minWidth: 90,
      accessor: (it) => it.mediaKind ?? "",
      filterOptions: ["audio", "video", "image"],
      cell: (it) => (it.mediaKind ? <span className="capitalize">{it.mediaKind}</span> : <span className="text-black/20">—</span>),
    },
    {
      // Priority 5 — file size (present for pending/queued items).
      id: "size",
      header: "Size",
      kind: "bytes",
      priority: 5,
      minWidth: 90,
      align: "right",
      accessor: (it) => it.sizeBytes ?? -1,
      cell: (it) =>
        it.sizeBytes !== undefined ? <span>{formatBytes(it.sizeBytes)}</span> : <span className="text-black/20">—</span>,
    },
    {
      // Priority 6 — media duration (HH:MM:SS), the thing that makes a transcribe run long.
      id: "duration",
      header: "Duration",
      kind: "int",
      priority: 6,
      minWidth: 96,
      align: "right",
      accessor: (it) => it.durationSec ?? -1,
      cell: (it) =>
        it.durationSec !== undefined ? (
          <span className="tabular-nums">{formatDuration(it.durationSec)}</span>
        ) : (
          <span className="text-black/20">—</span>
        ),
    },
    {
      // Priority 7 — Engine. Not available per-row on GET /api/progress yet (processing.mdx §4.3.2 lists it
      // for completeness); show "—" until the backend carries it. Kept so the column set matches the spec.
      id: "engine",
      header: "Engine",
      kind: "text",
      priority: 7,
      minWidth: 110,
      sortable: false,
      filterable: false,
      accessor: () => "",
      cell: () => <span className="text-black/20">—</span>,
    },
    {
      // Priority 8 — Elapsed / Started (running: from startedAt; failed: from `at`).
      id: "started",
      header: "Elapsed",
      kind: "timestamp",
      priority: 8,
      minWidth: 96,
      accessor: (it) => it.startedAt ?? it.at ?? "",
      cell: (it) => {
        const iso = it.startedAt ?? it.at;
        return iso ? <span className="text-black/60">{relativeTime(iso)}</span> : <span className="text-black/20">—</span>;
      },
    },
    {
      // Priority 9 — Reason. Auto-shown (pinned) whenever ANY row is Failed or Halted so the reason is never
      // hidden (processing.mdx §4.3.2); otherwise it is the FIRST column to drop as the page narrows.
      id: "reason",
      header: "Reason",
      kind: "text",
      priority: anyReason ? undefined : 9,
      minWidth: 160,
      sortable: false,
      filterable: false,
      accessor: (it) => it.reason ?? "",
      cell: (it) => {
        if (it.state !== "failed" && it.state !== "halted") return <span className="text-black/20">—</span>;
        const covered =
          it.coveredSec !== undefined && it.durationSec !== undefined
            ? `covered ${formatDuration(it.coveredSec)} of ${formatDuration(it.durationSec)}`
            : null;
        // Halted reasons are the provider's actionable prose ("gemini credits are depleted — top up at
        // ai.studio, then Resume") and read in amber; only a real failure is red (to_fix.mdx §7.3).
        const tone = it.state === "halted" ? "var(--lfb-warn)" : "var(--lfb-bad)";
        return (
          <span className="flex min-w-0 flex-col">
            <span className="truncate" style={{ color: tone }}>
              {it.reason}
            </span>
            {covered && <span className="truncate text-xs text-black/40">{covered}</span>}
          </span>
        );
      },
    },
  ];

  return (
    <DataTable
      tableId="processing-items"
      data={rows}
      columns={columns}
      getRowId={(it) => it.id}
      searchKeys={(it) => `${verb(it.op)} ${it.path} ${it.reason ?? ""}`}
      itemNoun="items"
      // Content (Waiting + Batches) renders BELOW this table on the Processing page, so it keeps a bounded
      // height instead of filling the viewport (charter Tables / repos.mdx §3.3.1).
      fillHeight={false}
    />
  );
}
