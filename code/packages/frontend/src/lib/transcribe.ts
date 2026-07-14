// Shared transcription launchers (Transcribe.mdx §2) — used by every entry point: the Media Viewer
// button, the file/directory ⋮ catalogs (EntityMenu), the repo kebab (RowKebabs), and the storage detail
// page. Each wraps api.* in a toast.promise so the slow, local Whisper run shows a spinner and then an
// honest result. Confirm-gated for the "all files" variants (they can run for a while).
import { toast } from "sonner";
import type { TranscribeResult, TranscribeBatchResult } from "@lfb/shared";
import { api } from "@/api/client";
import { clientLog } from "./clientLog.js";
import { requestStorageSetup } from "./setupWizard.js";

// ── Heavyweight-model consent bus (transcribe_engine.mdx §3.2/§3.6) ───────────────────────────────────
// The FIRST time a user runs a transcription on an Apple-Silicon Mac where the Qwen3-ASR model isn't yet
// provisioned, we offer the one-time download. This bus lets any transcribe launcher request that popup
// WITHOUT threading a callback through every call site; the TranscribeModelConsentProvider mounted once at
// the app root subscribes and shows the dialog. Mirrors setupWizard.ts's single-slot pattern.
export interface ModelConsentRequest {
  /** A short verb phrase for the copy, e.g. "transcribe 58 files". */
  label: string;
  estimateBytes: number;
  freeDiskBytes: number;
  /** Download & install the heavyweight model (background) AND proceed now on the Whisper fallback. */
  onApproveDownload: () => void;
  /** Skip the download; remember the fallback choice; proceed on the Whisper (Mac) engine now. */
  onUseFallback: () => void;
}
type ModelConsentListener = (req: ModelConsentRequest) => void;
let modelConsentListener: ModelConsentListener | null = null;
export function onModelConsentRequested(cb: ModelConsentListener): () => void {
  modelConsentListener = cb;
  return () => {
    if (modelConsentListener === cb) modelConsentListener = null;
  };
}
export function requestModelConsent(req: ModelConsentRequest): void {
  modelConsentListener?.(req);
}

/**
 * Gate a transcription action behind the heavyweight-model provisioning flow (transcribe_engine.mdx §3).
 * Opens the one-time consent popup only when it's genuinely first-time (Apple Silicon, engine=auto, model
 * missing/partial, and the user hasn't decided yet); otherwise runs immediately. The Whisper (Mac) fallback
 * always works, so a decline/cancel never leaves the user unable to transcribe. `run` is the confirmed
 * action (e.g. enqueue the checked files), resumed after the choice (§3.6).
 */
export async function withModelReady(opts: { label: string; run: () => void }): Promise<void> {
  let status;
  try {
    status = await api.transcribeEngine();
  } catch {
    opts.run(); // status unknown → just run; the mac engine always works
    return;
  }
  const q = status.qwen;
  const needsPopup =
    status.appleSilicon && status.configured === "auto" && status.consent == null && (q.readiness === "missing" || q.readiness === "partial");
  if (!needsPopup) {
    // Ready, pinned, unsupported hardware, already-decided, or already-downloading → proceed now.
    opts.run();
    return;
  }
  requestModelConsent({
    label: opts.label,
    estimateBytes: q.estimateBytes,
    freeDiskBytes: q.freeDiskBytes,
    // Kick provisioning in the background AND proceed now on the fallback so the user isn't blocked for the
    // multi-GB download; future runs use the higher-quality Qwen model once it's ready.
    onApproveDownload: () => {
      void api.transcribeProvision().catch((e) => clientLog.error("transcribe.provision", e));
      opts.run();
    },
    onUseFallback: () => {
      void api.transcribeConsent("use_fallback").catch((e) => clientLog.error("transcribe.consent", e));
      opts.run();
    },
  });
}

/** One-file outcome → a human line (Transcribe.mdx §1/§4). Exported so the useTranscribeFile hook and
 *  the Media Viewer report the SAME honest per-status text. */
