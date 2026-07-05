// The install-tools PREFLIGHT page (tools.mdx). Lists the external CLIs LFB depends on — `ipfs` (Kubo,
// REQUIRED) and ffmpeg/ffprobe + image tooling (OPTIONAL) — each with live status, what LFB uses it for,
// the exact copyable install command, and an Install action. Reuses the EXISTING backend detection: the
// IPFS node status/install job (/api/ipfs/node, /api/ipfs/install) for the required row + package
// manager, and /api/compress/tools for the optional rows. Nothing installs without an explicit click
// (charter consent posture, tools.mdx §4.1).
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { IpfsNodeStatus, IpfsInstallJob, CompressTools } from "@lfb/shared";
import { api } from "../../api/client.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { Section } from "../../components/ui/Section.js";
import { healthColor, type Health } from "../../components/ui/health.js";
import { clientLog } from "../../lib/clientLog.js";

type ToolLevel = "required" | "optional";

interface ToolRow {
  name: string;
  level: ToolLevel;
  usedFor: string;
  installed: boolean;
  version: string | null;
  providedBy: string | null; // e.g. ffprobe "(via ffmpeg)"
  command: string; // exact copyable install command
  canInstall: boolean; // an Install button is wired (only ipfs has a real backend install job)
}

function copy(text: string): void {
  navigator.clipboard?.writeText(text).catch((e) => clientLog.warn("ToolsPage.copy", e));
  toast.success("Copied");
}

export function ToolsPage() {
  const qc = useQueryClient();
  // The node status carries the required `ipfs` row + the platform's package manager + install command.
  const { data: node } = useQuery({ queryKey: ["ipfs-node"], queryFn: api.ipfsNode });
  // The optional compression tools (ffmpeg/ffprobe/magick/…).
  const { data: tools } = useQuery({ queryKey: ["compress-tools"], queryFn: api.compressTools });

  // Install job polling — only while an install is running (single-flight, re-attachable server job).
  const [installing, setInstalling] = useState(false);
  const { data: job } = useQuery({
    queryKey: ["ipfs-install-status"],
    queryFn: api.ipfsInstallStatus,
    enabled: installing,
    refetchInterval: (q) => {
      const j = q.state.data as IpfsInstallJob | undefined;
      return j && j.status === "running" ? 1200 : false;
    },
  });
  // When the job leaves "running" (done/error), re-probe the tool rows and stop polling.
  useEffect(() => {
    if (!installing || !job) return;
    if (job.status === "running" || job.status === "idle") return;
    setInstalling(false);
    void qc.invalidateQueries({ queryKey: ["ipfs-node"] });
    void qc.invalidateQueries({ queryKey: ["compress-tools"] });
    if (job.status === "error" && job.error) toast.error(job.error);
    else if (job.status === "done") toast.success("Tool installed");
  }, [installing, job, qc]);

  const startInstall = useMutation({
    mutationFn: () => api.ipfsInstall(),
    onSuccess: () => setInstalling(true),
    onError: (e: Error) => { clientLog.error("ToolsPage.install", e); toast.error(e.message); },
  });

  if (!node) return <div className="text-black/50">Loading…</div>;

  const rows = buildRows(node, tools ?? null);
  const missingRequired = rows.filter((r) => r.level === "required" && !r.installed);
  const allCommand = missingRequired.map((r) => r.command).join("\n") || node.installCommand;

  return (
    <div className="max-w-2xl">
      <PageHeader title="Tools" subtitle="Command-line tools LargeFileBridge uses to scan, sync, and compress." />

      <PackageManagerCard node={node} />

      <Section title="Tools" subtitle="Required tools must be present to scan and sync; optional tools enable compression.">
        <div className="divide-y divide-[var(--lfb-border)]">
          {rows.map((r) => (
            <ToolRowView
              key={r.name}
              row={r}
              installing={installing}
              onInstall={r.canInstall ? () => startInstall.mutate() : undefined}
            />
          ))}
        </div>

        {missingRequired.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              disabled={installing || !node.packageManagerPresent}
              onClick={() => startInstall.mutate()}
              className="rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {installing ? "Installing…" : "Install all required"}
            </button>
            <span className="text-xs text-black/50">
              Or run manually: <code className="text-xs">{allCommand}</code>
            </span>
            <button onClick={() => copy(allCommand)} className="text-xs text-[var(--lfb-primary)]">Copy</button>
          </div>
        )}

        {installing && job && job.log.length > 0 && (
          <pre className="mt-3 max-h-48 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
            {job.log.slice(-40).join("\n")}
          </pre>
        )}
      </Section>
    </div>
  );
}

