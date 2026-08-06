// Shared IPFS primitives used by the running dashboard (/ipfs, IpfsDashboardPage), the IPFS-off page
// (/ipfs/off, IpfsOffPage) and the pins page's node verdict (IpfsPage). Extracted so the very-different
// pages (ipfs_ui.mdx §5 running vs §12 off) don't duplicate the progress/error/security building blocks.
import { useEffect, useRef, useState } from "react";
import {
  RefreshCw, AlertCircle, Terminal, Copy, Check, ShieldCheck, ShieldAlert, RotateCw, X,
  ChevronRight, ChevronDown, Wrench, ArrowUpCircle,
} from "lucide-react";
import type {
  IpfsInstallJob, IpfsNodeStatus, IpfsAutostartStatus, IpfsJobKind, IpfsJobPhase,
  IpfsConfigHealth, IpfsUpgradeInfo,
} from "@lfb/shared";
import { toast } from "sonner";
import { api } from "../../api/client.js";
import { writeClipboard } from "@/lib/clipboard";

export function num(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}

// ── Restarting the daemon, waited out ────────────────────────────────────────
const RESTART_POLL_MS = 1000;
// The server-side job has its own start timeout; this only stops the browser polling forever if the API
// itself becomes unreachable mid-restart.
const RESTART_WAIT_MS = 180_000;

/**
 * Restart IPFS and WAIT for the real outcome (ipfs.mdx §3.1.1) — the one way any surface should do this.
 *
 * The restart runs server-side as a single job (`POST /ipfs/restart`) precisely because the stop and the
 * start are not independent: the stop is what takes a healthy node down, and `POST /ipfs/daemon` with
 * `start` answers the instant its background job BEGINS. A caller that awaited that pair would toast
 * "restarted" over a daemon still coming up, and would say nothing whatever about one that never came
 * back. So this polls the job to completion and THROWS the job's own error — including the sentence and
 * the `cause` the off-page's error panel can act on.
 *
 * `onJob` (optional) receives each polled job so a page that renders `ProgressView` can show it live.
 */
export async function restartIpfsAndWait(onJob?: (job: IpfsInstallJob) => void): Promise<void> {
  let job = (await api.ipfsRestart()).job;
  const deadline = Date.now() + RESTART_WAIT_MS;
  while (job && job.status === "running" && Date.now() < deadline) {
    onJob?.(job);
    await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
    job = await api.ipfsInstallStatus();
  }
  if (job) onJob?.(job);
  if (job?.status === "error") throw new Error(job.error ?? "IPFS didn't come back after the restart.");
  if (job?.status === "running") throw new Error("IPFS is still restarting — watch its progress on the IPFS page.");
}

// ── The redesigned turn-on/progress view (ipfs_ui.mdx §16) — a friendly status HERO with step chips
// on top, the terminal log DEMOTED to a collapsed "technical details" disclosure below. Shared by
// install / start / stop / repair / upgrade so the experience is identical everywhere a job runs.

// The ordered, human-labelled steps per job kind — chips light up as the job's phase advances.
function jobSteps(kind: IpfsJobKind): Array<{ phases: IpfsJobPhase[]; label: string }> {
  switch (kind) {
    case "install":
      return [
        { phases: ["detecting"], label: "Detect" },
        { phases: ["installing"], label: "Install" },
        { phases: ["initializing"], label: "Initialize" },
        { phases: ["starting", "autostart"], label: "Start" },
      ];
    case "upgrade":
      return [
        { phases: ["detecting", "stopping"], label: "Prepare" },
        { phases: ["upgrading"], label: "Upgrade" },
        { phases: ["starting", "autostart"], label: "Restart" },
      ];
    case "repair":
      return [
        { phases: ["repairing", "migrating"], label: "Fix config" },
        { phases: ["initializing"], label: "Initialize" },
        { phases: ["starting", "autostart"], label: "Start" },
      ];
    case "stop":
      return [{ phases: ["stopping"], label: "Stop" }];
    case "restart":
      return [
        { phases: ["stopping"], label: "Stop" },
        { phases: ["starting"], label: "Start" },
      ];
    default: // start
      return [
        { phases: ["initializing"], label: "Initialize" },
        { phases: ["starting"], label: "Start" },
        { phases: ["autostart"], label: "Keep on reboot" },
      ];
  }
}