export function transcribeMsgOne(r: TranscribeResult): string {
  switch (r.status) {
    case "transcribed":
      return `Transcribed — ${r.words ?? 0} words`;
    case "no_audio":
      return "No audio stream — nothing to transcribe";
    case "skipped":
      return r.reason === "already transcribed" ? "Already transcribed" : `Not transcribed: ${r.reason ?? "skipped"}`;
    case "tool_missing":
      return `Can't transcribe: ${r.reason ?? "whisper/ffmpeg not installed"}`;
    case "needs_setup":
      // First-time gate (Transcribe.mdx §3.5): no Personal storage owns this file yet.
      return "Set up Personal storage first — Settings → Storages";
    default:
      return `Transcription failed: ${r.reason ?? "error"}`;
  }
}

/** Tree/batch/storage outcome → honest counts (Transcribe.mdx §6). */
function msgBatch(r: TranscribeBatchResult): string {
  if (r.results.length === 0) return "No audio or video files found";
  return `Transcribed ${r.transcribed} · skipped ${r.skipped}${r.failed ? ` · failed ${r.failed}` : ""}`;
}

function errMsg(ctx: string) {
  return (e: unknown) => {
    clientLog.error(ctx, e);
    return e instanceof Error ? e.message : "Transcription failed";
  };
}

/** Transcribe ONE media file (Media Viewer button / file ⋮ "Transcribe…"). `onNeedsSetup` fires when the
 *  backend reports `needs_setup` (no Personal storage owns the file — Transcribe.mdx §3.5), so a caller can
 *  open the first-time setup wizard instead of only flashing a toast. */
export function runTranscribeFile(
  path: string,
  name: string,
  opts?: { overwrite?: boolean; onDone?: () => void; onNeedsSetup?: (reason: string) => void },
): void {
  // Gate behind the heavyweight-model provisioning flow first (transcribe_engine.mdx §3): a first-time run
  // offers the download, then proceeds. Ready/decided/unsupported → runs immediately.
  void withModelReady({
    label: `transcribe ${name}`,
    run: () =>
      toast.promise(api.transcribeFile(path, opts?.overwrite ?? false), {
        loading: `Transcribing ${name}…`,
        success: (r) => {
          if (r.status === "needs_setup") {
            // Open the first-time wizard; on completion re-run this exact transcription (Transcribe.mdx §3.5).
            requestStorageSetup({ mediaPath: path, actionLabel: "transcribe", retry: () => runTranscribeFile(path, name, opts) });
            opts?.onNeedsSetup?.(r.reason ?? "");
          } else opts?.onDone?.();
          return transcribeMsgOne(r);
        },
        error: errMsg("transcribe.file"),
      }),
  });
}

/** Transcribe ALL audio/video under a directory or repo working tree ("Transcribe all files…"). */
export function runTranscribeTree(path: string, label: string, onDone?: () => void): void {
  if (!window.confirm(`Transcribe all audio & video under "${label}"?\n\nThis runs Whisper locally and can take a while. Existing transcripts are skipped.`)) return;
  toast.promise(api.transcribeTree(path), {
    loading: `Transcribing everything under ${label}…`,
    success: (r) => {
      onDone?.();
      return msgBatch(r);
    },
    error: errMsg("transcribe.tree"),
  });
}

/** Transcribe ALL audio/video in a storage ("Transcribe all" on the storage detail page). */
export function runTranscribeStorage(id: string, label: string, onDone?: () => void): void {
  if (!window.confirm(`Transcribe all audio & video in "${label}"?\n\nThis runs Whisper locally and can take a while. Existing transcripts are skipped.`)) return;
  toast.promise(api.transcribeStorage(id), {
    loading: `Transcribing everything in ${label}…`,
    success: (r) => {
      onDone?.();
      return msgBatch(r);
    },
    error: errMsg("transcribe.storage"),
  });
}
