// The compression engine (compression.mdx). Drives quality-controllable brew tools (ffmpeg / ImageMagick
// / oxipng / cwebp / mozjpeg) to shrink IMAGE and VIDEO files at MEDIUM quality (prefer lossless), with
// two hard invariants: keep the same aspect ratio + pixel resolution (never downscale — §5), and run the
// alpha-channel safety check first (§6). Runs to a temp file, verifies, then does a recoverable replace
// (original → LFBridge trash). Audio is out of scope for now. Explicit-user-action only (charter §6.1).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  CompressionSettings,
  CompressMediaPrefs,
  CompressMedia,
  CompressTools,
  CompressCheck,
  CompressResult,
  DeleteOriginalMode,
  CompressInsideRequest,
  CompressInsidePlan,
  PerceptualFingerprint,
} from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { expandHome, compressInfo } from "../fs/badges.js";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";
import { findStorageRootForPath } from "../storage/storage.service.js";
import { writeCompressionRecord } from "../storage/analysis.service.js";
import { fingerprintImage, fingerprintVideo } from "../media/perceptual.service.js";
import { appendFileEvent, type SidecarSeed, type FileEventInput } from "../storage/file-sidecar.service.js";
import { appendHistory } from "../storage/history-log.service.js";
import { restampOnTransform } from "../storage/decisions.service.js";
import { repoIdFromPath, folderForRepoId } from "../store-model/units.service.js";
import { HARD_SKIP, isMacPackageDir } from "../../shared/scan-filters.js";
import { collectFilesRecursive } from "../../shared/fs-walk.js";
import { enqueue, createBatch } from "../jobqueue/jobqueue.service.js";
import { writeManifest, trackBatch } from "../jobqueue/batch-manifest.service.js";
import { log } from "../../shared/logging.js";

// ── settings (compression.mdx §7) ─────────────────────────────────────────────
export function getCompressionSettings(): CompressionSettings {
  const c = getAppConfig().compression;
  const map = (m: { enabled: boolean; quality: CompressMediaPrefs["quality"]; prefer: string[]; deny: string[]; convert_types: boolean; skip_exts: string[] }): CompressMediaPrefs => ({
    enabled: m.enabled,
    quality: m.quality,
    prefer: m.prefer,
    deny: m.deny,
    convertTypes: m.convert_types,
    skipExts: m.skip_exts.map(normExt),
  });
  return {
    images: map(c.images),
    video: map(c.video),
    audio: map(c.audio),
    preserveResolution: c.preserve_resolution,
    replaceOriginalToTrash: c.replace_original_to_trash,
  };
}

export async function setCompressionSettings(patch: Partial<CompressionSettings>): Promise<CompressionSettings> {
  await updateAppConfig((cfg) => {
    const applyMedia = (dst: { enabled: boolean; quality: string; prefer: string[]; deny: string[]; convert_types: boolean; skip_exts: string[] }, src?: Partial<CompressMediaPrefs>) => {
      if (!src) return;
      if (src.enabled !== undefined) dst.enabled = src.enabled;
      if (src.quality !== undefined) dst.quality = src.quality;
      if (src.prefer !== undefined) dst.prefer = src.prefer;
      if (src.deny !== undefined) dst.deny = src.deny;
      if (src.convertTypes !== undefined) dst.convert_types = src.convertTypes;
      if (src.skipExts !== undefined) dst.skip_exts = src.skipExts.map(normExt);
    };
    applyMedia(cfg.compression.images, patch.images);
    applyMedia(cfg.compression.video, patch.video);
    applyMedia(cfg.compression.audio, patch.audio);
    if (patch.preserveResolution !== undefined) cfg.compression.preserve_resolution = patch.preserveResolution;
    if (patch.replaceOriginalToTrash !== undefined) cfg.compression.replace_original_to_trash = patch.replaceOriginalToTrash;
    return cfg;
  });
  return getCompressionSettings();
}

// Apple photos & other HEVC/AV1-coded still formats. These are BYTE-efficient already, but we offer a
// COMPATIBILITY conversion → JPEG (images.mdx §4). They need a libheif reader (delegate or heif-dec) and
// their conversion is exempt from the size-gain guard (may grow the file). srcExt is lowercase w/ dot.
const HEIC_FAMILY_EXT = new Set([".heic", ".heif", ".avif"]);

/** Normalize a user-typed extension to lowercase with a single leading dot ("HEIC" / ".Heic" → ".heic"). */
function normExt(e: string): string {
  const t = e.trim().toLowerCase();
  if (!t) return "";
  return t.startsWith(".") ? t : "." + t;
}

// ── tool detection (compression.mdx §2) ────────────────────────────────────────
// Memoized per binary, for the life of the process. detectTools() and magickBin() are called PER FILE, so
// an un-cached `which` forked ~8 children for every file in a batch and blocked the event loop each time
// (to_fix.mdx §3.3.4 / T3). A tool does not appear or vanish mid-process, so the first answer is the only
// answer we need — one fork per tool, ever. Kept synchronous on purpose: the callers below are sync, and a
// single cached probe at first use is not the defect; the per-file repetition was.
const _onPath = new Map<string, boolean>();
function onPath(bin: string): boolean {
  const hit = _onPath.get(bin);
  if (hit !== undefined) return hit;
  let found = false;
  try {
    found = spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  } catch {
    found = false;
  }
  _onPath.set(bin, found);
  return found;
}

// Does ImageMagick (or a standalone libheif converter) know how to READ HEIC/HEIF? On macOS,
// `brew install imagemagick` bundles the libheif delegate; if it's missing we surface an "install libheif"
// message instead of silently failing on an Apple photo (images.mdx §4.1). Memoized — the `-list format`
// probe is comparatively heavy and detectTools() runs per compress.
// Memoized on the PROMISE, not the value: detectTools() is called per file and the describe/compress queue
// fans many jobs out at once, so caching only the settled boolean would let N concurrent first-callers each
// fork their own `-list format` probe. One probe, ever — every later caller awaits the same promise.
let _heifSupport: Promise<boolean> | null = null;
function magickSupportsHeif(): Promise<boolean> {
  if (_heifSupport !== null) return _heifSupport;
  _heifSupport = (async (): Promise<boolean> => {
    if (onPath("heif-dec") || onPath("heif-convert")) return true;
    if (!(onPath("magick") || onPath("convert"))) return false;
    try {
      const r = await run(magickBin(), ["-list", "format"], 15000);
      return /\bheic\b|\bheif\b/i.test(r.out);
    } catch {
      return false;
    }
  })();
  return _heifSupport;
}

