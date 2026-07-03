// The per-repo screen (one_repo.mdx + use_cases.mdx §5.4). The StatusBanner here is the UC-2
// diagnosis engine: "a file didn't show up on my other computer" — it names the FIRST real cause
// worst-first (IPFS down → synced-but-no-peers → undecided → pending) and hands over the one fix,
// so a non-expert never has to guess which of the four it was. The files table is unchanged; the old
// status strip moves into a collapsed "Repo details" disclosure.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { RefreshCw, Settings, ChevronLeft, Network, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import type { FileRow, Decision, RepoDetail } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { RepoStatusPill, TransferPill } from "../../components/Pill.js";
import { EntityKebab } from "../../components/menu/EntityMenu.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner, FixButton } from "../../components/ui/StatusBanner.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { type Health } from "../../components/ui/health.js";
import { relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";

const DECISIONS: Decision[] = ["sync", "ignore", "undecided"];

export function OneRepoPage() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
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
    // Trailing ⋯ kebab — the file entity menu (menus.mdx §3), same catalog as View-one-file.
    { id: "menu", header: "", kind: "text", sortable: false, filterable: false, align: "right",
      accessor: () => "",
      cell: (f) =>
        detail?.path ? <EntityKebab path={`${detail.path}/${f.path}`} /> : null },
  ];

  const c = detail?.counts;

  return (
    <div>
      <PageHeader
        above={
          <Link to="/" className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
            <ChevronLeft className="h-4 w-4" /> Repos
          </Link>
        }
        title={detail?.name ?? "…"}
        subtitle={detail?.path}
        actions={
          <>
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
          </>
        }
      />

      {detail && (
        <RepoVerdict
          detail={detail}
          onSyncNow={() => syncNow.mutate(undefined)}
          syncing={syncNow.isPending}
          navigate={navigate}
        />
      )}

      {/* Summary counts (quick filters would live here) */}
      {c && (
        <div className="mb-1 text-sm text-black/70">
          {c.synced + c.pending} Sync ·{" "}
          <span className={c.undecided > 0 ? "text-[var(--lfb-primary)] font-medium" : ""}>{c.undecided} Undecided</span> ·{" "}
          {c.ignored} Ignore
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

      {/* Repo details — the old status strip, now the mechanism a click away. */}
      {detail && (
        <div className="mt-3">
          <Disclosure label="Repo details">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span>Sync <b>{detail.synced ? "on" : "off"}</b></span>
              <span className="flex items-center gap-1">Status <RepoStatusPill status={detail.status} /></span>
              <span>Peers <b>{detail.peerCount}</b></span>
              <span>Last sync <b title={absoluteTime(detail.lastSyncAt)}>{relativeTime(detail.lastSyncAt)}</b></span>
              <span style={{ color: ipfsDown ? "var(--lfb-bad)" : "var(--lfb-ok)" }}>
                IPFS {ipfsDown ? "unreachable" : "ok"}
              </span>
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

// ── UC-2 diagnosis: name the first real cause, worst-first, and hand over the one fix. ──────────
function RepoVerdict({
  detail,
  onSyncNow,
  syncing,
  navigate,
}: {
  detail: RepoDetail;
  onSyncNow: () => void;
  syncing: boolean;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const ipfsDown = detail.ipfs === "unreachable";
  const { synced, pending, undecided } = detail.counts;
  // Files set to sync that aren't on ANY other computer yet — synced locally, but not backed up.
  const noPeerCount = detail.files.filter((f) => f.decision === "sync" && f.peers.length === 0).length;

  let state: Health = "ok";
  let headline = "Everything here is synced and backed up";
  let sub: string | undefined = detail.lastSyncAt
    ? `Last sync ${relativeTime(detail.lastSyncAt)} · ${detail.peerCount} peer${detail.peerCount === 1 ? "" : "s"}.`
    : undefined;
  let action: React.ReactNode = undefined;

  if (ipfsDown) {
    state = "bad";
    headline = "Syncing is paused — the IPFS engine on this computer isn't running";
    sub = "Decisions still save, but no files can move until IPFS starts.";
    action = (
      <FixButton state="bad" onClick={() => navigate({ to: "/ipfs" })}>
        <UploadCloud className="h-4 w-4" /> Open IPFS
      </FixButton>
    );
  } else if (detail.status === "error") {
    state = "bad";
    headline = "This repo hit an error on its last sync";
    sub = "Open the details below, or try Sync now.";
    action = (
      <FixButton state="bad" onClick={onSyncNow} disabled={syncing}>
        <RefreshCw className="h-4 w-4" /> Sync now
      </FixButton>
    );
  } else if (noPeerCount > 0) {
    state = "warn";
    headline = `${noPeerCount} synced file${noPeerCount === 1 ? " isn't" : "s aren't"} on any other computer yet`;
    sub = "They live only on this machine — not backed up. Open LFBridge on your other computer so it can pull them.";
    action = (
      <FixButton state="warn" onClick={() => navigate({ to: "/peers" })}>
        <Network className="h-4 w-4" /> See peers
      </FixButton>
    );
  } else if (undecided > 0) {
    state = "warn";
    headline = `${undecided} file${undecided === 1 ? "" : "s"} need${undecided === 1 ? "s" : ""} a decision`;
    sub = "Choose Sync or Ignore for them in the table below so LFBridge knows what to move.";
  } else if (pending > 0) {
    state = "warn";
    headline = `${pending} file${pending === 1 ? " is" : "s are"} queued to transfer`;
    sub = "They'll move on the next scheduled sync, or sync them now.";
    action = (
      <FixButton state="warn" onClick={onSyncNow} disabled={syncing}>
        <RefreshCw className="h-4 w-4" /> Sync now
      </FixButton>
    );
  } else if (synced === 0) {
    state = "neutral";
    headline = "Nothing set to sync in this repo yet";
    sub = "Set files to Sync below, or from the File System, to start bridging them.";
  }

  return <StatusBanner state={state} headline={headline} sub={sub} action={action} />;
}
