// Shared audio-prep + process helpers for the transcription engines (transcribe_engine.mdx §2). Both the
// Whisper engine (Transcribe.ts) and the Qwen3-ASR engine (qwen-asr.ts) need the same up-front steps —
// probe the media's duration, check it has an audio stream, demux a video to a temp MP3 — and the same
// small process/utility helpers. This module holds the engine-agnostic pieces so qwen-asr.ts does not
// duplicate them. (Transcribe.ts keeps its own private copies for now to avoid churn on the working engine.)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".mkv", ".avi", ".webm", ".mpg", ".mpeg", ".wmv", ".flv"];
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".flac", ".ogg", ".oga", ".aac", ".m4a", ".opus", ".aiff", ".aif", ".wma"];

const isWindows = os.platform() === "win32";

/**
 * The Whisper model the `mac` engine actually runs, and the ONE place that decides it (to_fix.mdx §6.2).
 *
 * This constant exists because two sites disagreed and nothing made them agree: `runWhisper()` spawned
 * `--model small` (~2 GiB resident) while `activeTranscribeModelKey()` reported `"base"` (~1 GiB) to the
 * RAM clamp — so `transcribeConcurrency()` sized every Mac box against HALF the memory a whisper job
 * really takes, and admitted twice the jobs the machine could hold. A budget that under-counts by 2× is
 * worse than no budget. Both sites now read this constant and the SAME `LFB_TRANSCRIBE_MODEL` override
 * (via {@link whisperModel}), so the runner and the RAM table cannot drift apart again.
 *
 * It lives here, in the engine-agnostic helper module, because both readers already depend on this file
 * and this file depends on nothing but node builtins — there is no import cycle to create.
 * `small` is the deliberate choice (transcribe_engine.mdx §2/§3): materially more accurate than
 * base/tiny, no multi-GB auto-download.
 */
export const DEFAULT_MAC_WHISPER_MODEL = "small";

/** The whisper model to run / to charge RAM for. Env override is honored identically by both readers. */
export function whisperModel(): string {
  return process.env.LFB_TRANSCRIBE_MODEL || DEFAULT_MAC_WHISPER_MODEL;
}

/**
 * The interactive dev shell's PATH commonly carries directories a restricted/background process does not:
 * pipx installs `whisper` and `mlx-qwen3-asr` shims into `~/.local/bin`, and Homebrew lives at
 * `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel). A tool can be genuinely installed and
 * still be invisible to `which`/`spawn` if the process's PATH doesn't include these — e.g. a launchd agent
 * with no `EnvironmentVariables` block, or any future supervisor that starts the backend with a minimal
 * environment. We therefore always search the CURRENT PATH plus these well-known install locations
 * (de-duplicated, current PATH wins on order) rather than trusting `process.env.PATH` alone. This is
 * additive only — an already-correct interactive PATH is unaffected.
 */
export function toolSearchPath(): string {
  const home = process.env.HOME || os.homedir();
  const extra = [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const current = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const merged = [...current, ...extra].filter((p, i, arr) => arr.indexOf(p) === i);
  return merged.join(path.delimiter);
}

/** The current process env with PATH widened by {@link toolSearchPath} — pass to `spawn`/`spawnSync` so
 *  detection AND execution agree on where a tool lives (transcribe_engine.mdx §2 robustness note). */
export function toolEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: toolSearchPath() };
}

/** Is a CLI on PATH? (`which`/`where`, never a shell alias.) Searches the widened tool PATH so a genuinely
 *  installed pipx/Homebrew tool is never reported missing just because the caller process's PATH is thin. */
export function commandExists(command: string): boolean {
  try {
    return spawnSync(isWindows ? "where" : "which", [command], { stdio: "ignore", env: toolEnv() }).status === 0;
  } catch {
    return false;
  }
}

/** The stdout capture ceiling — the same 1 MiB as fit-media.ts `runAsync()` (memory.mdx P-30). Every
 *  capturing caller here reads a one-line ffprobe answer, so a megabyte is orders of magnitude of slack. */
const STDOUT_CAP_BYTES = 1024 * 1024;

