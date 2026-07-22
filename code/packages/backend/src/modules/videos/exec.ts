// Async process + probe helpers for the Videos engines. HOUSE RULE (job_queue.mdx §3 / performance.mdx
// P-27, and the hard rule in ai_description.mdx §3.3.1): NOTHING heavy is ever spawnSync/readFileSync
// on an engine path — every ffmpeg/ffprobe call here is `spawn`, awaited. The one deliberate sync is
// the `which` PATH probe, the same few-ms exception ocr/frames.ts and compression.service.ts make.
//
// ffmpeg/ffprobe are resolved BY NAME ON PATH — exactly how the compress/transcode/ocr modules invoke
// them (perceptual.service.ts `ffmpegOnPath()`, ocr/frames.ts `toolOnPath()`). All inputs are local
// paths; no URL is ever passed, so no network is opened anywhere in this module (charter).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import sharp from "sharp";
import { toolOnPath } from "../ocr/frames.js";
import { registerChildProcess, unregisterChildProcess } from "../../shared/heap-watch.js";

export { toolOnPath };

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const STDERR_KEEP = 64 * 1024; // detect-mode match lines arrive late — keep a generous stderr tail

/**
 * Run a child to completion, async. stdout capture is opt-in and unbounded only for ffprobe-sized JSON;
 * stderr keeps a bounded tail (ffmpeg is chatty; the MPEG-7 detect lines we parse arrive at stream end,
 * so the TAIL is precisely the part that matters). The timeout hard-kills.
 */
export function runAsync(
  cmd: string,
  args: string[],
  label: string,
  opts: { timeoutMs?: number; captureStdout?: boolean } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const captureStdout = opts.captureStdout === true;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: (e as Error).message });
      return;
    }
    registerChildProcess(child.pid, label);
    const outChunks: string[] = [];
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => outChunks.push(String(d)));
    child.stderr?.on("data", (d) => {
      stderr = (stderr + String(d)).slice(-STDERR_KEEP);
    });
    const finish = (code: number | null, err?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterChildProcess(child.pid);
      resolve({ code, stdout: outChunks.join(""), stderr: err ? `${stderr}\n${err}` : stderr });
    };
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
  });
}

// ── display-attribute probes (duplicates.mdx §8.2 step 3) ─────────────────────────────────────────────

export interface MediaAttrs {
  durationS: number | null; // null for images
  width: number | null;
  height: number | null;
  codec: string | null;
}

/** Probe a VIDEO's display attributes with ffprobe (async). Null fields when the probe fails — a missing
 *  attribute is a blank cell, never a failed scan item. */
export async function probeVideoAttrs(abs: string): Promise<MediaAttrs> {
  if (!toolOnPath("ffprobe")) return { durationS: null, width: null, height: null, codec: null };
  const r = await runAsync(
    "ffprobe",
    [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name:format=duration",
      "-of", "json", abs,
    ],
    `videos-probe:${abs}`,
    { timeoutMs: 60_000, captureStdout: true },
  );
  if (r.code !== 0) return { durationS: null, width: null, height: null, codec: null };
  try {
    const j = JSON.parse(r.stdout) as {
      streams?: Array<{ width?: number; height?: number; codec_name?: string }>;
      format?: { duration?: string };
    };
    const s = j.streams?.[0];
    const dur = Number(j.format?.duration);
    return {
      durationS: Number.isFinite(dur) && dur > 0 ? dur : null,
      width: Number(s?.width) || null,
      height: Number(s?.height) || null,
      codec: s?.codec_name ? String(s.codec_name).toLowerCase() : null,
    };
  } catch {
    return { durationS: null, width: null, height: null, codec: null };
  }
}

/** Probe an IMAGE's display attributes with sharp (header-only metadata read — no pixel decode). The
 *  `format` (png/jpeg/heif/webp) is the image's codec in the §4.5 print-rule sense. */
export async function probeImageAttrs(abs: string): Promise<MediaAttrs> {
  try {
    const meta = await sharp(abs, { failOn: "none" }).metadata();
    return {
      durationS: null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      codec: meta.format ? String(meta.format).toLowerCase() : null,
    };
  } catch {
    return { durationS: null, width: null, height: null, codec: null };
  }
}

// ── exact content hash (duplicates.mdx §8.2 pass 1) ───────────────────────────────────────────────────

/**
 * FULL-content sha256 of a file, streamed async — never readFileSync (a multi-GB video must not enter
 * the heap, and the event loop must keep breathing). This is the "exact content hash" pass-1 identity:
 * unlike the tracking scheme's size+mtime+head/tail fingerprint, byte-identical COPIES (differing
 * mtimes) hash identically here — which is the entire point of the pass.
 */
export function sha256File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const stream = fs.createReadStream(abs);
    stream.on("data", (d) => h.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(h.digest("hex")));
  });
}
