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
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { bmvbhash } from "blockhash-core";
import { PerceptualFingerprintSchema, type PerceptualFingerprint } from "@lfb/shared";
import { log } from "../../shared/logging.js";

// ── libvips memory settings for a LONG-RUNNING process (memory.mdx — the 4 GB RSS incident) ───────────
// sharp's defaults are tuned for a short-lived CLI, not a daemon that must sit quietly on a laptop for
// weeks. Two of them cost us resident memory that `heapUsed` cannot see (it is native, outside V8):
//
//  * cache(false) — libvips keeps an operation/file cache (50 MB + 20 open files by default). We hash each
//    file ONCE and never touch it again, so the cache has a 0% hit rate here: it is pure retained bytes.
//  * concurrency(1) — libvips runs a thread pool PER PIPELINE sized to the core count, and each worker
//    carries its own tile buffers and malloc arena (which macOS does not hand back). We already fan out at
//    the JOB level (the queue's core budget), so per-pipeline threading only multiplies arenas by cores
//    for work that is, after the 512px shrink-on-load, a few hundred microseconds of pixels.
//
// Measured over 40 real images × 25 passes at 16-wide concurrency: RSS plateaus at 389 MB with the
// defaults and 281 MB with these two lines — ~110 MB of permanently resident native memory removed, with
// no measurable change in throughput (the decode is bounded to ~1 MB of pixels either way) and NO change
// to any hash value: neither setting touches the pixels, only how libvips schedules and retains them.
sharp.cache(false);
sharp.concurrency(1);

// blockhash `bits:16` -> 16^2 = 256-bit hash = 64 hex chars (the per-file sidecar size target, §5).
const BLOCKHASH_BITS = 16;

// Matching thresholds over the 256-bit fingerprint (§4). Hamming <= 32/256 == "same content"; the stricter
// <= 24 is exposed for high-precision de-dup.
const IMAGE_THRESHOLD = 32;
/** Exported so the de-dup engine's LSH banding can prove it has no false negatives (duplicates.mdx §8.7). */
export const IMAGE_THRESHOLD_STRICT = 24;

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

// ── the decode memory gate (to_fix.mdx §3.3) ────────────────────────────────────
// THE BUG THIS FIXES: this module used to decode every image at FULL RESOLUTION to raw RGBA —
// `width × height × 4` bytes — co-resident with a `readFileSync` of the whole source file. A 24 MP photo
// (6000×4000) is ~96 MB of raw RGBA + ~8 MB of source ≈ 105 MB live, PER FILE, with no size cap, on the
// `compress:image` bucket that fans out to the full core budget (~12–24 wide) ≈ ~1.2 GB live. That is the
// single largest un-gated memory consumer in the backend (to_fix.mdx §3.2), and it is charged twice per
// file (compressFile fingerprints before AND after — §3.1).
//
// ⚠️ READ THIS BEFORE "FIXING" THE DOWNSCALE BELOW ⚠️ (to_fix.mdx §3.4)
// compression.mdx states the invariant "we never downscale". That invariant governs the COMPRESSED OUTPUT
// FILE — a user's file must never lose resolution, and nothing here writes a user file. The downscale in
// `decodeForHash()` is INTERNAL to the fingerprint's own decode: it produces a throwaway pixel buffer that
// is hashed and freed, touches no output, and is invisible to the user. THESE DO NOT CONFLICT. A future
// reader will mistake this for a violation of that invariant and "fix" it back into the memory bomb
// described above — do not. See to_fix.mdx §3.4 and perceptual_fingerprint.mdx.
//
// WHY IT IS ALSO CORRECT, not just cheap: blockhash reduces the image to a 16×16 grid of block medians
// (BLOCKHASH_BITS) — i.e. it normalizes to ~256 samples internally. Every pixel beyond that grid's
// resolution is averaged away by the algorithm itself, so decoding 24 MP to hash 256 blocks is pure waste.
// Pre-shrinking to 512px is the SAME averaging done earlier and ~96× cheaper. This is exactly why the
// fingerprint survives a resize at all (perceptual_fingerprint.mdx §3): resize-invariance is the property
// the algorithm is built on, and it is what makes this optimization hash-stable.
const HASH_DECODE_MAX_EDGE = 512;