/**
 * Async, non-blocking spawn (transcribe_engine.mdx §4.1 — NEVER spawnSync, which freezes the event loop for
 * the whole run). Optionally streams complete stdout lines to `onLine`. Rejects on a non-zero exit unless
 * `allowFail`. There is deliberately NO wall-clock timeout — a 1–2h+ file may run for hours and must not be
 * reaped mid-file. Runs with the widened tool PATH (above) so a bare command name (`"whisper"`,
 * `"mlx-qwen3-asr"`, `"ffmpeg"`) resolves the same way `commandExists()` detected it.
 *
 * STDOUT CAPTURE IS OPT-IN, and that is a memory decision, not a style one (to_fix.mdx §6.2, memory.mdx
 * P-30 — fit-media.ts `runAsync()` is the precedent this mirrors exactly). This runner used to do
 * `stdout += chunk` for EVERY caller with no ceiling, which is the worst shape available on this path:
 * the *hours-long* transcription children are the chattiest (a multi-hour ASR run emits a segment line
 * per few seconds of audio) and they are precisely the callers that never read `stdout` — so the entire
 * segment log accumulated in one ever-growing string, and `stdout + chunk` transiently allocates ~2× the
 * accumulated string on every chunk, making it quadratic in chunk count. So: capture only when asked, cap
 * at 1 MiB, and accumulate into a chunk ARRAY joined once at close so the concat is linear.
 *
 * When neither `captureStdout` nor `onLine` is set the child is handed /dev/null for stdout — nothing is
 * allocated and there is no pipe that could fill and block the child. `onLine` still needs the pipe (it
 * consumes the stream line-by-line and discards it), so it opens one WITHOUT turning capture on: streaming
 * progress must never imply retaining the log. stderr is always captured and tail-bounded at 4096 — small,
 * and it is what every error message here reads.
 */
export function spawnAsync(
  bin: string,
  args: string[],
  opts: { allowFail?: boolean; onLine?: (line: string) => void; captureStdout?: boolean } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const captureStdout = opts.captureStdout === true;
    // The pipe exists for capture OR for line streaming; "ignore" is what makes a non-reading caller free.
    const wantStdoutPipe = captureStdout || !!opts.onLine;
    const child = spawn(bin, args, { stdio: ["ignore", wantStdoutPipe ? "pipe" : "ignore", "pipe"], env: toolEnv() });
    const chunks: string[] = [];
    let captured = 0;
    let stderr = "";
    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // Joined once, at settle — never in the data handler (that concat is the quadratic part of P-30).
    const finishOut = (): string => (captureStdout ? chunks.join("") : "");
    child.stdout?.on("data", (chunk: string) => {
      if (captureStdout && captured < STDOUT_CAP_BYTES) {
        chunks.push(chunk); // past the cap we drop, we do not grow
        captured += chunk.length;
      }
      if (!opts.onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) opts.onLine(line);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096); // keep only the tail — a long ffmpeg/whisper log can be huge
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (opts.onLine && pending) opts.onLine(pending);
      if (!opts.allowFail && code !== 0) {
        reject(new Error(`${bin} exited ${code}: ${stderr.split("\n").slice(-3).join(" ").slice(0, 200)}`));
        return;
      }
      resolve({ status: code, stdout: finishOut(), stderr });
    });
  });
}

// ── Apple SpeechAnalyzer capability gates (transcribe_engine.mdx §1) ──────────────────────────────────
// SpeechAnalyzer/SpeechTranscriber (the NEW on-device Apple engine — never the legacy SFSpeechRecognizer)
// ships starting in macOS 26 ("Tahoe"). Mirrors Transcribe.js's macOSMajorVersion()/chooseAutoEngine().

/** Minimum macOS *product* major version that ships SpeechAnalyzer/SpeechTranscriber. */
export const SPEECH_MIN_MACOS_MAJOR = 26;

/**
 * The macOS *product* version major integer (e.g. 26 for Tahoe), or null off-Mac / when it can't be read.
 * Uses `sw_vers -productVersion` (26.x on Tahoe) — NOT os.release()/the Darwin kernel version, which is
 * 25.x on macOS 26 and would misgate the feature.
 */
