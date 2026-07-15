// Shared IPFS-dashboard primitives used by BOTH the running dashboard (/ipfs, IpfsDashboardPage) and
// the IPFS-off page (/ipfs/off, IpfsOffPage). Extracted so the two very-different pages (ipfs_ui.mdx
// §5 running vs §12 off) don't duplicate the progress/error/security building blocks.
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
import { writeClipboard } from "@/lib/clipboard";

export function num(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
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
};
const JOB_SUB: Record<IpfsJobKind, string> = {
  install: "Setting up the engine that pins your big files between your computers.",
  start: "Bringing your node online so your big files can pin.",
  stop: "Taking your node offline on this computer.",
  repair: "Migrating your configuration so IPFS can start again.",
  upgrade: "Updating to a newer, healthier version of IPFS.",
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
  job, onRetry, onDismiss,
}: { job: IpfsInstallJob; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-5">
      <div className="flex items-center gap-2 text-red-800">
        <AlertCircle className="h-5 w-5" />
        <div className="font-semibold">{job.error ?? "Something went wrong"}</div>
      </div>
      {job.log.length > 0 && <LogBox lines={job.log} />}
      {job.manualCommand && <ManualCommand command={job.manualCommand} note="Run this in a terminal to finish by hand:" />}
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
export function SecurityCard({ node, onFix }: { node: IpfsNodeStatus; onFix: () => Promise<void> }) {
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
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
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
  const on = autostart.enabled;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--lfb-border)] bg-white px-4 py-3 text-sm">
      <RotateCw className={`h-4 w-4 ${on ? "text-green-600" : "text-black/40"}`} />
      <span className="font-medium">Start on reboot</span>
      <span className={on ? "text-green-700" : "text-black/50"}>
        {on ? "on ✓ — IPFS will restart automatically when you reboot" : "off — IPFS won't come back on its own after a reboot"}
      </span>
      <span className="ml-auto">
        {on ? (
          <button
            onClick={onRemove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-2.5 py-1 text-sm hover:bg-slate-100 disabled:opacity-50"
            title="Stop IPFS from starting automatically on reboot"
          >
            <X className="h-3.5 w-3.5" /> Turn off auto-start
          </button>
        ) : (
          <button
            onClick={onInstall}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-2.5 py-1 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            title="Set IPFS to start automatically every time you reboot"
          >
            <RotateCw className="h-3.5 w-3.5" /> Turn on auto-start
          </button>
        )}
      </span>
    </div>
  );
}
