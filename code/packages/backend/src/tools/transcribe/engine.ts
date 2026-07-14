// Engine selection + the qwen→mac auto-fallback (transcribe_engine.mdx §2/§2.1). The caller (transcribe.
// service) asks this module to transcribe a file; it picks the engine (Qwen3-ASR when available + preferred,
// else Whisper) and, for a `qwen` run that errors, transparently retries on Whisper so a file is never lost.
// Kept free of config I/O — the caller passes the resolved preference + consent so tools/ stays pure.
import os from "node:os";
import type { TranscribeEngineId } from "@lfb/shared";
import { log } from "../../shared/logging.js";
import { Transcriber, type TranscribeEngineResult, type ProgressSink } from "./Transcribe.js";
import { Qwen3AsrTranscriber } from "./qwen-asr.js";

const whisper = new Transcriber();
const qwen = new Qwen3AsrTranscriber();

export type EnginePreference = "auto" | TranscribeEngineId;

/** Is this an Apple-Silicon Mac? (qwen/MLX is only available here.) */
export function isAppleSilicon(): boolean {
  return os.platform() === "darwin" && os.arch() === "arm64";
}

/** Is the heavyweight qwen engine runnable right now (Apple Silicon + the mlx-qwen3-asr CLI present)? */
export function qwenAvailable(): boolean {
  return qwen.available();
}

/**
 * Which engine to use (transcribe_engine.mdx §2 selection order). `mac` when pinned or when qwen can't run
 * here; `qwen` when preferred/auto and available and the user hasn't opted for the fallback.
 */
export function pickEngine(pref: EnginePreference, consent?: string | null): TranscribeEngineId {
  if (pref === "mac") return "mac";
  if (pref === "qwen") return qwen.available() ? "qwen" : "mac";
  // auto — qwen when available, unless the user declined provisioning or chose the fallback.
  if (qwen.available() && consent !== "declined" && consent !== "use_fallback") return "qwen";
  return "mac";
}

export interface TranscribeEngineRunResult extends TranscribeEngineResult {
  engineUsed: TranscribeEngineId;
}

/**
 * Transcribe one file with the selected engine, applying the qwen→mac auto-fallback (§2.1). Returns the
 * result plus which engine actually produced it (the transcript header already records this). `allowFallback:
 * false` (an explicit `mac` pin, or a caller that wants no retry) disables the fallback layer.
 */
export async function transcribeWithEngine(
  inputFile: string,
  outputPath: string,
  opts: { engine: EnginePreference; consent?: string | null; allowFallback?: boolean; onProgress?: ProgressSink },
): Promise<TranscribeEngineRunResult> {
  const id = pickEngine(opts.engine, opts.consent);
  const allowFallback = opts.allowFallback !== false;

  if (id === "qwen") {
    try {
      const r = await qwen.transcribeToFile(inputFile, outputPath, opts.onProgress);
      // A clean result (or a genuine no-audio) is authoritative.
      if (r.status === "transcribed" || r.status === "no_audio") {
        return { ...r, engineUsed: "qwen" };
      }
      // tool_missing / failed: fall through to Whisper when allowed; otherwise this IS the final outcome —
      // log it here so a pinned-`qwen`, no-fallback failure is never silent (transcribe_engine.mdx §2.1).
      if (!allowFallback) {
        log.error("transcribe", `qwen ${r.status} for ${inputFile} (${r.reason ?? "no reason given"}) — fallback disabled (engine pinned to qwen)`);
        return { ...r, engineUsed: "qwen" };
      }
      log.warn("transcribe", `qwen returned ${r.status} (${r.reason ?? ""}) — falling back to whisper for ${inputFile}`);
    } catch (e) {
      if (!allowFallback) {
        log.error("transcribe", `qwen threw for ${inputFile} (${(e as Error).message}) — fallback disabled (engine pinned to qwen)`);
        throw e;
      }
      log.warn("transcribe", `qwen threw (${(e as Error).message}) — falling back to whisper for ${inputFile}`);
    }
    const r2 = await whisper.transcribeToFile(inputFile, outputPath, opts.onProgress);
    return { ...r2, engineUsed: "mac" };
  }

  const r = await whisper.transcribeToFile(inputFile, outputPath, opts.onProgress);
  return { ...r, engineUsed: "mac" };
}

/** Whether a name is a transcribable audio/video by extension (either engine handles it). */
export function canTranscribe(name: string): boolean {
  return whisper.canTranscribe(name);
}
