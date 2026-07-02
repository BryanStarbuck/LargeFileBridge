// The IPFS page (ipfs.mdx): the local pinset as ground truth. A node/security card sits above one
// TanStack table of pinned root CIDs; untracked pins offer one-click Import; the ?repo search param
// filters to one pinning repo (the left-bar disclosure children — §2.1).
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { RefreshCw, ShieldCheck, ShieldAlert, Copy, Check, DownloadCloud } from "lucide-react";
import { toast } from "sonner";
import type { IpfsPageData, IpfsPinRow, IpfsNodeCard } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { EntityKebab } from "../../components/menu/EntityMenu.js";
import { relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";

const PIN_TYPES = ["recursive", "direct", "mfs"];
const TRACKED = ["synced", "import", "path-less"];

export function IpfsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { repo } = useSearch({ strict: false }) as { repo?: string };
  const [untrackedOnly, setUntrackedOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({ queryKey: ["ipfs"], queryFn: api.ipfs });

  const set = (d: IpfsPageData) => qc.setQueryData(["ipfs"], d);

  const rescan = useMutation({
    mutationFn: api.ipfsRescan,
    onSuccess: (d) => {
      set(d);
      toast.success("Rescanned the pinset");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const doImport = useMutation({
    mutationFn: api.ipfsImport,
    onSuccess: (r) => {
      set(r.data);
      setSelected(new Set());
      toast.success(`Imported ${r.imported} pin${r.imported === 1 ? "" : "s"} into tracking`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const enforce = useMutation({
    mutationFn: api.ipfsEnforce,
    onSuccess: (d) => {
      set(d);
      toast.success("Restored only-our-content defaults");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const node = data?.node;
  const repoName = repo ? data?.repos.find((r) => r.repoId === repo)?.name : undefined;

  // Filter: by pinning repo (left-bar child), then by the "Untracked only" quick filter.
  const rows = useMemo(() => {
    let list = data?.pins ?? [];
    if (repo) list = list.filter((p) => p.repoId === repo);
    if (untrackedOnly) list = list.filter((p) => p.tracked === "import");
    return list;
  }, [data, repo, untrackedOnly]);

  const untrackedCount = node?.untrackedCount ?? 0;
  const nodeDown = node?.health === "unreachable";

  const columns: LfbColumn<IpfsPinRow>[] = [
    {
      id: "file",
      header: "File / CID",
      kind: "text",
      accessor: (p) => p.file ?? p.cid,
      cell: (p) =>
        p.file ? (
          <span className="font-medium" title={p.path ?? p.file}>
            {p.file}
          </span>
        ) : (
          <CidCell cid={p.cid} />
        ),
    },
    {
      id: "size",
      header: "Size",
      kind: "bytes",
      align: "right",
      accessor: (p) => p.sizeBytes,
      cell: (p) => (p.sizeBytes > 0 ? formatBytes(p.sizeBytes) : "—"),
    },
    {
      id: "pin",
      header: "Pin",
      kind: "enum",
      accessor: (p) => p.pinType,
      filterOptions: PIN_TYPES,
      cell: (p) => <span className="text-black/60">{p.pinType}</span>,
    },
    {
      id: "tracked",
      header: "Tracked",
      kind: "enum",
      accessor: (p) => p.tracked,
      filterOptions: TRACKED,
      cell: (p) =>
        p.tracked === "import" ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              doImport.mutate({ cids: [p.cid] });
            }}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--lfb-primary)] px-2 py-0.5 text-xs text-[var(--lfb-primary)] hover:bg-[var(--lfb-primary-tint)]"
          >
            <DownloadCloud className="h-3 w-3" /> Import
          </button>
        ) : (
          <TrackedPill tracked={p.tracked} />
        ),
    },
    {
      id: "unit",
      header: "Unit",
      kind: "text",
      accessor: (p) => p.unit ?? "—",
      cell: (p) =>
        p.unit && p.repoId ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate({ to: "/repos/$repoId", params: { repoId: p.repoId! } });
            }}
            className="text-[var(--lfb-primary)] hover:underline"
          >
            {p.unit}
          </button>
        ) : (
          <span className="text-black/40">{p.unit ?? "—"}</span>
        ),
    },
    {
      id: "peers",
      header: "Peers",
      kind: "int",
      align: "right",
      accessor: (p) => p.peers,
      cell: (p) => (
        <span className={p.tracked !== "import" && p.peers === 0 ? "text-red-600" : ""}>{p.peers}</span>
      ),
    },
    {
      id: "seen",
      header: "Seen",
      kind: "timestamp",
      align: "right",
      accessor: (p) => p.seenAt,
      cell: (p) => (
        <span title={absoluteTime(p.seenAt)} className="text-black/60">
          {relativeTime(p.seenAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      kind: "text",
      sortable: false,
      filterable: false,
      accessor: () => "",
      // The row ⋯ kebab (menus.mdx §5.3) — only where the pin resolves to a real local file entity.
      cell: (p) => (p.path ? <EntityKebab path={p.path} /> : <span className="text-black/20">—</span>),
    },
  ];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          IPFS
          {repoName && <span className="font-normal text-black/50"> · {repoName}</span>}
        </h1>
        <div className="flex items-center gap-2">
          {untrackedCount > 0 && (
            <button
              onClick={() => doImport.mutate({ all: true })}
              disabled={doImport.isPending || nodeDown}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--lfb-primary)] px-3 py-1.5 text-sm text-[var(--lfb-primary)] hover:bg-[var(--lfb-primary-tint)] disabled:opacity-40"
            >
              <DownloadCloud className="h-4 w-4" /> Import all untracked ({untrackedCount})
            </button>
          )}
          <button
            onClick={() => rescan.mutate()}
            disabled={rescan.isPending || nodeDown}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40"
          >
            <RefreshCw className={`h-4 w-4 ${rescan.isPending ? "animate-spin" : ""}`} /> Rescan
          </button>
        </div>
      </div>

      {node && <NodeCard node={node} onFix={() => enforce.mutate()} fixing={enforce.isPending} />}

      {nodeDown ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-800">
          The local IPFS (Kubo) node is unreachable, so the pinset can't be read. Start the daemon —
          or install the IPFS CLI — then Rescan.
        </div>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          searchKeys={(p) => `${p.file ?? ""} ${p.cid} ${p.unit ?? ""}`}
          getRowId={(p) => p.cid}
          onRowClick={(p) => p.path && navigate({ to: "/file", search: { path: p.path } })}
          itemNoun="pinned"
          loading={isLoading}
          selection={{
            selected,
            onChange: setSelected,
            bulk:
              selected.size > 0 ? (
                <button
                  onClick={() => doImport.mutate({ cids: [...selected] })}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--lfb-primary)] px-2.5 py-1 text-sm text-[var(--lfb-primary)] hover:bg-[var(--lfb-primary-tint)]"
                >
                  <DownloadCloud className="h-4 w-4" /> Import selected ({selected.size})
                </button>
              ) : undefined,
          }}
          rightHeader={
            <button
              onClick={() => setUntrackedOnly((v) => !v)}
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                untrackedOnly
                  ? "border-[var(--lfb-primary)] bg-[var(--lfb-primary-tint)] text-[var(--lfb-primary)]"
                  : "border-[var(--lfb-border)] hover:bg-slate-100"
              } ${untrackedCount === 0 ? "opacity-40" : ""}`}
              disabled={untrackedCount === 0}
              title="Show only pinned-but-untracked import candidates"
            >
              Untracked only
            </button>
          }
          empty={
            <div className="text-center text-black/60">
              {repo
                ? "No pinned files in this repo."
                : "This node isn't pinning anything yet. Sync a repo to start."}
            </div>
          }
        />
      )}
    </div>
  );
}

// ── The node-status / security card (ipfs.mdx §3) ──────────────────────────────
function NodeCard({ node, onFix, fixing }: { node: IpfsNodeCard; onFix: () => void; fixing: boolean }) {
  const ok = node.health === "ok";
  // Non-compliant = the node serves more than our own content. Deliberate opt-out (publicGateway) is
  // an amber "acknowledged" note; anything else is a red error with a Fix (§3.1).
  const nonCompliant = ok && !node.compliant;
  const acknowledged = nonCompliant && node.publicGateway;

  return (
    <div className="rounded-lg border border-[var(--lfb-border)] bg-white">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
        <Field label="Node">
          <span className={`inline-flex items-center gap-1.5 ${ok ? "text-green-700" : "text-red-700"}`}>
            <span className={`h-2 w-2 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`} />
            {ok ? "ok" : "unreachable"}
          </span>
        </Field>
        <Field label="PeerID">
          {node.peerId ? <CopyText text={node.peerId} display={middleTruncate(node.peerId, 16)} /> : "—"}
        </Field>
        <Field label="Reprovide">
          <Posture ok={node.reprovideStrategy !== "all"} label={node.reprovideStrategy} />
        </Field>
        <Field label="Gateway">
          <Posture ok={node.gatewayLocalOnly} label={node.gatewayLocalOnly ? "local-only" : "public"} />
        </Field>
        <Field label="GC">
          <Posture ok={node.gcOn} label={node.gcOn ? "on" : "off"} />
        </Field>
        <div className="ml-auto text-black/60">
          Pinned <b className="text-black">{node.pinnedCount.toLocaleString()}</b> ·{" "}
          {formatBytes(node.pinnedBytes)} &nbsp; Tracked{" "}
          <b className="text-black">{node.trackedCount.toLocaleString()}</b> · Untracked{" "}
          <b className={node.untrackedCount > 0 ? "text-[var(--lfb-primary)]" : "text-black"}>
            {node.untrackedCount.toLocaleString()}
          </b>
        </div>
      </div>

      {nonCompliant && (
        <div
          className={`flex items-center gap-2 border-t px-4 py-2 text-sm ${
            acknowledged
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {acknowledged ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
          <span className="flex-1">
            {acknowledged
              ? "This node serves more than your own content — you changed the public-gateway setting on this machine, so this is allowed."
              : "This node is configured to serve more than your own content."}
          </span>
          {!acknowledged && (
            <button
              onClick={onFix}
              disabled={fixing}
              className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {fixing ? "Fixing…" : "Fix"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-black/50">{label}</span>
      <span className="text-black">{children}</span>
    </div>
  );
}

function Posture({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={ok ? "text-green-700" : "text-red-700"}>
      {label} {ok ? "✓" : "✗"}
    </span>
  );
}

function TrackedPill({ tracked }: { tracked: "synced" | "path-less" }) {
  const map = {
    synced: { label: "synced", cls: "bg-green-100 text-green-800" },
    "path-less": { label: "path-less", cls: "bg-slate-100 text-slate-600" },
  } as const;
  const s = map[tracked];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${s.cls}`}>{s.label}</span>;
}

function CidCell({ cid }: { cid: string }) {
  return <CopyText text={cid} display={middleTruncate(cid, 24)} mono />;
}


function CopyText({ text, display, mono }: { text: string; display: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={`Copy ${text}`}
      className={`inline-flex items-center gap-1 hover:text-[var(--lfb-primary)] ${mono ? "font-mono text-xs" : ""}`}
    >
      {display}
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 text-black/30" />}
    </button>
  );
}
