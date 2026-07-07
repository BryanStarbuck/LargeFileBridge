// The transcription engine (Transcribe.mdx §5). A COPY of our standalone Transcribe.js
// (~/BGit/all/tools/Transcription/Transcribe.js) adapted to TypeScript as an IN-PROCESS class — no
// process.argv / process.exit / top-level auto-run. The web-app backend imports `Transcriber` and calls
// transcribeToFile() directly; we never shell out to `node Transcribe.js` and we do NOT reuse the
// ACT3-internal copy. It drives the local `whisper` (+ `ffmpeg`) binaries — Whisper is a Python CLI —
// but everything runs ON-MACHINE, no network (charter: only-our-content, no phone-home). There is NO
// cloud transcription and NO credentials of any kind: this needs no Google Cloud key, only the two
// local binaries.
//
// ASYNC, non-blocking (Transcribe.mdx §5.1). The original tool used spawnSync/execSync, which BLOCKS the
// Node event loop for the WHOLE Whisper run — on a 6-minute video the entire API server froze (health &
// progress polling died, the request looked dead). Here every child process is spawned ASYNCHRONOUSLY
// and awaited, so the event loop stays free to serve GET /api/progress while a transcription runs. We
// also stream Whisper's stdout to derive a determinate percentage (segment end-timestamp ÷ duration).
import { spawn, spawnSync } from "node:child_process";
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

