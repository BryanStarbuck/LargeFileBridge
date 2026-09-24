// Compute (or recall) ONE file's perceptual fingerprint (perceptual_fingerprint.mdx §FD, apis.mdx §5).
//
//   image → sharp decodes to RGB at ≤512 px (the §3.3 memory gate) → PDQ in the Go sidecar
//   video → the Go sidecar samples frames with ffmpeg (keyframes first) → PDQ per frame
//
// A still-valid stored value (same size + mtime + engine version) is returned without touching the media.
// Every failure becomes a typed FingerprintResult (ok:false, code, error) — this function never throws —
// and every failure is logged: user-file problems (corrupt media, unreadable file) as WARN, engine and
// internal problems as ERROR via logError. Both land in error.err.
//
// NO NETWORK: sharp on local bytes, a local ffmpeg, a local sidecar over pipes (fingerprints.no-network.spec.ts).
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  mediaKindForName,
  type Fingerprint,
  type FingerprintErrorCode,
  type FingerprintKind,
  type FingerprintResult,
} from "@lfb/shared";
import sharp from "../../shared/sharp-runtime.js";
import { sniffMediaKind } from "../../shared/media-sniff.js";
import { log, logError } from "../../shared/logging.js";
import { PdqUnavailableError, pdqBinaryPath, pdqFromRgb, pdqFromVideo } from "./pdq-sidecar.js";
import { getStored, isValid, putStored } from "./fingerprint.store.js";

const FILE = "fingerprint.service.ts";

/** Refuse to decode an image beyond this (to_fix.mdx §3.3.3): a PNG/TIFF is decoded whole before resizing. */
const MAX_DECODE_PIXELS = 64_000_000;

/** Video sampling knobs. Part of the version string: change one and every stored video row goes stale. */
export const VIDEO_INTERVAL_S = 1;
export const VIDEO_MAX_FRAMES = 3600;
export const VIDEO_TIMEOUT_S = 900;

// ── concurrency (shared by every caller: API, jobs, MCP, web app) ────────────────
// Images: sharp is pinned to one libvips thread per pipeline (sharp-runtime.ts), so parallelism comes from
// here. Videos: each one runs ffmpeg (multi-threaded) plus a hash pool in the sidecar, so a few at a time
// saturate the machine; more only thrashes the disk.
const CORES = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
export const IMAGE_CONCURRENCY = Math.max(2, Math.min(12, Math.floor(CORES / 2)));
export const VIDEO_CONCURRENCY = Math.max(1, Math.min(3, Math.floor(CORES / 8)));

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
const imageGate = new Semaphore(IMAGE_CONCURRENCY);
const inFlight = new Map<string, Promise<Computed>>();
const videoGate = new Semaphore(VIDEO_CONCURRENCY);

// ── engine version ─────────────────────────────────────────────────────────────
let engineVersion: Promise<string> | null = null;

/** `lfb-pdq --version`, read once. A missing binary yields "unknown" (the compute then reports why). */
export function pdqEngineVersion(): Promise<string> {
  if (!engineVersion) {
    engineVersion = new Promise<string>((resolve) => {
      let out = "";
      try {
        const p = spawn(pdqBinaryPath(), ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        p.stdout.on("data", (d: Buffer) => (out += d.toString()));
        p.on("error", () => resolve("unknown"));
        p.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : "unknown"));
      } catch {
        resolve("unknown");
      }
    }).then((v) => {
      if (v === "unknown") engineVersion = null; // re-read after `just build-pdq`, not stuck forever
      return v;
    });
  }
  return engineVersion;
}

/** The algo_version stored beside a value. The bulk scan's Go decoder uses the SAME image tag: measured
 *  within a few bits of sharp's (perceptual_fingerprint.mdx §FD.8); its `strategy` says "go-area". */
export function versionFor(kind: FingerprintKind, engine: string): string {
  return kind === "image"
    ? `${engine} image:fill${HASH_EDGE}+alpha2`
    : `${engine} video:interval=${VIDEO_INTERVAL_S},max=${VIDEO_MAX_FRAMES}`;
}

// ── helpers ─────────────────────────────────────────────────────────────────────
export function expandPath(p: string): string {
  const t = p.trim();
  if (t === "~") return os.homedir();
  if (t.startsWith("~/")) return path.join(os.homedir(), t.slice(2));
  return path.resolve(t);
}

