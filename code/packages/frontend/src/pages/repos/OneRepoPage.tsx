// The per-repo screen (one_repo.mdx): status strip + files table where decisions are made.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { RefreshCw, Settings, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import type { FileRow, Decision, RepoDetail } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { RepoStatusPill, TransferPill } from "../../components/Pill.js";
import { relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";

const DECISIONS: Decision[] = ["sync", "ignore", "undecided"];

export function OneRepoPage() {
  const { repoId } = useParams({ from: "/repos/$repoId" });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  const { data: detail, isLoading } = useQuery({
    queryKey: ["repo", repoId],
    queryFn: () => api.repo(repoId),
  });

  const setDecision = useMutation({
    mutationFn: ({ paths, decision }: { paths: string[]; decision: Decision }) =>
      api.setDecision(repoId, paths, decision),
    onSuccess: (d: RepoDetail) => qc.setQueryData(["repo", repoId], d),
    onError: (e: Error) => toast.error(e.message),
  });

  const syncNow = useMutation({
    mutationFn: (paths?: string[]) => api.syncNow(repoId, paths),
    onSuccess: (d: RepoDetail) => {
      qc.setQueryData(["repo", repoId], d);
      toast.success("Sync complete");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ipfsDown = detail?.ipfs === "unreachable";

  const columns: LfbColumn<FileRow>[] = [
    {
      id: "path",
      header: "File",
      kind: "text",
      accessor: (f) => f.path,
      cell: (f) => {
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
        const name = f.path.slice(dir.length);
        return (
          <span title={f.path}>
            <span className="text-black/40">{middleTruncate(dir, 30)}</span>
            <span className="font-medium">{name}</span>
          </span>
        );
      },
    },
    { id: "size", header: "Size", kind: "bytes", align: "right", accessor: (f) => f.sizeBytes,
      cell: (f) => formatBytes(f.sizeBytes) },
    {
      id: "decision",
      header: "Decision",
      kind: "enum",
      accessor: (f) => f.decision,
      filterOptions: DECISIONS,
      cell: (f) => (
        <select
          value={f.decision}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDecision.mutate({ paths: [f.path], decision: e.target.value as Decision })}
          className="rounded border border-[var(--lfb-border)] px-1 py-0.5 text-xs"
        >
          {DECISIONS.map((d) => (
            <option key={d} value={d}>
              {d[0].toUpperCase() + d.slice(1)}
            </option>
          ))}
        </select>
      ),
    },
    { id: "status", header: "Status", kind: "enum", accessor: (f) => f.transfer,
      cell: (f) => <TransferPill status={f.transfer} /> },
    { id: "peers", header: "Peers", kind: "int", align: "right", accessor: (f) => f.peers.length,
      cell: (f) => <span className={f.decision === "sync" && f.peers.length === 0 ? "text-red-600" : ""}>{f.peers.length}</span> },
    { id: "cid", header: "CID", kind: "text", accessor: (f) => f.cid,
      cell: (f) => f.cid ? <code className="text-xs text-black/60" title={f.cid} onClick={() => navigator.clipboard?.writeText(f.cid!)}>{middleTruncate(f.cid, 16)}</code> : <span className="text-black/20">—</span> },
    { id: "changed", header: "Changed", kind: "timestamp", accessor: (f) => f.changedAt,
      cell: (f) => <span title={absoluteTime(f.changedAt)}>{relativeTime(f.changedAt)}</span> },
  ];

  const c = detail?.counts;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link to="/" className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
            <ChevronLeft className="h-4 w-4" /> Repos / <span className="font-semibold text-black">{detail?.name}</span>
          </Link>
          <div className="text-sm text-black/50">{detail?.path}</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => navigate({ to: "/repos/$repoId/settings", params: { repoId } })}
            title="Repo settings"
            className="rounded-md border border-[var(--lfb-border)] p-2 hover:bg-slate-100"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            onClick={() => syncNow.mutate(undefined)}
            disabled={syncNow.isPending || ipfsDown}
            title={ipfsDown ? "IPFS node unreachable" : "Sync this repo now"}
            className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${syncNow.isPending ? "animate-spin" : ""}`} />
            {syncNow.isPending ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>

      {/* Status strip */}
      <div className="my-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-[var(--lfb-border)] px-4 py-2 text-sm">
        <span>Sync <b>{detail?.synced ? "on" : "off"}</b></span>
        <span className="flex items-center gap-1">Status {detail && <RepoStatusPill status={detail.status} />}</span>
        <span>Peers <b>{detail?.peerCount ?? 0}</b></span>
        <span>Last sync <b title={absoluteTime(detail?.lastSyncAt ?? null)}>{relativeTime(detail?.lastSyncAt ?? null)}</b></span>
        <span className={ipfsDown ? "text-red-600" : "text-green-700"}>
          IPFS {ipfsDown ? "unreachable" : "ok"}
        </span>
      </div>

      {ipfsDown && (
        <div className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          The local IPFS node is unreachable — Sync now and transfers are paused, but decisions still save.
        </div>
      )}

      {/* Summary counts (quick filters would live here) */}
      {c && (
        <div className="mb-1 text-sm text-black/70">
          {c.synced + c.pending} Sync · <span className={c.undecided > 0 ? "text-[var(--lfb-primary)] font-medium" : ""}>{c.undecided} Undecided</span> · {c.ignored} Ignore
        </div>
      )}

      <DataTable
        data={detail?.files ?? []}
        columns={columns}
        searchKeys={(f) => f.path}
        getRowId={(f) => f.fileId}
        itemNoun="files"
        loading={isLoading}
        selection={{
          selected,
          onChange: setSelected,
          bulk: selected.size > 0 ? (
            <div className="relative">
              <button onClick={() => setBulkOpen((o) => !o)} className="rounded-md border border-[var(--lfb-border)] px-2 py-1 text-sm hover:bg-slate-100">
                ⋮ {selected.size} selected
              </button>
              {bulkOpen && (
                <div className="absolute right-0 z-10 mt-1 w-48 rounded-lg border border-[var(--lfb-border)] bg-white shadow-lg py-1">
                  {DECISIONS.map((d) => (
                    <button key={d} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100"
                      onClick={() => { setDecision.mutate({ paths: [...selected], decision: d }); setBulkOpen(false); }}>
                      Set to {d[0].toUpperCase() + d.slice(1)}
                    </button>
                  ))}
                  <button className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100 text-[var(--lfb-primary)]"
                    onClick={() => { syncNow.mutate([...selected]); setBulkOpen(false); }}>
                    Sync now (selected)
                  </button>
                </div>
              )}
            </div>
          ) : undefined,
        }}
        empty={<p className="text-center text-black/60">No large files found in this repo.</p>}
      />
    </div>
  );
}