/** A determinate-progress sink: `fraction` is 0..1 of the audio decoded so far. */
export type ProgressSink = (p: { fraction: number; stage: "demux" | "transcribe" }) => void;

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
   * Transcribe one audio/video file to `outputPath` (a plain-text file at the caller's chosen path —
   * Transcribe.mdx §3 puts it at the sidecar <root>/<relpath-without-ext>.transcription). Pure result object; never
   * throws for the expected outcomes (missing tools, no audio) — those come back as a status. ASYNC:
   * awaits ffmpeg + whisper without blocking the event loop, and streams determinate progress to
   * `onProgress` when given (parsed from Whisper's segment timestamps against the media duration).
   */
  async transcribeToFile(inputFile: string, outputPath: string, onProgress?: ProgressSink): Promise<TranscribeEngineResult> {
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

    // Total audio duration (seconds) — the denominator for a determinate progress bar. Best-effort:
    // if ffprobe can't read it, progress stays indeterminate (a spinner) rather than lying.
    const durationSec = await this.probeDurationSec(inputFile);

    // Demux video → temp MP3; a video with no audio stream gets a placeholder transcript.
    let audioFile = inputFile;
    let tempAudio: string | null = null;
    if (VIDEO_EXTENSIONS.includes(ext)) {
      if (!(await this.hasAudioStream(inputFile))) {
        this.writePlaceholder(inputFile, outputPath);
        return { status: "no_audio", outputPath, words: 0, reason: "no audio stream — nothing to transcribe" };
      }
      onProgress?.({ fraction: 0, stage: "demux" });
      try {
        tempAudio = await this.demuxToMp3(inputFile);
        audioFile = tempAudio;
      } catch (e) {
        return { status: "failed", outputPath: null, words: null, reason: `ffmpeg demux failed: ${(e as Error).message}` };
      }
    }

    try {
      const words = await this.runWhisper(audioFile, outputPath, path.basename(inputFile), durationSec, onProgress);
      onProgress?.({ fraction: 1, stage: "transcribe" });
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
  private async runWhisper(
    audioFile: string,
    outputPath: string,
    originalName: string,
    durationSec: number | null,
    onProgress?: ProgressSink,
  ): Promise<number> {
    const audioDir = path.dirname(audioFile);
    const audioBase = path.basename(audioFile, path.extname(audioFile));
    // Whisper writes <audioBase>.txt into --output_dir; we read that, header it, and move it to outputPath.
    const whisperOut = path.join(audioDir, `${audioBase}.txt`);
    this.tryUnlink(whisperOut); // clear any stale prior output so our success check is meaningful

    const base = ["--model", "base", "--output_format", "txt", "--output_dir", audioDir, "--language", "en"];
    // Turn Whisper's decoded segments into a determinate fraction: each stdout line carries the segment
    // it just finished as `[start --> end]`; end ÷ duration is the share of audio processed.
    const onLine = durationSec && durationSec > 0
      ? (line: string) => {
          const end = this.parseSegmentEndSec(line);
          if (end != null) onProgress?.({ fraction: Math.min(0.99, end / durationSec), stage: "transcribe" });
        }
      : undefined;

    let ok = false;
    if (this.isMac && os.arch() === "arm64") {
      // Prefer the Metal GPU, but MPS sometimes exits 0 emitting garbage (non-English fragments) —
      // validate the output looks like English before trusting it, else fall back to CPU.
      await this.spawnAsync("whisper", [audioFile, ...base, "--device", "mps"], { allowFail: true, onLine });
      if (fs.existsSync(whisperOut) && this.looksLikeEnglish(whisperOut)) ok = true;
      else this.tryUnlink(whisperOut);
    }
    if (!ok) {
      await this.spawnAsync("whisper", [audioFile, ...base, "--device", "cpu", "--fp16", "False"], { onLine });
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

  /**
   * Parse the END timestamp of a Whisper segment line, e.g. `[00:04.800 --> 00:11.140]  text…`, into
   * seconds. Handles both `MM:SS.mmm` and `HH:MM:SS.mmm`. Returns null for a non-segment line.
   */
  private parseSegmentEndSec(line: string): number | null {
    const m = line.match(/-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/);
    if (!m) return null;
    const h = m[1] ? Number(m[1]) : 0;
    const min = Number(m[2]);
    const sec = Number(m[3]);
    const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
    return h * 3600 + min * 60 + sec + ms / 1000;
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
  /** Media duration in seconds via ffprobe, or null when it can't be read. */
  private async probeDurationSec(inputFile: string): Promise<number | null> {
    if (!this.commandExists("ffprobe")) return null;
    const r = await this.spawnAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputFile],
      { allowFail: true },
    );
    const n = Number.parseFloat((r.stdout ?? "").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  private async hasAudioStream(inputFile: string): Promise<boolean> {
    if (!this.commandExists("ffprobe")) return true; // can't tell → let ffmpeg try
    const r = await this.spawnAsync(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", inputFile],
      { allowFail: true },
    );
    return (r.stdout ?? "").trim().length > 0;
  }

  /** Extract the audio track to a temp MP3 (no video). Returns the temp path; caller unlinks it. */
  private async demuxToMp3(inputFile: string): Promise<string> {
    const tmp = path.join(os.tmpdir(), `lfb-transcribe-${process.hrtime.bigint()}.mp3`);
    const r = await this.spawnAsync("ffmpeg", ["-i", inputFile, "-vn", "-acodec", "libmp3lame", "-q:a", "2", tmp, "-y"], { allowFail: true });
    if (r.status !== 0 || !this.nonEmpty(tmp)) {
      this.tryUnlink(tmp);
      throw new Error((r.stderr ?? "").split("\n").slice(-3).join(" ").slice(0, 200) || "ffmpeg produced no audio");
    }
    return tmp;
  }

  // ── process helpers ──────────────────────────────────────────────────────────────
  /**
   * Async, non-blocking replacement for spawnSync. Buffers stdout/stderr and (optionally) invokes
   * `onLine` per COMPLETE stdout line so callers can stream progress. Rejects on a non-zero exit unless
   * `allowFail` is set. Never blocks the event loop — the whole point of the async engine (§5.1).
   */
  private spawnAsync(
    bin: string,
    args: string[],
    opts: { allowFail?: boolean; onLine?: (line: string) => void } = {},
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let pending = ""; // partial trailing line between chunks (for onLine)

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (!opts.onLine) return;
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? ""; // keep the last (possibly incomplete) fragment
        for (const line of lines) if (line) opts.onLine(line);
      });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

      child.on("error", (err) => reject(err)); // e.g. ENOENT — binary vanished mid-run
      child.on("close", (code) => {
        if (opts.onLine && pending) opts.onLine(pending); // flush any final partial line
        if (!opts.allowFail && code !== 0) {
          reject(new Error(`${bin} exited ${code}: ${stderr.split("\n").slice(-3).join(" ").slice(0, 200)}`));
          return;
        }
        resolve({ status: code, stdout, stderr });
      });
    });
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
