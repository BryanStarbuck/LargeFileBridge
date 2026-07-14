// Settings → Transcription (transcribe_engine.mdx §6). Surfaces the two-engine state, the heavyweight
// Qwen3-ASR model readiness (§3.1), its on-disk size / disk estimate, and the provisioning actions
// (Download/install · Update/Repair · Remove · Re-check). Matches the SettingsPage look: a <Section> card
// with a health line on the right, the app's button classes, react-query, and sonner toasts.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { formatBytes } from "@lfb/shared";
import type { TranscribeEngineStatus, TranscribeModelReadiness } from "@lfb/shared";
import { api } from "../../api/client.js";
import { Section } from "../../components/ui/Section.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { healthColor } from "../../components/ui/health.js";
import { clientLog } from "../../lib/clientLog.js";

const ENGINE_LABEL = {
  speech: "Apple SpeechAnalyzer — on-device (macOS 26+), preferred",
  qwen: "Qwen3-ASR (MLX) — heavyweight, higher quality",
  mac: "Whisper Small (Mac) — fallback",
} as const;

// Plain-English wording for each readiness state (§3.1). `unsupported` is the non-Apple-Silicon case where
// qwen can never run, so we say so and hide its actions.
const READINESS_TEXT: Record<TranscribeModelReadiness, string> = {
  installed: "Installed and ready ✓",
  missing: "Not downloaded",
  partial: "Half-installed — needs repair",
  outdated: "Installed, but an update is available",
  unsupported: "Not an Apple-Silicon Mac — the Whisper (Mac) engine is used",
};

