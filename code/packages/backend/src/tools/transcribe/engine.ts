// Engine selection + the speech → mac → qwen runtime fallback chain (transcribe_engine.mdx §2/§2.1). The
// caller (transcribe.service) asks this module to transcribe a file; it picks the engine per the preference
// order (Apple SpeechAnalyzer when available, else Whisper Small; qwen only when explicitly pinned) and, for
// a run that errors, transparently retries down the order so a file is never lost. Kept free of config I/O —
// the caller passes the resolved preference + consent so tools/ stays pure. Mirrors Transcribe.js's
// transcribe()/chooseAutoEngine() (the verified reference).
import os from "node:os";
import type { TranscribeEngineId } from "@lfb/shared";
import { log } from "../../shared/logging.js";
import { Transcriber, type TranscribeEngineResult, type ProgressSink } from "./Transcribe.js";
import { Qwen3AsrTranscriber } from "./qwen-asr.js";
import { SpeechAnalyzerTranscriber } from "./speech-analyzer.js";

const whisper = new Transcriber();
const qwen = new Qwen3AsrTranscriber();
const speech = new SpeechAnalyzerTranscriber();

// The auto-selection / runtime-fallback order (best first — NEVER the legacy Apple SFSpeechRecognizer).
const ENGINE_PREFERENCE: TranscribeEngineId[] = ["speech", "mac", "qwen"];

export type EnginePreference = "auto" | TranscribeEngineId;

/** Is this an Apple-Silicon Mac? (qwen/MLX is only available here.) */
export function isAppleSilicon(): boolean {
  return os.platform() === "darwin" && os.arch() === "arm64";
}

/** Is the heavyweight qwen engine runnable right now (Apple Silicon + the mlx-qwen3-asr CLI present)? */
export function qwenAvailable(): boolean {
  return qwen.available();
}

/** Is Apple SpeechAnalyzer runnable right now (macOS 26+ + swiftc)? */
export function speechAvailable(): boolean {
  return speech.available();
}

/**
 * Which engine to use (transcribe_engine.mdx §2 selection order — best first, NEVER legacy SFSpeechRecognizer):
 *   `speech` pref → speech if available, else mac (Whisper Small).
 *   `mac`    pref → mac.
 *   `qwen`   pref → qwen if available, else mac.
 *   `auto`        → speech if available, else mac. qwen is NOT auto-selected — it is the third choice, chosen
 *                   only by an explicit `qwen` pin (the heavyweight "another LLM").
 */
export function pickEngine(pref: EnginePreference, _consent?: string | null): TranscribeEngineId {
  if (pref === "speech") return speech.available() ? "speech" : "mac";
  if (pref === "mac") return "mac";
  if (pref === "qwen") return qwen.available() ? "qwen" : "mac";
  // auto — Apple SpeechAnalyzer when available, else the Whisper Small fallback (qwen is never auto-picked).
  return speech.available() ? "speech" : "mac";
}

export interface TranscribeEngineRunResult extends TranscribeEngineResult {
  engineUsed: TranscribeEngineId;
}

/** Run exactly one engine by id (no fallback). Returns its structured result. */
function runOne(id: TranscribeEngineId, inputFile: string, outputPath: string, onProgress?: ProgressSink): Promise<TranscribeEngineResult> {
  if (id === "speech") return speech.transcribeToFile(inputFile, outputPath, onProgress);
  if (id === "qwen") return qwen.transcribeToFile(inputFile, outputPath, onProgress);
  return whisper.transcribeToFile(inputFile, outputPath, onProgress);
}

/**
 * Transcribe one file, applying the runtime fallback chain that follows the preference order speech → mac →
 * qwen STARTING at the picked engine (§2.1, mirrors Transcribe.js transcribe()). A `transcribed`/`no_audio`
 * result is authoritative; a `tool_missing`/`failed` result or a thrown error advances to the next engine in
 * the chain, logging (never silently) on each fallback. `engineUsed` reflects whichever engine actually
 * produced the text. `allowFallback: false` (a pinned engine that wants no retry) runs only the picked engine.
 */
export async function transcribeWithEngine(
  inputFile: string,
  outputPath: string,
  opts: { engine: EnginePreference; consent?: string | null; allowFallback?: boolean; onProgress?: ProgressSink },
): Promise<TranscribeEngineRunResult> {
  const picked = pickEngine(opts.engine, opts.consent);
  const allowFallback = opts.allowFallback !== false;

  // The chain = the picked engine, then the engines AFTER it in the preference order (so speech falls back to
  // mac then qwen; mac to qwen; qwen to nothing). With fallback disabled we run only the picked engine.
  const startIdx = Math.max(0, ENGINE_PREFERENCE.indexOf(picked));
  const chain = allowFallback ? ENGINE_PREFERENCE.slice(startIdx) : [picked];

  let lastReason: string | null = null;
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i]!;
    if (i > 0) log.warn("transcribe", `${ENGINE_PREFERENCE[startIdx + i - 1]} failed (${lastReason ?? ""}) — falling back to ${id} for ${inputFile}`);
    try {
      const r = await runOne(id, inputFile, outputPath, opts.onProgress);
      // A clean transcript (or a genuine no-audio) is authoritative — stop here.
      if (r.status === "transcribed" || r.status === "no_audio") return { ...r, engineUsed: id };
      // tool_missing / failed → try the next engine when allowed; otherwise this IS the final outcome.
      lastReason = r.reason ?? r.status;
      if (i === chain.length - 1) {
        if (!allowFallback) log.error("transcribe", `${id} ${r.status} for ${inputFile} (${r.reason ?? "no reason given"}) — fallback disabled (engine pinned to ${picked})`);
        return { ...r, engineUsed: id };
      }
    } catch (e) {
      lastReason = (e as Error).message;
      if (i === chain.length - 1) {
        log.error("transcribe", `${id} threw for ${inputFile} (${lastReason}) — no engines left`);
        throw e;
      }
    }
  }

  // Unreachable (chain is always non-empty), but keeps the type checker honest.
  throw new Error(`all transcription engines failed for ${inputFile}: ${lastReason ?? "unknown"}`);
}

/** Whether a name is a transcribable audio/video by extension (either engine handles it). */
export function canTranscribe(name: string): boolean {
  return whisper.canTranscribe(name);
}