export async function detectTools(): Promise<CompressTools> {
  return {
    ffmpeg: onPath("ffmpeg"),
    ffprobe: onPath("ffprobe"),
    magick: onPath("magick") || onPath("convert"),
    oxipng: onPath("oxipng"),
    cwebp: onPath("cwebp"),
    cjpeg: onPath("cjpeg"),
    jpegoptim: onPath("jpegoptim"),
    heif: await magickSupportsHeif(),
  };
}
function magickBin(): string {
  return onPath("magick") ? "magick" : "convert";
}

// ── the one process runner (to_fix.mdx §3.3.4 / T3) ────────────────────────────
// EVERY child this module forks — the multi-minute ffmpeg/oxipng/cwebp transcode AND the short
// ffprobe/`magick identify` probes — runs through here, ASYNC (child_process.spawn). Nothing in this file
// may block the Node event loop. The probes used to be `spawnSync` "because they only take tens of ms" —
// but a spawnSync's timeout is a CEILING, not a promise: an ffprobe against a huge file on a cold cloud
// mount (Dropbox/Google Drive) stalls on I/O, and the whole app — every request, the progress poll, the
// queue — froze behind it for up to the full 10 minutes. That is the same freeze that made the Processing
// page fail to load during a mass AI-description run (ai_description.mdx §3.3.1, job_queue.mdx §3,
// performance.mdx P-27). Mirrors describe/fit-media.ts runAsync() and media/perceptual.service.ts.
//
// STDOUT CAPTURE IS OPT-IN, and that is a memory decision (memory.mdx P-30): the transcode caller throws
// stdout away, so it hands the child /dev/null and allocates nothing; only the probes (whose answer IS
// stdout — an ffprobe line is bytes, `-list format` is kilobytes) ask for it, capped at ~1MB. Chunks are
// pushed to an ARRAY and joined ONCE at settle, so the concat is linear rather than the quadratic
// `out = (out + chunk).slice(-cap)` on every data event. stderr is always captured, tail-bounded at 4096.
const STDOUT_CAP_BYTES = 1024 * 1024;

function runAsync(
  bin: string,
  args: string[],
  timeoutMs = 30 * 60 * 1000,
  opts: { captureStdout?: boolean } = {},
): Promise<{ code: number | null; out: string; err: string }> {
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
      // A missing binary can throw synchronously — resolve like a failed run rather than reject, so every
      // caller's single `code !== 0` branch keeps handling it (no caller needs a try/catch).
      resolve({ code: null, out: "", err: (e as Error).message });
      return;
    }
    // Joined once, at settle — never in the data handler.
    const finishOut = (): string => (captureStdout ? chunks.join("") : "");
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, timeoutMs);
    // Null when capture is off (stdio "ignore") — the optional chain is what makes that a no-op.
    child.stdout?.on("data", (d) => {
      if (captured >= STDOUT_CAP_BYTES) return; // past the cap we drop, we do not grow
      const s = d.toString();
      chunks.push(s);
      captured += s.length;
    });
    child.stderr?.on("data", (d) => {
      // Keep only the tail — a long ffmpeg log can be huge; we only surface the last lines on failure.
      err = (err + d.toString()).slice(-4096);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, out: finishOut(), err: e.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: finishOut(), err });
    });
  });
}

// ── probes (dimensions + alpha) ────────────────────────────────────────────────
// The probe flavour of the runner: stdout IS the answer here, and the 10-minute ceiling is the one the
// probes have always carried. Everything below awaits this — a probe that returns a Promise instead of a
// value would silently defeat the §5.1 integrity gate, so every probe's return type is written out.
function run(bin: string, args: string[], timeoutMs = 10 * 60 * 1000): Promise<{ code: number | null; out: string; err: string }> {
  return runAsync(bin, args, timeoutMs, { captureStdout: true });
}

// ── the already-compressed marker (compression.mdx §8.4) ───────────────────────
// A durable "LFBridge already compressed this" signal written INTO the compressed file's own container
// metadata (the `comment` tag), so it rides with the file's bytes over IPFS. On a re-run — or on ANOTHER
// computer in the mesh that already holds the compressed file — a file carrying this marker is skipped
// BEFORE any transcode, instead of being re-encoded just to discover "no gain". No new tool: it is written
// inline by the SAME encoder we already run (ffmpeg `-metadata` for video, `magick -set` for images) and
// read back with the fast ffprobe / `magick identify` probes. `v1` lets a future re-tuned engine invalidate
// old marks by bumping the version.
const MARKER_PREFIX = "LFBcompressed;";
function markerPayload(codec: string): string {
  return `${MARKER_PREFIX}v1;${codec}`;
}

// Read our marker's `comment` from a file (empty string if absent/unreadable). Fast async probe.
async function readMarker(abs: string, media: CompressMedia, tools: CompressTools): Promise<string> {
  try {
    if (media === "video") {
      if (!tools.ffprobe) return "";
      const r = await run("ffprobe", [
        "-v", "error",
        "-show_entries", "format_tags=comment",
        "-of", "default=noprint_wrappers=1:nokey=1",
        abs,
      ]);
      return r.out.trim();
    }
    if (!tools.magick) return "";
    const r = await run(magickBin(), ["identify", "-format", "%c", abs]);
    return r.out.trim();
  } catch {
    return "";
  }
}

// True when the file already carries OUR current-version marker — the skip signal (§8.4). A mark from an
// OLDER version is treated as absent so a genuinely improved engine can re-sweep those files.
async function isAlreadyCompressed(abs: string, media: CompressMedia, tools: CompressTools): Promise<boolean> {
  return (await readMarker(abs, media, tools)).startsWith(MARKER_PREFIX);
}

async function imageDims(abs: string, tools: CompressTools): Promise<{ w: number; h: number } | null> {
  if (!tools.magick) return null;
  const r = await run(magickBin(), ["identify", "-format", "%w %h", abs]);
  const m = /(\d+)\s+(\d+)/.exec(r.out.trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** true = image has USED transparency; false = opaque; null = couldn't determine. */
async function imageAlphaUsed(abs: string, tools: CompressTools): Promise<boolean | null> {
  if (!tools.magick) return null;
  const r = await run(magickBin(), ["identify", "-format", "%[opaque]", abs]);
  const v = r.out.trim().toLowerCase();
  if (v === "true") return false; // fully opaque → alpha unused
  if (v === "false") return true; // has transparency
  return null;
}

async function videoInfo(abs: string, tools: CompressTools): Promise<{ w: number; h: number; pixFmt: string } | null> {
  if (!tools.ffprobe) return null;
  const r = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,pix_fmt", "-of", "csv=p=0", abs,
  ]);
  const parts = r.out.trim().split(",");
  if (parts.length < 2) return null;
  return { w: Number(parts[0]), h: Number(parts[1]), pixFmt: (parts[2] ?? "").trim() };
}
/** A pixel format that carries alpha (yuva*, rgba/bgra/argb/abgr, ya8/ya16, gbrap…). */
function pixFmtHasAlpha(pixFmt: string): boolean {
  const f = pixFmt.toLowerCase();
  return ["yuva", "rgba", "bgra", "argb", "abgr", "gbrap", "ya8", "ya16", "ayuv"].some((tok) => f.includes(tok));
}

