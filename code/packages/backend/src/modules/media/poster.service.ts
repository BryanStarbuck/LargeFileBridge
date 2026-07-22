// Small cached JPEG "posters" for media files (media_viewer.mdx §2.1; duplicates.mdx §4.3a).
//
// WHY THIS EXISTS. A review column that shows a whole duplicate group renders N previews AT ONCE. Doing
// that with N live <video src="/api/media/raw"> elements is not a heavy version of the right thing — it is
// the wrong thing: HTTP/1.1 caps a browser at ~6 connections per origin, and a media element HOLDS its
// connection open while it buffers. A 9-member group therefore starves itself — the first six players hog
// every socket, previews 7-9 never load, and the page's own /api calls (including the grants for those
// members) queue behind them forever. The symptom is "the previews just don't load", with no error
// anywhere, because nothing failed: the requests were never sent.
//
// A poster is one small JPEG that finishes in milliseconds and releases its socket. It also fixes the
// second class of failure for free: formats the browser cannot decode at all (HEIC/HEIF, TIFF, ProRes /
// HEVC video) still produce a picture, because WE decode them here.
//
// 100% local (charter): sharp for images, the bundled ffmpeg for video frames. No network, ever.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";
import { log } from "../../shared/logging.js";
import { hasFfmpeg } from "./transcode.service.js";

/** `<state root>/media/posters/` — Category-B computed state (artifact_placement_policy.mdx). */
function postersDir(): string {
  const dir = path.join(resolveStateDir(), "media", "posters");
  ensureDir(dir);
  return dir;
}

/** The widths a caller may ask for, so the cache can never be sprayed with arbitrary sizes. */
export const POSTER_WIDTHS = [320, 640, 960] as const;
export type PosterWidth = (typeof POSTER_WIDTHS)[number];

/** Snap any requested width to the nearest allowed bucket (defaults to 640). */
export function normalizePosterWidth(raw: unknown): PosterWidth {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 640;
  let best: PosterWidth = 640;
  for (const w of POSTER_WIDTHS) if (Math.abs(w - n) < Math.abs(best - n)) best = w;
  return best;
}

// Cache key = path + size + mtime + width. A re-encode or a replace changes size/mtime, so a stale poster
// can never outlive its file's content — and the same file at two widths keeps two entries.
function cacheFile(abs: string, size: number, mtimeMs: number, width: number): string {
  const key = crypto.createHash("sha1").update(`${abs}\n${size}\n${Math.round(mtimeMs)}\n${width}`).digest("hex");
  return path.join(postersDir(), `${key}.jpg`);
}

// ── A tiny FIFO semaphore ─────────────────────────────────────────────────────────
// One group can ask for a dozen posters in the same tick. Twelve concurrent ffmpeg decodes of 4K video
// would spike the machine for a thumbnail strip, so generation is capped; the CACHE is what makes the
// second visit instant, not parallelism.
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// In-flight de-dup: two members of a group can be the SAME bytes at the same path (a re-render, a
// re-selection), and two concurrent generations of one cache file would race on the rename.
const inflight = new Map<string, Promise<string>>();

const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv", ".ts", ".m2ts",
]);
const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif",
]);

export function posterKindFor(abs: string): "video" | "image" | null {
  const ext = path.extname(abs).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

/**
 * Produce (or reuse) a cached JPEG poster for `abs` at `width` px wide. Resolves to the cache file path.
 * Throws only when the file is not a poster-able kind or every decoder failed — the caller turns that into
 * an honest 415/500 rather than a silently blank preview.
 */
export async function ensurePoster(abs: string, width: PosterWidth): Promise<string> {
  const kind = posterKindFor(abs);
  if (!kind) throw new Error("not a previewable media file");
  const st = fs.statSync(abs);
  const out = cacheFile(abs, st.size, st.mtimeMs, width);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;

  const pending = inflight.get(out);
  if (pending) return pending;

  const job = withSlot(async () => {
    const tmp = `${out}.${process.pid}.${active}.tmp.jpg`;
    try {
      if (kind === "image") await renderImagePoster(abs, tmp, width);
      else await renderVideoPoster(abs, tmp, width);
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error("poster encoder produced no bytes");
      fs.renameSync(tmp, out);
      return out;
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      throw e;
    }
  }).finally(() => inflight.delete(out));

  inflight.set(out, job);
  return job;
}

/** Images go through sharp; HEIC/HEIF (and any build without a codec) fall back to ffmpeg, which decodes
 *  far more than a browser will. `rotate()` first so an EXIF-rotated phone photo is not shown sideways. */
async function renderImagePoster(abs: string, tmp: string, width: number): Promise<void> {
  try {
    await sharp(abs, { failOn: "none", animated: false })
      .rotate()
      .resize({ width, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toFile(tmp);
    return;
  } catch (e) {
    log.debug("media", `sharp poster failed for ${abs} (${(e as Error).message}) — trying ffmpeg`);
  }
  await ffmpegPoster(abs, tmp, width, null);
}

/** Videos: one frame, seeked a little way in so we don't show a black leader frame. A short clip has no
 *  frame at 1 s, so a failed seek retries from 0 rather than reporting "no preview". */
async function renderVideoPoster(abs: string, tmp: string, width: number): Promise<void> {
  try {
    await ffmpegPoster(abs, tmp, width, 1);
    if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) return;
  } catch {
    /* fall through to the from-the-start retry */
  }
  await ffmpegPoster(abs, tmp, width, 0);
}

/** `-ss` BEFORE `-i` is the fast input seek (keyframe-accurate, near-instant even on a 4 GB file). */
function ffmpegPoster(abs: string, tmp: string, width: number, seekS: number | null): Promise<void> {
  if (!hasFfmpeg()) return Promise.reject(new Error("ffmpeg not installed — cannot render this preview"));
  const args = [
    "-v", "error",
    ...(seekS != null ? ["-ss", String(seekS)] : []),
    "-i", abs,
    "-frames:v", "1",
    "-vf", `scale='min(${width},iw)':-2`,
    "-q:v", "4",
    "-f", "image2",
    "-y", tmp,
  ];
  return new Promise((resolve, reject) => {
    let err = "";
    let settled = false;
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 30_000);
    child.stderr?.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-1000);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.split("\n").slice(-2).join(" ").slice(0, 200)}`));
    });
  });
}