export function TranscriptionSettingsSection() {
  const qc = useQueryClient();
  const { data, refetch, isFetching } = useQuery({
    queryKey: ["transcribe-engine"],
    queryFn: api.transcribeEngine,
  });

  // Every provisioning action re-reads engine state on success so the panel reflects the new readiness.
  const invalidate = () => qc.invalidateQueries({ queryKey: ["transcribe-engine"] });

  const provision = useMutation({
    mutationFn: () => api.transcribeProvision(),
    onSuccess: () => {
      invalidate();
      toast.success("Setting up the transcription model — watch progress on the Processing page.");
    },
    onError: (e: Error) => { clientLog.error("Transcription.provision", e); toast.error(e.message); },
  });
  const repair = useMutation({
    mutationFn: () => api.transcribeRepair(),
    onSuccess: () => {
      invalidate();
      toast.success("Updating the transcription model — watch progress on the Processing page.");
    },
    onError: (e: Error) => { clientLog.error("Transcription.repair", e); toast.error(e.message); },
  });
  const remove = useMutation({
    mutationFn: () => api.transcribeRemoveModel(),
    onSuccess: (r) => {
      invalidate();
      toast.success(
        r.removed
          ? `Removed the transcription model — freed ${formatBytes(r.freedBytes)}.`
          : "Nothing to remove — the model was not installed.",
      );
    },
    onError: (e: Error) => { clientLog.error("Transcription.remove", e); toast.error(e.message); },
  });

  if (!data) return <Section title="Transcription"><p className="text-sm text-black/50">Loading…</p></Section>;

  const s: TranscribeEngineStatus = data;
  const readiness = s.appleSilicon ? s.qwen.readiness : "unsupported";
  const showQwenActions = s.appleSilicon; // qwen provisioning is Apple-Silicon-only (§3, §5.2)
  const state = readiness === "installed" || readiness === "unsupported" ? "ok" : "warn";
  const busy = provision.isPending || repair.isPending || remove.isPending;

  // On-disk size when the weights are present, else the (ballpark→stored) install estimate + free disk (§3.1).
  const sizeLine =
    s.qwen.installedBytes != null
      ? `${formatBytes(s.qwen.installedBytes)} on disk`
      : `About ${formatBytes(s.qwen.estimateBytes)} to download · ${formatBytes(s.qwen.freeDiskBytes)} free`;

  return (
    <Section
      title="Transcription"
      subtitle="Speech-to-text for your audio & video. A heavyweight local model gives the best quality; a built-in Whisper engine is the fallback."
      state={state}
      right={
        <span style={{ color: healthColor(state) }}>
          {ENGINE_LABEL[s.active]}
        </span>
      }
    >
      <dl className="space-y-1.5 text-sm text-black/70">
        <div>
          Active engine: <b>{ENGINE_LABEL[s.active]}</b>
        </div>
        {showQwenActions && (
          <div>
            Heavyweight model ({s.qwen.model}):{" "}
            <span style={{ color: healthColor(state) }}>{READINESS_TEXT[readiness]}</span>
            {" · "}
            <span className="text-black/50">{sizeLine}</span>
          </div>
        )}
        {!showQwenActions && (
          <div className="text-black/60">{READINESS_TEXT.unsupported}</div>
        )}
        <div className="text-black/50">
          Whisper Small (Mac) fallback: {s.whisper.installed ? "installed ✓" : "not installed"}
          {" · "}
          ffmpeg (video demux): {s.ffmpeg ? "installed ✓" : "not installed"}
        </div>
      </dl>

      {/* macOS-update nudge (transcribe_engine.mdx §1): this Mac's hardware supports Apple SpeechAnalyzer —
          the higher-quality on-device primary — but the OS is older than macOS 26, so we fell back to
          Whisper Small. Recommend the update; nothing is broken, transcription still works on the fallback. */}
      {s.speech.needsOsUpdate && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This Mac supports Apple’s on-device <b>SpeechAnalyzer</b>, which gives higher-quality transcription,
          but it needs <b>macOS {26}+</b>{s.speech.osMajor != null ? ` (you’re on macOS ${s.speech.osMajor})` : ""}.
          Install the latest macOS update to enable it. For now, transcription falls back to <b>Whisper Small</b>.
        </div>
      )}

      {/* Provisioning actions — shown by readiness. All qwen actions are hidden on non-Apple-Silicon (§3, §6). */}
      <div className="mt-3 flex flex-wrap gap-2">
        {showQwenActions && readiness === "missing" && (
          <button
            disabled={busy}
            onClick={() => provision.mutate()}
            className="rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Download &amp; install model
          </button>
        )}
        {showQwenActions && (readiness === "partial" || readiness === "outdated") && (
          <button
            disabled={busy}
            onClick={() => repair.mutate()}
            className="rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {readiness === "outdated" ? "Update model" : "Repair model"}
          </button>
        )}
        {showQwenActions && readiness === "installed" && (
          <button
            disabled={busy}
            onClick={() => remove.mutate()}
            className="rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/60 disabled:opacity-50"
          >
            Remove model
          </button>
        )}
        <button
          disabled={isFetching}
          onClick={() => refetch()}
          className="rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/60 disabled:opacity-50"
        >
          {isFetching ? "Checking…" : "Re-check"}
        </button>
      </div>

      {/* Engine choice — READ-ONLY. There is no generic AppConfig save path here: api.patchSettings only
          accepts bigFile/scannerRoots/ipfs/performance, so persisting `transcribe.engine` is a follow-up
          (backend needs a PATCH endpoint for it — do NOT invent one). We only display the current setting. */}
      <div className="mt-3 text-sm text-black/70">
        Engine choice:{" "}
        <b>
          {s.configured === "auto"
            ? "Auto (picks the best available for this machine)"
            : ENGINE_LABEL[s.configured]}
        </b>
      </div>

      {/* Parallelism note (read-only) — batch transcription concurrency is auto-calibrated (§5); the knob
          lives in Settings → Parallelism, not here. */}
      <p className="mt-3 text-xs text-black/50">
        Batch transcription runs several files at once, calibrated to this machine's CPU cores and RAM.
        Tune the shared compute budget in the <b>Parallelism</b> section above (Settings → Parallelism).
      </p>

      <div className="mt-2">
        <Disclosure label="How transcription works">
          <p className="text-sm text-black/60">
            The heavyweight <b>Qwen3-ASR</b> engine (Apple Silicon only) is a multi-GB download that runs
            entirely on this computer — nothing about your media leaves the machine. If it isn't installed, or
            a run errors, LargeFileBridge falls back to the built-in <b>Whisper (Mac)</b> engine so you can
            always transcribe. Watch downloads and running jobs on the{" "}
            <Link to="/processing" className="text-[var(--lfb-primary)]">Processing</Link> page.
          </p>
        </Disclosure>
      </div>
    </Section>
  );
}