// ── codec metadata ──────────────────────────────────────────────────────────────
const IMAGE_TARGETS: Record<string, { ext: string; alpha: boolean }> = {
  jpeg: { ext: ".jpg", alpha: false },
  jpeg2000: { ext: ".jp2", alpha: false },
  webp: { ext: ".webp", alpha: true },
  png: { ext: ".png", alpha: true },
};
const VIDEO_TARGETS: Record<string, { encoder: string; ext: string; alpha: boolean; label: string }> = {
  h264: { encoder: "libx264", ext: ".mp4", alpha: false, label: "H.264" },
  hevc: { encoder: "libx265", ext: ".mp4", alpha: false, label: "HEVC" },
  av1: { encoder: "libaom-av1", ext: ".mp4", alpha: false, label: "AV1" },
};
const LOSSLESS_IMAGE_EXT = new Set([".png", ".bmp", ".tif", ".tiff", ".gif"]);
// Source extensions `cwebp` can actually decode. It CANNOT read GIF or BMP, so those must route through
// ImageMagick when targeting WebP (a GIF handed to cwebp fails with "Cannot read input picture file").
const CWEBP_READABLE = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"]);

function jpegQuality(q: CompressMediaPrefs["quality"]): number {
  return q === "high" ? 92 : q === "low" ? 70 : q === "lossless" ? 100 : 85;
}
function videoCrf(codec: string, q: CompressMediaPrefs["quality"]): number {
  const base = codec === "hevc" ? 24 : 21; // medium
  if (q === "lossless") return 0;
  if (q === "high") return base - 3;
  if (q === "low") return base + 5;
  return base;
}

function mediaOf(name: string): CompressMedia | null {
  const k = mediaKindForName(name);
  return k === "image" ? "images" : k === "video" ? "video" : k === "audio" ? "audio" : null;
}

// ── the plan / check (compression.mdx §3 + §6) ─────────────────────────────────
interface Plan {
  media: CompressMedia;
  targetKey: string;      // "png" | "jpeg" | "webp" | "jpeg2000" | "h264" | "hevc" | …
  targetCodec: string;    // human label
  ext: string;            // output extension
  action: string;
  lossless: boolean;
  // A COMPATIBILITY conversion (HEIC/HEIF/AVIF → JPEG, or a forced H.264) whose purpose is universal
  // playback/compatibility, NOT shrinkage — so it is EXEMPT from the "output must be smaller" size-gain
  // guard and may legitimately grow the file (images.mdx §4.1, compression.mdx §5). Resolution + alpha
  // invariants are never waived.
  formatConvert?: boolean;
}

// A plan may resolve to a deliberate SKIP (not an error, not a tool gap) — e.g. conversion is turned off
// and there is no in-place compressor for this format. The caller reports it as `skipped`.
type PlanResult = Plan | { toolMissing: string } | { skip: string };

function pickImageTarget(prefs: CompressMediaPrefs, tools: CompressTools, srcExt: string, alphaUsed: boolean | null): PlanResult {
  const denied = new Set(prefs.deny);
  const isLosslessSrc = LOSSLESS_IMAGE_EXT.has(srcExt);
  const isHeicFamily = HEIC_FAMILY_EXT.has(srcExt);
  // Lossless quality, or a PNG we keep as PNG → oxipng lossless recompress.
  const wantLossless = prefs.quality === "lossless";

  // ── convert_types OFF → FORMAT-PRESERVING only (images.mdx §2.1). No target may change the extension.
  if (!prefs.convertTypes) {
    if (isLosslessSrc) {
      if (!tools.oxipng && !tools.magick) return { toolMissing: "oxipng (brew install oxipng)" };
      const useOxi = tools.oxipng && srcExt === ".png";
      return { media: "images", targetKey: "png", targetCodec: useOxi ? "PNG (lossless)" : "recompress", ext: srcExt, action: "lossless recompress", lossless: true };
    }
    if (srcExt === ".jpg" || srcExt === ".jpeg" || srcExt === ".webp") {
      if (!tools.magick) return { toolMissing: "ImageMagick (brew install imagemagick)" };
      return { media: "images", targetKey: srcExt === ".webp" ? "webp" : "jpeg", targetCodec: srcExt === ".webp" ? "WebP" : "JPEG", ext: srcExt, action: `re-encode (${prefs.quality})`, lossless: false };
    }
    // HEIC/HEIF/AVIF (and any other) have no in-place compressor here → nothing to do when convert is off.
    return { skip: "conversion is turned off in settings (no in-place compression for this type)" };
  }

  // ── HEIC/HEIF/AVIF → JPEG COMPATIBILITY conversion (images.mdx §4). Primary-still decode happens in
  // imageCommand(); here we only pick the target. JPEG unless transparency is used (then lossless WebP).
  if (isHeicFamily) {
    if (!tools.heif) return { toolMissing: "libheif for ImageMagick (brew install imagemagick libheif)" };
    if (alphaUsed === true) {
      if (!denied.has("webp") && tools.magick) {
        return { media: "images", targetKey: "webp", targetCodec: "WebP", ext: ".webp", action: `→ WebP (lossless, keeps alpha)`, lossless: true, formatConvert: true };
      }
      return { skip: "HEIC has used transparency and JPEG can't keep it (allow WebP to convert it)" };
    }
    if (!denied.has("jpeg")) {
      if (!tools.magick) return { toolMissing: "ImageMagick (brew install imagemagick)" };
      return { media: "images", targetKey: "jpeg", targetCodec: "JPEG", ext: ".jpg", action: `→ JPEG (${prefs.quality}, primary image)`, lossless: false, formatConvert: true };
    }
    if (!denied.has("webp") && tools.magick) {
      return { media: "images", targetKey: "webp", targetCodec: "WebP", ext: ".webp", action: `→ WebP (${prefs.quality}, primary image)`, lossless: wantLossless, formatConvert: true };
    }
    return { skip: "JPEG and WebP are both denied for images — nothing to convert HEIC to" };
  }

  for (const key of prefs.prefer) {
    const t = IMAGE_TARGETS[key];
    if (!t || denied.has(key)) continue;
    // A no-alpha target is unsafe when transparency is used or undeterminable → skip it (steer onward).
    if (!t.alpha && alphaUsed !== false) continue;
    if (key === "webp") {
      if (!tools.cwebp && !tools.magick) return { toolMissing: "cwebp (brew install webp)" };
      const lossless = wantLossless || alphaUsed === true;
      return { media: "images", targetKey: "webp", targetCodec: "WebP", ext: ".webp", action: `→ WebP${lossless ? " (lossless)" : ` (${prefs.quality})`}`, lossless };
    }
    if (key === "jpeg") {
      if (!tools.magick) return { toolMissing: "ImageMagick (brew install imagemagick)" };
      return { media: "images", targetKey: "jpeg", targetCodec: "JPEG", ext: ".jpg", action: `→ JPEG (${prefs.quality})`, lossless: false };
    }
    if (key === "jpeg2000") {
      if (!tools.magick) return { toolMissing: "ImageMagick (brew install imagemagick)" };
      return { media: "images", targetKey: "jpeg2000", targetCodec: "JPEG 2000", ext: ".jp2", action: `→ JPEG 2000 (${prefs.quality})`, lossless: false };
    }
  }
  // Fallback: a lossless recompress of the source format (safe, keeps pixels + alpha).
  if (isLosslessSrc) {
    if (!tools.oxipng && !tools.magick) return { toolMissing: "oxipng (brew install oxipng)" };
    const useOxi = tools.oxipng && srcExt === ".png";
    return { media: "images", targetKey: "png", targetCodec: useOxi ? "PNG (lossless)" : "recompress", ext: srcExt, action: "lossless recompress", lossless: true };
  }
  // Already-lossy source (jpeg/webp) → re-encode at quality (may be no gain).
  if (!tools.magick) return { toolMissing: "ImageMagick (brew install imagemagick)" };
  return { media: "images", targetKey: srcExt === ".webp" ? "webp" : "jpeg", targetCodec: srcExt === ".webp" ? "WebP" : "JPEG", ext: srcExt, action: `re-encode (${prefs.quality})`, lossless: false };
}

