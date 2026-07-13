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

/** How much resident RAM one whisper instance needs, by model. Measured/estimated (transcribe_engine.mdx
 *  §3.1 stores a real measurement once the model is provisioned); until then these conservative defaults
 *  keep a small machine at 1 job. `large` is the heavyweight engine (~a few GB); `base` is the small model. */
const MODEL_RAM_PER_JOB_BYTES: Record<string, number> = {
  large: 5 * 1024 * 1024 * 1024, // ~5 GB resident for whisper-large-v3
  medium: 3 * 1024 * 1024 * 1024,
  small: 2 * 1024 * 1024 * 1024,
  base: 1 * 1024 * 1024 * 1024, // ~1 GB for the base model
  tiny: 1 * 1024 * 1024 * 1024,
};

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
