// The IPFS dashboard — the /ipfs landing page for a RUNNING node (ipfs_ui.mdx §5). Status hero with
// the on/off toggle, a grid of live metric tiles (each a drill-in), the auto-start-on-reboot control
// (§13), a gateway summary, and the only-our-content security card.
//
// PAGE SPLIT (ipfs_ui.mdx §12): this page is the HEALTHY state only. When the node is NOT running
// (installed-stopped, not-installed, unreachable) it redirects to /ipfs/off — a very different page
// that leads with turning IPFS on (and keeping it on across reboots). A start/stop/install job in
// flight still shows its live progress here before the redirect settles.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  RefreshCw, Power, Copy, Check,
  Boxes, HardDrive, Layers, Network, ArrowUpDown,
} from "lucide-react";
import { toast } from "sonner";
import type { IpfsNodeStatus, IpfsAutostartAction } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { middleTruncate } from "../../lib/format.js";
import { clientLog } from "../../lib/clientLog.js";
import { writeClipboard } from "@/lib/clipboard";
import { ProgressView, SecurityCard, AutostartRow, ConfigHealthCard, UpgradeCard, num } from "./ipfsShared.js";

export function IpfsDashboardPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: node, isLoading } = useQuery({
    queryKey: ["ipfsNode"],
    queryFn: api.ipfsNode,
    refetchInterval: 15_000,
  });

  // The install / start / stop job — poll only while one is actually running (so an in-flight stop
  // shows progress here before we hand off to /ipfs/off).
  const { data: job } = useQuery({
    queryKey: ["ipfsJob"],
    queryFn: api.ipfsInstallStatus,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1200 : false),
  });
  const jobActive = job?.status === "running";

  const daemon = useMutation({
    mutationFn: api.ipfsDaemon,
    onSuccess: (r) => {
      qc.setQueryData(["ipfsJob"], r.job ?? undefined);
      qc.setQueryData(["ipfsNode"], r.node);
    },
    onError: (e: Error) => { clientLog.error("IpfsDashboardPage.daemon", e); toast.error(e.message); },
  });

  const autostart = useMutation({
    mutationFn: (action: IpfsAutostartAction) => api.ipfsAutostart(action),
    onSuccess: (n) => {
      qc.setQueryData(["ipfsNode"], n);
      toast.success(n.autostart.enabled ? "IPFS will now start automatically on reboot" : "Reboot auto-start turned off");
    },
    onError: (e: Error) => { clientLog.error("IpfsDashboardPage.autostart", e); toast.error(e.message); },
  });

  // Guided upgrade (ipfs_ui.mdx §15) — kicks the watchable job; the ProgressView above then takes over.
  const upgrade = useMutation({
    mutationFn: api.ipfsUpgrade,
    onSuccess: (j) => qc.setQueryData(["ipfsJob"], j),
    onError: (e: Error) => { clientLog.error("IpfsDashboardPage.upgrade", e); toast.error(e.message); },
  });

  // Proactively migrate a non-blocking config issue while the node runs (ipfs_ui.mdx §14.4).
  const repair = useMutation({
    mutationFn: (issueIds: string[]) => api.ipfsConfigRepair(issueIds),
    onSuccess: (r) => {
      qc.setQueryData(["ipfsNode"], r.node);
      toast.success(r.backupPath ? `Configuration updated — backup saved to ${r.backupPath}` : "Configuration updated");
    },
    onError: (e: Error) => { clientLog.error("IpfsDashboardPage.repair", e); toast.error(e.message); },
  });

  // Redirect to the off-page when the node isn't running and nothing is in flight (§12).
  useEffect(() => {
    if (!jobActive && node && !node.running) {
      navigate({ to: "/ipfs/off", replace: true });
    }
  }, [jobActive, node, navigate]);

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

      {jobActive && job ? (
        <ProgressView job={job} />
      ) : node && node.running ? (
        <RunningDashboard
          node={node}
          navigate={navigate}
          onToggleOff={() => daemon.mutate({ action: "stop" })}
          toggling={daemon.isPending}
          onAutostart={(action) => autostart.mutate(action)}
          autostartBusy={autostart.isPending}
          onUpgrade={() => upgrade.mutate()}
          upgradeBusy={upgrade.isPending}
          onRepair={(ids) => repair.mutate(ids)}
          repairBusy={repair.isPending}
          onFix={async () => {
            try { await api.ipfsEnforce(); qc.invalidateQueries({ queryKey: ["ipfsNode"] }); toast.success("Restored only-our-content defaults"); }
            catch (e) { clientLog.error("IpfsDashboardPage.enforce", e); toast.error((e as Error).message); }
          }}
        />
      ) : (
        // Node not running and no job → the redirect above is taking us to /ipfs/off.
        <div className="text-black/50">Taking you to the IPFS controls…</div>
      )}
    </div>
  );
}

// ── Running dashboard ───────────────────────────────────────────────────────
function RunningDashboard({
  node, navigate, onToggleOff, toggling, onAutostart, autostartBusy, onUpgrade, upgradeBusy, onRepair, repairBusy, onFix,
}: {
  node: IpfsNodeStatus;
  navigate: ReturnType<typeof useNavigate>;
  onToggleOff: () => void;
  toggling: boolean;
  onAutostart: (action: IpfsAutostartAction) => void;
  autostartBusy: boolean;
  onUpgrade: () => void;
  upgradeBusy: boolean;
  onRepair: (issueIds: string[]) => void;
  repairBusy: boolean;
  onFix: () => Promise<void>;
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
        <Tile icon={<Layers className="h-4 w-4" />} label="Blocks" value={num(m.repoObjects)} sub="objects" />
        <Tile
          icon={<Network className="h-4 w-4" />}
          label="Peers"
          value={num(m.peersConnected)}
          sub="connected"
          onClick={() => navigate({ to: "/devices" })}
        />
        <Tile
          icon={<ArrowUpDown className="h-4 w-4" />}
          label="Bandwidth"
          value={m.bandwidthTotalOut != null || m.bandwidthTotalIn != null ? `▲${formatBytes(m.bandwidthTotalOut ?? 0)}` : "—"}
          sub={m.bandwidthTotalIn != null ? `▼${formatBytes(m.bandwidthTotalIn)}` : "in / out"}
        />
      </div>

      {/* Auto-start-on-reboot (§13) */}
      <AutostartRow
        autostart={node.autostart}
        busy={autostartBusy}
        onInstall={() => onAutostart("install")}
        onRemove={() => onAutostart("remove")}
      />

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

      {/* Version upgrade offer (§15) — quiet unless the build is old enough to be risky */}
      <UpgradeCard upgrade={node.upgrade} busy={upgradeBusy} onUpgrade={onUpgrade} />

      {/* Non-blocking config-health notes (§14.4) — the node is up, so these never block */}
      <ConfigHealthCard health={node.configHealth} busy={repairBusy} onFix={onRepair} />

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

function CopyText({ text, display, mono }: { text: string; display: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        // ✓ only on a write that really landed (menus.mdx §3.3).
        void writeClipboard(text, "IpfsDashboardPage.copy").then((ok) => {
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