function pickVideoTarget(prefs: CompressMediaPrefs, tools: CompressTools, srcExt: string, force?: string): PlanResult {
  if (!tools.ffmpeg) return { toolMissing: "ffmpeg (brew install ffmpeg)" };
  const denied = new Set(prefs.deny);
  // A forced codec (e.g. "h264" for a browser/upload-compatibility convert — codecs.mdx §5) wins over
  // the user's prefer list; otherwise take the first preferred-and-allowed target, defaulting to H.264.
  const key = (force && VIDEO_TARGETS[force])
    ? force
    : prefs.prefer.find((k) => VIDEO_TARGETS[k] && !denied.has(k)) ?? "h264";
  const t = VIDEO_TARGETS[key];
  // convert_types OFF (and no forced codec) → keep the SOURCE container extension instead of forcing .mp4
  // (images.mdx §1.4 — the same format-preserving policy as images). ffmpeg muxes into that container.
  const keepContainer = !prefs.convertTypes && !force && srcExt;
  const ext = keepContainer ? srcExt : t.ext;
  return { media: "video", targetKey: key, targetCodec: t.label, ext, action: `→ ${t.label} (${prefs.quality}, CRF ${videoCrf(key, prefs.quality)})`, lossless: prefs.quality === "lossless" };
}

/** Dry-run: what would happen + is it alpha-safe. Never touches the file. */
export async function checkFile(input: string): Promise<CompressCheck> {
  const abs = path.resolve(expandHome(input.trim()));
  const name = path.basename(abs);
  const media = mediaOf(name);
  const base: CompressCheck = {
    path: abs, media, eligible: false, action: "", targetCodec: null,
    alphaUsed: null, alphaSafe: true, warning: null, toolMissing: null,
  };
  if (!media) return { ...base, action: "not a compressible media file" };
  if (media === "audio") return { ...base, action: "audio compression is not enabled yet" };

  const settings = getCompressionSettings();
  const prefs = media === "images" ? settings.images : settings.video;
  if (!prefs.enabled) return { ...base, action: `${media} compression is disabled in settings` };
  const srcExt = path.extname(abs).toLowerCase();
  // Per-extension opt-OUT (images.mdx §2.2). An excluded extension is skipped BEFORE any probe.
  if (prefs.skipExts.includes(srcExt)) return { ...base, action: "extension excluded by settings" };
  const tools = await detectTools();

  if (media === "images") {
    const alphaUsed: boolean | null = await imageAlphaUsed(abs, tools);
    const plan = pickImageTarget(prefs, tools, srcExt, alphaUsed);
    if ("toolMissing" in plan) return { ...base, alphaUsed, toolMissing: plan.toolMissing, action: `needs ${plan.toolMissing}` };
    if ("skip" in plan) return { ...base, alphaUsed, action: plan.skip };
    const noAlphaTarget = !IMAGE_TARGETS[plan.targetKey]?.alpha;
    const alphaSafe = !(alphaUsed !== false && noAlphaTarget);
    return {
      ...base, eligible: true, action: plan.action, targetCodec: plan.targetCodec, alphaUsed,
      alphaSafe,
      warning: alphaUsed === true && noAlphaTarget ? "would lose transparency — steering to an alpha-safe target" : alphaUsed === null ? "alpha usage unknown (ImageMagick not installed) — treating conservatively" : null,
    };
  }
  // video
  const info = await videoInfo(abs, tools);
  const alphaUsed: boolean | null = info ? pixFmtHasAlpha(info.pixFmt) : null;
  const plan = pickVideoTarget(prefs, tools, srcExt);
  if ("toolMissing" in plan) return { ...base, alphaUsed, toolMissing: plan.toolMissing, action: `needs ${plan.toolMissing}` };
  if ("skip" in plan) return { ...base, alphaUsed, action: plan.skip };
  const targetAlpha = VIDEO_TARGETS[plan.targetKey]?.alpha ?? false;
  const alphaSafe = !(alphaUsed === true && !targetAlpha);
  return {
    ...base, eligible: alphaSafe, action: plan.action, targetCodec: plan.targetCodec, alphaUsed,
    alphaSafe,
    warning: !alphaSafe ? `source has a used alpha channel (${info?.pixFmt}); ${plan.targetCodec} can't keep it — blocked` : null,
  };
}

// ── compress one file (compression.mdx §8) ──────────────────────────────────────
function tmpOut(ext: string): string {
  const dir = path.join(resolveStateDir(), "tmp");
  ensureDir(dir);
  // In-process UUID — never `uuidgen`. Shelling out here forked a child PER FILE and blocked the event
  // loop on a batch of thousands for no benefit (to_fix.mdx §3.3.4 / T3). fit-media.ts made this same fix.
  return path.join(dir, `compress-${crypto.randomUUID()}${ext}`);
}

