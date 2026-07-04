// The IPFS dashboard / node control panel (ipfs_ui.mdx): the /ipfs landing page. A status hero with
// the two big controls (Install + on/off toggle), a grid of live metric tiles (each a drill-in), a
// gateway summary, and the only-our-content security card. The heavy pinset table is a separate page
// at /ipfs/pins, reached from the "Shared files" tile.
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  RefreshCw, Power, ShieldCheck, ShieldAlert, Copy, Check, DownloadCloud,
  Boxes, HardDrive, Layers, Network, ArrowUpDown, Terminal, AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import type { IpfsNodeStatus, IpfsInstallJob } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { middleTruncate } from "../../lib/format.js";
import { clientLog } from "../../lib/clientLog.js";

export function IpfsDashboardPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [dismissedError, setDismissedError] = useState(false);

  const { data: node, isLoading } = useQuery({
    queryKey: ["ipfsNode"],
    queryFn: api.ipfsNode,
    refetchInterval: 15_000,
  });

  // The install / start / stop job — poll only while one is actually running.
  const { data: job } = useQuery({
    queryKey: ["ipfsJob"],
    queryFn: api.ipfsInstallStatus,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1200 : false),
  });

  // When a job finishes, refresh the node status so the page flips to the right state.
  const prevStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (job && prevStatus.current === "running" && job.status !== "running") {
      qc.invalidateQueries({ queryKey: ["ipfsNode"] });
      if (job.status === "done") setDismissedError(false);
    }
    prevStatus.current = job?.status;
  }, [job, qc]);

  const install = useMutation({
    mutationFn: api.ipfsInstall,
    onSuccess: (j) => { qc.setQueryData(["ipfsJob"], j); setDismissedError(false); },
    onError: (e: Error) => { clientLog.error("IpfsDashboardPage.install", e); toast.error(e.message); },
  });
  const daemon = useMutation({
    mutationFn: api.ipfsDaemon,
    onSuccess: (r) => {
      qc.setQueryData(["ipfsJob"], r.job ?? undefined);
      qc.setQueryData(["ipfsNode"], r.node);
      setDismissedError(false);
    },
    onError: (e: Error) => { clientLog.error("IpfsDashboardPage.daemon", e); toast.error(e.message); },
  });

  const jobActive = job?.status === "running";
  const jobErrored = job?.status === "error" && !dismissedError;

  if (isLoading && !node) {
    return <div className="text-black/50">Loading the IPFS node…</div>;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">IPFS</h1>
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ["ipfsNode"] })}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* A running job (install / start / stop) takes over the body with a live progress view. */}
      {jobActive && job ? (
        <ProgressView job={job} />
      ) : jobErrored && job ? (
        <ErrorPanel
          job={job}
          onRetry={() => (job.kind === "install" ? install.mutate() : daemon.mutate("start"))}
          onDismiss={() => setDismissedError(true)}
        />
      ) : node && !node.installed ? (
        <InstallCard node={node} onInstall={() => install.mutate()} installing={install.isPending} />
      ) : node && !node.running ? (
        <StoppedCard node={node} onStart={() => daemon.mutate("start")} starting={daemon.isPending} />
      ) : node ? (
        <RunningDashboard
          node={node}
          navigate={navigate}
          onToggleOff={() => daemon.mutate("stop")}
          toggling={daemon.isPending}
          onFix={async () => {
            try { await api.ipfsEnforce(); qc.invalidateQueries({ queryKey: ["ipfsNode"] }); toast.success("Restored only-our-content defaults"); }
            catch (e) { clientLog.error("IpfsDashboardPage.enforce", e); toast.error((e as Error).message); }
          }}
        />
      ) : null}
    </div>
  );
}