/** Image or video, from the name — corrected by the file's first bytes (media-sniff.ts). */
export function kindOf(abs: string): FingerprintKind | null {
  const byName = mediaKindForName(path.basename(abs));
  const sniffed = sniffMediaKind(abs);
  if (sniffed === "image" || sniffed === "video") return sniffed;
  if (sniffed === "audio" || sniffed === "pdf") return null;
  return byName === "image" || byName === "video" ? byName : null;
}

function fail(p: string, code: FingerprintErrorCode, error: string): FingerprintResult {
  return { path: p, ok: false, code, error };
}

function classify(e: unknown): { code: FingerprintErrorCode; engineFault: boolean } {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof PdqUnavailableError) return { code: "pdq_unavailable", engineFault: true };
  if (/ffmpeg not installed/i.test(msg)) return { code: "ffmpeg_missing", engineFault: true };
  if (/did not answer within|timed out|timeout/i.test(msg)) return { code: "timeout", engineFault: true };
  if (/PDQ engine (exited|failed|write)/i.test(msg)) return { code: "internal", engineFault: true };
  if (/fingerprint decode ceiling|MP —/.test(msg)) return { code: "too_large", engineFault: false };
  return { code: "decode_failed", engineFault: false };
}

// ── image path ─────────────────────────────────────────────────────────────────
// WHAT WE HAND PDQ, AND WHY (measured 2026-09-24 on 60 camera photos + 30 screenshots × 7 transforms,
// perceptual_fingerprint.mdx §FD.1):
//   * a 128×128 "fill" resample (aspect squashed — PDQ squashes to 64×64 itself). Against the old ≤512 px
//     "inside" decode it matched as well or better on every transform, is ~20% faster, and sends 48 KB to
//     the sidecar instead of ~545 KB per image. It is also the SAME frame size the video path pipes, so an
//     image and a frame of a video that shows it are hashed from comparable inputs.
//   * TWO hashes for a transparent image. A PNG with ≥0.5% transparent pixels (macOS window screenshots —
//     their shadow — logos, stickers) has no single "true" appearance: one tool flattens it onto white, the
//     next onto black. Measured on 5 such screenshots: a white-only hash missed EVERY black-flattened JPEG copy
//     (median 64 bits apart), a black-only hash missed every white one, and mid-gray missed 3 of 5. Hashing
//     both and matching on the nearer one brought both cases to median 2–4, max 10. `value` is the white
//     hash (what a viewer shows); `value_alt` the black one.
const HASH_EDGE = 128;
/** Share of pixels that must be see-through before an image gets its second (black-background) hash. */
const ALPHA_ALT_MIN_FRACTION = 0.005;

interface DecodedImage {
  white: Buffer; // RGB, flattened on white
  black: Buffer | null; // RGB, flattened on black — only when the image is meaningfully transparent
  w: number;
  h: number;
}

async function decodeRgb(abs: string): Promise<DecodedImage> {
  let rgba: Buffer;
  try {
    const meta = await sharp(abs, { failOn: "none", limitInputPixels: MAX_DECODE_PIXELS }).metadata();
    const px = (meta.width ?? 0) * (meta.height ?? 0);
    if (px > MAX_DECODE_PIXELS) {
      throw new Error(
        `image is ${(px / 1e6).toFixed(0)}MP — beyond the ${(MAX_DECODE_PIXELS / 1e6).toFixed(0)}MP fingerprint decode ceiling`,
      );
    }
    // rotate(): honor EXIF orientation, so a phone photo and its exported (auto-rotated) copy match.
    const { data, info } = await sharp(abs, { failOn: "none", limitInputPixels: MAX_DECODE_PIXELS, animated: false })
      .rotate()
      .resize(HASH_EDGE, HASH_EDGE, { fit: "fill" })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4 || info.width !== HASH_EDGE || info.height !== HASH_EDGE) {
      throw new Error(`unexpected decode shape ${info.width}x${info.height}x${info.channels}`);
    }
    rgba = data;
  } catch (e) {
    if (/decode ceiling/.test((e as Error).message)) throw e;
    log.debug("fingerprints", `sharp could not decode ${abs} (${(e as Error).message}) — trying ffmpeg`);
    const rgb = await ffmpegDecodeRgb(abs);
    return { white: rgb, black: null, w: HASH_EDGE, h: HASH_EDGE };
  }
  return flattenBoth(rgba, HASH_EDGE, HASH_EDGE);
}