function trashOriginal(abs: string): void {
  const trashDir = path.join(resolveStateDir(), "trash");
  ensureDir(trashDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(trashDir, `${stamp}__${path.basename(abs)}`);
  try {
    fs.renameSync(abs, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.copyFileSync(abs, dest);
    fs.unlinkSync(abs);
  }
}

function fail(pathOut: string, reason: string, status: CompressResult["status"] = "failed", beforeBytes: number | null = null): CompressResult {
  // Every real compress fault must reach error.err (charter logging), not just the in-memory recentFailures
  // list that a background "Compress inside" run prunes after 30 min / loses on restart. A genuine failure
  // (tool crash, missing binary, a replace that left the original in trash) is an ERROR; a safety-guard
  // refusal ("blocked" — alpha-unsafe, resolution changed) is a WARN. A routine "skipped" (not media, no
  // gain, already compressed) is normal and stays unlogged.
  if (status === "failed") log.error("compress", `${pathOut}: ${reason}`);
  else if (status === "blocked") log.warn("compress", `${pathOut}: ${reason}`);
  return { path: pathOut, status, reason, beforeBytes, afterBytes: null, codec: null };
}

// ── §8.0 before/after capture (LOCKED) ──────────────────────────────────────────
// The EXACT content hash + size we record on the sidecar `before`/`after`. This mirrors the tracking
// fingerprint scheme (storage/tracking.service.ts — files.yaml `hash`: sha256 of size + mtime + head/tail
// 64 KiB, truncated to 32 hex) so a compress event's before/after hashes are directly comparable to what
// the tracking index stores. We do NOT invent a new hash — reusing the tracking scheme keeps one identity.
const FINGERPRINT_CHUNK = 64 * 1024;
function exactHashAndSize(abs: string): { hash: string | null; size: number | null } {
  try {
    const st = fs.statSync(abs);
    const h = crypto.createHash("sha256");
    h.update(String(st.size));
    h.update(String(Math.round(st.mtimeMs)));
    const fd = fs.openSync(abs, "r");
    try {
      const headLen = Math.min(FINGERPRINT_CHUNK, st.size);
      if (headLen > 0) {
        const head = Buffer.alloc(headLen);
        fs.readSync(fd, head, 0, headLen, 0);
        h.update(head);
      }
      if (st.size > FINGERPRINT_CHUNK) {
        const tailLen = Math.min(FINGERPRINT_CHUNK, st.size);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, Math.max(0, st.size - tailLen));
        h.update(tail);
      }
    } finally {
      fs.closeSync(fd);
    }
    return { hash: h.digest("hex").slice(0, 32), size: st.size };
  } catch {
    return { hash: null, size: null };
  }
}

// The perceptual content fingerprint of a media file (§8.0 — image on the decoded buffer, video on the
// path). ALWAYS guarded: a fingerprint failure must NEVER abort a compress — we log and return null so the
// event still records the exact-hash pair (the fp pair is the "content-preserved" proof, best-effort).
async function perceptualFingerprint(abs: string, media: CompressMedia): Promise<PerceptualFingerprint | null> {
  try {
    // BY PATH, never a Buffer (to_fix.mdx §3.3.2). This used to be `fingerprintImage(fs.readFileSync(abs))`:
    // the WHOLE file, read SYNCHRONOUSLY, with NO size cap, on a bucket that fans out to the full core
    // budget — and compressFile calls this TWICE per file (before + after the transcode, §3.1). Handing
    // sharp the path lets it read incrementally and decode bounded, so the source bytes never enter the
    // heap; combined with the bounded decode in fingerprintImage this drops ~105 MB live per file to ~1 MB.
    if (media === "images") return await fingerprintImage(abs);
    if (media === "video") return await fingerprintVideo(abs);
    return null;
  } catch (e) {
    log.warn("compress", `perceptual fingerprint skipped for ${abs}: ${(e as Error).message}`);
    return null;
  }
}

// Source codec label for the sidecar `codec.from` — probed BEFORE the transcode (the original is gone from
// its path afterwards). For video we ask ffprobe for the stream codec_name; for images we fall back to the
// source extension (jpeg/png/heic…). "unknown" when nothing resolves.
async function sourceCodecLabel(abs: string, media: CompressMedia, tools: CompressTools): Promise<string> {
  if (media === "video" && tools.ffprobe) {
    const r = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", abs,
    ]);
    const c = r.out.trim();
    if (c) return c;
  }
  return path.extname(abs).replace(/^\./, "").toLowerCase() || "unknown";
}

// Per-call options (compress_inside.mdx §4). `forceVideoCodec` pins the output codec (the viewer's
// compatibility convert); `deleteOriginal` OVERRIDES the global recoverable-by-default disposition for
// THIS file only ("hard" = unlink, "trash" = recoverable). Both optional; omitting keeps prior behavior.
export interface CompressFileOpts {
  forceVideoCodec?: string;
  deleteOriginal?: DeleteOriginalMode;
  // Per-job internal THREAD CAP (parallelization.mdx §2). Set by the background queue when it fans MANY
  // jobs out at once so N jobs stay inside the core budget (image → 1, video → a small cap) instead of
  // each grabbing every core (cores² oversubscription). OMITTED for a one-off single-file compress — that
  // lone file uses the tool's own all-core default. Fed to ffmpeg -threads / oxipng --threads /
  // cwebp multi-thread on-off / magick -limit thread below.
  threads?: number;
  // The acting user's allow-listed email (§8.0 / decisions.mdx §14) — stamped as the sidecar event's `by`
  // and the history line's actor, and the decider on a format-change re-stamp. OMITTED for a background/
  // system compress with no session (→ null): the writers auto-stamp `on_device` regardless.
  by?: string | null;
}

