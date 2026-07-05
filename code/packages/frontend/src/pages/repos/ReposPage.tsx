// The landing screen (repos.mdx): one TanStack table of managed repos + Add repo + Rescan.
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw, Plus, Bookmark } from "lucide-react";
import { toast } from "sonner";
import type { RepoRow, RepoStatus } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { RepoKebab } from "../../components/menu/RowKebabs.js";
import { RepoStatusPill } from "../../components/Pill.js";
import { relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";
import { clientLog } from "../../lib/clientLog.js";

const STATUS_OPTIONS: RepoStatus[] = [
  "up_to_date",
  "syncing",
  "behind",
  "needs_review",
  "error",
  "never",
];

export function ReposPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  const { data: repos, isLoading } = useQuery({ queryKey: ["repos"], queryFn: api.repos });

  // The scan runs server-side. The always-mounted ScanProgressBar is the single poller for
  // ["scanStatus"] (performance.mdx P-07) — here we just subscribe to that SHARED cache, with no second
  // competing interval, so the Rescan button reflects a scan running anywhere (even one started before
  // this page mounted) without doubling the request rate.
  const { data: scan } = useQuery({ queryKey: ["scanStatus"], queryFn: api.scanStatus });
  const scanning = scan?.status === "running";

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
    {
      id: "path",
      header: "Path",
      kind: "text",
      accessor: (r) => r.path,
      cell: (r) => (
        <span className="text-black/50" title={r.path}>
          {middleTruncate(r.path, 40)}
        </span>
      ),
    },
    { id: "synced", header: "Synced", kind: "int", align: "right", accessor: (r) => r.counts.synced,
      cell: (r) => <span className="text-green-700">{r.counts.synced}</span> },
    { id: "pending", header: "Pending", kind: "int", align: "right", accessor: (r) => r.counts.pending,
      cell: (r) => <span className={r.counts.pending > 0 ? "text-amber-600" : ""}>{r.counts.pending}</span> },
    { id: "undecided", header: "Undecided", kind: "int", align: "right", accessor: (r) => r.counts.undecided,
      cell: (r) => <span className={r.counts.undecided > 0 ? "text-[var(--lfb-primary)] font-medium" : ""}>{r.counts.undecided}</span> },
    { id: "ignored", header: "Ignored", kind: "int", align: "right", accessor: (r) => r.counts.ignored,
      cell: (r) => <span className="text-black/40">{r.counts.ignored}</span> },
    { id: "peers", header: "Peers", kind: "int", align: "right", accessor: (r) => r.peerCount,
      cell: (r) => <span className={r.peerCount === 0 ? "text-red-600" : ""}>{r.peerCount}</span> },
    { id: "lastSync", header: "Last sync", kind: "timestamp", accessor: (r) => r.lastSyncAt,
      cell: (r) => <span title={absoluteTime(r.lastSyncAt)}>{relativeTime(r.lastSyncAt)}</span> },
    { id: "status", header: "Status", kind: "enum", accessor: (r) => r.status, filterOptions: STATUS_OPTIONS,
      cell: (r) => <RepoStatusPill status={r.status} /> },
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
            className="flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${scanning ? "animate-spin" : ""}`} />{" "}
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white"
          >
            <Plus className="h-4 w-4" /> Add repo
          </button>
        </div>
      </div>

      <DataTable
        data={repos ?? []}
        columns={columns}
        searchKeys={(r) => `${r.name} ${r.path}`}
        getRowId={(r) => r.repoId}
        onRowClick={(r) => navigate({ to: "/repos/$repoId", params: { repoId: r.repoId } })}
        rowMenu={(r) => <RepoKebab repo={r} />}
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
      className="grid place-items-center rounded p-0.5 hover:bg-slate-100"
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
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/30" onClick={onClose}>
      <div className="w-96 rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-lg font-semibold">Add repo</h2>
        <p className="mb-3 text-sm text-black/60">Enter the absolute path to a git working tree.</p>
        <input
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && path && add.mutate()}
          placeholder="~/BGit/Bryan_git/LargeFileBridge"
          className="w-full rounded-md border border-[var(--lfb-border)] px-2 py-1.5 text-sm outline-none focus:border-[var(--lfb-primary)]"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm hover:bg-slate-100">
            Cancel
          </button>
          <button
            onClick={() => add.mutate()}
            disabled={!path || add.isPending}
            className="rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