export function macOSMajorVersion(): number | null {
  if (os.platform() !== "darwin") return null;
  try {
    const r = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8", env: toolEnv() });
    if (r.status !== 0) return null;
    const major = Number.parseInt(String(r.stdout ?? "").trim().split(".")[0], 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

/** Can Apple SpeechAnalyzer run right now? darwin + macOS ≥ 26 + swiftc (to build the tiny helper). */
export function speechAnalyzerSupported(): boolean {
  return os.platform() === "darwin" && (macOSMajorVersion() ?? 0) >= SPEECH_MIN_MACOS_MAJOR && commandExists("swiftc");
}

/** True when this Mac's HARDWARE could run SpeechAnalyzer but the OS is older than macOS 26 — i.e. an OS
 *  update would unlock the higher-quality on-device engine (drives the Settings update nudge). */
export function speechAnalyzerNeedsOsUpdate(): boolean {
  return os.platform() === "darwin" && os.arch() === "arm64" && (macOSMajorVersion() ?? 0) < SPEECH_MIN_MACOS_MAJOR;
}

/** Media duration in seconds via ffprobe, or null when unreadable (progress/coverage stays best-effort). */
export async function probeDurationSec(inputFile: string): Promise<number | null> {
  if (!commandExists("ffprobe")) return null;
  const r = await spawnAsync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputFile],
    { allowFail: true, captureStdout: true }, // reads stdout — the duration IS the answer (to_fix.mdx §6.2)
  );
  const n = Number.parseFloat((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Does the media carry an audio stream? (ffprobe; when ffprobe is absent, assume yes and let ffmpeg try.) */
export async function hasAudioStream(inputFile: string): Promise<boolean> {
  if (!commandExists("ffprobe")) return true;
  const r = await spawnAsync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", inputFile],
    { allowFail: true, captureStdout: true }, // reads stdout — its presence IS the answer (to_fix.mdx §6.2)
  );
  return (r.stdout ?? "").trim().length > 0;
}

/** Extract the audio track to a temp MP3 (no video). Returns the temp path; the caller unlinks it. */
export async function demuxToMp3(inputFile: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `lfb-transcribe-${process.hrtime.bigint()}.mp3`);
  const r = await spawnAsync("ffmpeg", ["-i", inputFile, "-vn", "-acodec", "libmp3lame", "-q:a", "2", tmp, "-y"], {
    allowFail: true,
  });
  if (r.status !== 0 || !nonEmpty(tmp)) {
    tryUnlink(tmp);
    throw new Error((r.stderr ?? "").split("\n").slice(-3).join(" ").slice(0, 200) || "ffmpeg produced no audio");
  }
  return tmp;
}

export function nonEmpty(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}
export function tryUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** True when a run's covered seconds reach the source duration within tolerance (transcribe_engine.mdx §4.2):
 *  max(15s, 2% of duration), so a slightly-off ffprobe duration is not a false truncation but a stop-at-20min
 *  of a 2-hour file is caught. */
export function coversFullDuration(coveredSec: number, durationSec: number): boolean {
  const tolerance = Math.max(15, durationSec * 0.02);
  return coveredSec >= durationSec - tolerance;
}

/** Seconds → HH:MM:SS. */
export function hms(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [h, m, ss].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The transcript metadata header (Transcribe.mdx §4) — engine/model + source duration + covered figure. */
export function transcriptHeader(originalName: string, opts: { engine: string; device?: string; durationSec?: number | null; coveredSec?: number | null }): string {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  const lines = [
    `Transcription of: ${originalName}`,
    `Generated on: ${ts}`,
    `Engine: ${opts.engine}${opts.device ? ` (device: ${opts.device}, language: en)` : " (language: en)"}`,
  ];
  if (opts.durationSec) {
    const covered = opts.coveredSec != null ? hms(opts.coveredSec) : "—";
    const full = opts.coveredSec != null && coversFullDuration(opts.coveredSec, opts.durationSec) ? "  ✓ full" : "";
    lines.push(`Source duration: ${hms(opts.durationSec)}   ·   Transcript covers: ${covered}${full}`);
  }
  lines.push("=".repeat(60), "", "");
  return lines.join("\n");
}

export function isTranscribableExt(name: string): boolean {
  return [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].includes(path.extname(name).toLowerCase());
}
