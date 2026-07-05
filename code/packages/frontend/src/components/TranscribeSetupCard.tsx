// Setup guidance shown when the local transcription binaries are missing (Transcribe.mdx §5.2). This is
// the transcription analog of CredentialsSetupCard — but transcription needs NO credentials and NO cloud
// account: it runs entirely on this machine with `whisper` (+ `ffmpeg` for video). So instead of a
// secrets schema we show the exact install commands for whatever is missing, plus a "Re-check" button
// that re-queries GET /api/transcribe/tools and — once the tools appear — lets the user run again
// without reloading the page (the "hit a button to re-run once you've fixed it" flow).
import { useState } from "react";
import { Copy, Check, TerminalSquare, RefreshCw } from "lucide-react";
import type { TranscribeTools } from "@lfb/shared";
import { clientLog } from "../lib/clientLog.js";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (e) {
          clientLog.warn("TranscribeSetupCard.copy", e);
        }
      }}
      className="inline-flex items-center gap-1 rounded border border-[var(--lfb-border)] px-2 py-1 text-xs text-black/60 hover:bg-black/5"
      aria-label="Copy install command"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// One row per missing binary: what it's for + the exact command to install it.
const TOOL_INFO: Record<keyof TranscribeTools, { label: string; usedFor: string; command: string }> = {
  whisper: { label: "whisper", usedFor: "the speech-to-text engine (OpenAI Whisper, runs locally)", command: "pipx install openai-whisper" },
  ffmpeg: { label: "ffmpeg", usedFor: "extracting the audio track from a video before transcribing", command: "brew install ffmpeg" },
  ffprobe: { label: "ffprobe", usedFor: "reading a video's duration (drives the progress bar) — comes with ffmpeg", command: "brew install ffmpeg" },
};

export function TranscribeSetupCard({
  tools,
  onRecheck,
  rechecking = false,
}: {
  tools: TranscribeTools;
  onRecheck: () => void;
  rechecking?: boolean;
}) {
  // whisper is always required; ffmpeg only matters for video (still worth showing). ffprobe is optional
  // (progress-bar nicety) and satisfied by the same ffmpeg install, so don't list it as its own blocker.
  const missing = (["whisper", "ffmpeg"] as (keyof TranscribeTools)[]).filter((k) => !tools[k]);
  // De-dupe commands (whisper + ffmpeg differ; if only ffmpeg missing it's one line).
  const commands = [...new Set(missing.map((k) => TOOL_INFO[k].command))];

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-5 text-left">
      <div className="flex items-center gap-2 text-amber-800">
        <TerminalSquare className="h-5 w-5" />
        <h2 className="font-semibold">Transcription tools aren’t installed on this computer</h2>
      </div>
      <p className="mt-2 text-sm text-black/70">
        Transcription runs <b>entirely on this machine</b> — nothing is uploaded and no account,
        API key, or Google Cloud credential is needed. It just needs two free command-line tools.
        {missing.length > 0 && " Install what's missing below, then press Re-check."}
      </p>

      {/* Per-tool status */}
      <div className="mt-4 divide-y divide-amber-200/60 rounded-md border border-amber-200/60 bg-white/70">
        {(["whisper", "ffmpeg", "ffprobe"] as (keyof TranscribeTools)[]).map((k) => (
          <div key={k} className="flex items-center gap-3 px-3 py-2 text-sm">
            <code className="w-20 shrink-0">{TOOL_INFO[k].label}</code>
            <span className={`w-24 shrink-0 ${tools[k] ? "text-green-600" : "text-amber-700"}`}>
              {tools[k] ? "● installed" : "✗ missing"}
            </span>
            <span className="min-w-0 flex-1 text-black/55">{TOOL_INFO[k].usedFor}</span>
          </div>
        ))}
      </div>

      {/* Exact install commands to run */}
      {commands.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-black/50">Run this, then Re-check</span>
            <CopyButton text={commands.join("\n")} />
          </div>
          <pre className="overflow-x-auto rounded-md border border-[var(--lfb-border)] bg-white px-3 py-2 font-mono text-xs leading-relaxed">
            {commands.join("\n")}
          </pre>
          <p className="mt-1 text-xs text-black/50">
            {missing.includes("whisper") && (
              <>
                <span className="font-mono">whisper</span> needs <span className="font-mono">pipx</span>{" "}
                (<span className="font-mono">brew install pipx</span> on Mac).{" "}
              </>
            )}
            On macOS these use Homebrew — see <b>Settings → Tools</b> for the full preflight.
          </p>
        </div>
      )}

      <div className="mt-4">
        <button
          onClick={onRecheck}
          disabled={rechecking}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${rechecking ? "animate-spin" : ""}`} />
          {rechecking ? "Re-checking…" : "Re-check"}
        </button>
      </div>
    </div>
  );
}