// Pixel-count ceiling (to_fix.mdx §3.3.3). `resize()` lets sharp/libvips shrink-on-load for JPEG/WebP, so
// those never materialize full-res — but a PNG/TIFF is decoded whole by libvips before the resize, so the
// resize alone does NOT bound them. A 100 MP TIFF must never decode: 100e6 × 4 = ~400 MB in one buffer.
// Above this ceiling we refuse and return no fingerprint (the caller logs and continues — a missing
// fingerprint is a lost signal, an OOM is a lost batch). 64 MP (8000×8000) sits far above any real photo.
const MAX_DECODE_PIXELS = 64_000_000;

// ── image fingerprint (§3) ──────────────────────────────────────────────────────
/**
 * Compute the 256-bit perceptual fingerprint of an image. Accepts a PATH (preferred — sharp reads it
 * incrementally and never materializes the file in the heap) or a Buffer (kept for callers that already
 * hold bytes, e.g. the tests). Decodes with `sharp` (any format sharp reads) at a bounded size, then
 * blockhash-core at bits:16. Returns { algo:"blockhash", value:<64-hex>, quality:0..100 }.
 * Pure local computation — no network.
 *
 * Memory: bounded at ~1 MB of pixels regardless of the source's resolution (to_fix.mdx §3.3.1–3.3.3),
 * down from an uncapped ~105 MB. Throws for an image beyond MAX_DECODE_PIXELS rather than decode it.
 */
export async function fingerprintImage(src: Buffer | string): Promise<PerceptualFingerprint> {
  // Scoped so the raw pixel buffer is unreachable the moment we have the two numbers we want (§3.3.6).
  // `luminanceQuality` reads the SAME downscaled buffer (~1 MB), so nothing large outlives this call —
  // the old code kept a ~96 MB `data` alive across both the hash and the quality pass, rooting it twice.
  const { value, quality } = await decodeForHash(src);
  return PerceptualFingerprintSchema.parse({ algo: "blockhash", value, quality });
}

