// Shared transcription launchers (Transcribe.mdx §2) — used by every entry point: the Media Viewer
// button, the file/directory ⋮ catalogs (EntityMenu), the repo kebab (RowKebabs), and the storage detail
// page. Each wraps api.* in a toast.promise so the slow, local Whisper run shows a spinner and then an
// honest result. Confirm-gated for the "all files" variants (they can run for a while).
import { toast } from "sonner";
import type { TranscribeResult, TranscribeBatchResult } from "@lfb/shared";
import { api } from "@/api/client";
import { clientLog } from "./clientLog.js";

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

/** Transcribe ONE media file (Media Viewer button / file ⋮ "Transcribe…"). */
export function runTranscribeFile(path: string, name: string, opts?: { overwrite?: boolean; onDone?: () => void }): void {
  toast.promise(api.transcribeFile(path, opts?.overwrite ?? false), {
    loading: `Transcribing ${name}…`,
    success: (r) => {
      opts?.onDone?.();
      return transcribeMsgOne(r);
    },
    error: errMsg("transcribe.file"),
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
