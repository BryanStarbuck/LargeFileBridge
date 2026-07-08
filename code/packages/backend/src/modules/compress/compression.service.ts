// The compression engine (compression.mdx). Drives quality-controllable brew tools (ffmpeg / ImageMagick
// / oxipng / cwebp / mozjpeg) to shrink IMAGE and VIDEO files at MEDIUM quality (prefer lossless), with
// two hard invariants: keep the same aspect ratio + pixel resolution (never downscale — §5), and run the
// alpha-channel safety check first (§6). Runs to a temp file, verifies, then does a recoverable replace
// (original → LFBridge trash). Audio is out of scope for now. Explicit-user-action only (charter §6.1).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
} from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { expandHome, compressInfo } from "../fs/badges.js";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";
import { findStorageRootForPath } from "../storage/storage.service.js";
import { writeCompressionRecord } from "../storage/analysis.service.js";
import { HARD_SKIP } from "../../shared/scan-filters.js";
import { enqueue, createBatch } from "../jobqueue/jobqueue.service.js";
import { log } from "../../shared/logging.js";

// ── settings (compression.mdx §7) ─────────────────────────────────────────────
export function getCompressionSettings(): CompressionSettings {
  const c = getAppConfig().compression;
  const map = (m: { enabled: boolean; quality: CompressMediaPrefs["quality"]; prefer: string[]; deny: string[] }): CompressMediaPrefs => ({
    enabled: m.enabled,
    quality: m.quality,
    prefer: m.prefer,
    deny: m.deny,
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
    const applyMedia = (dst: { enabled: boolean; quality: string; prefer: string[]; deny: string[] }, src?: Partial<CompressMediaPrefs>) => {
      if (!src) return;
      if (src.enabled !== undefined) dst.enabled = src.enabled;
      if (src.quality !== undefined) dst.quality = src.quality;
      if (src.prefer !== undefined) dst.prefer = src.prefer;
      if (src.deny !== undefined) dst.deny = src.deny;
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

// ── tool detection (compression.mdx §2) ────────────────────────────────────────
function onPath(bin: string): boolean {
  try {
    return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}
export function detectTools(): CompressTools {
  return {
    ffmpeg: onPath("ffmpeg"),
    ffprobe: onPath("ffprobe"),
    magick: onPath("magick") || onPath("convert"),
    oxipng: onPath("oxipng"),
    cwebp: onPath("cwebp"),
    cjpeg: onPath("cjpeg"),
    jpegoptim: onPath("jpegoptim"),
  };
}
function magickBin(): string {
  return onPath("magick") ? "magick" : "convert";
}

// ── probes (dimensions + alpha) ────────────────────────────────────────────────
function run(bin: string, args: string[], timeoutMs = 10 * 60 * 1000): { code: number | null; out: string; err: string } {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// The heavy transcode runner — ASYNC (child_process.spawn), so a multi-minute ffmpeg/oxipng/cwebp run
// NEVER blocks the Node event loop. This is what lets the background compress queue run while the web
// app stays responsive (the user navigates other tabs, the progress poll keeps answering). Quick probes
// (ffprobe/identify — tens of ms) stay synchronous; only this long call needs to yield.
function runAsync(bin: string, args: string[], timeoutMs = 30 * 60 * 1000): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    let err = "";
    let settled = false;
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr?.on("data", (d) => {
      // Keep only the tail — a long ffmpeg log can be huge; we only surface the last lines on failure.
      err = (err + d.toString()).slice(-4096);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, err: e.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, err });
    });
  });
}

function imageDims(abs: string, tools: CompressTools): { w: number; h: number } | null {
  if (!tools.magick) return null;
  const r = run(magickBin(), ["identify", "-format", "%w %h", abs]);
  const m = /(\d+)\s+(\d+)/.exec(r.out.trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** true = image has USED transparency; false = opaque; null = couldn't determine. */
function imageAlphaUsed(abs: string, tools: CompressTools): boolean | null {
  if (!tools.magick) return null;
  const r = run(magickBin(), ["identify", "-format", "%[opaque]", abs]);
  const v = r.out.trim().toLowerCase();
  if (v === "true") return false; // fully opaque → alpha unused
  if (v === "false") return true; // has transparency
  return null;
}

function videoInfo(abs: string, tools: CompressTools): { w: number; h: number; pixFmt: string } | null {
  if (!tools.ffprobe) return null;
  const r = run("ffprobe", [
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
}

function pickImageTarget(prefs: CompressMediaPrefs, tools: CompressTools, srcExt: string, alphaUsed: boolean | null): Plan | { toolMissing: string } {
  const denied = new Set(prefs.deny);
  const isLosslessSrc = LOSSLESS_IMAGE_EXT.has(srcExt);
  // Lossless quality, or a PNG we keep as PNG → oxipng lossless recompress.
  const wantLossless = prefs.quality === "lossless";
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

function pickVideoTarget(prefs: CompressMediaPrefs, tools: CompressTools, force?: string): Plan | { toolMissing: string } {
  if (!tools.ffmpeg) return { toolMissing: "ffmpeg (brew install ffmpeg)" };
  const denied = new Set(prefs.deny);
  // A forced codec (e.g. "h264" for a browser/upload-compatibility convert — codecs.mdx §5) wins over
  // the user's prefer list; otherwise take the first preferred-and-allowed target, defaulting to H.264.
  const key = (force && VIDEO_TARGETS[force])
    ? force
    : prefs.prefer.find((k) => VIDEO_TARGETS[k] && !denied.has(k)) ?? "h264";
  const t = VIDEO_TARGETS[key];
  return { media: "video", targetKey: key, targetCodec: t.label, ext: t.ext, action: `→ ${t.label} (${prefs.quality}, CRF ${videoCrf(key, prefs.quality)})`, lossless: prefs.quality === "lossless" };
}

/** Dry-run: what would happen + is it alpha-safe. Never touches the file. */
export function checkFile(input: string): CompressCheck {
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
  const tools = detectTools();

  if (media === "images") {
    const srcExt = path.extname(abs).toLowerCase();
    const alphaUsed = imageAlphaUsed(abs, tools);
    const plan = pickImageTarget(prefs, tools, srcExt, alphaUsed);
    if ("toolMissing" in plan) return { ...base, alphaUsed, toolMissing: plan.toolMissing, action: `needs ${plan.toolMissing}` };
    const noAlphaTarget = !IMAGE_TARGETS[plan.targetKey]?.alpha;
    const alphaSafe = !(alphaUsed !== false && noAlphaTarget);
    return {
      ...base, eligible: true, action: plan.action, targetCodec: plan.targetCodec, alphaUsed,
      alphaSafe,
      warning: alphaUsed === true && noAlphaTarget ? "would lose transparency — steering to an alpha-safe target" : alphaUsed === null ? "alpha usage unknown (ImageMagick not installed) — treating conservatively" : null,
    };
  }
  // video
  const info = videoInfo(abs, tools);
  const alphaUsed = info ? pixFmtHasAlpha(info.pixFmt) : null;
  const plan = pickVideoTarget(prefs, tools);
  if ("toolMissing" in plan) return { ...base, alphaUsed, toolMissing: plan.toolMissing, action: `needs ${plan.toolMissing}` };
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
  const rand = spawnSync("uuidgen", [], { encoding: "utf8" }).stdout?.trim() || String(process.hrtime.bigint());
  return path.join(dir, `compress-${rand}${ext}`);
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
  return { path: pathOut, status, reason, beforeBytes, afterBytes: null, codec: null };
}

// Per-call options (compress_inside.mdx §4). `forceVideoCodec` pins the output codec (the viewer's
// compatibility convert); `deleteOriginal` OVERRIDES the global recoverable-by-default disposition for
// THIS file only ("hard" = unlink, "trash" = recoverable). Both optional; omitting keeps prior behavior.
export interface CompressFileOpts {
  forceVideoCodec?: string;
  deleteOriginal?: DeleteOriginalMode;
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
  const check = checkFile(abs);
  if (!check.media || check.media === "audio") return fail(abs, check.action, "skipped", beforeBytes);
  if (check.toolMissing) return fail(abs, `needs ${check.toolMissing}`, "failed", beforeBytes);
  if (!check.alphaSafe) return fail(abs, check.warning ?? "alpha safety check failed", "blocked", beforeBytes);
  if (!check.eligible) return fail(abs, check.action, "skipped", beforeBytes);

  const settings = getCompressionSettings();
  const tools = detectTools();
  const media = check.media;
  const prefs = media === "images" ? settings.images : settings.video;
  const plan = media === "images"
    ? pickImageTarget(prefs, tools, path.extname(abs).toLowerCase(), check.alphaUsed)
    : pickVideoTarget(prefs, tools, forceVideoCodec);
  if ("toolMissing" in plan) return fail(abs, `needs ${plan.toolMissing}`, "failed", beforeBytes);

  const out = tmpOut(plan.ext);
  const inDims = media === "images" ? imageDims(abs, tools) : (videoInfo(abs, tools) && { w: videoInfo(abs, tools)!.w, h: videoInfo(abs, tools)!.h });

  // Build + run the tool.
  let cmd: { bin: string; args: string[] };
  if (media === "images") {
    cmd = imageCommand(plan, abs, out, prefs, tools);
  } else {
    const t = VIDEO_TARGETS[plan.targetKey];
    cmd = { bin: "ffmpeg", args: ["-y", "-i", abs, "-c:v", t.encoder, "-crf", String(videoCrf(plan.targetKey, prefs.quality)), "-pix_fmt", "yuv420p", "-c:a", "copy", out] };
  }
  const r = await runAsync(cmd.bin, cmd.args);
  if (r.code !== 0 || !safeSize(out)) {
    tryUnlink(out);
    return fail(abs, `${cmd.bin} failed: ${(r.err || "").split("\n").slice(-3).join(" ").slice(0, 200)}`, "failed", beforeBytes);
  }

  // §5 — verify resolution unchanged (never downscale) and that we actually gained.
  const outDims = media === "images" ? imageDims(out, tools) : (videoInfo(out, tools) && { w: videoInfo(out, tools)!.w, h: videoInfo(out, tools)!.h });
  if (settings.preserveResolution && inDims && outDims && (inDims.w !== outDims.w || inDims.h !== outDims.h)) {
    tryUnlink(out);
    return fail(abs, `refused: resolution changed ${inDims.w}×${inDims.h} → ${outDims.w}×${outDims.h}`, "blocked", beforeBytes);
  }
  const afterBytes = fs.statSync(out).size;
  if (beforeBytes != null && afterBytes >= beforeBytes) {
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

  return { path: finalPath, status: "compressed", reason: null, beforeBytes, afterBytes, codec: check.targetCodec };
}

function imageCommand(plan: Plan, abs: string, out: string, prefs: CompressMediaPrefs, tools: CompressTools): { bin: string; args: string[] } {
  const q = String(jpegQuality(prefs.quality));
  if (plan.targetKey === "png" && tools.oxipng) {
    return { bin: "oxipng", args: ["-o", "4", "--strip", "safe", abs, "--out", out] };
  }
  if (plan.targetKey === "webp" && tools.cwebp) {
    return plan.lossless
      ? { bin: "cwebp", args: ["-lossless", abs, "-o", out] }
      : { bin: "cwebp", args: ["-q", q, abs, "-o", out] };
  }
  // Everything else via ImageMagick, quality-controlled, NO resize (keeps resolution).
  return { bin: magickBin(), args: [abs, "-quality", q, out] };
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
export function enqueueCompressInside(req: CompressInsideRequest): CompressInsidePlan {
  const root = path.resolve(expandHome(req.root.trim()));
  const files = walkCompressible(root, {
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
  const batchId = createBatch({
    kind: "compress",
    label: `Compress inside ${collapseHome(root)}`,
    total: files.length,
    deleteOriginal: req.deleteOriginal,
  });
  const { queued } = enqueue(
    files.map((p) => ({
      op: "compress" as const,
      path: p,
      overwrite: false,
      compress: { deleteOriginal: req.deleteOriginal },
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
 * dirs (same skip set as the scan), and includes only files whose extension heuristic says they SHOULD
 * compress (compressInfo — already-compressed media is skipped cheaply, no wasted transcode).
 */
function walkCompressible(
  root: string,
  sel: { images: boolean; videos: boolean; recursive: boolean },
): string[] {
  const out: string[] = [];
  const wanted = (name: string): boolean => {
    const info = compressInfo(name);
    if (info.compressState !== "should") return false; // skip already-compressed / non-media
    if (info.compressible === "image") return sel.images;
    if (info.compressible === "video") return sel.videos;
    return false;
  };
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (HARD_SKIP.has(ent.name) || ent.name.startsWith(".")) continue;
        if (sel.recursive) visit(path.join(dir, ent.name), depth + 1);
      } else if (ent.isFile() && wanted(ent.name)) {
        out.push(path.join(dir, ent.name));
      }
    }
  };
  try {
    if (fs.statSync(root).isDirectory()) visit(root, 0);
  } catch {
    /* unreadable root */
  }
  return out;
}

function collapseHome(abs: string): string {
  const home = process.env.HOME ?? "";
  return home && abs.startsWith(home) ? "~" + abs.slice(home.length) : abs;
}
