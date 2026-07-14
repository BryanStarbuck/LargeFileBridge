// The PRIMARY transcription engine: Apple SpeechAnalyzer / SpeechTranscriber (transcribe_engine.mdx §1).
// Learned from the canonical tool ~/BGit/all/tools/Transcription/Transcribe.js (engine #1 `speech`). It is
// the NEW on-device Apple speech engine — macOS 26+ — and deliberately NEVER the legacy SFSpeechRecognizer.
// The model ships inside the OS (no multi-GB download); per-locale assets auto-download in the Swift helper.
//
// We drive a tiny Swift CLI (speech/SpeechAnalyzerCLI.swift), compiled ONCE to a cached binary keyed by a
// sha1 of its source (mirrors Transcribe.js's ensureSpeechBinary). Like the other engines this is ASYNC /
// non-blocking (spawnAsync, never spawnSync) and ingests full-length audio natively — no duration cap, no
// timeout — because the helper reads the whole file to EOF via analyzeSequence(from:), so a successful run
// inherently covers the full duration (§4). Errors are thrown/returned as a structured result so engine.ts's
// fallback (speech → mac → qwen) can retry — most importantly exit code 3 (macOS < 26 → "needs macOS 26+").
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  speechAnalyzerSupported,
  SPEECH_MIN_MACOS_MAJOR,
} from "./audio-prep.js";

// The metadata-header engine label (the model itself ships inside macOS 26+).
export const SPEECH_MODEL_LABEL = "apple-speechanalyzer";

// The Swift helper that drives SpeechAnalyzer, shipped next to this module. Resolved via import.meta.url so
// it works under tsx (source) and a compiled build alike (mirrors modules/describe/prompts.ts).
const SPEECH_HELPER_SRC = fileURLToPath(new URL("./speech/SpeechAnalyzerCLI.swift", import.meta.url));

