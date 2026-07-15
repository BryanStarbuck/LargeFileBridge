// The IPFS page (ipfs.mdx + use_cases.mdx §5.1). Redesigned to lead with the verdict:
// PageHeader → StatusBanner (running? serving only our content?) → metric tiles → an Improvable
// "untracked backlog" card → the pinset table (the working surface) → a collapsed "Node details"
// disclosure for the mechanism (PeerID / reprovide / gateway / GC). Progressive disclosure (§2):
// the answer first, the internals a click away.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch, Link } from "@tanstack/react-router";
import { RefreshCw, Copy, Check, DownloadCloud, ShieldCheck, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import type { IpfsPageData, IpfsPinRow, IpfsNodeCard } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { EntityKebab, type Action } from "../../components/menu/EntityMenu.js";
import { PageActions } from "../../components/menu/PageActions.js";
import { publishIpfsList } from "../../components/menu/domainActions.js";
import { PinKebab } from "../../components/menu/RowKebabs.js";
import { PinToggle } from "../../components/PinToggle.js";
import { usePinCid } from "../../components/usePinCid.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner, FixButton } from "../../components/ui/StatusBanner.js";
import type { WarningDef } from "../../components/ui/warnings/registry.js";
import { refetchUntilResolved } from "../../components/ui/warnings/resolveRefetch.js";
import { DiagnosticCard } from "../../components/ui/DiagnosticCard.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { StatTile, StatTileRow } from "../../components/ui/StatTile.js";
import { type Health } from "../../components/ui/health.js";
import { relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";
import { clientLog } from "../../lib/clientLog.js";
import { writeClipboard } from "@/lib/clipboard";

const PIN_TYPES = ["recursive", "direct", "mfs"];
const TRACKED = ["pinned", "import", "path-less"];

export function IpfsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { repo } = useSearch({ strict: false }) as { repo?: string };
  const [untrackedOnly, setUntrackedOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pin = usePinCid(); // per-CID pin/unpin toggle (ipfs.mdx §3)

  const { data, isLoading } = useQuery({ queryKey: ["ipfs"], queryFn: api.ipfs });

  const set = (d: IpfsPageData) => qc.setQueryData(["ipfs"], d);

  const rescan = useMutation({
    mutationFn: api.ipfsRescan,
    onSuccess: (d) => {
      set(d);
      toast.success("Rescanned the pinset");
    },
    onError: (e: Error) => { clientLog.error("IpfsPage.rescan", e); toast.error(e.message); },
  });

  const doImport = useMutation({
    mutationFn: api.ipfsImport,
    onSuccess: (r) => {
      set(r.data);
      setSelected(new Set());
      toast.success(`Imported ${r.imported} pin${r.imported === 1 ? "" : "s"} into tracking`);
    },
    onError: (e: Error) => { clientLog.error("IpfsPage.import", e); toast.error(e.message); },
  });

  const enforce = useMutation({
    mutationFn: api.ipfsEnforce,
    onSuccess: (d) => {
      set(d);
      toast.success("Restored only-our-content defaults");
    },
    onError: (e: Error) => { clientLog.error("IpfsPage.enforce", e); toast.error(e.message); },
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

  // The action-links row (page_actions.mdx §4 — IPFS pins): Publish IPFS list… · Re-verify pins.
  // Re-verify reuses the real pinset rescan endpoint (api.ipfsRescan).
  const ipfsActions: Action[] = [
    publishIpfsList(),
    {
      id: "reverify-pins",
      label: "Re-verify pins",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      group: "Work",
      disabled: rescan.isPending || nodeDown,
      onSelect: () => rescan.mutate(),
    },
  ];

  const columns: LfbColumn<IpfsPinRow>[] = [
    {
      // The toggle pin: solid dark-blue = pinned, outline = not. Every pins-page row is a real CID
      // in the local pinset, so it starts pinned; clicking runs pin add/rm on the node (ipfs.mdx §3).
      id: "pinned",
      header: "Pin",
      kind: "text",
      sortable: false,
      filterable: false,
      accessor: () => "",
      cell: (p) => {
        const pinned = pin.isPinned(p.cid, true);
        return (
          <PinToggle
            pinned={pinned}
            busy={pin.isBusy(p.cid)}
            disabled={nodeDown}
            onToggle={() => pin.toggle(p.cid, pinned)}
          />
        );
      },
    },
    {
      id: "file",
      header: "File name",
      kind: "text",
      accessor: (p) => p.file ?? "",
      cell: (p) =>
        p.file ? (
          <span className="font-medium" title={p.file}>
            {p.file}
          </span>
        ) : (
          <span className="text-black/30">—</span>
        ),
    },
    {
      id: "path",
      header: "Path",
      kind: "text",
      accessor: (p) => p.path ?? "",
      cell: (p) =>
        p.path ? (
          <span className="text-black/60" title={p.path}>
            {middleTruncate(p.path, 44)}
          </span>
        ) : (
          <span className="text-black/30">—</span>
        ),
    },
    {
      // Narrow CID column: show ~10 characters with a middle ellipsis; click to copy the full CID.
      id: "cid",
      header: "CID",
      kind: "text",
      accessor: (p) => p.cid,
      cell: (p) => <CidCell cid={p.cid} />,
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
      id: "pintype",
      header: "Type",
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
  ];

  return (
    <div>
      <PageHeader
        above={
          <Link to="/ipfs" className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
            <ChevronLeft className="h-4 w-4" /> IPFS
          </Link>
        }
        title={
          <>
            Shared files
            {repoName && <span className="font-normal text-black/50"> · {repoName}</span>}
          </>
        }
        subtitle="Every file this computer is pinning over IPFS — the ground truth of what's shared across your machines."
        actionsRow={<PageActions actions={ipfsActions} />}
        actions={
          <>
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
          </>
        }
      />

      {node && (
        <NodeVerdict
          node={node}
          onFix={() => enforce.mutate()}
          fixing={enforce.isPending}
          // Burst-refetch so the "engine isn't running" banner clears on its own once the daemon has
          // finished booting — a single invalidate can fire while it's still coming up (warnings.mdx §5.3.1).
          onWarningApplied={() => refetchUntilResolved(qc, [["ipfs"]])}
        />
      )}

      {node && !nodeDown && (
        <StatTileRow>
          <StatTile label="Pinned files" value={node.pinnedCount.toLocaleString()} sub={formatBytes(node.pinnedBytes)} />
          <StatTile label="Tracked" value={node.trackedCount.toLocaleString()} sub="known to LFBridge" />
          <StatTile
            label="Untracked"
            value={node.untrackedCount.toLocaleString()}
            sub={untrackedCount > 0 ? "click to review" : "all imported"}
            state={untrackedCount > 0 ? "warn" : "ok"}
            onClick={untrackedCount > 0 ? () => setUntrackedOnly(true) : undefined}
            title="Pinned but not yet tracked by LFBridge"
          />
        </StatTileRow>
      )}

      {/* Improvable: the import backlog — an offer, not an alarm. */}
      {node && !nodeDown && untrackedCount > 0 && (
        <div className="mb-4">
          <DiagnosticCard
            state="warn"
            title={`${untrackedCount} pinned file${untrackedCount === 1 ? "" : "s"} aren't tracked yet`}
            summary="LFBridge found pins on this computer that it isn't managing. Import them so they pin and back up like the rest."
            fix={
              <FixButton state="warn" onClick={() => doImport.mutate({ all: true })} disabled={doImport.isPending}>
                <DownloadCloud className="h-4 w-4" /> Import all
              </FixButton>
            }
          >
            "Tracked" means LFBridge has recorded the file in a repo manifest so it can keep it pinned
            across your computers. Importing is metadata-only — no bytes move, nothing on disk changes.
          </DiagnosticCard>
        </div>
      )}

      {nodeDown ? (
        <DiagnosticCard
          state="bad"
          title="Start the IPFS engine to read your pins"
          summary="The pinset can't be read while the engine is down."
          defaultOpen
        >
          <p className="mb-2">Start the daemon, or install the IPFS (Kubo) CLI, then click Rescan:</p>
          <pre className="overflow-x-auto rounded bg-slate-100 px-3 py-2 font-mono text-xs text-black">
            {"# start the daemon\nipfs daemon\n\n# or install it first (macOS)\nbrew install ipfs"}
          </pre>
        </DiagnosticCard>
      ) : (
        <>
          <h2 className="mb-1 text-sm font-semibold text-black/70">Pinned files</h2>
          <DataTable
            // Content below the table (NodeDetails) → bounded height, not full-page
            // (ipfs.mdx §5 / repos.mdx §3.3.1).
            fillHeight={false}
            data={rows}
            columns={columns}
            searchKeys={(p) => `${p.file ?? ""} ${p.path ?? ""} ${p.cid} ${p.unit ?? ""}`}
            getRowId={(p) => p.cid}
            onRowClick={(p) => p.path && navigate({ to: "/file", search: { path: p.path } })}
            // Every row gets a ⋮ (menus.mdx §3): a resolvable pin → the file catalog; an untracked /
            // path-less pin → the pin catalog (§5.5: Copy CID · Import · Unpin).
            rowMenu={(p) => (p.path ? <EntityKebab path={p.path} /> : <PinKebab pin={p} />)}
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
                  : "This node isn't pinning anything yet. Pin a repo to start."}
              </div>
            }
          />

          {node && <NodeDetails node={node} />}
        </>
      )}
    </div>
  );
}

// ── The verdict banner (use_cases.mdx §5.1 row 2) — worst-first: down > non-compliant > OK. ──────
function NodeVerdict({
  node,
  onFix,
  fixing,
  onWarningApplied,
}: {
  node: IpfsNodeCard;
  onFix: () => void;
  fixing: boolean;
  onWarningApplied?: () => void;
}) {
  if (node.health === "unreachable") {
    // Gap-close (warnings.mdx §10.1.2): this verdict previously had no Fix. The blue arrow now opens
    // the educate-and-fix popup that actually starts the daemon (with an optional keep-on-reboot).
    const warning: WarningDef = {
      id: "ipfs-not-running",
      state: "bad",
      headline: "The IPFS engine isn't running",
      sub: "Your files can't move between computers until it starts.",
      popup: {
        whatThisIs:
          "IPFS is the local peer-to-peer engine that reads, adds, and fetches your pinned files. It's installed on this computer but isn't answering right now, so nothing can transfer.",
        whyItMatters:
          "Pins can't be read or added and no file can move in either direction. Your Add-to-IPFS (pin) / Ignore decisions and metadata are safe — this is a paused pipe, not a broken file.",
        options: [
          {
            kind: "checkbox",
            name: "autostart",
            label: "Also keep IPFS on after I reboot",
            helper: "Installs the reboot auto-start so pinning survives a restart.",
            defaultChecked: true,
          },
        ],
        actionLabel: "Start IPFS",
        // §5.3 — async: close the popup, show a dock card while the daemon boots, toast on done, and
        // refetch the IPFS status so this "engine isn't running" banner clears once it's actually up.
        progress: {
          kind: "configure",
          target: "IPFS engine",
          doneLabel: "IPFS started",
          invalidate: [["ipfs"]],
        },
        apply: async (sel) => {
          await api.ipfsDaemon({ action: "start", autostart: !!sel.checks.autostart });
        },
      },
    };
    return (
      <StatusBanner
        state="bad"
        headline="The IPFS engine isn't running"
        sub="Your files can't move between computers until it starts. Decisions still save; transfers are paused."
        warning={warning}
        onWarningApplied={onWarningApplied}
      />
    );
  }
  const nonCompliant = !node.compliant;
  const acknowledged = nonCompliant && node.publicGateway;
  if (nonCompliant) {
    // Deliberate public-gateway opt-out is an acknowledged Improvable; anything else is Broken.
    const state: Health = acknowledged ? "warn" : "bad";
    return (
      <StatusBanner
        state={state}
        headline={
          acknowledged
            ? "This computer serves more than your own content (you allowed it)"
            : "This computer is set to serve other people's content"
        }
        sub={
          acknowledged
            ? "You changed the public-gateway setting on this machine, so this is allowed."
            : "LFBridge should serve only your own files — not act as a public gateway for the internet."
        }
        action={
          acknowledged ? undefined : (
            <FixButton state="bad" onClick={onFix} disabled={fixing}>
              <ShieldCheck className="h-4 w-4" /> {fixing ? "Fixing…" : "Serve only my content"}
            </FixButton>
          )
        }
      />
    );
  }
  return (
    <StatusBanner
      state="ok"
      headline="IPFS is running and serving only your own content"
      sub={`${node.pinnedCount.toLocaleString()} files pinned · ${formatBytes(node.pinnedBytes)}.`}
    />
  );
}

// ── "Node details" — the mechanism, one click away (use_cases.mdx §5.1 step 6). ──────────────────
function NodeDetails({ node }: { node: IpfsNodeCard }) {
  return (
    <div className="mt-3">
      <Disclosure label="Node details">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
          <Field label="PeerID">
            {node.peerId ? <CopyText text={node.peerId} display={middleTruncate(node.peerId, 20)} mono /> : "—"}
          </Field>
          <Field label="Reprovide">
            <Posture ok={node.reprovideStrategy !== "all"} label={node.reprovideStrategy} />
          </Field>
          <Field label="Gateway">
            <Posture ok={node.gatewayLocalOnly} label={node.gatewayLocalOnly ? "local-only" : "public"} />
          </Field>
          <Field label="Garbage collection">
            <Posture ok={node.gcOn} label={node.gcOn ? "on" : "off"} />
          </Field>
        </div>
        <p className="mt-3 text-xs text-black/45">
          These control the only-our-content security posture (knowledge/ipfs.mdx §6): reprovide stays
          off "all", the gateway is bound to loopback only, and GC keeps any incidental third-party
          cache transient.
        </p>
      </Disclosure>
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
    <span style={{ color: ok ? "var(--lfb-ok)" : "var(--lfb-bad)" }}>
      {label} {ok ? "✓" : "✗"}
    </span>
  );
}

function TrackedPill({ tracked }: { tracked: "pinned" | "path-less" }) {
  const map = {
    pinned: { label: "pinned", cls: "bg-green-100 text-green-800" },
    "path-less": { label: "path-less", cls: "bg-slate-100 text-slate-600" },
  } as const;
  const s = map[tracked];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${s.cls}`}>{s.label}</span>;
}

function CidCell({ cid }: { cid: string }) {
  // Narrow by design (charter): show ~10 chars with a middle ellipsis; the full CID is the copy value.
  return <CopyText text={cid} display={middleTruncate(cid, 10)} mono />;
}

function CopyText({ text, display, mono }: { text: string; display: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        // ✓ only on a write that really landed (menus.mdx §3.3).
        void writeClipboard(text, "IpfsPage.copy").then((ok) => {
          if (!ok) return toast.error("Couldn't copy to the clipboard");
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={`Copy ${text}`}
      className={`inline-flex items-center gap-1 hover:text-[var(--lfb-primary)] ${mono ? "font-mono text-xs" : ""}`}
    >
      {display}
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 text-black/30" />}
    </button>
  );
}
