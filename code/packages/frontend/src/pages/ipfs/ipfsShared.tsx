// Shared IPFS-dashboard primitives used by BOTH the running dashboard (/ipfs, IpfsDashboardPage) and
// the IPFS-off page (/ipfs/off, IpfsOffPage). Extracted so the two very-different pages (ipfs_ui.mdx
// §5 running vs §12 off) don't duplicate the progress/error/security building blocks.
import { useEffect, useRef, useState } from "react";
import { RefreshCw, AlertCircle, Terminal, Copy, Check, ShieldCheck, ShieldAlert, RotateCw, X } from "lucide-react";
import type { IpfsInstallJob, IpfsNodeStatus, IpfsAutostartStatus } from "@lfb/shared";
import { clientLog } from "../../lib/clientLog.js";

export function num(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}

// ── Progress + error views (install / start / stop jobs — ipfs_ui.mdx §7.2) ──
export function ProgressView({ job }: { job: IpfsInstallJob }) {
  const title =
    job.kind === "install"
      ? "Installing IPFS…"
      : job.kind === "start"
        ? "Starting the IPFS daemon…"
        : "Stopping IPFS…";
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
        navigator.clipboard?.writeText(text).catch((err) => clientLog.warn("ipfs.copy", err));
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
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

// ── Auto-start-on-reboot control (ipfs_ui.mdx §13) ───────────────────────────
// The running dashboard's compact "will IPFS come back after a reboot?" line + one-click toggle. Not
// shown on OSes we don't automate yet (supported:false).
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
