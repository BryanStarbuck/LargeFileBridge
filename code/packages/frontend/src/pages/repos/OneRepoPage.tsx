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
import type { FileRow, Decision, RepoDetail, SyncCounts, SyncNowResult } from "@lfb/shared";
import { formatBytes, viewerRouteForName } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { RepoStatusPill, TransferPill } from "../../components/Pill.js";
import { EntityKebab } from "../../components/menu/EntityMenu.js";
import { PinToggle } from "../../components/PinToggle.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner, FixButton } from "../../components/ui/StatusBanner.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { type Health } from "../../components/ui/health.js";
import { relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";
import { clientLog } from "../../lib/clientLog.js";

const DECISIONS: Decision[] = ["sync", "ignore", "undecided"];

/** Human summary of what a sync run actually did — the honest counts, never a fixed string (sync_process.mdx §6). */
function syncSummary(c: SyncCounts): string {
  if (c.eligible === 0) return "Nothing to sync — no files marked Sync";
  const parts: string[] = [];
  if (c.added) parts.push(`${c.added} added`);
  if (c.fetched) parts.push(`${c.fetched} fetched`);
  if (c.skipped) parts.push(`${c.skipped} already up-to-date`);
  if (c.failed) parts.push(`${c.failed} failed`);
  return parts.length ? `Sync done — ${parts.join(", ")}` : "Nothing to sync — no files marked Sync";
}

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
    onError: (e: Error) => {
      clientLog.error("OneRepoPage.setDecision", e);
      toast.error(e.message);
    },
  });

  const syncNow = useMutation({
    mutationFn: (paths?: string[]) => api.syncNow(repoId, paths),
    onSuccess: (r: SyncNowResult) => {
      qc.setQueryData(["repo", repoId], r.detail);
      // Report what the run ACTUALLY did, never a blanket "complete" (sync_process.mdx §6): an honest
      // "nothing to sync" for a no-op, real counts otherwise, and an error toast when only failures occurred.
      const summary = syncSummary(r.counts);
      if (r.counts.failed > 0 && r.counts.added === 0 && r.counts.fetched === 0) toast.error(summary);
      else toast.success(summary);
    },
    onError: (e: Error) => {
      clientLog.error("OneRepoPage.syncNow", e);
      toast.error(e.message);
    },
  });

  // Bulk compress the checked rows (compression.mdx §4). The selection Set holds fileIds; map them back
  // to absolute paths for the batch endpoint.
  const compressBatch = useMutation({
    mutationFn: (paths: string[]) => api.compressBatch(paths),
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.status === "compressed").length;
      const blocked = r.results.filter((x) => x.status === "blocked").length;
      toast.success(`Compressed ${ok}/${r.results.length}${blocked ? ` · ${blocked} blocked (alpha/resolution)` : ""}`);
      qc.invalidateQueries({ queryKey: ["repo", repoId] });
      setSelected(new Set());
    },
    onError: (e: Error) => { clientLog.error("OneRepoPage.compressBatch", e); toast.error(e.message); },
  });
  const compressSelected = () => {
    if (!detail?.path) return;
    const paths = detail.files.filter((f) => selected.has(f.fileId)).map((f) => `${detail.path}/${f.path}`);
    if (!paths.length) return;
    if (!window.confirm(`Compress ${paths.length} file${paths.length === 1 ? "" : "s"}? Medium quality, same resolution — originals move to LFBridge trash (recoverable).`)) return;
    compressBatch.mutate(paths);
  };

  const ipfsDown = detail?.ipfs === "unreachable";

  const columns: LfbColumn<FileRow>[] = [
    {
      // Same toggle pin as everywhere (ipfs.mdx §3): solid dark-blue = pinned (this file is synced
      // over IPFS), outline = not. Toggling flips the sync⇄ignore decision that governs the pin.
      id: "pinned",
      header: "Pin",
      kind: "text",
      sortable: false,
      filterable: false,
      accessor: () => "",
      cell: (f) => {
        const pinned = f.decision === "sync";
        // Control cell — stop the click bubbling to the row's navigate (one_repo.mdx §4.7).
        return (
          <span onClick={(e) => e.stopPropagation()}>
            <PinToggle
              pinned={pinned}
              disabled={ipfsDown}
              onToggle={() =>
                setDecision.mutate({ paths: [f.path], decision: pinned ? "ignore" : "sync" })
              }
            />
          </span>
        );
      },
    },
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
      cell: (f) => f.cid ? <code className="text-xs text-black/60" title={f.cid} onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(f.cid!).catch((err) => clientLog.warn("OneRepoPage.copyCid", err)); toast.success("CID copied"); }}>{middleTruncate(f.cid, 16)}</code> : <span className="text-black/20">—</span> },
    { id: "changed", header: "Changed", kind: "timestamp", accessor: (f) => f.changedAt,
      cell: (f) => <span title={absoluteTime(f.changedAt)}>{relativeTime(f.changedAt)}</span> },
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
        // Content below the table (the Repo details disclosure) → bounded height, not full-page
        // (one_repo.mdx §4 / repos.mdx §3.3.1).
        fillHeight={false}
        data={detail?.files ?? []}
        columns={columns}
        searchKeys={(f) => f.path}
        getRowId={(f) => f.fileId}
        // Row click → the file's "View one file" experience: media routes to its viewer
        // (/image · /video · /audio), everything else to /file (one_repo.mdx §4.7). The FileRow path is
        // repo-relative, so join it onto the repo root for the absolute path every entity page keys off.
        onRowClick={(f) => {
          if (!detail?.path) return;
          const abs = `${detail.path}/${f.path}`;
          const name = f.path.slice(f.path.lastIndexOf("/") + 1);
          navigate({ to: viewerRouteForName(name), search: { path: abs } });
        }}
        // Trailing ⋮ kebab — the file entity menu (menus.mdx §3), same catalog as View-one-file.
        rowMenu={(f) => (detail?.path ? <EntityKebab path={`${detail.path}/${f.path}`} /> : null)}
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
                  <button className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100"
                    disabled={compressBatch.isPending}
                    onClick={() => { compressSelected(); setBulkOpen(false); }}>
                    Compress selected
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
      <FixButton state="warn" onClick={() => navigate({ to: "/devices" })}>
        <Network className="h-4 w-4" /> See devices
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
