// The landing screen (repos.mdx): one TanStack table of managed repos + Add repo + Rescan.
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw, Plus, Bookmark } from "lucide-react";
import { toast } from "sonner";
import type { RepoRow, RepoStatus } from "@lfb/shared";
import { api } from "../../api/client.js";
import { streamRepoRows } from "../../api/streamQueries.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { RepoGear, RepoKebab } from "../../components/menu/RowKebabs.js";
import { PageActions } from "../../components/menu/PageActions.js";
import { pinAllRepos } from "../../components/menu/domainActions.js";
import type { Action } from "../../components/menu/EntityMenu.js";
import { RepoStatusPill } from "../../components/Pill.js";
import { relativeTime, absoluteTime, middleTruncate, formatBytes } from "../../lib/format.js";
import { useLiveRefresh } from "../../lib/useLiveRefresh.js";
import { useCensusPending } from "../../lib/useCensusPending.js";
import { clientLog } from "../../lib/clientLog.js";

const STATUS_OPTIONS: RepoStatus[] = [
  "up_to_date",
  "pinning",
  "behind",
  "needs_review",
  "error",
  "never",
];

/** The large files a row's counts cover — the five buckets are disjoint and exhaustive by construction
 *  (units.service `repoRowStats`), so their sum IS the repo's tracked-file total. Derived rather than sent
 *  so the Files column can never disagree with the columns beside it. */
function totalFiles(r: RepoRow): number {
  const c = r.counts;
  return c.pinned + c.pending + c.undecided + c.ignored + c.pinnedForeign;
}