function buildRows(node: IpfsNodeStatus, tools: CompressTools | null): ToolRow[] {
  const brew = (formula: string): string =>
    node.platform === "darwin" ? `brew install ${formula}` : node.installCommand;
  const ffmpeg = tools?.ffmpeg ?? false;
  const ffprobe = tools?.ffprobe ?? false;
  const magick = tools?.magick ?? false;

  return [
    {
      name: "ipfs",
      level: "required",
      usedFor: "IPFS node — pinning, add/get, the pinset (required)",
      installed: node.installed,
      version: node.version,
      providedBy: null,
      command: node.installCommand,
      canInstall: !!node.installMethod, // brew/winget only; Linux/other is manual
    },
    {
      name: "ffmpeg",
      level: "optional",
      usedFor: "Compress video · size baselines",
      installed: ffmpeg,
      version: null,
      providedBy: null,
      command: brew("ffmpeg"),
      canInstall: false,
    },
    {
      name: "ffprobe",
      level: "optional",
      usedFor: "Read a video's duration + resolution",
      installed: ffprobe || ffmpeg,
      version: null,
      providedBy: ffmpeg ? "ffmpeg" : null, // one ffmpeg install satisfies both rows
      command: brew("ffmpeg"),
      canInstall: false,
    },
    {
      name: "magick",
      level: "optional",
      usedFor: "Compress images · convert PNG→compressible",
      installed: magick,
      version: null,
      providedBy: null,
      command: brew("imagemagick"),
      canInstall: false,
    },
  ];
}

function ToolRowView({
  row,
  installing,
  onInstall,
}: {
  row: ToolRow;
  installing: boolean;
  onInstall?: () => void;
}) {
  const state: Health = row.installed ? "ok" : row.level === "required" ? "bad" : "warn";
  const statusText = row.installed
    ? row.providedBy
      ? `via ${row.providedBy}`
      : row.version
        ? `v${row.version}`
        : "installed"
    : "missing";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <code className="w-20 shrink-0">{row.name}</code>
      <span className="w-24 shrink-0" style={{ color: healthColor(state) }}>
        {row.installed ? "● " : "✗ "}
        {statusText}
      </span>
      <span className="min-w-0 flex-1 text-black/60">
        {row.usedFor} <span className="text-black/35">({row.level})</span>
      </span>
      {!row.installed && onInstall && (
        <button
          disabled={installing}
          onClick={onInstall}
          className="rounded border border-[var(--lfb-border)] px-2 py-1 text-xs disabled:opacity-50"
        >
          Install
        </button>
      )}
      {!row.installed && !onInstall && (
        <button onClick={() => copy(row.command)} className="text-xs text-[var(--lfb-primary)]" title={row.command}>
          Copy command
        </button>
      )}
    </div>
  );
}

function PackageManagerCard({ node }: { node: IpfsNodeStatus }) {
  const found = node.packageManagerPresent;
  const label = node.installMethod ?? "package manager";
  const state: Health = found ? "ok" : "warn";
  return (
    <Section
      title="Package manager"
      state={state}
      right={
        <span style={{ color: healthColor(state) }}>{found ? "found" : "not found"}</span>
      }
    >
      {found ? (
        <p className="text-sm text-black/70">
          <b className="capitalize">{label}</b> is installed — the tool rows below can be installed with one click.
        </p>
      ) : node.platform === "darwin" ? (
        <p className="text-sm text-black/70">
          Homebrew was not found. Install it first (a system-level change LFB won't make for you):{" "}
          <code className="text-xs">
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
          </code>
        </p>
      ) : (
        <p className="text-sm text-black/70">
          No supported package manager found for this platform. Install the tools below manually.
        </p>
      )}
    </Section>
  );
}