// ── Running dashboard ───────────────────────────────────────────────────────
function RunningDashboard({
  node, navigate, onToggleOff, toggling, onFix,
}: {
  node: IpfsNodeStatus;
  navigate: ReturnType<typeof useNavigate>;
  onToggleOff: () => void;
  toggling: boolean;
  onFix: () => void;
}) {
  const m = node.metrics;
  return (
    <div className="space-y-4">
      {/* Hero */}
      <div className="rounded-lg border border-[var(--lfb-border)] bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
            <div>
              <div className="font-semibold">IPFS is running</div>
              <div className="text-xs text-black/50">
                {node.version ? `Kubo v${node.version}` : "Kubo"} · Installed ✓
              </div>
            </div>
          </div>
          <button
            onClick={onToggleOff}
            disabled={toggling}
            title="Turn the IPFS daemon off on this computer"
            className="inline-flex items-center gap-1.5 rounded-md border border-green-300 bg-green-50 px-3 py-1.5 text-sm text-green-800 hover:bg-green-100 disabled:opacity-50"
          >
            <Power className="h-4 w-4" /> On
          </button>
        </div>
        {node.peerId && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-black/50">
            PeerID <CopyText text={node.peerId} display={middleTruncate(node.peerId, 20)} mono />
          </div>
        )}
      </div>

      {/* Metric tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile
          icon={<Boxes className="h-4 w-4" />}
          label="Shared files"
          value={num(m.sharedFiles)}
          sub={m.untrackedFiles ? `${m.untrackedFiles.toLocaleString()} to import` : "files"}
          accentSub={!!m.untrackedFiles}
          onClick={() => navigate({ to: "/ipfs/pins" })}
        />
        <Tile
          icon={<HardDrive className="h-4 w-4" />}
          label="Storage"
          value={m.repoSizeBytes != null ? formatBytes(m.repoSizeBytes) : "—"}
          sub={m.storageMaxBytes != null ? `/ ${formatBytes(m.storageMaxBytes)}` : "on disk"}
        />
        <Tile
          icon={<Layers className="h-4 w-4" />}
          label="Blocks"
          value={num(m.repoObjects)}
          sub="objects"
        />
        <Tile
          icon={<Network className="h-4 w-4" />}
          label="Peers"
          value={num(m.peersConnected)}
          sub="connected"
          onClick={() => navigate({ to: "/peers" })}
        />
        <Tile
          icon={<ArrowUpDown className="h-4 w-4" />}
          label="Bandwidth"
          value={
            m.bandwidthTotalOut != null || m.bandwidthTotalIn != null
              ? `▲${formatBytes(m.bandwidthTotalOut ?? 0)}`
              : "—"
          }
          sub={m.bandwidthTotalIn != null ? `▼${formatBytes(m.bandwidthTotalIn)}` : "in / out"}
        />
      </div>

      {/* Gateway panel */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-[var(--lfb-border)] bg-white px-4 py-3 text-sm">
        <span className="font-medium">Gateway</span>
        {node.gateway.enabled ? (
          <span className={node.gateway.localOnly ? "text-green-700" : "text-red-700"}>
            {node.gateway.localOnly ? "local-only ✓" : "public ✗"}
          </span>
        ) : (
          <span className="text-black/50">off</span>
        )}
        {node.gateway.url && <CopyText text={node.gateway.url} display={node.gateway.url} mono />}
        <span className="ml-auto text-xs text-black/40">Serves your own content over HTTP on this machine only.</span>
      </div>

      {/* Security posture */}
      <SecurityCard node={node} onFix={onFix} />
    </div>
  );
}

function Tile({
  icon, label, value, sub, onClick, accentSub,
}: {
  icon: React.ReactNode; label: string; value: string; sub: string; onClick?: () => void; accentSub?: boolean;
}) {
  const clickable = !!onClick;
  return (
    <button
      onClick={onClick}
      disabled={!clickable}
      className={`rounded-lg border border-[var(--lfb-border)] bg-white p-3 text-left ${
        clickable ? "hover:border-[var(--lfb-primary)] hover:shadow-sm" : "cursor-default"
      }`}
    >
      <div className="flex items-center justify-between text-black/50">
        <span className="inline-flex items-center gap-1.5 text-xs">{icon}{label}</span>
        {clickable && <span className="text-black/30">›</span>}
      </div>
      <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
      <div className={`text-xs ${accentSub ? "font-medium text-[var(--lfb-primary)]" : "text-black/40"}`}>{sub}</div>
    </button>
  );
}

function num(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}

// ── Not-installed / stopped states ──────────────────────────────────────────
function InstallCard({ node, onInstall, installing }: { node: IpfsNodeStatus; onInstall: () => void; installing: boolean }) {
  const auto = node.installMethod && node.packageManagerPresent;
  return (
    <div className="rounded-lg border border-[var(--lfb-border)] bg-white p-6">
      <div className="flex items-center gap-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
        <h2 className="text-lg font-semibold">IPFS isn't installed on this computer</h2>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-black/60">
        IPFS is the engine that moves your big files between your computers. It runs locally on this
        machine — it isn't a cloud service. Install it to start syncing.
      </p>
      <div className="mt-3 text-xs text-black/50">
        Platform: <b>{node.platform}</b>
        {node.installMethod && <> · Method: <b>{node.installMethod}</b>{!node.packageManagerPresent && <span className="text-red-600"> (not found)</span>}</>}
      </div>
      <div className="mt-4 flex items-center gap-3">
        {auto && (
          <button
            onClick={onInstall}
            disabled={installing}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <DownloadCloud className="h-4 w-4" /> Install IPFS
          </button>
        )}
      </div>
      <ManualCommand command={node.installCommand} note={auto ? "Prefer to do it yourself?" : "Automatic install isn't available here — run this in a terminal:"} />
    </div>
  );
}