export async function compressFile(input: string, opts?: CompressFileOpts | string): Promise<CompressResult> {
  // Back-compat: an old positional `forceVideoCodec` string is still accepted.
  const o: CompressFileOpts = typeof opts === "string" ? { forceVideoCodec: opts } : opts ?? {};
  const forceVideoCodec = o.forceVideoCodec;
  const abs = path.resolve(expandHome(input.trim()));
  let beforeBytes: number | null = null;
  try {
    beforeBytes = fs.statSync(abs).size;
  } catch {
    return fail(abs, "file not found");
  }
  const check = await checkFile(abs);
  if (!check.media || check.media === "audio") return fail(abs, check.action, "skipped", beforeBytes);
  if (check.toolMissing) return fail(abs, `needs ${check.toolMissing}`, "failed", beforeBytes);
  if (!check.alphaSafe) return fail(abs, check.warning ?? "alpha safety check failed", "blocked", beforeBytes);
  if (!check.eligible) return fail(abs, check.action, "skipped", beforeBytes);

  const settings = getCompressionSettings();
  const tools = await detectTools();
  const media = check.media;

  // §8.4 — the already-compressed marker. If this file already carries our in-file marker (from a prior
  // pass here, or because a peer compressed it and it pinned over IPFS), skip it BEFORE any transcode — the
  // whole point is to never re-encode a file we (or another of the user's computers) already compressed.
  if (await isAlreadyCompressed(abs, media, tools)) {
    return { path: abs, status: "skipped", reason: "already compressed (marker)", beforeBytes, afterBytes: beforeBytes, codec: check.targetCodec };
  }

  const prefs = media === "images" ? settings.images : settings.video;
  const srcExt = path.extname(abs).toLowerCase();
  const plan = media === "images"
    ? pickImageTarget(prefs, tools, srcExt, check.alphaUsed)
    : pickVideoTarget(prefs, tools, srcExt, forceVideoCodec);
  if ("toolMissing" in plan) return fail(abs, `needs ${plan.toolMissing}`, "failed", beforeBytes);
  if ("skip" in plan) return fail(abs, plan.skip, "skipped", beforeBytes);

  // §8.0 — capture the BEFORE state FIRST, before we touch a byte: the original's exact content hash + size
  // and (video/image) its perceptual fingerprint, plus its source codec. Once the replace (step 5) runs the
  // original only exists in trash, so "what it was" must be recorded now. All best-effort (guarded).
  const beforeCap = exactHashAndSize(abs);
  const srcCodec = await sourceCodecLabel(abs, media, tools);
  const fingerprintBefore = await perceptualFingerprint(abs, media);

  const out = tmpOut(plan.ext);
  // The INPUT half of the §5.1 integrity gate + the §5 resolution guard below. The type is written out on
  // purpose: it is what makes tsc reject a probe left un-awaited here (a Promise is ALWAYS truthy, so a
  // missing await would turn the `!outDims` gate below into a permanent false and let corrupt output
  // replace the user's original — silent data loss). One probe per file, not three.
  const inInfo = media === "images" ? null : await videoInfo(abs, tools);
  const inDims: { w: number; h: number } | null =
    media === "images" ? await imageDims(abs, tools) : (inInfo ? { w: inInfo.w, h: inInfo.h } : null);

  // Build + run the tool.
  let cmd: { bin: string; args: string[] };
  if (media === "images") {
    cmd = imageCommand(plan, abs, out, prefs, tools, o.threads);
  } else {
    const t = VIDEO_TARGETS[plan.targetKey];
    // -threads caps a BATCHED job to its slice (parallelization.mdx §2); a one-off compress omits it so
    // ffmpeg uses its all-core default. 0 would mean "auto/all cores" to ffmpeg — so only pass when > 0.
    const threadArgs = o.threads && o.threads > 0 ? ["-threads", String(o.threads)] : [];
    // §8.4 — stamp the in-file marker inline (free — no extra pass). `-metadata comment=…` writes it into
    // the output's moov/udta so a re-run / a peer reads it back and skips this file.
    cmd = { bin: "ffmpeg", args: ["-y", "-i", abs, "-c:v", t.encoder, ...threadArgs, "-crf", String(videoCrf(plan.targetKey, prefs.quality)), "-pix_fmt", "yuv420p", "-c:a", "copy", "-metadata", `comment=${markerPayload(plan.targetKey)}`, out] };
  }
  const r = await runAsync(cmd.bin, cmd.args);
  if (r.code !== 0 || !safeSize(out)) {
    tryUnlink(out);
    return fail(abs, `${cmd.bin} failed: ${(r.err || "").split("\n").slice(-3).join(" ").slice(0, 200)}`, "failed", beforeBytes);
  }

  // §5 — verify resolution unchanged (never downscale) and that we actually gained.
  // Re-probed with the SAME probe that read the input, and RESOLVED (awaited) before the gate reads it.
  const outInfo = media === "images" ? null : await videoInfo(out, tools);
  const outDims: { w: number; h: number } | null =
    media === "images" ? await imageDims(out, tools) : (outInfo ? { w: outInfo.w, h: outInfo.h } : null);
  // §5.1 — OUTPUT INTEGRITY GATE (LOCKED, fail-CLOSED). A transcode can exit 0 yet leave a TRUNCATED or
  // CORRUPT file — e.g. a ~134-byte broken JPEG — that `safeSize` (>0) and the size-gain guard both happily
  // accept (it IS smaller than the original), after which the irreversible replace clobbers a good file
  // with garbage. Before we touch the original we therefore PROVE the output decodes: we re-probe its pixel
  // dimensions with the SAME probe that read the input. If the input's dimensions were readable but the
  // output's are NOT, the encoder produced an unreadable file — refuse and keep the original untouched.
  // This is independent of preserveResolution (a user turning that off must NOT disable corruption
  // detection). This is the last line of defense against silent compression data-loss.
  if (inDims && !outDims) {
    tryUnlink(out);
    return fail(abs, "refused: compressed output is unreadable/corrupt — could not verify its dimensions; original kept", "blocked", beforeBytes);
  }
  if (settings.preserveResolution && inDims && outDims && (inDims.w !== outDims.w || inDims.h !== outDims.h)) {
    tryUnlink(out);
    return fail(abs, `refused: resolution changed ${inDims.w}×${inDims.h} → ${outDims.w}×${outDims.h}`, "blocked", beforeBytes);
  }
  const afterBytes = fs.statSync(out).size;
  // A COMPATIBILITY conversion (HEIC/HEIF/AVIF → JPEG, or a forced H.264 — compression.mdx §5) exists for
  // universal playback, not shrinkage, so it is EXEMPT from the "must be smaller" guard and may grow the
  // file. Every OTHER compress must actually gain, or we keep the original untouched.
  if (!plan.formatConvert && beforeBytes != null && afterBytes >= beforeBytes) {
    tryUnlink(out);
    return { path: abs, status: "skipped", reason: "no gain (already well compressed)", beforeBytes, afterBytes, codec: check.targetCodec };
  }

  // §8 — replace: dispose the original, then move temp → final path (new ext if the format changed).
  // Disposition: a per-call `deleteOriginal` (the "Compress inside" dialog's per-run radio,
  // compress_inside.mdx §4) wins; otherwise the global recoverable-by-default (settings). This runs
  // ONLY here — after the temp verified resolution and confirmed a size gain — so a file that failed
  // to compress NEVER reaches this point and its original is never touched (the transactional rule).
  const disposition: DeleteOriginalMode =
    o.deleteOriginal ?? (settings.replaceOriginalToTrash ? "trash" : "hard");
  const finalPath = path.join(path.dirname(abs), path.basename(abs, path.extname(abs)) + plan.ext);
  try {
    if (disposition === "trash") trashOriginal(abs);
    else fs.unlinkSync(abs);
    fs.renameSync(out, finalPath);
  } catch (e) {
    tryUnlink(out);
    return fail(abs, `replace failed: ${(e as Error).message}`, "failed", beforeBytes);
  }
  log.info("compress", `${abs} → ${finalPath} (${check.targetCodec}) ${beforeBytes}→${afterBytes} bytes`);

  // Best-effort travelling compression record in the owning storage's SDL (syncable_data_location.mdx §4.3).
  // Wrapped so it can NEVER fail a compression — the bytes are already replaced by this point.
  try {
    const storageRoot = findStorageRootForPath(finalPath);
    if (storageRoot && beforeBytes != null) {
      const rel = path.relative(storageRoot, finalPath);
      writeCompressionRecord(storageRoot, rel, {
        source: rel,
        original: {
          name: path.basename(abs),
          extension: path.extname(abs).replace(/^\./, ""),
          size: beforeBytes,
        },
        compressed: {
          codec: plan.targetKey,
          size: afterBytes,
          ratio: beforeBytes > 0 ? Number((afterBytes / beforeBytes).toFixed(3)) : 0,
          at: new Date().toISOString(),
        },
      });
    }
  } catch (e) {
    log.warn("compress", `compression record skipped: ${(e as Error).message}`);
  }

  // §8.0 — capture the AFTER state on the RESULT file (exact hash + size, post perceptual fingerprint), then
  // append ONE per-file sidecar event + a history line to the owning repo, and re-stamp any team decision
  // across a format change. ALL best-effort (guarded): the bytes are already safely replaced by this point,
  // so a tracking-write failure must NEVER surface as a compression failure or lose the file.
  try {
    const repoRoot = findStorageRootForPath(finalPath);
    if (repoRoot) {
      const relFinal = path.relative(repoRoot, finalPath);
      // A format change (extension differs) is a CONVERT (PNG→JPEG / HEIC→JPEG) and moves the file to a new
      // path; a same-extension re-encode is a COMPRESS in place. This split drives the event kind, the
      // format:{from,to} field, and whether a decision re-stamp is needed (only when the path changes).
      const oldExt = path.extname(abs).toLowerCase();
      const isConvert = oldExt !== plan.ext.toLowerCase();

      const afterCap = exactHashAndSize(finalPath);
      const fingerprintAfter = await perceptualFingerprint(finalPath, media);

      const seed: SidecarSeed = {
        name: path.basename(finalPath),
        categories: [media === "images" ? "image" : "video"],
        size: afterCap.size ?? afterBytes,
        hash: afterCap.hash,
        fingerprint: fingerprintAfter,
      };
      const event: FileEventInput = {
        kind: isConvert ? "convert" : "compress",
        before: { hash: beforeCap.hash, size: beforeCap.size ?? beforeBytes },
        after: { hash: afterCap.hash, size: afterCap.size ?? afterBytes },
        fingerprint_before: fingerprintBefore,
        fingerprint_after: fingerprintAfter,
        codec: { from: srcCodec, to: plan.targetKey },
        by: o.by ?? null,
      };
      if (isConvert) {
        event.format = { from: oldExt.replace(/^\./, ""), to: plan.ext.replace(/^\./, "") };
      }
      appendFileEvent(repoRoot, relFinal, event, seed);

      appendHistory(repoRoot, {
        verb: isConvert ? "CONVERT" : "COMPRESS",
        by: o.by ?? undefined,
        summary: `${isConvert ? "Converted" : "Compressed"} ${relFinal} (${check.targetCodec}) ${srcCodec}→${plan.targetKey} ${beforeBytes}→${afterBytes} bytes`,
      });

      // §12 (decisions.mdx) — a format change moves the file to a new path, which the decision fold keys on;
      // re-stamp the team's existing pin/ignore choice onto the new path so a decided file stays decided.
      // Skipped for an in-place compress (same path → decision key unchanged).
      if (isConvert) {
        const folder = folderForRepoId(repoIdFromPath(repoRoot));
        if (folder) {
          const oldRel = path.relative(repoRoot, abs);
          await restampOnTransform(folder, oldRel, relFinal, o.by ?? null);
        }
      }
    }
  } catch (e) {
    log.warn("compress", `sidecar/history capture skipped: ${(e as Error).message}`);
  }

  return { path: finalPath, status: "compressed", reason: null, beforeBytes, afterBytes, codec: check.targetCodec };
}