export function ReposPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  // STREAMED (performance.mdx P-37): the rows land in batches as the server composes them, so the table
  // starts filling in tens of milliseconds instead of after the last repo on the machine. The cache key and
  // its contents are unchanged — every mutation, invalidation and optimistic patch below still owns it.
  const { data: repos, isLoading } = useQuery({
    queryKey: ["repos"],
    queryFn: ({ signal }) => streamRepoRows(qc, signal),
  });

  // The scan runs server-side. The always-mounted ScanProgressBar is the single poller for
  // ["scanStatus"] (performance.mdx P-07) — here we just subscribe to that SHARED cache, with no second
  // competing interval, so the Rescan button reflects a scan running anywhere (even one started before
  // this page mounted) without doubling the request rate.
  const { data: scan } = useQuery({ queryKey: ["scanStatus"], queryFn: api.scanStatus });
  const scanning = scan?.status === "running";
  const census = useCensusPending();

  // Live refresh (performance.mdx Aspect 6b): a backbone reconcile or scan changes the list, an open
  // page learns without a reload.
  useLiveRefresh(["repos", "scans"], [["repos"], ["scanStatus"]]);

  // When a scan transitions out of "running", refresh the repos table with the fresh counts.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !scanning) {
      qc.invalidateQueries({ queryKey: ["repos"] });
      if (scan?.status === "error") toast.error(scan.error ?? "Scan failed");
    }
    wasRunning.current = scanning;
  }, [scanning, scan?.status, scan?.error, qc]);

  const rescan = useMutation({
    mutationFn: api.rescan,
    onSuccess: (r) => {
      if (!r.started) toast.info("A scan is already running");
      qc.invalidateQueries({ queryKey: ["scanStatus"] });
    },
    onError: (e: Error) => {
      clientLog.error("ReposPage.rescan", e);
      toast.error(e.message);
    },
  });

  // Bookmark toggle (repos.mdx §8) — optimistic: flip the row in cache immediately, roll back on error.
  const toggleBookmark = useMutation({
    mutationFn: ({ repoId, bookmarked }: { repoId: string; bookmarked: boolean }) =>
      api.toggleBookmark(repoId, bookmarked),
    onMutate: async ({ repoId, bookmarked }) => {
      await qc.cancelQueries({ queryKey: ["repos"] });
      const prev = qc.getQueryData<RepoRow[]>(["repos"]);
      qc.setQueryData<RepoRow[]>(["repos"], (old) =>
        old?.map((r) => (r.repoId === repoId ? { ...r, bookmarked } : r)),
      );
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      clientLog.error("ReposPage.toggleBookmark", e);
      if (ctx?.prev) qc.setQueryData(["repos"], ctx.prev);
      toast.error(e.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["repos"] }),
  });

  const columns: LfbColumn<RepoRow>[] = [
    {
      // Leading favorite toggle — a control cell (never opens the repo). Sort/filter on yes/no.
      id: "bookmark",
      header: "Bookmark",
      kind: "enum",
      filterOptions: ["yes", "no"],
      accessor: (r) => (r.bookmarked ? "yes" : "no"),
      cell: (r) => (
        <BookmarkToggle
          on={r.bookmarked}
          onToggle={() =>
            toggleBookmark.mutate({ repoId: r.repoId, bookmarked: !r.bookmarked })
          }
        />
      ),
    },
    {
      id: "name",
      header: "Repo",
      kind: "text",
      accessor: (r) => r.name,
      cell: (r) => <span className="font-semibold text-black">{r.name}</span>,
    },
    // Responsive column priority (repos.mdx §3.2.1): LOWER number = kept longer; undefined = pinned
    // (bookmark · name · status never hide). Peers (10) hides first, then Ignored (8), Path (7)…
    {
      id: "path",
      header: "Path",
      kind: "text",
      priority: 7,
      minWidth: 160,
      accessor: (r) => r.path,
      cell: (r) => (
        <span className="text-black/50" title={r.path}>
          {middleTruncate(r.path, 40)}
        </span>
      ),
    },
    { id: "pinned", header: "Pinned", kind: "int", align: "right", priority: 6, minWidth: 80, accessor: (r) => r.counts.pinned,
      cell: (r) => <span className="text-green-700">{r.counts.pinned}</span> },
    { id: "pending", header: "Pending", kind: "int", align: "right", priority: 5, minWidth: 80, accessor: (r) => r.counts.pending,
      cell: (r) => <span className={r.counts.pending > 0 ? "text-amber-600" : ""}>{r.counts.pending}</span> },
    { id: "undecided", header: "Undecided", kind: "int", align: "right", priority: 3, minWidth: 88, accessor: (r) => r.counts.undecided,
      cell: (r) => <span className={r.counts.undecided > 0 ? "text-[var(--lfb-primary)] font-medium" : ""}>{r.counts.undecided}</span> },
    { id: "ignored", header: "Ignored", kind: "int", align: "right", priority: 8, minWidth: 78, accessor: (r) => r.counts.ignored,
      cell: (r) => <span className="text-black/40">{r.counts.ignored}</span> },
    // Already pinned (repos.mdx §3.2 col 11) — `counts.pinnedForeign`. The backend has always counted these
    // and the table never showed them, so an undecided file whose bytes another IPFS tool already pinned on
    // this node was subtracted from Undecided and added to nothing: the four count columns stopped adding
    // up to the repo's file total and there was no cell to explain the gap.
    { id: "alreadyPinned", header: "Already pinned", kind: "int", align: "right", priority: 14, minWidth: 116,
      accessor: (r) => r.counts.pinnedForeign,
      cell: (r) => (
        <span className={r.counts.pinnedForeign > 0 ? "text-green-700" : "text-black/40"}
          title="Undecided files whose bytes are already pinned on this computer by another IPFS tool">
          {r.counts.pinnedForeign}
        </span>
      ) },
    // The denominator (§3.2 col 8). Without it an all-zero row is unreadable: a repo with no large files at
    // all and a repo whose scan never ran look identical. Derived as the sum of the five count columns, so
    // the row is self-checking — if Files disagrees with what the columns add up to, one of them is wrong.
    { id: "files", header: "Files", kind: "int", align: "right", priority: 12, minWidth: 76,
      accessor: (r) => totalFiles(r),
      cell: (r) => (
        <span className={totalFiles(r) === 0 ? "text-black/40" : ""}
          title="Large files Large File Bridge tracks in this repo (small analysis-only media excluded)">
          {totalFiles(r)}
        </span>
      ) },
    { id: "size", header: "Size", kind: "bytes", align: "right", priority: 9, minWidth: 88,
      accessor: (r) => r.bytes.total,
      cell: (r) => (
        <span className="text-black/60"
          title={r.bytes.total > 0 ? `${formatBytes(r.bytes.pinned)} of it pinned on this computer` : undefined}>
          {r.bytes.total > 0 ? formatBytes(r.bytes.total) : "—"}
        </span>
      ) },
    // Bytes owed IN (§3.2 col 13) — the remote-only rows (storage_company.mdx §8.5). These files are inside
    // Pending/Undecided already; this is the same files on the "where are the bytes?" axis, and it is the
    // number a freshly-set-up second computer needs most.
    { id: "missingHere", header: "Missing here", kind: "int", align: "right", priority: 13, minWidth: 104,
      accessor: (r) => r.missingHere,
      cell: (r) => (
        <span className={r.missingHere > 0 ? "text-amber-600" : "text-black/40"}
          title="Files another of your computers has that this one does not — pull them down">
          {r.missingHere}
        </span>
      ) },
    // The risk number (§3.2 col 12) — the repo-level roll-up of the One-repo `Not backed up` tile.
    { id: "notBackedUp", header: "Not backed up", kind: "int", align: "right", priority: 11, minWidth: 112,
      accessor: (r) => r.notBackedUp,
      cell: (r) => (
        <span className={r.notBackedUp > 0 ? "text-red-600 font-medium" : "text-black/40"}
          title="Pinned files that exist only on this computer — no other machine has a copy">
          {r.notBackedUp}
        </span>
      ) },
    // Peers = your OTHER computers. Red 0 is the "nothing is backing this up" alarm (§4.1), so it must only
    // fire when there is something to back up: a repo with no pinned files has no redundancy to be missing,
    // and painting its 0 red made every repo without large files shout for attention it did not need.
    { id: "peers", header: "Peers", kind: "int", align: "right", priority: 10, minWidth: 72, accessor: (r) => r.peerCount,
      cell: (r) =>
        r.counts.pinned === 0 && r.peerCount === 0 ? (
          <span className="text-black/40" title="Nothing pinned here yet — no copies to count">—</span>
        ) : (
          <span className={r.peerCount === 0 ? "text-red-600" : ""}
            title="Your other computers that hold at least one of this repo's files">
            {r.peerCount}
          </span>
        ) },
    { id: "lastPin", header: "Last pin", kind: "timestamp", priority: 4, minWidth: 96, accessor: (r) => r.lastPinAt,
      cell: (r) => <span title={absoluteTime(r.lastPinAt)}>{relativeTime(r.lastPinAt)}</span> },
    // When the census behind every count on this row was taken (§3.2 col 14). A stale scan is the single
    // most common reason a number here is not what the disk says.
    { id: "lastScan", header: "Last scan", kind: "timestamp", priority: 15, minWidth: 96, accessor: (r) => r.lastScanAt,
      cell: (r) => (
        <span className="text-black/50" title={absoluteTime(r.lastScanAt)}>{relativeTime(r.lastScanAt)}</span>
      ) },
    { id: "status", header: "Status", kind: "enum", accessor: (r) => r.status, filterOptions: STATUS_OPTIONS,
      cell: (r) => <RepoStatusPill status={r.status} /> },
  ];

  // The action-links row (page_actions.mdx §4 — Repos list): Rescan all · Pin all. Rows are repos, not
  // files, so there is NO producing pair here. + Add repo stays the header primary.
  const repoListActions: Action[] = [
    {
      id: "rescan-all",
      label: "Rescan all",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      group: "Work",
      disabled: scanning || rescan.isPending,
      onSelect: () => rescan.mutate(),
    },
    pinAllRepos(),
  ];

  return (
    // Full-page-height (repos.mdx §3.3.1): a flex column so the DataTable fills to the bottom.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex shrink-0 items-center justify-between">
        <h1 className="text-2xl font-bold">Repos</h1>
        <div className="flex gap-2">
          <button
            onClick={() => rescan.mutate()}
            disabled={scanning || rescan.isPending}
            className="lfb-btn lfb-btn-secondary"
          >
            <RefreshCw className={`h-4 w-4 ${scanning ? "animate-spin" : ""}`} />{" "}
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="lfb-btn lfb-btn-primary"
          >
            <Plus className="h-4 w-4" /> Add repo
          </button>
        </div>
      </div>

      {/* Page action-links row, directly under the title (page_actions.mdx §3). */}
      <div className="mb-2 shrink-0">
        <PageActions actions={repoListActions} />
      </div>

      {/* Every per-repo number in the table below — peers, pinned, undecided — is recomputed by the same
          background passes, so the list needs the same honesty the metric tiles got (useCensusPending).
          Without it a repo reads a settled-looking count that quietly changes minutes later. */}
      {/* The row is always reserved so a pass that starts long after the page settled does not resize the
          table under the user — same rule as the metrics strip (MetricsStrip.tsx). */}
      <div className="mb-2 flex h-4 shrink-0 items-center" aria-live="polite">
        {census.active && (
          <p className="flex items-center gap-1.5 text-xs text-black/45">
            <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
            {census.label} — these counts are still going up.
          </p>
        )}
      </div>

      <DataTable
        tableId="repos"
        data={repos ?? []}
        columns={columns}
        searchKeys={(r) => `${r.name} ${r.path}`}
        getRowId={(r) => r.repoId}
        onRowClick={(r) => navigate({ to: "/repos/$repoId", params: { repoId: r.repoId } })}
        // ⌘/Ctrl/middle-click opens the row's destination in a new tab, like any link (tables.mdx §4d).
        rowHref={(r) => `/repos/${encodeURIComponent(r.repoId)}`}
        // Gear → per-repo settings, sitting just left of the ⋮ kebab (repo_settings.mdx §1).
        rowMenu={(r) => (
          <>
            <RepoGear repo={r} />
            <RepoKebab repo={r} />
          </>
        )}
        itemNoun="repos"
        // Default sort (tables.mdx §3.4): bookmarked repos float to the top, then by name.
        defaultSort={[
          { id: "bookmark", desc: true },
          { id: "name", desc: false },
        ]}
        loading={isLoading}
        empty={
          <button onClick={() => setShowAdd(true)} className="mx-auto block rounded-lg border-2 border-dashed border-[var(--lfb-border)] px-8 py-10 text-black/60">
            No repos yet. Add your first repo →
          </button>
        }
      />

      {showAdd && <AddRepoDialog onClose={() => setShowAdd(false)} />}
    </div>
  );
}

