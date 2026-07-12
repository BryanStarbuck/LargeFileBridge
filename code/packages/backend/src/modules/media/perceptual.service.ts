// Perceptual content fingerprint (perceptual_fingerprint.mdx). A transform-robust "perceptual hash" that
// recognizes when two media files are FUNDAMENTALLY THE SAME CONTENT even after they were resized to a
// lower resolution, re-compressed, re-encoded to a different codec, frame-rate changed, or format-converted
// (e.g. PNG->JPEG heavy-lossy). This complements — never replaces — the exact content hash (files.mdx):
// the exact hash proves BYTE identity; this fingerprint proves CONTENT identity across transforms.
//
// CHOICE (perceptual_fingerprint.mdx §3): images -> PDQ (256-bit) is the target; the future PDQ swap is a
// Rust/napi or WASM binding. This module ships the no-native-build FALLBACK now — blockhash-core at
// `bits:16` (256-bit = 64-hex, MIT, pure JS) with `sharp` decoding pixels — isolated behind this ONE module
// so the fallback->PDQ swap is a one-file change (the four exports below keep their signatures). Video ->
// vPDQ: sample frames with the SAME local ffmpeg the compress/transcode modules already shell out to, hash
// each frame with the image primitive, and keep a compact representative.
//
// HARD REQUIREMENT (§6, charter): NO network access of any kind. Everything here is pure local computation
// on decoded pixel/frame buffers plus a local ffmpeg process for frame extraction. This module opens no
// network connection of any kind — no client import, no remote fetch — enforced by the guard test
// perceptual.no-network.spec.ts.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { bmvbhash } from "blockhash-core";
import { PerceptualFingerprintSchema, type PerceptualFingerprint } from "@lfb/shared";
import { log } from "../../shared/logging.js";

// blockhash `bits:16` -> 16^2 = 256-bit hash = 64 hex chars (the per-file sidecar size target, §5).
const BLOCKHASH_BITS = 16;

// Matching thresholds over the 256-bit fingerprint (§4). Hamming <= 32/256 == "same content"; the stricter
// <= 24 is exposed for high-precision de-dup.
const IMAGE_THRESHOLD = 32;
const IMAGE_THRESHOLD_STRICT = 24;

// Quality gate (§4): flat/junk frames (a black video frame, a solid fill) produce untrustworthy hashes, so
// we drop them from AUTOMATIC matching. `quality` is a 0..100 luminance-spread proxy (PDQ ships a real
// quality score; this is the fallback's stand-in). A fingerprint whose quality is below this floor never
// auto-matches. A null quality (unknown) is NOT gated — absence of a score is not a low score.
const QUALITY_FLOOR = 8;

// Video sampling: ~1 fps, capped so a long clip stays a bounded, fast operation. The representative frame
// (highest quality among the samples) becomes the fingerprint value — more robust than a literal first
// frame, which is often black/blank.
const VIDEO_SAMPLE_FPS = 1;
const VIDEO_MAX_FRAMES = 16;

// ── image fingerprint (§3) ──────────────────────────────────────────────────────
/**
 * Compute the 256-bit perceptual fingerprint of an image buffer. Decodes with `sharp` (any format sharp
 * reads), then blockhash-core at bits:16. Returns { algo:"blockhash", value:<64-hex>, quality:0..100 }.
 * Pure local computation — no network.
 */
