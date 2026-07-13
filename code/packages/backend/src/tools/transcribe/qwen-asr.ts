// The heavyweight transcription engine: Qwen3-ASR via Apple MLX (transcribe_engine.mdx §2). Learned from
// the canonical tool ~/BGit/all/tools/Transcription/Transcribe.js (engine #2 `qwen`). It drives the
// `mlx-qwen3-asr` CLI at model Qwen/Qwen3-ASR-1.7B — Apple-Silicon-native, higher quality than whisper-base.
// The CLI installs via `pipx install mlx-qwen3-asr`; the weights download from Hugging Face on first run
// (~3.4 GB) — that provisioning is owned by model-provision.service.ts, gated behind the user's permission.
//
// Like the Whisper engine (Transcribe.ts) this is ASYNC / non-blocking (spawnAsync, never spawnSync) and
// ingests full-length audio natively — no duration cap, no timeout — so a 1–2h+ file transcribes end-to-end
// (transcribe_engine.mdx §4). Errors are thrown/returned as a structured result so engine.ts's fallback can
// retry on Whisper.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../../shared/logging.js";
import type { TranscribeEngineResult, ProgressSink } from "./Transcribe.js";
import {
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  commandExists,
  spawnAsync,
  probeDurationSec,
  hasAudioStream,
  demuxToMp3,
  tryUnlink,
  transcriptHeader,
} from "./audio-prep.js";

// The Hugging Face repo the CLI pulls on first run. 1.7B is chosen over 0.6B for quality (the reference
// tool's rationale). Keep in sync with model-provision.service.ts.
export const QWEN_MODEL = "Qwen/Qwen3-ASR-1.7B";
export const QWEN_MODEL_LABEL = "qwen3-asr-1.7b-mlx";
export const QWEN_CLI = "mlx-qwen3-asr";

/** In-process Qwen3-ASR (MLX) engine — one instance is cheap; construct per call or reuse. */
export class Qwen3AsrTranscriber {
  readonly id = "qwen" as const;
  readonly supportedExtensions = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];

  /** qwen is Apple-Silicon-only (MLX). On anything else it is never available (engine.ts routes to `mac`). */
  available(): boolean {
    return os.platform() === "darwin" && os.arch() === "arm64" && commandExists(QWEN_CLI);
  }

  canTranscribe(name: string): boolean {
    return this.supportedExtensions.includes(path.extname(name).toLowerCase());
  }

  /**
   * Transcribe one audio/video file to `outputPath` with Qwen3-ASR. Returns a structured result; only throws
   * for truly unexpected conditions (so engine.ts's qwen→mac fallback catches them). Streams a coarse
   * spinner-style progress via `onProgress` (the CLI does not emit per-segment timestamps, so a determinate
   * bar isn't available — coverage is trusted to the CLI's native full-file ingestion, §4).
   */
  async transcribeToFile(inputFile: string, outputPath: string, onProgress?: ProgressSink): Promise<TranscribeEngineResult> {
    if (!this.available()) {
      const why = os.platform() === "darwin" && os.arch() === "arm64" ? `${QWEN_CLI} not installed — pipx install ${QWEN_CLI}` : "Qwen3-ASR (MLX) requires an Apple Silicon Mac";
      return { status: "tool_missing", outputPath: null, words: null, reason: why };
    }
    const ext = path.extname(inputFile).toLowerCase();
    if (VIDEO_EXTENSIONS.includes(ext) && !commandExists("ffmpeg")) {
      return { status: "tool_missing", outputPath: null, words: null, reason: "ffmpeg not installed — brew install ffmpeg" };
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const durationSec = await probeDurationSec(inputFile);

    // Demux video → temp MP3; a silent video gets a placeholder rather than a failure.
    let audioFile = inputFile;
    let tempAudio: string | null = null;
    if (VIDEO_EXTENSIONS.includes(ext)) {
      if (!(await hasAudioStream(inputFile))) {
        fs.writeFileSync(outputPath, transcriptHeader(path.basename(inputFile), { engine: QWEN_MODEL_LABEL, durationSec }) + "[No audio stream — nothing to transcribe]\n", "utf8");
        return { status: "no_audio", outputPath, words: 0, reason: "no audio stream — nothing to transcribe" };
      }
      onProgress?.({ fraction: 0, stage: "demux" });
      try {
        tempAudio = await demuxToMp3(inputFile);
        audioFile = tempAudio;
      } catch (e) {
        return { status: "failed", outputPath: null, words: null, reason: `ffmpeg demux failed: ${(e as Error).message}` };
      }
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-qwen-asr-"));
    try {
      onProgress?.({ fraction: 0.05, stage: "transcribe" });
      // English-forced, txt output into our scratch dir. No duration-limiting flag — the CLI ingests the
      // whole file (transcribe_engine.mdx §4.1). --quiet keeps the CLI's own chatter down.
      const r = await spawnAsync(QWEN_CLI, [audioFile, "--model", QWEN_MODEL, "--language", "English", "-f", "txt", "-o", scratch, "--quiet"], {
        allowFail: true,
      });

      // The CLI derives the output name from the input; scanning the fresh scratch dir avoids depending on
      // the exact convention.
      let produced: string[] = [];
      try {
        produced = fs.readdirSync(scratch).filter((f) => f.toLowerCase().endsWith(".txt"));
      } catch {
        /* dir unreadable → failure below */
      }
      if (r.status !== 0 || produced.length === 0) {
        const detail = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).slice(-1)[0];
        // Thrown (not returned) so engine.ts's fallback retries on Whisper — a missing model download or an
        // MLX hiccup should never lose the file.
        throw new Error(detail || `${QWEN_CLI} exited with code ${r.status}`);
      }

      const body = fs.readFileSync(path.join(scratch, produced[0]), "utf8").trim();
      if (!body) throw new Error("Qwen3-ASR produced an empty transcription");

      fs.writeFileSync(outputPath, transcriptHeader(path.basename(inputFile), { engine: QWEN_MODEL_LABEL, device: "mlx", durationSec, coveredSec: null }) + body, "utf8");
      onProgress?.({ fraction: 1, stage: "transcribe" });
      const words = body.split(/\s+/).filter(Boolean).length;
      log.info("transcribe", `${inputFile} → ${outputPath} (${words} words, qwen3-asr)`);
      return { status: "transcribed", outputPath, words, reason: null };
    } finally {
      if (tempAudio) tryUnlink(tempAudio);
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
