// The transcription engine (Transcribe.mdx §5). A COPY of our standalone Transcribe.js
// (~/BGit/all/tools/Transcription/Transcribe.js) adapted to TypeScript as an IN-PROCESS class — no
// process.argv / process.exit / top-level auto-run. The web-app backend imports `Transcriber` and calls
// transcribeToFile() directly; we never shell out to `node Transcribe.js` and we do NOT reuse the
// ACT3-internal copy. It still drives the local `whisper` (+ `ffmpeg`) binaries via spawnSync — Whisper
// is a Python CLI — but everything runs ON-MACHINE, no network (charter: only-our-content, no phone-home).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../../shared/logging.js";

// Video / container formats whose audio track must be demuxed to MP3 before Whisper can read it.
const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".mkv", ".avi", ".webm", ".mpg", ".mpeg", ".wmv", ".flv"];
// Everything Whisper can ingest directly once we have audio.
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".flac", ".ogg", ".oga", ".aac", ".m4a", ".opus", ".aiff", ".aif", ".wma"];

export interface TranscribeToolStatus {
  whisper: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
}

export type TranscribeStatus = "transcribed" | "no_audio" | "tool_missing" | "failed";

export interface TranscribeEngineResult {
  status: TranscribeStatus;
  /** The transcript file written (on success / no_audio placeholder), else null. */
  outputPath: string | null;
  /** Word count of the transcript body (success only). */
  words: number | null;
  /** Human-readable reason for a non-success outcome, or the missing tool hint. */
  reason: string | null;
}