/** Composite RGBA over white (always) and over black (only if enough of it is see-through). */
export function flattenBoth(rgba: Buffer, w: number, h: number): DecodedImage {
  const n = w * h;
  let seeThrough = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) seeThrough++;
  const white = Buffer.allocUnsafe(n * 3);
  const black = seeThrough / n >= ALPHA_ALT_MIN_FRACTION ? Buffer.allocUnsafe(n * 3) : null;
  for (let p = 0, i = 0, o = 0; p < n; p++, i += 4, o += 3) {
    const a = rgba[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const v = rgba[i + c] * a;
      white[o + c] = Math.round(v + 255 * (1 - a));
      if (black) black[o + c] = Math.round(v);
    }
  }
  return { white, black, w, h };
}

/** ffmpeg decodes what sharp cannot (HEIC on a build without the codec, exotic TIFF/RAW). Same 128×128 fill. */
function ffmpegDecodeRgb(abs: string): Promise<Buffer> {
  const edge = HASH_EDGE;
  const want = edge * edge * 3;
  return new Promise((resolve, reject) => {
    const args = [
      "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
      "-i", `file:${abs}`, "-frames:v", "1",
      "-vf", `scale=${edge}:${edge}:flags=area,format=rgb24`,
      "-f", "rawvideo", "pipe:1",
    ];
    let child;
    try {
      child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(`ffmpeg not installed — cannot decode this image (${(e as Error).message})`));
      return;
    }
    const chunks: Buffer[] = [];
    let got = 0;
    let err = "";
    const timer = setTimeout(() => child!.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (d: Buffer) => {
      if (got < want) {
        chunks.push(d);
        got += d.length;
      }
    });
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-600)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(/ENOENT/.test(e.message) ? "ffmpeg not installed — cannot decode this image" : e.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks).subarray(0, want);
      if (buf.length === want) resolve(buf);
      else reject(new Error(`could not decode image (ffmpeg code ${code}: ${err.trim().slice(-300) || "no frame"})`));
    });
  });
}

type Computed = Pick<Fingerprint, "value" | "value_alt" | "quality" | "frame_count" | "duration_s" | "strategy" | "frames">;

async function computeImage(abs: string): Promise<Computed> {
  const img = await decodeRgb(abs);
  const [white, black] = await Promise.all([
    pdqFromRgb(img.white, img.w, img.h),
    img.black ? pdqFromRgb(img.black, img.w, img.h) : Promise.resolve(null),
  ]);
  return {
    value: white.hash,
    // Only worth storing when it differs — an image whose see-through pixels are all near-invisible hashes
    // the same on both backgrounds, and a duplicate value would only add noise to matching.
    value_alt: black && black.hash !== white.hash ? black.hash : null,
    quality: white.quality,
    frame_count: null,
    duration_s: null,
    strategy: null,
    frames: undefined,
  };
}

async function computeVideo(abs: string): Promise<Computed> {
  const r = await pdqFromVideo(abs, { intervalS: VIDEO_INTERVAL_S, maxFrames: VIDEO_MAX_FRAMES, timeoutS: VIDEO_TIMEOUT_S });
  if (r.frames.length === 0) throw new Error("no frame could be decoded from this video");
  if (r.tried.length > 0) log.debug("fingerprints", `video plans abandoned for ${abs}: ${r.tried.join("; ")}`);
  // The representative value is the highest-quality frame — more telling than a black leader frame.
  let best = r.frames[0];
  for (const f of r.frames) if (f.q > best.q) best = f;
  const last = r.frames[r.frames.length - 1];
  return {
    value: best.h,
    value_alt: null,
    quality: best.q,
    frame_count: r.frames.length,
    duration_s: r.duration ?? (last ? last.ts : null),
    strategy: r.strategy,
    frames: r.frames,
  };
}