function imageCommand(plan: Plan, abs: string, out: string, prefs: CompressMediaPrefs, tools: CompressTools, threads?: number): { bin: string; args: string[] } {
  const q = String(jpegQuality(prefs.quality));
  // Thread-cap a BATCHED image job so the queue can fan MANY of them out to ~90% of cores without each
  // tool also grabbing every core (parallelization.mdx §2). oxipng defaults to ALL cores (rayon) — the
  // most important one to pin to 1 under a wide fan-out. A one-off compress passes no `threads` and each
  // tool uses its own default. `capped` = an explicit small cap was requested.
  const capped = threads != null && threads > 0;

  // ── HEIC / HEIF / AVIF → the PRIMARY still (images.mdx §4.1, LOCKED). A HEIC is a CONTAINER that may
  // hold a primary image, thumbnails, depth/auxiliary images, and (Live Photos) a motion clip. We read
  // ONLY the primary still by pinning scene `[0]` — ImageMagick's HEIF reader decodes the pitm primary
  // image as scene 0 — and we pass NO `--with-aux` / coalesce, so no thumbnail, aux/depth image, or
  // motion-video frame can be selected. `-auto-orient` bakes in the EXIF rotation the container carried.
  // These always route through ImageMagick (cwebp/oxipng can't read HEIC). Never downscaled (no resize).
  const srcExt = path.extname(abs).toLowerCase();
  if (HEIC_FAMILY_EXT.has(srcExt)) {
    const limit = capped ? ["-limit", "thread", String(threads)] : [];
    const primary = `${abs}[0]`; // scene 0 = the pitm primary image — never a preview/aux/motion frame
    const enc = plan.targetKey === "webp" && plan.lossless
      ? ["-define", "webp:lossless=true"]
      : ["-quality", q];
    return { bin: magickBin(), args: [...limit, primary, "-auto-orient", ...enc, "-set", "comment", markerPayload(plan.targetKey), out] };
  }

  if (plan.targetKey === "png" && tools.oxipng) {
    const t = capped ? ["--threads", String(threads)] : [];
    return { bin: "oxipng", args: ["-o", "4", ...t, "--strip", "safe", abs, "--out", out] };
  }
  if (plan.targetKey === "webp" && tools.cwebp && CWEBP_READABLE.has(srcExt)) {
    // cwebp reads only PNG/JPEG/TIFF/WebP — it CANNOT read GIF or BMP ("Cannot read input picture file").
    // A GIF/BMP → WebP conversion therefore falls through to the ImageMagick branch below (which decodes
    // both, and coalesces a multi-frame GIF into an animated WebP). Gating on CWEBP_READABLE is what keeps
    // those sources off cwebp instead of failing every one of them.
    // cwebp is single-threaded by default; `-mt` opts INTO multi-threading. A batched (capped) job stays
    // single-threaded; a one-off job turns -mt ON to use the whole machine on that lone file.
    const mt = capped ? [] : ["-mt"];
    return plan.lossless
      ? { bin: "cwebp", args: [...mt, "-lossless", abs, "-o", out] }
      : { bin: "cwebp", args: [...mt, "-q", q, abs, "-o", out] };
  }
  // Everything else via ImageMagick, quality-controlled, NO resize (keeps resolution). `-limit thread N`
  // caps a batched job; a one-off uses ImageMagick's default thread policy. `-set comment …` stamps the
  // §8.4 in-file marker inline (into the JPEG COM / PNG tEXt) so a re-run / a peer skips this file.
  const limit = capped ? ["-limit", "thread", String(threads)] : [];
  return { bin: magickBin(), args: [...limit, abs, "-quality", q, "-set", "comment", markerPayload(plan.targetKey), out] };
}