function StoppedCard({ node, onStart, starting }: { node: IpfsNodeStatus; onStart: () => void; starting: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--lfb-border)] bg-white p-6">
      <div className="flex items-center gap-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <h2 className="text-lg font-semibold">IPFS is installed but not running</h2>
      </div>
      <p className="mt-2 text-sm text-black/60">
        {node.version ? `Kubo v${node.version}. ` : ""}Turn it on so your files can sync across your computers.
      </p>
      <div className="mt-4">
        <button
          onClick={onStart}
          disabled={starting}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          <Power className="h-4 w-4" /> Turn on
        </button>
      </div>
      <ManualCommand command="ipfs daemon --enable-gc" note="Or start it yourself:" />
    </div>
  );
}

// ── Progress + error views ──────────────────────────────────────────────────
function ProgressView({ job }: { job: IpfsInstallJob }) {
  const title =
    job.kind === "install" ? "Installing IPFS…" : job.kind === "start" ? "Starting the IPFS daemon…" : "Stopping IPFS…";
  return (
    <div className="rounded-lg border border-[var(--lfb-border)] bg-white p-5">
      <div className="flex items-center gap-2.5">
        <RefreshCw className="h-4 w-4 animate-spin text-[var(--lfb-primary)]" />
        <div className="font-semibold">{title}</div>
        <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{job.phase}</span>
      </div>
      <LogBox lines={job.log} />
    </div>
  );
}

function ErrorPanel({ job, onRetry, onDismiss }: { job: IpfsInstallJob; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-5">
      <div className="flex items-center gap-2 text-red-800">
        <AlertCircle className="h-5 w-5" />
        <div className="font-semibold">{job.error ?? "Something went wrong"}</div>
      </div>
      {job.log.length > 0 && <LogBox lines={job.log} />}
      {job.manualCommand && (
        <ManualCommand command={job.manualCommand} note="Run this in a terminal to finish by hand:" />
      )}
      <div className="mt-4 flex gap-2">
        <button onClick={onRetry} className="rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
          Retry
        </button>
        <button onClick={onDismiss} className="rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm hover:bg-white">
          Dismiss
        </button>
      </div>
    </div>
  );
}

function LogBox({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  if (lines.length === 0) return null;
  return (
    <pre ref={ref} className="mt-3 max-h-56 overflow-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
      {lines.join("\n")}
    </pre>
  );
}

function ManualCommand({ command, note }: { command: string; note: string }) {
  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-black/50">
        <Terminal className="h-3.5 w-3.5" /> {note}
      </div>
      <div className="flex items-center gap-2 rounded-md border border-[var(--lfb-border)] bg-slate-50 px-3 py-2 font-mono text-xs">
        <span className="flex-1 break-all">{command}</span>
        <CopyText text={command} display="" iconOnly />
      </div>
    </div>
  );
}

// ── Security card (mirrors the pinset page's card — ipfs_ui.mdx §8) ──────────
function SecurityCard({ node, onFix }: { node: IpfsNodeStatus; onFix: () => void }) {
  const [fixing, setFixing] = useState(false);
  const nonCompliant = node.running && !node.compliant;
  const acknowledged = nonCompliant && node.publicGateway;
  return (
    <div className="rounded-lg border border-[var(--lfb-border)] bg-white">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium">
          {node.compliant ? <ShieldCheck className="h-4 w-4 text-green-600" /> : <ShieldAlert className="h-4 w-4 text-red-600" />}
          {node.compliant ? "Only your content ✓" : "Check needed"}
        </span>
        <Posture label="Reprovide" ok={node.reprovideStrategy !== "all"} value={node.reprovideStrategy} />
        <Posture label="Gateway" ok={node.gatewayLocalOnly} value={node.gatewayLocalOnly ? "local-only" : "public"} />
        <Posture label="GC" ok={node.gcOn} value={node.gcOn ? "on" : "off"} />
      </div>
      {nonCompliant && (
        <div className={`flex items-center gap-2 border-t px-4 py-2 text-sm ${acknowledged ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-800"}`}>
          {acknowledged ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
          <span className="flex-1">
            {acknowledged
              ? "This node serves more than your own content — you changed the public-gateway setting on this machine, so this is allowed."
              : "This node is configured to serve more than your own content."}
          </span>
          {!acknowledged && (
            <button
              onClick={async () => { setFixing(true); await onFix(); setFixing(false); }}
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

function Posture({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-black/50">{label}</span>
      <span className={ok ? "text-green-700" : "text-red-700"}>{value} {ok ? "✓" : "✗"}</span>
    </span>
  );
}

function CopyText({ text, display, mono, iconOnly }: { text: string; display: string; mono?: boolean; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(text).catch((err) => clientLog.warn("IpfsDashboardPage.copy", err)); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      title={`Copy ${text}`}
      className={`inline-flex items-center gap-1 hover:text-[var(--lfb-primary)] ${mono ? "font-mono text-xs" : ""}`}
    >
      {!iconOnly && display}
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 text-black/30" />}
    </button>
  );
}