/** Decode → hash → quality, all inside one scope so the pixel buffer dies here and never escapes. */
async function decodeForHash(src: Buffer | string): Promise<{ value: string; quality: number }> {
  // A header-only read (no pixels decoded) — this is what makes the ceiling cheap to enforce.
  const meta = await sharp(src, { failOn: "none", limitInputPixels: MAX_DECODE_PIXELS }).metadata();
  const pixels = (meta.width ?? 0) * (meta.height ?? 0);
  if (pixels > MAX_DECODE_PIXELS) {
    throw new Error(
      `image is ${(pixels / 1e6).toFixed(0)}MP — beyond the ${(MAX_DECODE_PIXELS / 1e6).toFixed(0)}MP ` +
        `fingerprint decode ceiling; skipping its perceptual fingerprint rather than decoding it`,
    );
  }

  // Decode to raw RGBA (4 channels) — blockhash-core indexes pixels as `(y*w + x) * 4` and treats a 0
  // alpha as white, so it REQUIRES an alpha channel. `failOn:"none"` keeps a slightly-corrupt image usable.
  // `withoutEnlargement` means an image already under 512px is decoded EXACTLY as before — so every small
  // image's stored fingerprint is bit-identical across this change; only oversize decodes are bounded.
  // `fit:"inside"` preserves the aspect ratio, which blockhash's block geometry depends on.
  const { data, info } = await sharp(src, { failOn: "none", limitInputPixels: MAX_DECODE_PIXELS })
    .resize(HASH_DECODE_MAX_EDGE, HASH_DECODE_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const value = bmvbhash({ width: info.width, height: info.height, data }, BLOCKHASH_BITS);
  const quality = luminanceQuality(data, info.width, info.height);
  return { value, quality };
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
    const r = await runAsync("ffmpeg", args, 5 * 60 * 1000);
    if (r.code !== 0) {
      throw new Error(`ffmpeg frame sampling failed (code ${r.code}): ${(r.err || "").slice(-300)}`);
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
    // Each frame is handed to fingerprintImage BY PATH (to_fix.mdx §3.3.1–3.3.2): the old code read the
    // whole full-res PNG into a Buffer and then decoded it at full resolution — up to VIDEO_MAX_FRAMES (16)
    // times per video, each a fresh ~96 MB raw RGBA for a 4K frame. By path + the bounded decode above,
    // each frame now costs ~1 MB and the source PNG never enters the heap at all.
    let best: PerceptualFingerprint | null = null;
    for (const frame of frameFiles) {
      const fp = await fingerprintImage(frame);
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
// PATH (no hardcoded path). Local process only. This one STAYS synchronous, deliberately: it is a
// near-instant detection probe (a few ms), the same precedent fit-media.ts `which()` sets. Only the HEAVY
// call — the ffmpeg frame sampling below — must be async (to_fix.mdx §3.3.4).
function ffmpegOnPath(): boolean {
  try {
    return spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

// The heavy process runner — ASYNC (child_process.spawn). This REPLACES a `spawnSync("ffmpeg", …)` with a
// 5-MINUTE timeout, which was a T3 charter violation on a queue path (to_fix.mdx §3.2/§3.3.4,
// performance.mdx P-27, job_queue.mdx §3): it could freeze the Node event loop for the full five minutes
// while sampling frames from a large video — the web app unresponsive, GET /api/progress unanswered, the
// Processing page unable to load. NEVER reintroduce spawnSync on this path (acceptance criterion G-6:
// `grep -rn "spawnSync" perceptual.service.ts` must find only the `which` probe above).
//
// This mirrors the runner fit-media.ts already proved (memory.mdx P-30): stdout capture is OPT-IN and
// bounded at STDOUT_CAP_BYTES, accumulated into a chunk ARRAY joined once at settle (never
// `out = (out + chunk).slice(-cap)`, which transiently allocates ~2× the accumulation on EVERY chunk —
// quadratic for a chatty ffmpeg); stderr is tail-sliced at 4096; the timeout hard-kills. No caller here
// reads stdout — the frames are written to files, not piped — so capture stays off and the child is handed
// /dev/null, allocating nothing and leaving no pipe that could fill and stall it.
const STDOUT_CAP_BYTES = 1024 * 1024;

function runAsync(
  bin: string,
  args: string[],
  timeoutMs = 5 * 60 * 1000,
  opts: { captureStdout?: boolean } = {},
): Promise<{ code: number | null; err: string; out: string }> {
  return new Promise((resolve) => {
    const captureStdout = opts.captureStdout === true;
    const chunks: string[] = [];
    let captured = 0;
    let err = "";
    let settled = false;
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"] });
    } catch (e) {
      resolve({ code: null, err: (e as Error).message, out: "" });
      return;
    }
    // Joined once, at settle — never in the data handler (that concat is the quadratic part of P-30).
    const finishOut = (): string => (captureStdout ? chunks.join("") : "");
    const timer = setTimeout(() => {
      if (!settled) child!.kill("SIGKILL");
    }, timeoutMs);
    // Null when capture is off (stdio "ignore") — the optional chain is what makes that a no-op.
    child.stdout?.on("data", (d) => {
      if (captured >= STDOUT_CAP_BYTES) return; // past the cap we drop, we do not grow
      const s = d.toString();
      chunks.push(s);
      captured += s.length;
    });
    child.stderr?.on("data", (d) => {
      err = (err + d.toString()).slice(-4096); // keep only the tail — a long ffmpeg log can be huge
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, err: e.message, out: finishOut() });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, err, out: finishOut() });
    });
  });
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