/** Byte size for the batch manifest, or 0 if unreadable. Distinct from `safeSize()` above, which answers
 *  "is this file readable and non-empty?" and returns a BOOLEAN. */
function statSizeOrZero(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function safeSize(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}
function tryUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

export async function compressBatch(inputs: string[]): Promise<CompressResult[]> {
  const out: CompressResult[] = [];
  for (const p of inputs) {
    try {
      out.push(await compressFile(p));
    } catch (e) {
      out.push(fail(p, (e as Error).message, "failed"));
    }
  }
  return out;
}

// ── "Compress videos & images inside" (compress_inside.mdx) ──────────────────────
// The triple-dot-menu / page-action dialog: walk a directory for the SELECTED kinds (images and/or
// videos, optionally recursive), create a ProcessingBatch, and hand every eligible file to the
// background queue as a `compress` task carrying the per-run originals-disposition. Returns the PLAN
// immediately (never waits for the work). The queue drains it one file at a time with per-file
// transactional safety (a failed file's original is never deleted — compress_inside.mdx §4).
export async function enqueueCompressInside(req: CompressInsideRequest): Promise<CompressInsidePlan> {
  const root = path.resolve(expandHome(req.root.trim()));
  const files = await walkCompressible(root, {
    images: req.images,
    videos: req.videos,
    recursive: req.recursive,
  });
  // Nothing eligible → no batch (no empty card on the Processing page); the honest "nothing to compress"
  // toast is driven off the zero plan (compress_inside.mdx §6).
  if (files.length === 0) {
    return { batchId: "", considered: 0, eligible: 0, queued: 0, images: 0, videos: 0 };
  }
  let images = 0;
  let videos = 0;
  for (const f of files) {
    if (mediaOf(path.basename(f)) === "images") images++;
    else videos++;
  }
  // The BATCH MANIFEST, before the enqueue — the durable record of the click (to_fix.mdx §4.1). Compress
  // was the ONE producer that opened a live batch but wrote NO manifest, and `createBatch` minted its own
  // id: so its tasks carried a registry id no manifest had ever heard of, and a crashed compress run left
  // nothing on disk to reconstruct. The manifest now mints the id and the batch ADOPTS it
  // (processing_batches.mdx §1) — one id, one run, joinable across the live row, the disk record, and every
  // log line.
  const manifest = writeManifest({
    op: "compress",
    scope: collapseHome(root),
    counts: { eligible: files.length, images, videos },
    // NOTE: this module's `safeSize()` is a BOOLEAN validity check, not a byte count (name collision with
    // the other producers' helper) — read the size directly rather than shipping `true` as a file size.
    files: files.map((p) => ({ path: p, sizeBytes: statSizeOrZero(p) })),
  });
  const batchId = createBatch({
    batchId: manifest.batchId,
    kind: "compress",
    label: `Compress · ${collapseHome(root)} · ${files.length} files`,
    scope: collapseHome(root),
    total: files.length,
    deleteOriginal: req.deleteOriginal,
    manifestPath: manifest.file,
  });
  trackBatch(manifest.batchId, files.length);
  const { queued } = enqueue(
    files.map((p) => ({
      op: "compress" as const,
      path: p,
      overwrite: false,
      // Stamp the media kind so the queue draws the right media-aware budget (job_queue.mdx §3): image
      // tasks fan wide (1 thread each), video tasks fan narrow (thread-capped). walkCompressible only
      // returns images/videos, so anything not an image is a video here.
      compress: {
        deleteOriginal: req.deleteOriginal,
        mediaKind: (mediaOf(path.basename(p)) === "images" ? "image" : "video") as "image" | "video",
      },
      batchId,
    })),
  );
  log.info(
    "compress",
    `compress-inside [${collapseHome(root)}] images=${req.images} videos=${req.videos} recursive=${req.recursive} delete=${req.deleteOriginal}: ${files.length} eligible → ${queued} queued`,
  );
  return { batchId, considered: files.length, eligible: files.length, queued, images, videos };
}

/**
 * Collect compressible files under `root` of the selected kinds. Skips HARD_SKIP / hidden / tracking
 * dirs (same skip set as the scan) AND macOS package bundles (.app/.framework/… — a bundle's internal
 * assets are referenced by name and must never be compressed/renamed/deleted, the bundles-opaque rule),
 * and includes only files whose extension heuristic says they SHOULD compress (compressInfo — already-
 * compressed media is skipped cheaply, no wasted transcode).
 *
 * Async + cooperatively yielding via the shared fs-walk so "Compress inside" over a large/cloud-mounted
 * folder never freezes the event loop (it fires on an interactive click, page_actions/compress_inside.mdx).
 */
function walkCompressible(
  root: string,
  sel: { images: boolean; videos: boolean; recursive: boolean },
): Promise<string[]> {
  const wanted = (name: string): boolean => {
    const info = compressInfo(name);
    if (info.compressState !== "should") return false; // skip already-compressed / non-media
    if (info.compressible === "image") return sel.images;
    if (info.compressible === "video") return sel.videos;
    return false;
  };
  return collectFilesRecursive(root, wanted, HARD_SKIP, { recursive: sel.recursive, skipDir: isMacPackageDir });
}

function collapseHome(abs: string): string {
  const home = process.env.HOME ?? "";
  return home && abs.startsWith(home) ? "~" + abs.slice(home.length) : abs;
}