/** In-process Apple SpeechAnalyzer engine — one instance is cheap; construct per call or reuse. */
export class SpeechAnalyzerTranscriber {
  readonly id = "speech" as const;
  readonly supportedExtensions = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];

  /** speech is macOS-26+-only (+ swiftc to build the helper). Otherwise never available (engine.ts routes on). */
  available(): boolean {
    return speechAnalyzerSupported();
  }

  canTranscribe(name: string): boolean {
    return this.supportedExtensions.includes(path.extname(name).toLowerCase());
  }

  /**
   * Compile (once) and return the path to the cached SpeechAnalyzer helper binary. The Swift source ships
   * next to this module; we compile it to ~/.cache/large_files_bridge/ keyed by a content hash, so an edit
   * recompiles and an unchanged helper is reused instantly. Throws (→ engine.ts fallback) if the source is
   * missing or swiftc fails. Mirrors Transcribe.js's ensureSpeechBinary().
   */
  private async ensureSpeechBinary(): Promise<string> {
    if (!fs.existsSync(SPEECH_HELPER_SRC)) {
      throw new Error(`SpeechAnalyzer helper source not found at ${SPEECH_HELPER_SRC}`);
    }
    const hash = crypto.createHash("sha1").update(fs.readFileSync(SPEECH_HELPER_SRC)).digest("hex").slice(0, 12);
    const cacheDir = path.join(process.env.HOME || os.homedir(), ".cache", "large_files_bridge");
    const bin = path.join(cacheDir, `SpeechAnalyzerCLI_${hash}`);
    if (fs.existsSync(bin)) return bin;

    fs.mkdirSync(cacheDir, { recursive: true });
    // -parse-as-library because the source uses @main (Transcribe.js uses the same flags).
    const r = await spawnAsync("swiftc", ["-O", "-parse-as-library", "-o", bin, SPEECH_HELPER_SRC], { allowFail: true });
    if (r.status !== 0 || !fs.existsSync(bin)) {
      const detail = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).slice(-1)[0];
      throw new Error(`could not build the SpeechAnalyzer helper — ${detail || `swiftc exited ${r.status}`}`);
    }
    return bin;
  }

  /**
   * Transcribe one audio/video file to `outputPath` with Apple SpeechAnalyzer. Returns a structured result;
   * only throws for truly unexpected conditions (so engine.ts's speech→mac→qwen fallback catches them —
   * notably exit code 3, macOS < 26). Coverage is guaranteed full: the Swift helper reads the whole file to
   * EOF (analyzeSequence-to-EOF), so a successful run inherently covers the whole duration (§4).
   */
  async transcribeToFile(inputFile: string, outputPath: string, onProgress?: ProgressSink): Promise<TranscribeEngineResult> {
    if (!this.available()) {
      const why =
        os.platform() !== "darwin"
          ? "Apple SpeechAnalyzer requires macOS 26+ (this is not a Mac)"
          : !commandExists("swiftc")
            ? "Apple SpeechAnalyzer needs the Xcode command-line tools (swiftc) — xcode-select --install"
            : `Apple SpeechAnalyzer needs macOS ${SPEECH_MIN_MACOS_MAJOR}+`;
      log.warn("transcribe", `${inputFile}: ${why}`);
      return { status: "tool_missing", outputPath: null, words: null, reason: why };
    }
    const ext = path.extname(inputFile).toLowerCase();
    if (VIDEO_EXTENSIONS.includes(ext) && !commandExists("ffmpeg")) {
      log.warn("transcribe", `${inputFile}: ffmpeg not installed — brew install ffmpeg`);
      return { status: "tool_missing", outputPath: null, words: null, reason: "ffmpeg not installed — brew install ffmpeg" };
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const durationSec = await probeDurationSec(inputFile);

    // Demux video → temp MP3; a silent video gets a placeholder rather than a failure.
    let audioFile = inputFile;
    let tempAudio: string | null = null;
    if (VIDEO_EXTENSIONS.includes(ext)) {
      if (!(await hasAudioStream(inputFile))) {
        fs.writeFileSync(outputPath, transcriptHeader(path.basename(inputFile), { engine: SPEECH_MODEL_LABEL, durationSec }) + "[No audio stream — nothing to transcribe]\n", "utf8");
        return { status: "no_audio", outputPath, words: 0, reason: "no audio stream — nothing to transcribe" };
      }
      onProgress?.({ fraction: 0, stage: "demux" });
      try {
        tempAudio = await demuxToMp3(inputFile);
        audioFile = tempAudio;
      } catch (e) {
        log.error("transcribe", `${inputFile}: ffmpeg demux failed: ${(e as Error).message}`);
        return { status: "failed", outputPath: null, words: null, reason: `ffmpeg demux failed: ${(e as Error).message}` };
      }
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-speech-asr-"));
    try {
      const bin = await this.ensureSpeechBinary();
      const outTxt = path.join(scratch, "transcript.txt");
      onProgress?.({ fraction: 0.05, stage: "transcribe" });
      // No wall-clock timeout — a 1–2h+ file must run to completion (§4.1). The helper writes plain text.
      const r = await spawnAsync(bin, ["--input", audioFile, "--output", outTxt, "--locale", "en-US"], { allowFail: true });

      if (r.status !== 0 || !fs.existsSync(outTxt)) {
        const detail = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).slice(-1)[0];
        // Exit 3 = SpeechAnalyzer APIs unavailable (OS older than macOS 26). Thrown (not returned) so
        // engine.ts's fallback retries on Whisper Small — a first-time swiftc/OS hiccup never loses the file.
        if (r.status === 3) throw new Error(detail || `Apple SpeechAnalyzer unavailable — needs macOS ${SPEECH_MIN_MACOS_MAJOR}+`);
        throw new Error(detail || `SpeechAnalyzerCLI exited with code ${r.status}`);
      }

      const body = fs.readFileSync(outTxt, "utf8").trim();
      if (!body) throw new Error("Apple SpeechAnalyzer produced an empty transcription");

      // Full coverage is guaranteed by analyzeSequence-to-EOF, so coveredSec = durationSec (§4).
      fs.writeFileSync(
        outputPath,
        transcriptHeader(path.basename(inputFile), { engine: SPEECH_MODEL_LABEL, device: "on-device", durationSec, coveredSec: durationSec }) + body,
        "utf8",
      );
      onProgress?.({ fraction: 1, stage: "transcribe" });
      const words = body.split(/\s+/).filter(Boolean).length;
      log.info("transcribe", `${inputFile} → ${outputPath} (${words} words, apple-speechanalyzer)`);
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