// The leading ribbon toggle (repos.mdx §8.1). On = solid yellow (filled + stroked). Off = thin gray
// outline with an empty (white) fill. A control cell: the click stops propagation so it never opens
// the repo row (§8.2). Keyboard-accessible via the native <button>.
function BookmarkToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      aria-pressed={on}
      aria-label={on ? "Bookmarked — click to remove" : "Bookmark this repo"}
      title={on ? "Bookmarked" : "Bookmark"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="lfb-icon-btn p-0.5"
    >
      <Bookmark
        className={`h-4 w-4 ${on ? "text-yellow-500" : "text-black/25 hover:text-yellow-400"}`}
        fill={on ? "currentColor" : "none"}
        strokeWidth={1.5}
      />
    </button>
  );
}

function AddRepoDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const add = useMutation({
    mutationFn: () => api.addRepo(path),
    onSuccess: () => {
      toast.success("Repo added");
      qc.invalidateQueries({ queryKey: ["repos"] });
      onClose();
    },
    onError: (e: Error) => {
      clientLog.error("ReposPage.addRepo", e);
      toast.error(e.message);
    },
  });
  return (
    <div className="lfb-scrim fixed inset-0 z-20 grid place-items-center p-4" onClick={onClose}>
      <div className="w-96 lfb-modal p-5 " onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-lg font-semibold">Add repo</h2>
        <p className="mb-3 text-sm text-black/60">Enter the absolute path to a git working tree.</p>
        <input
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && path && add.mutate()}
          placeholder="~/repos/LargeFileBridge"
          className="lfb-input w-full px-2 py-1.5 text-sm focus:border-[var(--lfb-primary)]"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="lfb-btn lfb-btn-ghost">
            Cancel
          </button>
          <button
            onClick={() => add.mutate()}
            disabled={!path || add.isPending}
            className="lfb-btn lfb-btn-primary"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