/** In-process transcription engine — one instance is cheap; construct per call or reuse. */
export class Transcriber {
  private readonly isMac = os.platform() === "darwin";
  private readonly isWindows = os.platform() === "win32";
  readonly supportedExtensions = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];

  /** True when a name has an extension we can transcribe (audio or video). */
  canTranscribe(name: string): boolean {
    return this.supportedExtensions.includes(path.extname(name).toLowerCase());
  }

  /** Which underlying binaries are installed (drives the UI disabled-state + install hint). */
  toolStatus(): TranscribeToolStatus {
    return {
      whisper: this.commandExists("whisper"),
      ffmpeg: this.commandExists("ffmpeg"),
      ffprobe: this.commandExists("ffprobe"),
    };
  }

  /**
   * Transcribe one audio/video file to `outputPath` (a .txt written by the caller's chosen layout —
   * Transcribe.mdx §3 puts it under <storageRoot>/.transcribe/<relpath>.txt). Pure result object; never
   * throws for the expected outcomes (missing tools, no audio) — those come back as a status.
   */
  transcribeToFile(inputFile: string, outputPath: string): TranscribeEngineResult {
    const ext = path.extname(inputFile).toLowerCase();
    const tools = this.toolStatus();

    // Whisper is always required; ffmpeg only for video demux. Report the missing tool clearly.
    if (!tools.whisper) {
      return { status: "tool_missing", outputPath: null, words: null, reason: "whisper not installed — `pipx install openai-whisper`" };
    }
    if (VIDEO_EXTENSIONS.includes(ext) && !tools.ffmpeg) {
      return { status: "tool_missing", outputPath: null, words: null, reason: "ffmpeg not installed — `brew install ffmpeg`" };
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Demux video → temp MP3; a video with no audio stream gets a placeholder transcript.
    let audioFile = inputFile;
    let tempAudio: string | null = null;
    if (VIDEO_EXTENSIONS.includes(ext)) {
      if (!this.hasAudioStream(inputFile)) {
        this.writePlaceholder(inputFile, outputPath);
        return { status: "no_audio", outputPath, words: 0, reason: "no audio stream — nothing to transcribe" };
      }
      try {
        tempAudio = this.demuxToMp3(inputFile);
        audioFile = tempAudio;
      } catch (e) {
        return { status: "failed", outputPath: null, words: null, reason: `ffmpeg demux failed: ${(e as Error).message}` };
      }
    }

    try {
      const words = this.runWhisper(audioFile, outputPath, path.basename(inputFile));
      return { status: "transcribed", outputPath, words, reason: null };
    } catch (e) {
      log.error("transcribe", `whisper failed for ${inputFile}: ${(e as Error).message}`);
      return { status: "failed", outputPath: null, words: null, reason: (e as Error).message };
    } finally {
      if (tempAudio) this.tryUnlink(tempAudio);
    }
  }

  // ── whisper ───────────────────────────────────────────────────────────────────
  /** Run Whisper (MPS on Apple Silicon with a CPU fallback), header the output, return word count. */
  private runWhisper(audioFile: string, outputPath: string, originalName: string): number {
    const audioDir = path.dirname(audioFile);
    const audioBase = path.basename(audioFile, path.extname(audioFile));
    // Whisper writes <audioBase>.txt into --output_dir; we read that, header it, and move it to outputPath.
    const whisperOut = path.join(audioDir, `${audioBase}.txt`);
    this.tryUnlink(whisperOut); // clear any stale prior output so our success check is meaningful

    const base = ["--model", "base", "--output_format", "txt", "--output_dir", audioDir, "--language", "en"];

    let ok = false;
    if (this.isMac && os.arch() === "arm64") {
      // Prefer the Metal GPU, but MPS sometimes exits 0 emitting garbage (non-English fragments) —
      // validate the output looks like English before trusting it, else fall back to CPU.
      this.spawn("whisper", [audioFile, ...base, "--device", "mps"]);
      if (fs.existsSync(whisperOut) && this.looksLikeEnglish(whisperOut)) ok = true;
      else this.tryUnlink(whisperOut);
    }
    if (!ok) {
      this.spawn("whisper", [audioFile, ...base, "--device", "cpu", "--fp16", "False"]);
    }
    if (!fs.existsSync(whisperOut)) {
      throw new Error(`whisper produced no output for ${originalName}`);
    }

    const body = fs.readFileSync(whisperOut, "utf8").trim();
    fs.writeFileSync(outputPath, this.header(originalName) + body, "utf8");
    // Remove whisper's scratch .txt if it is a different file from our final transcript.
    if (path.resolve(whisperOut) !== path.resolve(outputPath)) this.tryUnlink(whisperOut);

    return body ? body.split(/\s+/).length : 0;
  }

  private header(originalName: string): string {
    const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
    return [
      `Transcription of: ${originalName}`,
      `Generated on: ${ts}`,
      `Model used: whisper-base (language: en)`,
      "=".repeat(60),
      "",
      "",
    ].join("\n");
  }

  private writePlaceholder(inputFile: string, outputPath: string): void {
    fs.writeFileSync(outputPath, this.header(path.basename(inputFile)) + "[No audio stream — nothing to transcribe]\n", "utf8");
  }

  /**
   * English transcripts are essentially all ASCII; >2% non-ASCII is the MPS-garbage signature
   * (Apple-Silicon numerical instability emits Vietnamese fragments / control chars).
   */
  private looksLikeEnglish(filePath: string): boolean {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      if (text.trim().length < 20) return false;
      let nonAscii = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) nonAscii++;
      return nonAscii / text.length < 0.02;
    } catch {
      return false;
    }
  }

  // ── ffmpeg / ffprobe ────────────────────────────────────────────────────────────
  private hasAudioStream(inputFile: string): boolean {
    if (!this.commandExists("ffprobe")) return true; // can't tell → let ffmpeg try
    const r = this.spawn("ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", inputFile,
    ], /*allowFail*/ true);
    return (r.stdout ?? "").trim().length > 0;
  }

  /** Extract the audio track to a temp MP3 (no video). Returns the temp path; caller unlinks it. */
  private demuxToMp3(inputFile: string): string {
    const tmp = path.join(os.tmpdir(), `lfb-transcribe-${process.hrtime.bigint()}.mp3`);
    const r = this.spawn("ffmpeg", ["-i", inputFile, "-vn", "-acodec", "libmp3lame", "-q:a", "2", tmp, "-y"], true);
    if (r.status !== 0 || !this.nonEmpty(tmp)) {
      this.tryUnlink(tmp);
      throw new Error((r.stderr ?? "").split("\n").slice(-3).join(" ").slice(0, 200) || "ffmpeg produced no audio");
    }
    return tmp;
  }

  // ── process helpers ──────────────────────────────────────────────────────────────
  private spawn(bin: string, args: string[], allowFail = false): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    if (!allowFail && r.status !== 0) {
      throw new Error(`${bin} exited ${r.status}: ${(r.stderr ?? "").split("\n").slice(-3).join(" ").slice(0, 200)}`);
    }
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  private commandExists(command: string): boolean {
    try {
      return spawnSync(this.isWindows ? "where" : "which", [command], { stdio: "ignore" }).status === 0;
    } catch {
      return false;
    }
  }

  private nonEmpty(p: string): boolean {
    try {
      return fs.statSync(p).size > 0;
    } catch {
      return false;
    }
  }
  private tryUnlink(p: string): void {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}
