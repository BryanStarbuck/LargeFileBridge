// The IPFS-OFF page (/ipfs/off — ipfs_ui.mdx §12). A deliberately DIFFERENT page from the running
// dashboard: when you land here IPFS is not running, and the whole page is about getting it back on —
// and, ideally, keeping it on across reboots. This is the page you hit after a reboot ("I rebooted;
// IPFS isn't running").
//
// The centerpiece for the installed-but-stopped state is a TWO-BUTTON choice:
//   1) (recommended) "Turn On IPFS" that ALSO sets IPFS to start automatically every reboot.
//   2) "Or" — "Turn On IPFS" that just starts it now WITHOUT changing the reboot auto-start setup.
// We steer toward (1): it's the primary/filled button, labelled recommended.
//
// Redirects to /ipfs (the running dashboard) once the node is healthy and no job is in flight.
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Power, DownloadCloud, RotateCw, Terminal } from "lucide-react";
import { toast } from "sonner";
import type { IpfsNodeStatus } from "@lfb/shared";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";
import { ProgressView, ErrorPanel, ManualCommand } from "./ipfsShared.js";

export function IpfsOffPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: node, isLoading } = useQuery({
    queryKey: ["ipfsNode"],
    queryFn: api.ipfsNode,
    refetchInterval: 15_000,
  });

  const { data: job } = useQuery({
    queryKey: ["ipfsJob"],
    queryFn: api.ipfsInstallStatus,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1200 : false),
  });
  const jobActive = job?.status === "running";
  const jobErrored = job?.status === "error";

  const install = useMutation({
    mutationFn: api.ipfsInstall,
    onSuccess: (j) => qc.setQueryData(["ipfsJob"], j),
    onError: (e: Error) => { clientLog.error("IpfsOffPage.install", e); toast.error(e.message); },
  });
  const daemon = useMutation({
    mutationFn: api.ipfsDaemon,
    onSuccess: (r) => {
      qc.setQueryData(["ipfsJob"], r.job ?? undefined);
      qc.setQueryData(["ipfsNode"], r.node);
    },
    onError: (e: Error) => { clientLog.error("IpfsOffPage.daemon", e); toast.error(e.message); },
  });

  // When a job finishes, refresh node status so we can redirect / re-render the right state.
  useEffect(() => {
    if (job && job.status !== "running") qc.invalidateQueries({ queryKey: ["ipfsNode"] });
  }, [job?.status, qc]);

  // Once healthy and idle, hand off to the running dashboard (§12).
  useEffect(() => {
    if (!jobActive && node && node.running) {
      navigate({ to: "/ipfs", replace: true });
    }
  }, [jobActive, node, navigate]);

  if (isLoading && !node) {
    return <div className="text-black/50">Loading the IPFS node…</div>;
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">IPFS</h1>

      {jobActive && job ? (
        <ProgressView job={job} />
      ) : jobErrored && job ? (
        <ErrorPanel
          job={job}
          onRetry={() => (job.kind === "install" ? install.mutate() : daemon.mutate({ action: "start" }))}
          onDismiss={() => qc.setQueryData(["ipfsJob"], { ...job, status: "idle" })}
        />
      ) : node && !node.installed ? (
        <InstallCard node={node} onInstall={() => install.mutate()} installing={install.isPending} />
      ) : node && !node.running ? (
        <StoppedCard
          node={node}
          starting={daemon.isPending}
          onTurnOnWithAutostart={() => daemon.mutate({ action: "start", autostart: true })}
          onTurnOnOnly={() => daemon.mutate({ action: "start" })}
        />
      ) : (
        <div className="text-black/50">IPFS is running — taking you to the dashboard…</div>
      )}
    </div>
  );
}

// ── Installed-but-stopped: the two-button choice (ipfs_ui.mdx §12) ────────────
function StoppedCard({
  node, starting, onTurnOnWithAutostart, onTurnOnOnly,
}: {
  node: IpfsNodeStatus;
  starting: boolean;
  onTurnOnWithAutostart: () => void;
  onTurnOnOnly: () => void;
}) {
  const a = node.autostart;
  // If auto-start is already set up (or the OS can't do it), there's no meaningful choice — one button.
  const alreadyAuto = a.supported && a.enabled;
  const canAuto = a.supported && !a.enabled;

  return (
    <div className="rounded-lg border border-[var(--lfb-border)] bg-white p-6">
      <div className="flex items-center gap-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <h2 className="text-lg font-semibold">IPFS is installed but not running</h2>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-black/60">
        {node.version ? `Kubo v${node.version}. ` : ""}Turn it on so your big files can sync across your
        computers.
        {alreadyAuto && " IPFS is already set to start automatically when you reboot ✓."}
      </p>

      {canAuto ? (
        // The two-button choice — steer toward keeping IPFS on across reboots.
        <div className="mt-5 space-y-5">
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-black/80">
              <RotateCw className="h-4 w-4 text-[var(--lfb-primary)]" />
              Automatically restart when you reboot
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={onTurnOnWithAutostart}
                disabled={starting}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                <Power className="h-4 w-4" /> Turn On IPFS
              </button>
              <span className="text-sm text-black/55">
                Turns IPFS on now <b>and</b> sets it to start automatically every time you reboot or log
                in. <span className="font-medium text-[var(--lfb-primary)]">Recommended.</span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-black/35">
            <span className="h-px flex-1 bg-[var(--lfb-border)]" /> Or <span className="h-px flex-1 bg-[var(--lfb-border)]" />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={onTurnOnOnly}
              disabled={starting}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-4 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-50"
            >
              <Power className="h-4 w-4" /> Turn On IPFS
            </button>
            <span className="text-sm text-black/55">
              But don't modify whether or how IPFS starts up when you restart the computer.
            </span>
          </div>
        </div>
      ) : (
        // Auto-start already on, or not supported on this OS → a single Turn-On button.
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            onClick={onTurnOnOnly}
            disabled={starting}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <Power className="h-4 w-4" /> Turn On IPFS
          </button>
          {!a.supported && (
            <span className="text-sm text-black/55">
              Automatic restart on reboot isn't available on this operating system yet.
            </span>
          )}
        </div>
      )}

      <ManualCommand command="ipfs daemon --enable-gc" note="Or start it yourself:" />
    </div>
  );
}

// ── Not installed: install first (install brings the daemon up) ──────────────
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
      <p className="mt-3 flex items-center gap-1.5 text-xs text-black/40">
        <Terminal className="h-3.5 w-3.5" /> After IPFS is installed and running, you can set it to start
        automatically on reboot from the IPFS page.
      </p>
    </div>
  );
}