export async function fingerprintImage(buf: Buffer): Promise<PerceptualFingerprint> {
  // Decode to raw RGBA (4 channels) — blockhash-core indexes pixels as `(y*w + x) * 4` and treats a 0
  // alpha as white, so it REQUIRES an alpha channel. `failOn:"none"` keeps a slightly-corrupt image usable.
  const { data, info } = await sharp(buf, { failOn: "none" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const value = bmvbhash({ width: info.width, height: info.height, data }, BLOCKHASH_BITS);
  const quality = luminanceQuality(data, info.width, info.height);

  return PerceptualFingerprintSchema.parse({ algo: "blockhash", value, quality });
}

// A 0..100 "is this frame worth trusting" proxy: the standard deviation of luminance across a sub-sample of
// pixels, clamped to 0..100. A flat fill or a black frame -> ~0 (gated out); a normal photo -> tens. This
// stands in for PDQ's real quality score until the PDQ binding lands.
function luminanceQuality(rgba: Uint8Array | Buffer, width: number, height: number): number {
  const pixels = width * height;
  if (pixels <= 0) return 0;
  // Sample up to ~4096 pixels so quality stays O(1) regardless of resolution.
  const stride = Math.max(1, Math.floor(pixels / 4096));
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let p = 0; p < pixels; p += stride) {
    const i = p * 4;
    const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    sum += lum;
    sumSq += lum * lum;
    n++;
  }
  if (n === 0) return 0;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const std = Math.sqrt(variance);
  return Math.min(100, Math.round(std));
}

// ── video fingerprint (§3, vPDQ) ────────────────────────────────────────────────
/**
 * Compute a perceptual fingerprint for a video by sampling frames with the local ffmpeg (~1 fps, capped),
 * hashing each sampled frame with the image primitive, and keeping the highest-quality frame as the compact
 * representative. Returns { algo:"vpdq", value:<64-hex>, quality:0..100 }. The full per-frame list is out of
 * scope for v1 (see §5's `.vpdq` sidecar option); inline representative is acceptable now.
 *
 * The only external process is the SAME local ffmpeg the compress/transcode modules already invoke by name
 * on PATH — itself fully offline. No network connection is opened anywhere in this path.
 */
export async function fingerprintVideo(pathToVideo: string): Promise<PerceptualFingerprint> {
  if (!ffmpegOnPath()) {
    throw new Error("ffmpeg not installed — install it (brew install ffmpeg) to fingerprint video");
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-vpdq-"));
  try {
    // Sample frames to PNGs: fps filter reduces to VIDEO_SAMPLE_FPS, then cap the count. `-nostdin` +
    // `-loglevel error` keep it quiet and non-interactive; all paths are LOCAL — no URL inputs.
    const outPattern = path.join(workDir, "frame_%04d.png");
    const args = [
      "-nostdin",
      "-loglevel", "error",
      "-i", pathToVideo,
      "-vf", `fps=${VIDEO_SAMPLE_FPS}`,
      "-frames:v", String(VIDEO_MAX_FRAMES),
      "-y",
      outPattern,
    ];
    const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) {
      throw new Error(`ffmpeg frame sampling failed (code ${r.status}): ${(r.stderr ?? "").slice(-300)}`);
    }

    const frameFiles = fs
      .readdirSync(workDir)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .map((f) => path.join(workDir, f));
    if (frameFiles.length === 0) {
      throw new Error(`ffmpeg produced no frames for ${pathToVideo}`);
    }

    // Hash each sampled frame, then pick the highest-quality one as the representative fingerprint.
    let best: PerceptualFingerprint | null = null;
    for (const frame of frameFiles) {
      const fp = await fingerprintImage(fs.readFileSync(frame));
      if (best === null || (fp.quality ?? 0) > (best.quality ?? 0)) best = fp;
    }
    // best is non-null here (frameFiles is non-empty).
    const rep = best!;

    return PerceptualFingerprintSchema.parse({ algo: "vpdq", value: rep.value, quality: rep.quality });
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      log.debug("media", `perceptual: temp frame cleanup failed for ${workDir}: ${(e as Error).message}`);
    }
  }
}

// `which ffmpeg` — the exact detection the compress/transcode modules use; ffmpeg is invoked by name on
// PATH (no hardcoded path). Local process only.
function ffmpegOnPath(): boolean {
  try {
    return spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

// ── matching (§4) ────────────────────────────────────────────────────────────────
// Popcount of a nibble (0..15) — how many bits are set in one hex digit.
const NIBBLE_BITS: readonly number[] = Array.from({ length: 16 }, (_, i) => {
  let c = 0;
  for (let b = i; b; b >>= 1) c += b & 1;
  return c;
});

/**
 * Hamming distance over two hex fingerprints — the count of differing bits. Smaller = more similar;
 * identical content -> 0. If the two hashes differ in length (e.g. a 256-bit blockhash vs a 64-bit hash),
 * the overlapping nibbles are compared bit-for-bit and every unmatched trailing nibble counts as 4 differing
 * bits, so cross-length comparisons never silently look "close".
 */
export function hammingDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const min = Math.min(x.length, y.length);
  let dist = 0;
  for (let i = 0; i < min; i++) {
    const na = parseInt(x[i], 16);
    const nb = parseInt(y[i], 16);
    // A non-hex character contributes its full 4 bits as "different" — a malformed hash is never treated
    // as a match.
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      dist += 4;
      continue;
    }
    dist += NIBBLE_BITS[na ^ nb];
  }
  dist += Math.abs(x.length - y.length) * 4;
  return dist;
}

/**
 * Decide whether two fingerprints are "the same content" (§4). Requires the same algo (a blockhash and a
 * vpdq value are not comparable), applies the image Hamming threshold (<= 32/256; strict <= 24), and gates
 * on the quality score — a fingerprint whose quality is known and below the floor never auto-matches. A
 * match is a SIGNAL ONLY; LFB never auto-acts on it (§4, charter).
 */
export function sameContent(a: PerceptualFingerprint, b: PerceptualFingerprint, opts?: { strict?: boolean }): boolean {
  if (a.algo !== b.algo) return false;
  // Quality gate: a known-low-quality (flat/junk) fingerprint is excluded from automatic matching.
  if (a.quality != null && a.quality < QUALITY_FLOOR) return false;
  if (b.quality != null && b.quality < QUALITY_FLOOR) return false;
  const threshold = opts?.strict ? IMAGE_THRESHOLD_STRICT : IMAGE_THRESHOLD;
  return hammingDistance(a.value, b.value) <= threshold;
}