// ── the one public entry point ─────────────────────────────────────────────────
export interface FingerprintOptions {
  force?: boolean;
  includeFrames?: boolean;
  signal?: AbortSignal;
}

/**
 * The fingerprint of one file: a still-valid stored value, or a fresh computation (then stored).
 * Never throws — failures come back as `{ ok: false, code, error }`.
 */
export async function fingerprintPath(input: string, opts: FingerprintOptions = {}): Promise<FingerprintResult> {
  let abs = input;
  try {
    abs = expandPath(input);
    if (opts.signal?.aborted) return fail(abs, "cancelled", "cancelled");

    let st;
    try {
      st = await fsp.stat(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return fail(abs, code === "ENOENT" ? "not_found" : "decode_failed", code === "ENOENT" ? "file not found" : (e as Error).message);
    }
    if (!st.isFile()) return fail(abs, "not_a_file", "not a regular file");
    const kind = kindOf(abs);
    if (!kind) return fail(abs, "not_media", "not an image or video file");

    const engine = await pdqEngineVersion();
    const version = versionFor(kind, engine);

    if (!opts.force) {
      const stored = await getStored(abs, opts.includeFrames === true);
      if (stored && isValid(stored.fp, st.size, st.mtimeMs, version)) {
        return { path: abs, ok: true, fingerprint: shape(stored.fp, opts.includeFrames), source: stored.tier, stored: stored.tier === "postgres" ? true : undefined };
      }
    }

    // Single-flight: a directory job and an MCP call (or two overlapping jobs) asking for the same unchanged
    // file share ONE computation instead of decoding it twice. Keyed by path + the stat we just took, so a
    // file that changed in between is never answered with the older bytes' result.
    const flightKey = `${abs}\u0000${st.size}\u0000${st.mtimeMs}\u0000${kind}`;
    const gate = kind === "video" ? videoGate : imageGate;
    const t0 = performance.now();
    let flight = inFlight.get(flightKey);
    if (!flight) {
      flight = gate.run(async () => (kind === "video" ? computeVideo(abs) : computeImage(abs)));
      inFlight.set(flightKey, flight);
      void flight.then(
        () => inFlight.delete(flightKey),
        () => inFlight.delete(flightKey),
      );
    }
    if (opts.signal?.aborted) return fail(abs, "cancelled", "cancelled");
    const computed = await flight;
    const computeMs = Math.round((performance.now() - t0) * 10) / 10;

    const fp: Fingerprint = {
      path: abs,
      kind,
      algo: kind === "video" ? "pdq-frames" : "pdq",
      // A binary built during this very call (first use) reported "unknown" above — re-read it.
      algo_version: engine === "unknown" ? versionFor(kind, await pdqEngineVersion()) : version,
      size_bytes: st.size,
      mtime_ms: st.mtimeMs,
      ...computed,
      compute_ms: computeMs,
      computed_at: new Date().toISOString(),
    };

    // The file may have changed WHILE we read it. Storing that value under the new (size, mtime) would claim
    // a fingerprint for bytes we never saw, so re-stat and refuse to persist a torn read.
    let stable = true;
    try {
      const after = await fsp.stat(abs);
      stable = after.size === st.size && after.mtimeMs === st.mtimeMs;
    } catch {
      stable = false;
    }
    let stored = false;
    if (stable) stored = await putStored(fp);
    else log.warn("fingerprints", `${abs} changed while it was being fingerprinted — result returned, not stored`);

    return { path: abs, ok: true, fingerprint: shape(fp, opts.includeFrames), source: "computed", stored };
  } catch (e) {
    const { code, engineFault } = classify(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (engineFault) {
      logError({ file: FILE, operation: "fingerprintPath", error: e, data: { path: abs, code } });
    } else {
      log.warn("fingerprints", `could not fingerprint ${abs} (${code}): ${msg}`);
    }
    return fail(abs, code, msg);
  }
}

/** Frames are large; they travel only when the caller asked for them. */
export function shapeFingerprint(fp: Fingerprint, includeFrames?: boolean): Fingerprint {
  return shape(fp, includeFrames);
}

function shape(fp: Fingerprint, includeFrames?: boolean): Fingerprint {
  if (includeFrames || !fp.frames) return fp;
  const { frames: _drop, ...rest } = fp;
  return rest;
}
