// COMPRESS-TO-FIT for AI description (ai_description.mdx §3.3). A hosted vision model is called with the
// file inline as base64, and that inline request is bounded (~20MB) — so before we upload an image or a
// video we make sure the bytes we send are UNDER a hard target (17.5MB, safely below the 18MB inline
// cap). When a file is already under the target we send it untouched; when it is over, we transcode a
// TEMPORARY copy down to fit and upload that instead. The ORIGINAL FILE IS NEVER TOUCHED — we only ever
// write to a temp file under the state dir and hand its path to the adapter, then delete it.
//
// Video strategy (charter: "keep the pixel resolution the same if highly compressing it, but if that
// doesn't work, reduce the pixel resolution ~25% each time and repeat until it fits"):
//   1. Try a strong CRF encode at the ORIGINAL resolution; if that lands under the target, keep full res.
//   2. Still over → try an even more aggressive CRF at original resolution (last chance to keep res).
//   3. Still over → step the resolution down ~25% (snapping to a standard height within 3%) and retry,
//      repeating down a ladder to a 240p floor.
//   4. Final guarantee → a two-pass encode at the floor resolution to an exact target bitrate, which
//      deterministically lands under the cap.
// Image strategy: re-encode to JPEG at descending quality, then descending scale, until it fits.
//
// H.264 (libx264, yuv420p, +faststart) is chosen deliberately over "better-compressing" HEVC/AV1: the
// point is that the provider's decoder MUST accept it, and H.264/mp4 is the one format every vision
// provider decodes. AAC audio is kept but re-encoded low so it can't dominate the byte budget.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";
import { log } from "../../shared/logging.js";

/** The byte ceiling we compress down to. Held safely under the 18MB inline cap in adapters.ts so the
 *  compressed copy always clears readBase64Capped() with margin. */
export const FIT_TARGET_BYTES = Math.floor(17.5 * 1024 * 1024); // 18,350,080 bytes

/** Standard video heights we prefer to "snap" a 25%-reduced resolution onto when one is within 3%. */
const STANDARD_HEIGHTS = [4320, 2160, 1440, 1080, 900, 720, 540, 480, 360, 288, 240];
const MIN_HEIGHT = 240;
const MAX_LADDER_STEPS = 8;

export interface FitResult {
  /** The path to upload — the original when it already fits, else a temp compressed copy. */
  path: string;
  /** true when `path` is a temp compressed copy that must be cleaned up. */
  compressed: boolean;
  /** Delete the temp copy (no-op when the original was used). Always call in a finally. */
  cleanup: () => void;
  /** A short human note about what happened (for logging / the stored record), or null. */
  note: string | null;
}

const NOOP_CLEANUP = () => {};

