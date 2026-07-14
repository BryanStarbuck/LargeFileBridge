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

/**
 * Async, non-blocking spawn (transcribe_engine.mdx §4.1 — NEVER spawnSync, which freezes the event loop for
 * the whole run). Buffers stdout/stderr and optionally streams complete stdout lines to `onLine`. Rejects on
 * a non-zero exit unless `allowFail`. There is deliberately NO wall-clock timeout — a 1–2h+ file may run for
 * hours and must not be reaped mid-file. Runs with the widened tool PATH (above) so a bare command name
 * (`"whisper"`, `"mlx-qwen3-asr"`, `"ffmpeg"`) resolves the same way `commandExists()` detected it.
 */
export function spawnAsync(
  bin: string,
  args: string[],
  opts: { allowFail?: boolean; onLine?: (line: string) => void } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: toolEnv() });
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (!opts.onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) opts.onLine(line);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (opts.onLine && pending) opts.onLine(pending);
      if (!opts.allowFail && code !== 0) {
        reject(new Error(`${bin} exited ${code}: ${stderr.split("\n").slice(-3).join(" ").slice(0, 200)}`));
        return;
      }
      resolve({ status: code, stdout, stderr });
    });
  });
}

/** Media duration in seconds via ffprobe, or null when unreadable (progress/coverage stays best-effort). */
export async function probeDurationSec(inputFile: string): Promise<number | null> {
  if (!commandExists("ffprobe")) return null;
  const r = await spawnAsync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputFile],
    { allowFail: true },
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
    { allowFail: true },
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
