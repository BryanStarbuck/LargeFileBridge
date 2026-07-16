// Per-machine transcription parallelism (transcribe_engine.mdx §5). Transcription is resource-heavy, so how
// many files we run AT ONCE must be CALIBRATED to the machine — not a fixed cap. A low-power box can only
// hold ONE heavy run; a big (~24-core / large-RAM) box runs SEVERAL. This is the transcribe-specific draw
// from the shared Core Budget (parallelization.mdx): mass-compute-narrow, additionally clamped by RAM (each
// whisper instance needs several GB resident) and by however many GPU/MPS streams the machine allows.
//
// transcribeConcurrency = clamp(1, floor(budget / whisperThreads), floor(usableRAM / modelRamPerJob), gpuStreams)
//
// Pure + dependency-light so it is easy to unit-test and reason about. The `budget` (mass-compute Core
// Budget) is passed in — snapshotted once by the queue's admission pass — mirroring capFor()'s discipline.
import os from "node:os";
import { getAppConfig } from "../store-model/config.service.js";
import { log } from "../../shared/logging.js";
import { whisperModel } from "../../tools/transcribe/audio-prep.js";

/** How much resident RAM one transcription job needs, by model/engine (transcribe_engine.mdx §5.1).
 *  Conservative defaults until §3.1 stores a real measurement. `qwen` (Qwen3-ASR-1.7B via MLX) holds the
 *  model in unified memory (several GB per instance); `base` is the small whisper model. */
const MODEL_RAM_PER_JOB_BYTES: Record<string, number> = {
  qwen: 6 * 1024 * 1024 * 1024, // ~6 GB unified memory for Qwen3-ASR-1.7B (MLX)
  large: 5 * 1024 * 1024 * 1024,
  medium: 3 * 1024 * 1024 * 1024,
  small: 2 * 1024 * 1024 * 1024,
  base: 1 * 1024 * 1024 * 1024, // ~1 GB for whisper-base
  tiny: 1 * 1024 * 1024 * 1024,
};

// The active engine's RAM key, cached briefly so the queue's hot admission loop doesn't re-parse config.yaml
// per task. `mac` → whatever whisper model the runner ACTUALLY spawns; anything else → the heavyweight `qwen`.
//
// The mac branch reads whisperModel() rather than naming a model itself (to_fix.mdx §6.2). It used to return
// the literal `"base"` (1 GiB in the table above) while Transcribe.ts — `runWhisper()` spawned `--model small`
// (2 GiB): this table under-counted Whisper by 2× on every Mac, so the RAM clamp below admitted twice the
// concurrent jobs the machine could hold and the box went to swap while the budget reported healthy. One
// constant, read by both sites, with the same LFB_TRANSCRIBE_MODEL override — they cannot drift again.
let cachedModelKey = "qwen";
let cachedAt = 0;
export function activeTranscribeModelKey(): string {
  const now = Date.now();
  if (now - cachedAt > 5000) {
    try {
      cachedModelKey = getAppConfig().transcribe.engine === "mac" ? whisperModel() : "qwen";
    } catch (e) {
      // Keep the last value on a transient read failure — the admission loop must never throw — but a
      // config read that keeps failing is a real problem worth a trail (the RAM clamp silently goes stale).
      log.warn("transcribe", `activeTranscribeModelKey: config read failed, keeping last value (${cachedModelKey}): ${(e as Error).message}`);
    }
    cachedAt = now;
  }
  return process.env.LFB_TRANSCRIBE_MODEL || cachedModelKey;
}

/** Reserve some RAM for the OS + the web app + IPFS so we never drive the box into swap. */
const RAM_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The memory pool we size Whisper against: AVAILABLE memory, never INSTALLED (to_fix.mdx §6.1).
 *
 * This clamp existed to stop us driving the box into swap, and `os.totalmem()` could not do that job: it
 * reports the RAM the machine SHIPPED with, a constant that is identical on an idle box and on one where a
 * 24-wide describe batch is already holding ~1 GB of base64 while ffmpeg, IPFS and the page cache hold more.
 * So the clamp computed the same answer during the crisis as it did at boot — the exact blindness in §6's
 * "two blind halves": transcribe budgeted OTHER processes' RAM but not ours. `os.freemem()` moves with the
 * machine, so a loaded box admits fewer whisper jobs, which is the whole point of a clamp.
 *
 * RAM_HEADROOM_BYTES still comes off the top. It is doing a different job now — under totalmem() it was a
 * crude stand-in for "everything else on the box"; under freemem() that is already excluded, and the
 * headroom is the margin that keeps the LAST admitted job from being the one that starts the swapping.
 */
function availableRamBytes(): number {
  return os.freemem();
}

export interface TranscribeConcurrencyInputs {
  /** The mass-compute Core Budget snapshot (parallelization.mdx §1). */
  budget: number;
  /** Threads one whisper job uses internally (anti-oversubscription, parallelization.mdx §2). */
  whisperThreads: number;
  /** The active model (`base` today; `large` once provisioning selects the heavyweight engine). */
  model: string;
  /** How many concurrent GPU/MPS streams the machine allows (≥1). CPU-only ⇒ effectively unbounded here. */
  gpuStreams?: number;
  /**
   * The RAM pool to size against, in bytes. Defaults to {@link availableRamBytes} — os.freemem(), i.e.
   * AVAILABLE memory, NOT os.totalmem()/installed (to_fix.mdx §6.1). Retained as an injection point so
   * tests can pin a pool and assert the clamp deterministically.
   */
  totalRamBytes?: number;
}

/**
 * The number of transcription jobs this machine should run in parallel (transcribe_engine.mdx §5.1).
 * Always ≥ 1 (every machine can do one). Low-power boxes converge on 1; a big box runs several.
 */
export function transcribeConcurrency(inp: TranscribeConcurrencyInputs): number {
  const poolRam = inp.totalRamBytes ?? availableRamBytes();
  const usableRam = Math.max(0, poolRam - RAM_HEADROOM_BYTES);
  const modelRamPerJob = MODEL_RAM_PER_JOB_BYTES[inp.model] ?? MODEL_RAM_PER_JOB_BYTES.base;

  const cpuTerm = Math.floor(inp.budget / Math.max(1, inp.whisperThreads));
  const ramTerm = Math.floor(usableRam / modelRamPerJob);
  const gpuTerm = inp.gpuStreams && inp.gpuStreams > 0 ? inp.gpuStreams : Number.POSITIVE_INFINITY;

  // The floor of 1 matters more under freemem() than it did under totalmem(): a genuinely loaded box can
  // report less free RAM than one model needs, driving ramTerm to 0. Refusing to transcribe AT ALL is not an
  // outcome this function is allowed to produce — every machine can do one (transcribe_engine.mdx §5.1) —
  // so the clamp narrows to serial, never to a stall.
  return Math.max(1, Math.min(cpuTerm, ramTerm, gpuTerm));
}