// ── small process helpers ───────────────────────────────────────────────────────
// `which` is a near-instant detection probe (a few ms), so it stays synchronous — the mirror of
// compression.service.ts `onPath()`. Only the HEAVY calls below (ffprobe/ffmpeg/magick) run async.
function which(bin: string): boolean {
  try {
    return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}
// The heavy process runner — ASYNC (child_process.spawn), so a multi-minute ffmpeg/magick transcode (and
// even the shorter ffprobe/magick probes) NEVER block the Node event loop (ai_description.mdx §3.3.1,
// job_queue.mdx §3, performance.mdx P-27). This is what lets the describe queue run ~24 files in parallel
// (job_queue.mdx §3) while the web app stays responsive and GET /api/progress keeps answering — the exact
// freeze that made the Processing page fail to load during a mass AI-description run. Captures stdout too
// (probeVideo needs the ffprobe JSON), both streams bounded so a chatty tool can't grow memory unbounded.
function runAsync(
  bin: string,
  args: string[],
  timeoutMs = 15 * 60 * 1000,
): Promise<{ code: number | null; err: string; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, err: (e as Error).message, out: "" });
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) child!.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      out = (out + d.toString()).slice(-32 * 1024 * 1024); // bounded (the old maxBuffer)
    });
    child.stderr?.on("data", (d) => {
      err = (err + d.toString()).slice(-4096); // keep only the tail — a long ffmpeg log can be huge
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, err: e.message, out });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, err, out });
    });
  });
}
function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}
function tryUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}
function tmpPath(ext: string): string {
  const dir = path.join(resolveStateDir(), "tmp");
  ensureDir(dir);
  // randomUUID() (no child process) — the old spawnSync("uuidgen") was a synchronous process spawn per
  // temp file, another needless event-loop hit on the hot path.
  return path.join(dir, `describe-fit-${randomUUID()}${ext}`);
}
function lastErr(err: string): string {
  return (err || "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200);
}

// ── resolution ladder ────────────────────────────────────────────────────────────
function evenDown(n: number): number {
  const f = Math.floor(n);
  return f % 2 === 0 ? f : f - 1;
}
/** A 25%-reduced height, snapped to a standard height when one is within 3% of the reduced value. */
function stepDownHeight(h: number): number {
  const candidate = h * 0.75;
  for (const s of STANDARD_HEIGHTS) {
    if (Math.abs(s - candidate) / candidate <= 0.03) return s;
  }
  return evenDown(candidate);
}
/** [origH, then repeated 25% reductions] down to the floor — the resolutions we try in order. */
function resolutionLadder(origH: number): number[] {
  const out: number[] = [];
  let h = Math.max(evenDown(origH), MIN_HEIGHT);
  out.push(h);
  while (h > MIN_HEIGHT && out.length < MAX_LADDER_STEPS) {
    let next = stepDownHeight(h);
    if (next >= h) next = evenDown(h - 2); // guarantee progress
    if (next < MIN_HEIGHT) next = MIN_HEIGHT;
    if (next === h) break;
    out.push(next);
    h = next;
  }
  return out;
}

// ── video probe + encode ──────────────────────────────────────────────────────────
interface VideoInfo {
  width: number;
  height: number;
  duration: number; // seconds
}
async function probeVideo(abs: string): Promise<VideoInfo | null> {
  const r = await runAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", abs,
  ], 60_000);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
    const s = j.streams?.[0];
    const width = Number(s?.width);
    const height = Number(s?.height);
    const duration = Number(j.format?.duration);
    if (!width || !height) return null;
    return { width, height, duration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
  } catch {
    return null;
  }
}

/** CRF-based encode of the whole clip to a temp mp4. Only downscales when targetH < origH. */
async function encodeCrf(src: string, out: string, origH: number, targetH: number, crf: number): Promise<{ code: number | null; err: string }> {
  const scale = targetH < origH ? ["-vf", `scale=-2:${targetH}`] : [];
  return runAsync("ffmpeg", [
    "-y", "-i", src,
    ...scale,
    "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    out,
  ]);
}

/** Two-pass encode to an EXACT target video bitrate — the deterministic "must fit" fallback. */
async function encodeTwoPass(src: string, out: string, origH: number, targetH: number, videoKbps: number): Promise<{ code: number | null; err: string }> {
  const scale = targetH < origH ? ["-vf", `scale=-2:${targetH}`] : [];
  const logbase = tmpPath("").replace(/\.$/, "") + "-2pass";
  const common = [...scale, "-c:v", "libx264", "-preset", "medium", "-b:v", `${videoKbps}k`, "-passlogfile", logbase];
  const p1 = await runAsync("ffmpeg", ["-y", "-i", src, ...common, "-pass", "1", "-an", "-f", "mp4", "/dev/null"]);
  if (p1.code !== 0) {
    tryUnlink(`${logbase}-0.log`);
    tryUnlink(`${logbase}-0.log.mbtree`);
    return p1;
  }
  const p2 = await runAsync("ffmpeg", [
    "-y", "-i", src, ...common, "-pass", "2",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", out,
  ]);
  tryUnlink(`${logbase}-0.log`);
  tryUnlink(`${logbase}-0.log.mbtree`);
  return p2;
}

