// The install-tools PREFLIGHT page (tools.mdx). Lists the external CLIs LFB depends on — `ipfs` (Kubo,
// REQUIRED) and ffmpeg/ffprobe + image tooling (OPTIONAL) — each with live status, what LFB uses it for,
// the exact copyable install command, and an Install action. Reuses the EXISTING backend detection: the
// IPFS node status/install job (/api/ipfs/node, /api/ipfs/install) for the required row + package
// manager, and /api/compress/tools for the optional rows. Nothing installs without an explicit click
// (charter consent posture, tools.mdx §4.1).
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { IpfsNodeStatus, IpfsInstallJob, CompressTools, DescribeKind, TranscribeTools } from "@lfb/shared";
import { api } from "../../api/client.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { Section } from "../../components/ui/Section.js";
import { healthColor, type Health } from "../../components/ui/health.js";
import { clientLog } from "../../lib/clientLog.js";
import { copyText } from "@/lib/clipboard";

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
  void copyText(text, "Command", "ToolsPage.copy");
}

export function ToolsPage() {
  const qc = useQueryClient();
  // The node status carries the required `ipfs` row + the platform's package manager + install command.
  const { data: node } = useQuery({ queryKey: ["ipfs-node"], queryFn: api.ipfsNode });
  // The optional compression tools (ffmpeg/ffprobe/magick/…).
  const { data: tools } = useQuery({ queryKey: ["compress-tools"], queryFn: api.compressTools });
  // The transcription CLI binaries (Transcribe.mdx §5.2: "the full install preflight also lists these
  // under Settings → Tools"). Only the small binaries belong here — the heavyweight Qwen3-ASR model has
  // its own provisioning UI in Settings → Transcription (transcribe_engine.mdx §6).
  const { data: transcribeTools } = useQuery({ queryKey: ["transcribe-tools"], queryFn: api.transcribeTools });

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

  const rows = buildRows(node, tools ?? null, transcribeTools ?? null);
  const missingRequired = rows.filter((r) => r.level === "required" && !r.installed);
  const allCommand = missingRequired.map((r) => r.command).join("\n") || node.installCommand;

  return (
    <div className="max-w-2xl">
      <PageHeader title="Tools" subtitle="Command-line tools LargeFileBridge uses to scan, pin, compress, and transcribe." />

      <PackageManagerCard node={node} />

      <Section title="Tools" subtitle="Required tools must be present to scan and pin; optional tools enable compression and transcription.">
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

      <AiDescriptionSection />
    </div>
  );
}

// ── AI description providers + prompt editor (ai_description.mdx §5/§4) ──────────────
// Shows which vision providers are configured on this machine (Gemini/Grok/OpenAI, from config or env)
// and lets the user CUSTOMIZE the per-kind prompt files. Saving writes a per-computer override that is
// then used in place of the shipped default; Reset reverts to the default.
const ENV_HINT: Record<string, string> = {
  gemini: "GEMINI_API_KEY (or GOOGLE_API_KEY)",
  grok: "XAI_API_KEY (or GROK_API_KEY)",
  openai: "OPENAI_API_KEY",
};

function AiDescriptionSection() {
  const qc = useQueryClient();
  const { data: providers } = useQuery({ queryKey: ["describe-providers"], queryFn: () => api.describeProviders() });
  const [kind, setKind] = useState<DescribeKind>("video");
  const { data: prompt } = useQuery({ queryKey: ["describe-prompt", kind], queryFn: () => api.describePrompt(kind) });

  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [kind]); // reset the editor when the kind toggles
  const value = draft ?? prompt?.text ?? "";

  const save = useMutation({
    mutationFn: () => api.saveDescribePrompt(kind, value),
    onSuccess: (v) => { qc.setQueryData(["describe-prompt", kind], v); setDraft(null); toast.success("Prompt saved (customized on this computer)"); },
    onError: (e: Error) => { clientLog.error("ToolsPage.savePrompt", e); toast.error(e.message); },
  });
  const reset = useMutation({
    mutationFn: () => api.resetDescribePrompt(kind),
    onSuccess: (v) => { qc.setQueryData(["describe-prompt", kind], v); setDraft(null); toast.success("Prompt reset to the shipped default"); },
    onError: (e: Error) => { clientLog.error("ToolsPage.resetPrompt", e); toast.error(e.message); },
  });

  return (
    <Section title="AI description" subtitle="Vision providers used to describe images & videos, and the prompt sent to them.">
      <div className="mb-4 divide-y divide-[var(--lfb-border)]">
        {(providers?.providers ?? []).map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className="w-32 shrink-0 font-medium">{p.label}</span>
            <span className="w-24 shrink-0" style={{ color: healthColor(p.available ? "ok" : "warn") }}>
              {p.available ? "● configured" : "✗ no key"}
            </span>
            <span className="min-w-0 flex-1 text-black/55">
              describes {p.supports.join(" + ")}
              {p.available && p.usingFile && <> — key from <code className="text-xs">~/.config/GoogleCloud/apikey.yaml</code></>}
              {!p.available && <> — set <code className="text-xs">{ENV_HINT[p.id]}</code> or add it in config.yaml</>}
            </span>
          </div>
        ))}
        {providers && !providers.anyAvailable && (
          <p className="pt-2 text-xs text-amber-700">
            No provider is configured — AI description is disabled until you add at least one API key. Only Gemini describes video.
          </p>
        )}
      </div>

      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium">Prompt for</span>
        {(["video", "image"] as DescribeKind[]).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-md border px-2.5 py-1 text-xs capitalize ${kind === k ? "border-[var(--lfb-primary)] bg-[var(--lfb-primary)]/10 text-[var(--lfb-primary)]" : "border-[var(--lfb-border)] text-black/60"}`}
          >
            {k}
          </button>
        ))}
        {prompt && (
          <span className="ml-auto text-xs text-black/45">{prompt.isOverride ? "customized on this computer" : "shipped default"}</span>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="h-64 w-full rounded-lg border border-[var(--lfb-border)] bg-white p-3 font-mono text-xs text-black/80"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={save.isPending || draft === null}
          onClick={() => save.mutate()}
          className="rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save (customize)"}
        </button>
        {prompt?.isOverride && (
          <button
            disabled={reset.isPending}
            onClick={() => reset.mutate()}
            className="rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/60 disabled:opacity-50"
          >
            Reset to default
          </button>
        )}
      </div>
    </Section>
  );
}

function buildRows(node: IpfsNodeStatus, tools: CompressTools | null, transcribeTools: TranscribeTools | null): ToolRow[] {
  const brew = (formula: string): string =>
    node.platform === "darwin" ? `brew install ${formula}` : node.installCommand;
  const ffmpeg = tools?.ffmpeg ?? false;
  const ffprobe = tools?.ffprobe ?? false;
  const magick = tools?.magick ?? false;
  const whisper = transcribeTools?.whisper ?? false;

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
      name: "whisper",
      level: "optional",
      usedFor: "Transcribe audio & video locally (OpenAI Whisper) — runs entirely on this machine",
      installed: whisper,
      version: null,
      providedBy: null,
      command: "pipx install openai-whisper",
      canInstall: false,
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