const JOB_TITLE: Record<IpfsJobKind, string> = {
  install: "Installing IPFS…",
  start: "Starting IPFS…",
  stop: "Stopping IPFS…",
  repair: "Fixing your IPFS configuration…",
  upgrade: "Upgrading IPFS…",
  restart: "Restarting IPFS…",
};
const JOB_SUB: Record<IpfsJobKind, string> = {
  install: "Setting up the engine that pins your big files between your computers.",
  start: "Bringing your node online so your big files can pin.",
  stop: "Taking your node offline on this computer.",
  repair: "Migrating your configuration so IPFS can start again.",
  upgrade: "Updating to a newer, healthier version of IPFS.",
  restart: "Putting your saved settings into effect — IPFS reads them when it starts.",
};

export function ProgressView({ job }: { job: IpfsInstallJob }) {
  const steps = jobSteps(job.kind);
  // Which step is active? The furthest step whose phases include the current phase (or that has passed).
  const activeIdx = Math.max(
    0,
    steps.findIndex((s) => s.phases.includes(job.phase)),
  );
  const done = job.status === "done";
  return (
    <div className="rounded-lg border border-[var(--lfb-border)] bg-white p-6">
      {/* HERO — the friendly story, not the terminal */}
      <div className="flex items-start gap-3">
        {done ? (
          <Check className="mt-0.5 h-6 w-6 shrink-0 text-green-600" />
        ) : (
          <RefreshCw className="mt-0.5 h-6 w-6 shrink-0 animate-spin text-[var(--lfb-primary)]" />
        )}
        <div className="min-w-0">
          <div className="text-lg font-semibold">{done ? "Done" : JOB_TITLE[job.kind]}</div>
          <div className="text-sm text-black/55">{JOB_SUB[job.kind]}</div>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
          {job.phase}
        </span>
      </div>

      {/* STEP CHIPS — a non-technical progress the user actually reads */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {steps.map((s, i) => {
          const state = done || i < activeIdx ? "done" : i === activeIdx ? "active" : "pending";
          return (
            <span
              key={s.label}
              className={
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium " +
                (state === "done"
                  ? "bg-green-50 text-green-700"
                  : state === "active"
                    ? "bg-[color-mix(in_srgb,var(--lfb-primary)_12%,white)] text-[var(--lfb-primary)]"
                    : "bg-slate-50 text-black/35")
              }
            >
              <span
                className={
                  "h-1.5 w-1.5 rounded-full " +
                  (state === "done" ? "bg-green-500" : state === "active" ? "bg-[var(--lfb-primary)]" : "bg-black/20")
                }
              />
              {s.label}
            </span>
          );
        })}
      </div>

      {/* TERMINAL — demoted to a collapsed "technical details" disclosure */}
      <CollapsibleLog lines={job.log} />
    </div>
  );
}

// The terminal log, collapsed by default behind a "Show technical details" toggle (ipfs_ui.mdx §16.1).
export function CollapsibleLog({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs text-black/45 hover:text-black/70"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Terminal className="h-3.5 w-3.5" /> {open ? "Hide" : "Show"} technical details
      </button>
      {open && <LogBox lines={lines} />}
    </div>
  );
}

export function ErrorPanel({
  job, onRetry, onMigrate, onDismiss,
}: { job: IpfsInstallJob; onRetry: () => void; onMigrate: () => void; onDismiss: () => void }) {
  // A repo left behind by an older Kubo needs a ONE-TIME migration, and the app can run it — `start`
  // with `migrate: true` is `ipfs daemon --migrate` (ipfs_ui.mdx §14.2). Plain Retry can only fail the
  // same way forever, so the panel used to hand the user a terminal command for a repair it could do
  // itself. The manual command stays below as the escape hatch.
  const needsMigrate = job.cause === "needs_migrate";
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-5">
      <div className="flex items-center gap-2 text-red-800">
        <AlertCircle className="h-5 w-5" />
        <div className="font-semibold">{job.error ?? "Something went wrong"}</div>
      </div>
      {needsMigrate && (
        <p className="mt-2 max-w-2xl text-sm text-red-900/80">
          Large File Bridge can run the migration for you. It updates the on-disk IPFS repository to the
          format this version needs — your pinned files and your node identity are kept.
        </p>
      )}
      {job.log.length > 0 && <LogBox lines={job.log} />}
      {job.manualCommand && <ManualCommand command={job.manualCommand} note="Run this in a terminal to finish by hand:" />}
      <div className="mt-4 flex gap-2">
        {needsMigrate ? (
          <button onClick={onMigrate} className="lfb-btn lfb-btn-primary">
            Run the one-time migration
          </button>
        ) : (
          <button onClick={onRetry} className="lfb-btn lfb-btn-primary">
            Retry
          </button>
        )}
        <button onClick={onDismiss} className="lfb-btn lfb-btn-secondary">
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function LogBox({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  if (lines.length === 0) return null;
  return (
    <pre ref={ref} className="mt-3 max-h-56 overflow-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
      {lines.join("\n")}
    </pre>
  );
}

export function ManualCommand({ command, note }: { command: string; note: string }) {
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

export function CopyText({
  text, display, mono, iconOnly,
}: { text: string; display: string; mono?: boolean; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        // The ✓ is this button's feedback, so flip it only when the write REALLY landed; a failed copy
        // toasts the error instead of showing a check that lies (menus.mdx §3.3).
        void writeClipboard(text, "ipfs.copy").then((ok) => {
          if (!ok) return toast.error("Couldn't copy to the clipboard");
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={`Copy ${text}`}
      className={`inline-flex items-center gap-1 hover:text-[var(--lfb-primary)] ${mono ? "font-mono text-xs" : ""}`}
    >
      {!iconOnly && display}
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 text-black/30" />}
    </button>
  );
}

// ── Security posture card (only-our-content — ipfs_ui.mdx §8) ─────────────────
export function SecurityCard({
  node, onFix, onRestart,
}: {
  node: IpfsNodeStatus;
  onFix: () => Promise<void>;
  // Kubo reads every charter key at startup (ipfs.mdx §3.1.1), so a written setting is not a live one.
  // Without this the card's "Only your content ✓" describes the config FILE while the running daemon is
  // still relaying strangers' traffic — the one state this card exists to make impossible.
  onRestart: () => Promise<void>;
}) {
  const [fixing, setFixing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const nonCompliant = node.running && !node.compliant;
  const acknowledged = nonCompliant && node.publicGateway;
  const pendingRestart = node.running && node.compliant && node.restartRequired;
  return (
    <div className="rounded-lg border border-[var(--lfb-border)] bg-white">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium">
          {pendingRestart ? (
            <RotateCw className="h-4 w-4 text-amber-600" />
          ) : node.compliant ? (
            <ShieldCheck className="h-4 w-4 text-green-600" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-red-600" />
          )}
          {pendingRestart ? "Restart needed" : node.compliant ? "Only your content ✓" : "Check needed"}
        </span>
        <Posture label="Reprovide" ok={node.reprovideStrategy !== "all"} value={node.reprovideStrategy} />
        <Posture label="Gateway" ok={node.gatewayLocalOnly} value={node.gatewayLocalOnly ? "local-only" : "public"} />
        {/* The charter bans bouncing other people's content OR TRAFFIC (ipfs.mdx §3.2). Reprovide and
            Gateway cover content; these two cover traffic — and both default ON in Kubo, so leaving
            them off the card meant reporting "Only your content ✓" for a node relaying strangers. */}
        <Posture label="Relay" ok={node.relayServiceOff} value={node.relayServiceOff ? "off" : "relaying"} />
        <Posture label="Routing" ok={node.dhtClientOnly} value={node.dhtClientOnly ? "client-only" : "serving"} />
        <Posture label="GC" ok={node.gcOn} value={node.gcOn ? "on" : "off"} />
      </div>
      {pendingRestart && (
        <div className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <RotateCw className="h-4 w-4" />
          <span className="flex-1">
            Your only-your-content settings are saved, but IPFS only reads them when it starts — until it
            restarts, this computer is still using its previous ones.
          </span>
          <button
            onClick={async () => { setRestarting(true); await onRestart(); setRestarting(false); }}
            disabled={restarting}
            className="lfb-btn lfb-btn-warn lfb-btn-sm"
          >
            {restarting ? "Restarting…" : "Restart IPFS"}
          </button>
        </div>
      )}
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
              className="lfb-btn lfb-btn-danger lfb-btn-sm"
            >
              {fixing ? "Fixing…" : "Fix"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Posture({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-black/50">{label}</span>
      <span className={ok ? "text-green-700" : "text-red-700"}>{value} {ok ? "✓" : "✗"}</span>
    </span>
  );
}

// ── Config health & guided self-repair (ipfs_ui.mdx §14) ─────────────────────
// The card that turns the incident (a deprecated config key crash mislabeled as a "timeout") into a
// one-click, confirm-then-apply fix. Lists each change in plain language BEFORE the user commits, notes
// the timestamped backup, and always keeps the manual steps within reach. Used on the off-page as a
// BLOCKER takeover, and on the dashboard as a quiet warn/info card.
export function ConfigHealthCard({
  health, busy, onFix,
}: {
  health: IpfsConfigHealth;
  busy: boolean;
  onFix: (issueIds: string[]) => void;
}) {
  const [showManual, setShowManual] = useState(false);
  if (!health.checked || health.issues.length === 0) return null;

  // Rank the most severe issue first — it drives the card's tone and headline.
  const order = { blocker: 0, warn: 1, info: 2 } as const;
  const issues = [...health.issues].sort((a, b) => order[a.severity] - order[b.severity]);
  const primary = issues[0];
  const blocker = primary.severity === "blocker";
  const fixableIds = issues.filter((i) => i.fixable).map((i) => i.id);
  const changes = issues.filter((i) => i.fixable).flatMap((i) => i.changes);
  const manualSteps = issues.flatMap((i) => i.manualSteps);

  const tone = blocker
    ? "border-amber-300 bg-amber-50"
    : primary.severity === "warn"
      ? "border-amber-200 bg-amber-50/60"
      : "border-[var(--lfb-border)] bg-white";

  return (
    <div className={`rounded-lg border ${tone} p-6`}>
      <div className="flex items-start gap-2.5">
        <Wrench className={`mt-0.5 h-5 w-5 shrink-0 ${blocker ? "text-amber-600" : "text-black/50"}`} />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{primary.title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-black/60">{primary.detail}</p>
        </div>
      </div>

      {changes.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-black/45">What we'll change</div>
          <ul className="space-y-1 text-sm text-black/70">
            {changes.map((c, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-black/40" />
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {fixableIds.length > 0 && (
          <button
            onClick={() => onFix(fixableIds)}
            disabled={busy}
            className="lfb-btn lfb-btn-primary lfb-btn-lg"
          >
            <Wrench className="h-4 w-4" /> {busy ? "Fixing…" : "Review & Fix Configuration"}
          </button>
        )}
        {manualSteps.length > 0 && (
          <button
            onClick={() => setShowManual((s) => !s)}
            className="inline-flex items-center gap-1 text-sm text-black/50 hover:text-black/75"
          >
            {showManual ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Or do it yourself
          </button>
        )}
      </div>

      {showManual && manualSteps.length > 0 && (
        <div className="mt-3 rounded-md border border-[var(--lfb-border)] bg-slate-50 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs text-black/50">
            <Terminal className="h-3.5 w-3.5" /> Run these in a terminal (we back up your config first):
          </div>
          <pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-black/70">
            {manualSteps.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Version upgrade offer (ipfs_ui.mdx §15) ──────────────────────────────────
// Quiet on the dashboard when a newer build merely exists; prominent when the installed version is
// below the recommended baseline (old enough to risk the start crashes this whole feature guards).
export function UpgradeCard({
  upgrade, busy, onUpgrade,
}: {
  upgrade: IpfsUpgradeInfo;
  busy: boolean;
  onUpgrade: () => void;
}) {
  // Nothing to show unless it's below baseline OR the package manager reports a newer build.
  if (!upgrade.belowBaseline && upgrade.updateAvailable !== true) return null;
  const urgent = upgrade.belowBaseline;
  return (
    <div className={`rounded-lg border p-4 ${urgent ? "border-amber-300 bg-amber-50" : "border-[var(--lfb-border)] bg-white"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ArrowUpCircle className={`h-5 w-5 shrink-0 ${urgent ? "text-amber-600" : "text-[var(--lfb-primary)]"}`} />
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {urgent ? "A newer, recommended version of IPFS is available" : "An IPFS update is available"}
          </div>
          <div className="text-xs text-black/55">
            Installed: {upgrade.installedVersion ? `Kubo v${upgrade.installedVersion}` : "unknown"}
            {urgent && <> · Recommended: v{upgrade.recommendedMin}+</>}
            {urgent && " — older versions can fail to start after a config change."}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {upgrade.canAutoUpgrade && (
            <button
              onClick={onUpgrade}
              disabled={busy}
              className={
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 " +
                (urgent
                  ? "bg-[var(--lfb-primary)] text-white hover:opacity-90"
                  : "border border-[var(--lfb-border)] hover:bg-slate-100")
              }
            >
              <ArrowUpCircle className="h-4 w-4" /> {busy ? "Upgrading…" : "Upgrade IPFS"}
            </button>
          )}
        </div>
      </div>
      <ManualCommand command={upgrade.upgradeCommand} note="Or upgrade it yourself:" />
    </div>
  );
}

// ── Auto-start-on-reboot control (ipfs_ui.mdx §13/§18) ───────────────────────
// The running dashboard's "will IPFS come back after a reboot?" control. PROMINENCE follows state
// (ipfs_ui.mdx §18): when OFF it's a FILLED BLUE call-to-action (we want the user to enable it); when
// ON it drops to a muted "Starts on reboot ✓" status line with only an understated Turn-off. Not shown
// on OSes we don't automate yet (supported:false).
export function AutostartRow({
  autostart, busy, onInstall, onRemove,
}: {
  autostart: IpfsAutostartStatus;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  if (!autostart.supported) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--lfb-border)] bg-white px-4 py-3 text-sm">
        <RotateCw className="h-4 w-4 text-black/40" />
        <span className="font-medium">Start on reboot</span>
        <span className="text-black/50">not available on this operating system yet</span>
      </div>
    );
  }
  // This row answers ONE question: "will IPFS come back after I reboot?" (ipfs_ui.mdx §13.1)
  //
  // Two ways it used to answer wrongly:
  //   1. "Registered with launchd" is NOT "working". An agent that lost the repo-lock race sits
  //      registered-but-DEAD at exit code 1, and this rendered it "on ✓" — the exact contradiction the
  //      user hit ("it says on, but IPFS is off after every reboot"). So: enabled && !lastRunFailed.
  //   2. Someone ELSE may be the one starting IPFS (Homebrew's kubo agent). We deliberately don't
  //      compete with it (§13.2) — but the honest answer to the question is then still YES. Reporting
  //      "off" because *our* agent isn't the owner would be a new lie in the other direction.
  const failed = autostart.lastRunFailed;
  const conflict = autostart.conflict;
  const oursOn = autostart.enabled && !failed;
  const on = oursOn || conflict !== null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--lfb-border)] bg-white px-4 py-3 text-sm">
      <RotateCw className={`h-4 w-4 ${failed && !conflict ? "text-amber-600" : on ? "text-green-600" : "text-black/40"}`} />
      <span className="font-medium">Start on reboot</span>
      <span className={failed && !conflict ? "text-amber-700" : on ? "text-green-700" : "text-black/50"}>
        {conflict
          ? `on ✓ — ${conflict.source} starts IPFS when you log in`
          : failed
            ? `set up, but it failed at the last reboot${autostart.lastExitCode !== null ? ` (exit ${autostart.lastExitCode})` : ""} — IPFS did not come back`
            : oursOn
              ? "on ✓ — IPFS will restart automatically when you reboot"
              : "off — IPFS won't come back on its own after a reboot"}
      </span>
      {/* Name the real cause instead of leaving the user to guess — the whole point of §13.1. */}
      {failed && !conflict && autostart.failureReason && (
        <span className="w-full text-xs text-black/50">{autostart.failureReason}</span>
      )}
      {conflict && (
        <span className="w-full text-xs text-black/50">
          Large File Bridge is letting {conflict.source} ({conflict.label}) do that, rather than adding a
          second daemon that would fight it for the IPFS repository lock at every login.
          {autostart.installed
            ? " An older Large File Bridge auto-start agent is still installed and losing that race — turn it off to clear the conflict."
            : ""}
        </span>
      )}
      {/* The control acts ONLY on OUR agent — it must never imply we can toggle someone else's. With a
          foreign owner and no agent of ours, there is nothing for this button to do (§13.2): offering
          "Turn off" there would be a no-op that reads like it stops Homebrew's, and offering "Turn on"
          would promise a competing agent we deliberately refuse to create. So: no button. */}
      <span className="ml-auto">
        {conflict && !autostart.installed ? null : autostart.installed ? (
          <button
            onClick={onRemove}
            disabled={busy}
            className="lfb-btn lfb-btn-secondary lfb-btn-sm"
            title={
              conflict
                ? `Remove Large File Bridge's auto-start agent, leaving ${conflict.source} as the only one that starts IPFS`
                : "Stop IPFS from starting automatically on reboot"
            }
          >
            <X className="h-3.5 w-3.5" /> {conflict ? "Clear the conflict" : "Turn off auto-start"}
          </button>
        ) : (
          <button
            onClick={onInstall}
            disabled={busy}
            className="lfb-btn lfb-btn-primary lfb-btn-sm"
            title="Set IPFS to start automatically every time you reboot"
          >
            <RotateCw className="h-3.5 w-3.5" /> Turn on auto-start
          </button>
        )}
      </span>
    </div>
  );
}
