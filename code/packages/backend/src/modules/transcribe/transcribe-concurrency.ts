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

/** How much resident RAM one transcription job needs, by model/engine (transcribe_engine.mdx §5.1).
 *  Conservative defaults until §3.1 stores a real measurement. `qwen` (Qwen3-ASR-1.7B via MLX) holds the
 *  model in unified memory (several GB per instance); `base` is the small whisper model. */
const MODEL_RAM_PER_JOB_BYTES: Record<string, number> = {
  qwen: 6 * 1024 * 1024 * 1024, // ~6 GB unified memory for Qwen3-ASR-1.7B (MLX)
  large: 5 * 1024 * 1024 * 1024,
  medium: 3 * 1024 * 1024 * 1024,
  small: 2 * 1024 * 1024 * 1024,
  base: 1 * 1024 * 1024 * 1024, // ~1 GB for whisper-base (the mac fallback)
  tiny: 1 * 1024 * 1024 * 1024,
};

// The active engine's RAM key, cached briefly so the queue's hot admission loop doesn't re-parse config.yaml
// per task. `mac` → the light `base` whisper model; anything else → the heavyweight `qwen` footprint.
let cachedModelKey = "qwen";
let cachedAt = 0;
export function activeTranscribeModelKey(): string {
  const now = Date.now();
  if (now - cachedAt > 5000) {
    try {
      cachedModelKey = getAppConfig().transcribe.engine === "mac" ? "base" : "qwen";
    } catch {
      /* keep the last value on a transient read failure */
    }
    cachedAt = now;
  }
  return process.env.LFB_TRANSCRIBE_MODEL || cachedModelKey;
}

/** Reserve some RAM for the OS + the web app + IPFS so we never drive the box into swap. */
const RAM_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;

export interface TranscribeConcurrencyInputs {
  /** The mass-compute Core Budget snapshot (parallelization.mdx §1). */
  budget: number;
  /** Threads one whisper job uses internally (anti-oversubscription, parallelization.mdx §2). */
  whisperThreads: number;
  /** The active model (`base` today; `large` once provisioning selects the heavyweight engine). */
  model: string;
  /** How many concurrent GPU/MPS streams the machine allows (≥1). CPU-only ⇒ effectively unbounded here. */
  gpuStreams?: number;
  /** Total physical RAM in bytes (defaults to os.totalmem()); injectable for tests. */
  totalRamBytes?: number;
}

/**
 * The number of transcription jobs this machine should run in parallel (transcribe_engine.mdx §5.1).
 * Always ≥ 1 (every machine can do one). Low-power boxes converge on 1; a big box runs several.
 */
export function transcribeConcurrency(inp: TranscribeConcurrencyInputs): number {
  const totalRam = inp.totalRamBytes ?? os.totalmem();
  const usableRam = Math.max(0, totalRam - RAM_HEADROOM_BYTES);
  const modelRamPerJob = MODEL_RAM_PER_JOB_BYTES[inp.model] ?? MODEL_RAM_PER_JOB_BYTES.base;

  const cpuTerm = Math.floor(inp.budget / Math.max(1, inp.whisperThreads));
  const ramTerm = Math.floor(usableRam / modelRamPerJob);
  const gpuTerm = inp.gpuStreams && inp.gpuStreams > 0 ? inp.gpuStreams : Number.POSITIVE_INFINITY;

  return Math.max(1, Math.min(cpuTerm, ramTerm, gpuTerm));
}
