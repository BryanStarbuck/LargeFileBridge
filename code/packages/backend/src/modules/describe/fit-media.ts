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
import { spawnSync } from "node:child_process";
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
function which(bin: string): boolean {
  try {
    return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}
function run(bin: string, args: string[], timeoutMs = 15 * 60 * 1000): { code: number | null; err: string; out: string } {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, err: r.stderr ?? "", out: r.stdout ?? "" };
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
let tmpCounter = 0;
function tmpPath(ext: string): string {
  const dir = path.join(resolveStateDir(), "tmp");
  ensureDir(dir);
  const rand = spawnSync("uuidgen", [], { encoding: "utf8" }).stdout?.trim() || `${process.hrtime.bigint()}-${tmpCounter++}`;
  return path.join(dir, `describe-fit-${rand}${ext}`);
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
function probeVideo(abs: string): VideoInfo | null {
  const r = run("ffprobe", [
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
function encodeCrf(src: string, out: string, origH: number, targetH: number, crf: number): { code: number | null; err: string } {
  const scale = targetH < origH ? ["-vf", `scale=-2:${targetH}`] : [];
  return run("ffmpeg", [
    "-y", "-i", src,
    ...scale,
    "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    out,
  ]);
}

/** Two-pass encode to an EXACT target video bitrate — the deterministic "must fit" fallback. */
function encodeTwoPass(src: string, out: string, origH: number, targetH: number, videoKbps: number): { code: number | null; err: string } {
  const scale = targetH < origH ? ["-vf", `scale=-2:${targetH}`] : [];
  const logbase = tmpPath("").replace(/\.$/, "") + "-2pass";
  const common = [...scale, "-c:v", "libx264", "-preset", "medium", "-b:v", `${videoKbps}k`, "-passlogfile", logbase];
  const p1 = run("ffmpeg", ["-y", "-i", src, ...common, "-pass", "1", "-an", "-f", "mp4", "/dev/null"]);
  if (p1.code !== 0) {
    tryUnlink(`${logbase}-0.log`);
    tryUnlink(`${logbase}-0.log.mbtree`);
    return p1;
  }
  const p2 = run("ffmpeg", [
    "-y", "-i", src, ...common, "-pass", "2",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", out,
  ]);
  tryUnlink(`${logbase}-0.log`);
  tryUnlink(`${logbase}-0.log.mbtree`);
  return p2;
}

function fitVideoUnderLimit(src: string, limitBytes: number): { out: string; note: string } {
  if (!which("ffmpeg")) {
    throw new Error("this video is over the AI-description size limit and needs ffmpeg to compress it — install it with: brew install ffmpeg");
  }
  const info = probeVideo(src); // ffprobe may be absent; we degrade gracefully below
  const origH = info?.height ?? 1080;
  const ladder = resolutionLadder(origH);

  // Walk the ladder. At the ORIGINAL resolution give two CRF attempts (28, then a very aggressive 34) so
  // we exhaust "keep the resolution, just compress harder" before dropping pixels. Lower rungs get one.
  for (let i = 0; i < ladder.length; i++) {
    const targetH = ladder[i];
    const crfs = i === 0 ? [28, 34] : [30];
    for (const crf of crfs) {
      const out = tmpPath(".mp4");
      const r = encodeCrf(src, out, origH, targetH, crf);
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
  const r = encodeTwoPass(src, out, origH, floorH, videoKbps);
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
function fitImageUnderLimit(src: string, limitBytes: number): { out: string; note: string } {
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
      const r = run(bin, [src, ...resize, "-strip", "-quality", String(q), out], 5 * 60 * 1000);
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
export function fitMediaUnderLimit(absPath: string, kind: "image" | "video", limitBytes = FIT_TARGET_BYTES): FitResult {
  const size = sizeOf(absPath);
  if (size >= 0 && size <= limitBytes) {
    return { path: absPath, compressed: false, cleanup: NOOP_CLEANUP, note: null };
  }
  const { out, note } = kind === "video"
    ? fitVideoUnderLimit(absPath, limitBytes)
    : fitImageUnderLimit(absPath, limitBytes);
  log.info("describe", `${absPath} (${(size / 1024 / 1024).toFixed(1)}MB) → ${note}`);
  return {
    path: out,
    compressed: true,
    cleanup: () => tryUnlink(out),
    note,
  };
}