async function fitVideoUnderLimit(src: string, limitBytes: number): Promise<{ out: string; note: string }> {
  if (!which("ffmpeg")) {
    throw new Error("this video is over the AI-description size limit and needs ffmpeg to compress it — install it with: brew install ffmpeg");
  }
  const info = await probeVideo(src); // ffprobe may be absent; we degrade gracefully below
  const origH = info?.height ?? 1080;
  const ladder = resolutionLadder(origH);

  // Walk the ladder. At the ORIGINAL resolution give two CRF attempts (28, then a very aggressive 34) so
  // we exhaust "keep the resolution, just compress harder" before dropping pixels. Lower rungs get one.
  for (let i = 0; i < ladder.length; i++) {
    const targetH = ladder[i];
    const crfs = i === 0 ? [28, 34] : [30];
    for (const crf of crfs) {
      const out = tmpPath(".mp4");
      const r = await encodeCrf(src, out, origH, targetH, crf);
      const outSize = sizeOf(out);
      if (r.code === 0 && outSize > 0 && outSize <= limitBytes) {
        const note = targetH < origH
          ? `compressed to fit: H.264 CRF ${crf}, downscaled to ${targetH}p (${(outSize / 1024 / 1024).toFixed(1)}MB)`
          : `compressed to fit: H.264 CRF ${crf} at original resolution (${(outSize / 1024 / 1024).toFixed(1)}MB)`;
        return { out, note };
      }
      tryUnlink(out);
    }
  }

  // Final guarantee: two-pass to an exact bitrate at the floor resolution. Needs a duration to size the
  // bitrate; if ffprobe couldn't give one, assume a conservative 600s so we err on the smaller side.
  const floorH = ladder[ladder.length - 1];
  const duration = info?.duration && info.duration > 0 ? info.duration : 600;
  const audioKbps = 64;
  const totalKbps = Math.floor((limitBytes * 8 * 0.94) / 1000 / duration);
  const videoKbps = Math.max(120, totalKbps - audioKbps);
  const out = tmpPath(".mp4");
  const r = await encodeTwoPass(src, out, origH, floorH, videoKbps);
  const outSize = sizeOf(out);
  if (r.code === 0 && outSize > 0 && outSize <= limitBytes) {
    return { out, note: `compressed to fit: H.264 two-pass ${videoKbps}kbps at ${floorH}p (${(outSize / 1024 / 1024).toFixed(1)}MB)` };
  }
  tryUnlink(out);
  throw new Error(`could not compress this video under ${(limitBytes / 1024 / 1024).toFixed(1)}MB for AI description${r.err ? ` (ffmpeg: ${lastErr(r.err)})` : ""}`);
}

// ── image fit ──────────────────────────────────────────────────────────────────────
function magickBin(): string | null {
  if (which("magick")) return "magick";
  if (which("convert")) return "convert";
  return null;
}
async function fitImageUnderLimit(src: string, limitBytes: number): Promise<{ out: string; note: string }> {
  const bin = magickBin();
  if (!bin) {
    throw new Error("this image is over the AI-description size limit and needs ImageMagick to compress it — install it with: brew install imagemagick");
  }
  // Descend quality first (keeps resolution), then descend scale. A temp JPEG is fine — it exists only to
  // show the model; the original (which may keep alpha/PNG) is never modified.
  for (const scalePct of [100, 75, 56, 42, 32, 24, 18]) {
    for (const q of [85, 72, 60]) {
      const out = tmpPath(".jpg");
      const resize = scalePct < 100 ? ["-resize", `${scalePct}%`] : [];
      const r = await runAsync(bin, [src, ...resize, "-strip", "-quality", String(q), out], 5 * 60 * 1000);
      const outSize = sizeOf(out);
      if (r.code === 0 && outSize > 0 && outSize <= limitBytes) {
        const note = scalePct < 100
          ? `compressed to fit: JPEG q${q}, scaled to ${scalePct}% (${(outSize / 1024 / 1024).toFixed(1)}MB)`
          : `compressed to fit: JPEG q${q} at original resolution (${(outSize / 1024 / 1024).toFixed(1)}MB)`;
        return { out, note };
      }
      tryUnlink(out);
    }
  }
  throw new Error(`could not compress this image under ${(limitBytes / 1024 / 1024).toFixed(1)}MB for AI description`);
}

/**
 * Ensure the media we upload for AI description is at or under `limitBytes`. Returns the ORIGINAL path
 * untouched when it already fits; otherwise transcodes a temporary compressed copy that fits and returns
 * its path with a cleanup(). Never modifies the original. Throws (with a helpful message) only when the
 * required tool is missing or the file genuinely can't be squeezed under the cap.
 */
export async function fitMediaUnderLimit(absPath: string, kind: "image" | "video", limitBytes = FIT_TARGET_BYTES): Promise<FitResult> {
  const size = sizeOf(absPath);
  if (size >= 0 && size <= limitBytes) {
    return { path: absPath, compressed: false, cleanup: NOOP_CLEANUP, note: null };
  }
  const { out, note } = kind === "video"
    ? await fitVideoUnderLimit(absPath, limitBytes)
    : await fitImageUnderLimit(absPath, limitBytes);
  log.info("describe", `${absPath} (${(size / 1024 / 1024).toFixed(1)}MB) → ${note}`);
  return {
    path: out,
    compressed: true,
    cleanup: () => tryUnlink(out),
    note,
  };
}
