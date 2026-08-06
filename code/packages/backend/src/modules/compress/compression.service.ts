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
import type { CompressionOutcome } from "@lfb/shared";
import {
  markerPayload,
  isAnyMarker,
  markerCodec,
  canStampInFile,
  readImageMarker,
  stampImageMarker,
  webpmuxStampArgs,
} from "./compress-marker.js";
import {
  encodeImage,
  encodeHeicPrimary,
  probeImage,
  jpegChromaSampling,
  chromaGotCoarser,
} from "./image-encode.js";
import { ledgerSaysDone, writeLedger, buildRecord } from "./compress-ledger.js";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { expandHome, compressInfo } from "../fs/badges.js";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";
import { findStorageRootForPath } from "../storage/storage.service.js";
import { fingerprintImage, fingerprintVideo } from "../media/perceptual.service.js";
import { appendFileEvent, type SidecarSeed, type FileEventInput } from "../storage/file-sidecar.service.js";
import { appendHistory } from "../storage/history-log.service.js";
import { restampOnTransform } from "../storage/decisions.service.js";
import { repoIdFromPath, folderForRepoId } from "../store-model/units.service.js";
import { HARD_SKIP, isMacPackageDir } from "../../shared/scan-filters.js";
import { collectFilesRecursive } from "../../shared/fs-walk.js";
import { enqueue, createBatch } from "../jobqueue/jobqueue.service.js";
import { writeManifest, trackBatch } from "../jobqueue/batch-manifest.service.js";
import { relPosix } from "../../shared/rel-path.js";
import { log } from "../../shared/logging.js";
import { collapseHome } from "../../shared/home-path.js";
import { stableGitBin } from "../git/git-bin.js";

// ── settings (compression.mdx §7) ─────────────────────────────────────────────
export function getCompressionSettings(): CompressionSettings {
  const c = getAppConfig().compression;
  const map = (m: {
    enabled: boolean;
    quality: CompressMediaPrefs["quality"];
    prefer: string[];
    deny: string[];
    convert_types: boolean;
    skip_exts: string[];
    allow_lossless_to_lossy?: boolean;
    png_palette?: boolean;
    guard_chroma?: boolean;
    preserve_chroma?: boolean;
    preset?: string;
  }): CompressMediaPrefs => ({
    enabled: m.enabled,
    quality: m.quality,
    prefer: m.prefer,
    deny: m.deny,
    convertTypes: m.convert_types,
    skipExts: m.skip_exts.map(normExt),
    // Read with explicit fallbacks rather than `?? true`-by-accident: a config written before these keys
    // existed must land on the SAFE value, and for R4 the safe value is "no, do not turn a PNG into a JPEG".
    allowLosslessToLossy: m.allow_lossless_to_lossy ?? false,
    pngPalette: m.png_palette ?? true,
    guardChroma: m.guard_chroma ?? true,
    preserveChroma: m.preserve_chroma ?? true,
    preset: m.preset ?? "slow",
  });
  return {
    images: map(c.images),
    video: map(c.video),
    audio: map(c.audio),
    preserveResolution: c.preserve_resolution,
    replaceOriginalToTrash: c.replace_original_to_trash,
    minSizeGain: c.min_size_gain ?? 0.2,
    minSizeGainLossless: c.min_size_gain_lossless ?? 0.02,
    minSizeGainLosslessToLossy: c.min_size_gain_lossless_to_lossy ?? 0.5,
  };
}

export async function setCompressionSettings(patch: Partial<CompressionSettings>): Promise<CompressionSettings> {
  await updateAppConfig((cfg) => {
    const applyMedia = (
      dst: {
        enabled: boolean;
        quality: string;
        prefer: string[];
        deny: string[];
        convert_types: boolean;
        skip_exts: string[];
        allow_lossless_to_lossy?: boolean;
        png_palette?: boolean;
        guard_chroma?: boolean;
        preserve_chroma?: boolean;
        preset?: string;
      },
      src?: Partial<CompressMediaPrefs>,
    ) => {
      if (!src) return;
      if (src.enabled !== undefined) dst.enabled = src.enabled;
      if (src.quality !== undefined) dst.quality = src.quality;
      if (src.prefer !== undefined) dst.prefer = src.prefer;
      if (src.deny !== undefined) dst.deny = src.deny;
      if (src.convertTypes !== undefined) dst.convert_types = src.convertTypes;
      if (src.skipExts !== undefined) dst.skip_exts = src.skipExts.map(normExt);
      if (src.allowLosslessToLossy !== undefined) dst.allow_lossless_to_lossy = src.allowLosslessToLossy;
      if (src.pngPalette !== undefined) dst.png_palette = src.pngPalette;
      if (src.guardChroma !== undefined) dst.guard_chroma = src.guardChroma;
      if (src.preserveChroma !== undefined) dst.preserve_chroma = src.preserveChroma;
      if (src.preset !== undefined) dst.preset = src.preset as typeof dst.preset;
    };
    applyMedia(cfg.compression.images, patch.images);
    applyMedia(cfg.compression.video, patch.video);
    applyMedia(cfg.compression.audio, patch.audio);
    if (patch.preserveResolution !== undefined) cfg.compression.preserve_resolution = patch.preserveResolution;
    if (patch.replaceOriginalToTrash !== undefined) cfg.compression.replace_original_to_trash = patch.replaceOriginalToTrash;
    if (patch.minSizeGain !== undefined) cfg.compression.min_size_gain = patch.minSizeGain;
    if (patch.minSizeGainLossless !== undefined) cfg.compression.min_size_gain_lossless = patch.minSizeGainLossless;
    if (patch.minSizeGainLosslessToLossy !== undefined) {
      cfg.compression.min_size_gain_lossless_to_lossy = patch.minSizeGainLosslessToLossy;
    }
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
    // oxipng / cwebp / cjpeg are no longer REQUIRED: the image encoders they used to provide now run
    // in-process through sharp, which bundles mozjpeg, libwebp and libpng. That is not a cosmetic change —
    // oxipng was not even installed on this machine, so the "lossless PNG recompress" path the spec
    // promised had silently never been available, and every PNG fell through to the lossy branch instead.
    // The flags are still reported because the settings page shows which tools are present.
    oxipng: onPath("oxipng"),
    cwebp: onPath("cwebp"),
    cjpeg: onPath("cjpeg"),
    jpegoptim: onPath("jpegoptim"),
    // The LOSSLESS JPEG repacker (§3.1) — re-packs an already-lossy JPEG's entropy coding for 3-10% fewer
    // bytes with byte-identical DCT coefficients. mozjpeg's build is preferred; libjpeg-turbo's works too.
    jpegtran: onPath(MOZJPEG_JPEGTRAN) || onPath("jpegtran"),
    // Writes the in-file marker into a WebP's RIFF container (compress-marker.ts). Absent → WebP outputs
    // carry no in-file marker and rely on the compression record instead.
    webpmux: onPath("webpmux"),
    // sharp is a library dependency, not a PATH tool — always available, reported for the settings page.
    sharp: true,
    heif: await magickSupportsHeif(),
  };
}

/**
 * Sweep abandoned transcode temporaries (BUG-9).
 *
 * `tmpOut()` writes candidates to `<state>/tmp/compress-<uuid><ext>`. The happy path renames them away and
 * the guarded failure paths delete them, but a process that is KILLED, crashes, or is OOM-reaped mid
 * transcode leaves its candidate behind forever. Nothing ever collected them: this machine had 146 orphans
 * totalling 11 GB, which is also a record of how often those runs were killed part-way.
 *
 * Called at boot and after each bulk run. Only removes `compress-*` entries older than `maxAgeHours`, so it
 * can never delete a candidate a job currently in flight is still writing.
 */
export function sweepCompressTemp(maxAgeHours = 24): { files: number; bytes: number } {
  const dir = path.join(resolveStateDir(), "tmp");
  let files = 0;
  let bytes = 0;
  try {
    const cutoff = Date.now() - maxAgeHours * 3600_000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("compress-")) continue;
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= cutoff) continue;
        fs.rmSync(p, { force: true, recursive: st.isDirectory() });
        files++;
        bytes += st.size;
      } catch {
        /* a file that vanished under us needs no sweeping */
      }
    }
  } catch {
    return { files, bytes }; // no tmp dir yet → nothing to sweep
  }
  if (files > 0) {
    log.info("compress", `swept ${files} abandoned transcode temp file(s), reclaimed ${(bytes / 1024 / 1024).toFixed(0)} MB`);
  }
  return { files, bytes };
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
// The marker itself lives in compress-marker.ts: a durable "Large File Bridge already compressed this"
// stamp spliced into the compressed file's OWN container metadata, so it rides with the bytes over IPFS,
// through a git checkout, onto a USB stick. Any computer that receives the file knows not to redo the work.
//
// This function is the READ side. Images are answered by a bounded head-slice buffer walk — no child
// process — which matters because this is the single most-called probe in a bulk run (the old code forked
// `magick identify` once per file just to ask "is it marked?"). Video and audio still need ffprobe, since
// their metadata atom is not guaranteed to sit near the front of the container.
async function readMarker(abs: string, media: CompressMedia, tools: CompressTools): Promise<string> {
  try {
    if (media === "video" || media === "audio") {
      if (!tools.ffprobe) return "";
      const r = await run("ffprobe", [
        "-v", "error",
        "-show_entries", "format_tags=comment",
        "-of", "default=noprint_wrappers=1:nokey=1",
        abs,
      ]);
      const out = r.out.trim();
      return isAnyMarker(out) ? out : "";
    }
    const inFile = readImageMarker(abs);
    if (inFile) return inFile;
    // Compatibility fallback: a file marked by the ORIGINAL engine could carry the stamp in a container slot
    // the pure-TS reader does not walk (a TIFF/GIF `comment` tag, say). One fork, only for the formats the
    // fast path cannot answer, and only when the fast path came back empty.
    if (!canStampInFile(abs) && tools.magick) {
      const r = await run(magickBin(), ["identify", "-format", "%c", abs]);
      const out = r.out.trim();
      return isAnyMarker(out) ? out : "";
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Stamp the durable marker onto a freshly-encoded output, LOSSLESSLY.
 *
 * This is the fix for the defect that made files compress over and over: the old engine could only stamp a
 * marker by handing `-set comment` to the ENCODER, so the oxipng (PNG→PNG) and cwebp (→WebP) paths — which
 * take no such flag — wrote no marker at all, and every one of those files was re-encoded on every run
 * forever. Stamping is now a separate post-encode metadata splice that does not care which encoder ran.
 *
 * Video and audio are NOT stamped here: ffmpeg writes their marker inline during the transcode we were
 * already running, which is free. Returns whether the file now carries a marker; false is not a failure —
 * the ledger records the state for formats that have nowhere to put one.
 */
async function stampMarker(out: string, codec: string, tools: CompressTools): Promise<boolean> {
  const text = markerPayload(codec);
  const ext = path.extname(out).toLowerCase();
  if (ext === ".webp") {
    // WebP needs its RIFF container promoted to extended (VP8X) form to hold a metadata chunk. `webpmux`
    // does that surgery without touching the VP8/VP8L bitstream. Absent → no in-file marker, ledger only.
    if (!onPath("webpmux")) return false;
    const tmp = `${out}.mux.tmp`;
    const r = await runAsync("webpmux", webpmuxStampArgs(out, tmp, text), 60_000);
    if (r.code === 0 && safeSize(tmp)) {
      try {
        fs.renameSync(tmp, out);
        return true;
      } catch {
        tryUnlink(tmp);
        return false;
      }
    }
    tryUnlink(tmp);
    return false;
  }
  if (stampImageMarker(out, text)) return true;
  // Last resort for the formats with no pure-TS writer (GIF/TIFF/BMP). These are LOSSLESS targets, so a
  // re-write through ImageMagick costs no quality — but it does cost a pass, so it is the fallback, never
  // the path. A failure here is silent by design: the ledger still records the state.
  if (tools.magick) {
    const tmp = `${out}.mark.tmp${path.extname(out)}`;
    const r = await runAsync(magickBin(), [out, "-set", "comment", text, tmp], 5 * 60_000);
    if (r.code === 0 && safeSize(tmp)) {
      try {
        fs.renameSync(tmp, out);
        return true;
      } catch {
        tryUnlink(tmp);
        return false;
      }
    }
    tryUnlink(tmp);
  }
  return false;
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

/**
 * The two source facts every image plan needs, from ONE in-process metadata read where possible:
 *   * `pages`     — the frame count. > 1 means animated, and a still encoder must never see it (BUG-8).
 *   * `alphaUsed` — whether transparency is actually USED, which is a stronger question than "does the
 *                   file have an alpha channel". An opaque PNG screenshot has a channel that is entirely
 *                   opaque; treating that as "uses alpha" would block safe targets for no reason, and
 *                   treating "has a channel" as "uses it" is precisely the confusion that let the alpha
 *                   guard wave 3,248 opaque screenshots through to a JPEG.
 *
 * The expensive `%[opaque]` fork is only paid when sharp says an alpha channel EXISTS — when there is no
 * channel at all the answer is definitively "not used" and costs nothing.
 */
async function imageShape(abs: string, tools: CompressTools): Promise<{ alphaUsed: boolean | null; pages: number }> {
  const meta = await probeImage(abs);
  if (meta && !meta.hasAlpha) return { alphaUsed: false, pages: meta.pages };
  const alphaUsed = await imageAlphaUsed(abs, tools);
  return { alphaUsed, pages: meta?.pages ?? 1 };
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

// ── the quality ladder (compression.mdx §2.1 R2, LOCKED) ───────────────────────
// The default sits 75% of the way toward BEST quality, not at the midpoint.
//
// The old ladder put "medium" at the exact middle of the band — quality 85 — and that is the number that
// rewrote 3,248 images. The rule is now explicit and the arithmetic is auditable: on the usable JPEG band
// 70..100, 75% toward best is 70 + 0.75 × 30 = 92.5 → q92. Paired with 4:4:4 chroma (image-encode.ts) and
// mozjpeg, which is 15-25% more byte-efficient at the same visual quality — that efficiency is what pays
// for the higher target instead of the files simply getting bigger.
// Where a rung lands is `worst + t × (best − worst)`, and ties ROUND TOWARD BETTER QUALITY — the same rule
// on both bands, so neither can drift toward the smaller file by accident. medium = 70 + 0.75 × 30 = 92.5
// → q93.
const JPEG_BAND = { worst: 70, best: 100 } as const;
export function jpegQuality(q: CompressMediaPrefs["quality"]): number {
  if (q === "lossless") return 100;
  const t = q === "high" ? 0.87 : q === "low" ? 0.27 : 0.75; // medium = the documented 75/25 policy
  return Math.ceil(JPEG_BAND.worst + t * (JPEG_BAND.best - JPEG_BAND.worst));
}

// Same 75/25 policy on the video band, where LOWER CRF is better quality. The usable H.264 band is 28
// (visibly degraded) .. 18 (near-transparent); 75% toward best is 28 − 0.75 × 10 = 20.5 → CRF 20. HEVC's
// band sits ~3 higher for the same perceived quality → CRF 23. Both are paired with `-preset slow`
// (settings), which spends search effort to buy back the bytes the lower CRF costs.
const CRF_BAND: Record<string, { worst: number; best: number }> = {
  h264: { worst: 28, best: 18 },
  hevc: { worst: 31, best: 21 },
  av1: { worst: 40, best: 26 },
};
export function videoCrf(codec: string, q: CompressMediaPrefs["quality"]): number {
  if (q === "lossless") return 0;
  const band = CRF_BAND[codec] ?? CRF_BAND.h264;
  const t = q === "high" ? 0.87 : q === "low" ? 0.27 : 0.75;
  // Floor, not round — on the CRF band LOWER is better, so flooring is the same "toward better quality"
  // tie-break that `Math.ceil` is on the JPEG band. medium H.264 = 28 − 0.75 × 10 = 20.5 → CRF 20.
  return Math.floor(band.worst - t * (band.worst - band.best));
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
  // Was the SOURCE a lossless format (PNG/BMP/TIFF/GIF)? Together with `lossless` this classifies the
  // transform, which is what selects the size-gain floor (R3): lossless→lossless is free and takes the low
  // floor, lossy→lossy takes the 20% floor, and lossless→lossy is the destructive one and takes 50% on top
  // of needing an explicit opt-in.
  losslessSource?: boolean;
  // Multi-frame source (animated GIF / animated WebP). A still encoder handed one of these writes out-0,
  // out-1, … instead of the path we asked for — the failure that left stray frame files in the temp dir —
  // or silently drops every frame but the first.
  animated?: boolean;
}

// A plan may resolve to a deliberate SKIP (not an error, not a tool gap) — e.g. conversion is turned off
// and there is no in-place compressor for this format. The caller reports it as `skipped`.
type PlanResult = Plan | { toolMissing: string } | { skip: string };

/**
 * Choose the output format for an image.
 *
 * THE ORDER OF THE TESTS BELOW *IS* THE POLICY, and it is the single most important change in this file.
 *
 * The old version consulted the user's `prefer` list FIRST, and the shipped default was `["jpeg", …]` with
 * `convert_types: true`. So the very first question asked of a lossless PNG screenshot was "may I make it a
 * JPEG?", the answer was yes, and 3,248 lossless originals became quality-85 4:2:0 JPEGs — after which the
 * originals were deleted. The alpha guard did not stop it, because an opaque screenshot's alpha is UNUSED
 * and the guard only protects transparency that is actually in use.
 *
 * Now `isLosslessSrc` is asked FIRST (R4). A PNG/BMP/TIFF/GIF gets a LOSSLESS target unless the user has
 * deliberately turned `allow_lossless_to_lossy` on — and even then the transform must clear a 50% size
 * floor and keeps the original in trash. This is not a quality-vs-size compromise: measured on the 16 real
 * originals this app destroyed, the lossless path returns 60-78% of the bytes with zero pixel change, where
 * the lossy path took 84-92% and threw the image away.
 */
export function pickImageTarget(
  prefs: CompressMediaPrefs,
  tools: CompressTools,
  srcExt: string,
  alphaUsed: boolean | null,
  pages = 1,
): PlanResult {
  const denied = new Set(prefs.deny);
  const isLosslessSrc = LOSSLESS_IMAGE_EXT.has(srcExt);
  const isHeicFamily = HEIC_FAMILY_EXT.has(srcExt);
  const wantLossless = prefs.quality === "lossless";
  const animated = pages > 1;

  // ── ANIMATION GUARD (BUG-8). A multi-frame source handed to a STILL encoder either writes `out-0.ext,
  // out-1.ext, …` instead of the path we asked for — which is how stray frame files accumulated in the temp
  // directory — or silently keeps only frame 0 and throws the animation away. Neither is acceptable, so a
  // multi-frame source may only go to a target that carries every frame.
  if (animated) {
    if (denied.has("webp")) return { skip: `animated source (${pages} frames) and WebP is denied — nothing can carry the animation` };
    // Animated → lossless animated WebP. Same frames, same pixels, typically far smaller than an animated
    // GIF. This changes the extension, so it obeys the same convert_types gate as any other conversion.
    if (!prefs.convertTypes && srcExt !== ".webp") {
      return { skip: `animated source (${pages} frames) — converting it to animated WebP needs file-type conversion turned on` };
    }
    return {
      media: "images", targetKey: "webp", targetCodec: "WebP (animated)",
      ext: srcExt === ".webp" ? ".webp" : ".webp",
      action: `→ animated WebP (lossless, ${pages} frames)`,
      lossless: true, losslessSource: isLosslessSrc, animated: true,
    };
  }

  // ── HEIC/HEIF/AVIF → JPEG COMPATIBILITY conversion (images.mdx §4). Exists for playability, not
  // shrinkage, so it is exempt from the size-gain floors. Primary-still decoding happens in the encoder.
  if (isHeicFamily) {
    if (!tools.heif) return { toolMissing: "HEIC/HEIF support (reinstall the app's image codecs)" };
    if (alphaUsed === true) {
      if (!denied.has("webp")) {
        return { media: "images", targetKey: "webp", targetCodec: "WebP", ext: ".webp", action: "→ WebP (lossless, keeps alpha)", lossless: true, formatConvert: true };
      }
      return { skip: "HEIC has used transparency and JPEG can't keep it (allow WebP to convert it)" };
    }
    if (!denied.has("jpeg")) {
      return { media: "images", targetKey: "jpeg", targetCodec: "JPEG", ext: ".jpg", action: `→ JPEG (${prefs.quality}, primary image)`, lossless: false, formatConvert: true };
    }
    if (!denied.has("webp")) {
      return { media: "images", targetKey: "webp", targetCodec: "WebP", ext: ".webp", action: `→ WebP (${prefs.quality}, primary image)`, lossless: wantLossless, formatConvert: true };
    }
    return { skip: "JPEG and WebP are both denied for images — nothing to convert HEIC to" };
  }

  // ── R4: A LOSSLESS SOURCE KEEPS A LOSSLESS TARGET. Asked before `prefer` is even read.
  if (isLosslessSrc) {
    const losslessPlan = (): PlanResult => {
      // Format-PRESERVING wherever the format can hold its own lossless re-encode (R6 — no silent
      // renames): a .png stays a .png, so no markdown, HTML, CSS or manifest reference to it can break.
      if (srcExt === ".png") {
        return { media: "images", targetKey: "png", targetCodec: "PNG (lossless)", ext: ".png", action: "lossless recompress (same pixels)", lossless: true, losslessSource: true };
      }
      // BMP / TIFF / single-frame GIF have no useful in-place lossless recompression — PNG is their
      // lossless home. That IS a rename, so it needs file-type conversion turned on.
      if (!prefs.convertTypes) {
        return { skip: `${srcExt} compresses losslessly only by becoming a PNG, and file-type conversion is turned off` };
      }
      if (denied.has("png")) return { skip: "PNG is denied for images — nothing lossless to convert this to" };
      return { media: "images", targetKey: "png", targetCodec: "PNG (lossless)", ext: ".png", action: "→ PNG (lossless, same pixels)", lossless: true, losslessSource: true };
    };
    // The destructive path, and it takes THREE deliberate settings to reach: conversion on, the R4 opt-in
    // on, and a non-lossless quality. It still has to clear the 50% floor downstream, and the original
    // still goes to trash rather than being deleted.
    if (prefs.convertTypes && prefs.allowLosslessToLossy === true && !wantLossless) {
      for (const key of prefs.prefer) {
        const t = IMAGE_TARGETS[key];
        if (!t || denied.has(key)) continue;
        if (!t.alpha && alphaUsed !== false) continue; // would drop transparency → steer past it
        if (key === "webp") {
          return { media: "images", targetKey: "webp", targetCodec: "WebP", ext: ".webp", action: `→ WebP (${prefs.quality}) — lossless source, opted in`, lossless: false, losslessSource: true };
        }
        if (key === "jpeg") {
          return { media: "images", targetKey: "jpeg", targetCodec: "JPEG", ext: ".jpg", action: `→ JPEG (${prefs.quality}) — lossless source, opted in`, lossless: false, losslessSource: true };
        }
      }
    }
    return losslessPlan();
  }

  // ── An ALREADY-LOSSY source (JPEG / WebP) is ALWAYS re-encoded FORMAT-PRESERVING. Two reasons, and both
  // are rules elsewhere in this file:
  //
  //   * R6 — a JPEG→WebP conversion RENAMES the file, and every markdown / HTML / CSS / manifest reference
  //     to it breaks. A shipped default must not do that silently. (This is not hypothetical: with
  //     `prefer: ["webp", …]` the engine converted every .jpg on the machine to .webp.)
  //   * The information a lossy source threw away is gone. Passing it through a DIFFERENT lossy codec
  //     cannot recover any of it and adds a second generation of loss for a marginal byte win.
  //
  // A user who genuinely wants a different container has the explicit convert action for it (§8.1), which
  // is a deliberate, per-file choice rather than a side effect of a compress sweep. The caller additionally
  // runs the "is the source already at or below our target?" test (BUG-6) before spending anything here.
  return {
    media: "images",
    targetKey: srcExt === ".webp" ? "webp" : "jpeg",
    targetCodec: srcExt === ".webp" ? "WebP" : "JPEG",
    ext: srcExt,
    action: `re-encode (${prefs.quality})`,
    lossless: false,
  };
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
  return {
    media: "video", targetKey: key, targetCodec: t.label, ext,
    action: `→ ${t.label} (${prefs.quality}, CRF ${videoCrf(key, prefs.quality)}, preset ${prefs.preset ?? "slow"})`,
    lossless: prefs.quality === "lossless",
    // A FORCED codec is the compatibility convert (codecs.mdx §5): its job is universal playability, so it
    // is exempt from the size-gain floors and is the one case allowed to normalise chroma to yuv420p.
    formatConvert: Boolean(force),
  };
}

/**
 * The output pixel format for a video encode — R1 applied to video.
 *
 * The old engine hard-coded `-pix_fmt yuv420p` on every transcode. For a 4:2:0 source that is a no-op, but
 * for a 4:2:2 or 4:4:4 source it SILENTLY HALVES the colour planes: exactly the image 4:2:0 defect, in the
 * other media type, and equally invisible to a guard that only compares width and height.
 *
 * So: keep the source's chroma when it is finer than 4:2:0 and the encoder can carry it. The one exemption
 * is a COMPATIBILITY convert, where normalising to yuv420p is the entire point — a High 4:4:4 Predictive
 * H.264 stream is not playable in most places, and that conversion exists to make a file playable.
 */
export function videoPixFmt(srcPixFmt: string, prefs: CompressMediaPrefs, isCompatConvert: boolean): string {
  const f = (srcPixFmt || "").toLowerCase();
  if (isCompatConvert || prefs.preserveChroma === false) return "yuv420p";
  // Already 4:2:0 (or unknown) → yuv420p is not a reduction, and it is the safest, most playable choice.
  if (!f || f.includes("420")) return "yuv420p";
  // Finer than 4:2:0. Preserve it rather than throw colour resolution away. x264/x265 pick the profile that
  // carries it automatically once the pixel format asks for it.
  if (f.includes("444")) return f.includes("10") ? "yuv444p10le" : "yuv444p";
  if (f.includes("422")) return f.includes("10") ? "yuv422p10le" : "yuv422p";
  if (f.includes("10")) return "yuv420p10le";
  return "yuv420p";
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
    const { alphaUsed, pages } = await imageShape(abs, tools);
    const plan = pickImageTarget(prefs, tools, srcExt, alphaUsed, pages);
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
  // BUG-9 — the temp path is hoisted out of the body so the `finally` at the very bottom can sweep it on
  // EVERY exit, including an exception thrown between the encode and the replace. The old code only
  // unlinked on the paths it explicitly returned from, which is how 146 orphaned temp files totalling 11 GB
  // accumulated from runs that were killed part-way.
  let tmpPath: string | null = null;
  try {
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

    // ── §8.4 — HAVE WE ALREADY DEALT WITH THIS FILE? Asked of THREE independent sources before a single
    // byte is transcoded, because compressing a file twice is not merely wasted work: for a lossy target it
    // stacks a fresh generation of loss on the last one. Any source saying "done" stops us.
    const done = await alreadyHandled(abs, media, tools, beforeBytes);
    if (done) {
      return { path: abs, status: "skipped", reason: done.reason, beforeBytes, afterBytes: beforeBytes, codec: check.targetCodec };
    }

    const prefs = media === "images" ? settings.images : settings.video;
    const srcExt = path.extname(abs).toLowerCase();
    const shape = media === "images" ? await imageShape(abs, tools) : { alphaUsed: check.alphaUsed, pages: 1 };
    const plan = media === "images"
      ? pickImageTarget(prefs, tools, srcExt, shape.alphaUsed, shape.pages)
      : pickVideoTarget(prefs, tools, srcExt, forceVideoCodec);
    if ("toolMissing" in plan) return fail(abs, `needs ${plan.toolMissing}`, "failed", beforeBytes);
    if ("skip" in plan) return fail(abs, plan.skip, "skipped", beforeBytes);

    // ── BUG-6 — DO NOT RE-ENCODE A FILE THAT IS ALREADY AT OR BELOW OUR TARGET. A JPEG that arrived from a
    // phone or a social network is already lossy; re-encoding it cannot recover information that is gone,
    // it can only add a second generation of DCT error on top of the first. When the source is already at
    // or under the target quality the ONLY transform worth doing is a lossless entropy repack, which
    // encodeImageCandidate picks automatically — so all this test does is refuse the genuinely destructive
    // case where a repack is not available either.
    const srcQ = media === "images" && (srcExt === ".jpg" || srcExt === ".jpeg")
      ? await jpegSourceQuality(abs, tools)
      : null;

    // §8.0 — capture the BEFORE state FIRST, before we touch a byte: the original's exact content hash +
    // size and (video/image) its perceptual fingerprint, plus its source codec. Once the replace runs, the
    // original only exists in trash, so "what it was" must be recorded now. All best-effort (guarded).
    const beforeCap = exactHashAndSize(abs);
    const srcCodec = await sourceCodecLabel(abs, media, tools);
    const fingerprintBefore = await perceptualFingerprint(abs, media);

    const out = tmpOut(plan.ext);
    tmpPath = out;
    // The INPUT half of the §5.1 integrity gate + the §5 resolution guard below. The type is written out on
    // purpose: it is what makes tsc reject a probe left un-awaited here (a Promise is ALWAYS truthy, so a
    // missing await would turn the `!outDims` gate below into a permanent false and let corrupt output
    // replace the user's original — silent data loss). One probe per file, not three.
    const inInfo = media === "images" ? null : await videoInfo(abs, tools);
    const inDims: { w: number; h: number } | null =
      media === "images" ? await imageDims(abs, tools) : (inInfo ? { w: inInfo.w, h: inInfo.h } : null);
    // The CHROMA half of the resolution rule — captured before, compared after. `%w %h` reports the LUMA
    // plane only, which is exactly why the old guard could report "resolution unchanged" while the two
    // colour planes had been halved in both axes.
    const inChroma = media === "images" ? jpegChromaSampling(abs) : (inInfo?.pixFmt ?? "");

    let how = "";
    // The encoder's VERIFIED verdict, which is not the same thing as the plan's intent. `plan.lossless` is
    // what we asked for; `wasLossless` is what we got and checked. Everything downstream — which size floor
    // applies, what the record says, what the log claims — reads the verified fact, never the intent.
    let wasLossless = plan.lossless === true;
    if (media === "images") {
      const enc = await encodeImageCandidate(plan, abs, out, prefs, tools, srcQ);
      if (!enc.ok) {
        return fail(abs, enc.reason ?? "image encode failed", enc.declined ? "skipped" : "failed", beforeBytes);
      }
      how = enc.how;
      wasLossless = enc.lossless;
      // A plan that PROMISED lossless and did not deliver it must never replace the user's file. This
      // cannot happen today (encodePng copies the source through rather than emit a lossy fallback), and
      // this is the belt that keeps it that way if a future encoder is added.
      if (plan.lossless === true && !enc.lossless) {
        return fail(abs, "refused: the lossless encode could not be verified as lossless; original kept", "blocked", beforeBytes);
      }
    } else {
      const t = VIDEO_TARGETS[plan.targetKey];
      // -threads caps a BATCHED job to its slice (parallelization.mdx §2); a one-off compress omits it so
      // ffmpeg uses its all-core default. 0 would mean "auto/all cores" to ffmpeg — so only pass when > 0.
      const threadArgs = o.threads && o.threads > 0 ? ["-threads", String(o.threads)] : [];
      const pixFmt = videoPixFmt(inInfo?.pixFmt ?? "", prefs, Boolean(plan.formatConvert));
      const crf = videoCrf(plan.targetKey, prefs.quality);
      const preset = prefs.preset ?? "slow";
      how = `${t.label} CRF ${crf} preset ${preset} ${pixFmt}`;
      // §8.4 — the in-file marker is stamped INLINE here (free — no extra pass): `-metadata comment=…`
      // writes it into the output's moov/udta, so a re-run, or another of the user's computers that
      // receives this file, reads it back and skips the work.
      const args = [
        "-y", "-i", abs,
        "-c:v", t.encoder, ...threadArgs,
        "-crf", String(crf),
        "-preset", preset,
        "-pix_fmt", pixFmt,
        "-c:a", "copy",
        "-movflags", "+use_metadata_tags",
        "-metadata", `comment=${markerPayload(plan.targetKey)}`,
        out,
      ];
      const r = await runAsync("ffmpeg", args);
      if (r.code !== 0 || !safeSize(out)) {
        return fail(abs, `ffmpeg failed: ${(r.err || "").split("\n").slice(-3).join(" ").slice(0, 200)}`, "failed", beforeBytes);
      }
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
      return fail(abs, "refused: compressed output is unreadable/corrupt — could not verify its dimensions; original kept", "blocked", beforeBytes);
    }
    if (settings.preserveResolution && inDims && outDims && (inDims.w !== outDims.w || inDims.h !== outDims.h)) {
      return fail(abs, `refused: resolution changed ${inDims.w}×${inDims.h} → ${outDims.w}×${outDims.h}`, "blocked", beforeBytes);
    }

    // ── R1's SECOND HALF — CHROMA (BUG-1). The check above compares `%w %h`, which are the LUMA plane's
    // dimensions. The two COLOUR planes have their own resolution, and a 4:2:0 encode stores them at half
    // width AND half height — a quarter of the colour detail — while `%w %h` reports no change at all. That
    // is how 3,248 images were subsampled past a guard that was, on its own terms, working correctly.
    // The encoder is now told 4:4:4 explicitly (image-encode.ts CHROMA_444) and this is the verification.
    const outChroma = media === "images" ? jpegChromaSampling(out) : ((await videoInfo(out, tools))?.pixFmt ?? "");
    if (prefs.guardChroma !== false && media === "images" && chromaGotCoarser(inChroma, outChroma)) {
      return fail(abs, `refused: colour resolution dropped (chroma ${inChroma || "?"} → ${outChroma || "?"}) — this is a resolution reduction; original kept`, "blocked", beforeBytes);
    }
    if (media === "video" && prefs.preserveChroma !== false && !plan.formatConvert && chromaCoarserPixFmt(inChroma, outChroma)) {
      return fail(abs, `refused: colour resolution dropped (pixel format ${inChroma} → ${outChroma}); original kept`, "blocked", beforeBytes);
    }

    const afterBytes = fs.statSync(out).size;

    // ── R3 — THE SIZE-GAIN FLOOR (BUG-3). The old gate was `afterBytes >= beforeBytes`: ANY reduction, even
    // one byte, was accepted. That is how a lossless PNG was destroyed for a 1.4% saving (Document.png,
    // 56,243 → 55,440 bytes) and another for 10.2%. A compress is only worth committing when it actually
    // wins, and how big a win it must be depends on WHAT IS BEING TRADED:
    //
    //   lossless → lossless   nothing is traded, so any real gain is free money  (min_size_gain_lossless)
    //   lossy    → lossy      quality is being spent                             (min_size_gain, 20%)
    //   lossless → lossy      the destructive one — needs the opt-in AND a big win (…_lossless_to_lossy, 50%)
    //   compatibility convert exists for playability, not shrinkage               (exempt, may grow)
    const gain = beforeBytes != null && beforeBytes > 0 ? 1 - afterBytes / beforeBytes : 1;
    const floor = plan.losslessSource && !wasLossless
      ? settings.minSizeGainLosslessToLossy
      : wasLossless
        ? settings.minSizeGainLossless
        : settings.minSizeGain;
    if (!plan.formatConvert && gain < floor) {
      const reason =
        `kept the original — the best candidate was only ${(gain * 100).toFixed(1)}% smaller` +
        ` (needs ${(floor * 100).toFixed(0)}%${plan.losslessSource && !wasLossless ? ", because this would trade a lossless original for a lossy copy" : ""})`;
      // RECORD THE REFUSAL (§8.4). Without this the file carries no memory of the decision and every later
      // sweep pays the full transcode again to reach the identical conclusion — which is most of why files
      // felt like they were being compressed over and over.
      recordOutcome(abs, abs, {
        outcome: "declined", codec: plan.targetKey, size: beforeBytes ?? afterBytes,
        originalSize: beforeBytes ?? afterBytes, reason, chroma: inChroma, lossless: true, engine: how,
      });
      return { path: abs, status: "skipped", reason, beforeBytes, afterBytes, codec: check.targetCodec };
    }

    // ── §8.4 — STAMP THE DURABLE MARKER, before the replace, so the bytes that land in the user's tree are
    // already marked. Video/audio were marked inline by ffmpeg; images are stamped here by a lossless
    // metadata splice. This is the fix for the paths that previously wrote NO marker at all (the PNG and
    // WebP encoders took no comment flag), which is why those files were re-encoded on every single run.
    let marked = media !== "images";
    if (media === "images") {
      marked = await stampMarker(out, plan.targetKey, tools);
      if (!marked) {
        log.debug("compress", `${path.basename(out)}: format carries no in-file marker — relying on the compression record`);
      }
      // The splice rewrote the file; re-read its size so the record and the log line are truthful.
    }
    const finalBytes = fs.statSync(out).size;

    // §8 — replace: dispose the original, then move temp → final path (new ext if the format changed).
    // Disposition: a per-call `deleteOriginal` (the "Compress inside" dialog's per-run radio,
    // compress_inside.mdx §4) wins; otherwise the global recoverable-by-default (settings). This runs
    // ONLY here — after the temp verified resolution, chroma, integrity and the size floor — so a file that
    // failed to compress NEVER reaches this point and its original is never touched (the transactional rule).
    const disposition: DeleteOriginalMode =
      o.deleteOriginal ?? (settings.replaceOriginalToTrash ? "trash" : "hard");
    const finalPath = path.join(path.dirname(abs), path.basename(abs, path.extname(abs)) + plan.ext);
    try {
      if (disposition === "trash") trashOriginal(abs);
      else fs.unlinkSync(abs);
      fs.renameSync(out, finalPath);
      tmpPath = null; // the temp is now the user's file — the finally must not delete it
    } catch (e) {
      return fail(abs, `replace failed: ${(e as Error).message}`, "failed", beforeBytes);
    }
    log.info(
      "compress",
      `${abs} → ${finalPath} (${how}) ${beforeBytes}→${finalBytes} bytes, ${(gain * 100).toFixed(1)}% smaller` +
        `, chroma ${outChroma || "n/a"}${wasLossless ? ", LOSSLESS" : ""}${marked ? "" : ", no in-file marker"}`,
    );

    // The travelling compression record — the SECOND and THIRD answers to "was this already compressed?".
    // It is written to Local Storage and mirrored from there into the owning company / Personal sync repo,
    // so the user's OTHER computers know this file is finished even when its format could not carry an
    // in-file marker. Best-effort: the bytes are already replaced, so this can never fail a compression.
    recordOutcome(abs, finalPath, {
      outcome: "compressed", codec: plan.targetKey, size: finalBytes,
      originalSize: beforeBytes ?? finalBytes, reason: null, chroma: outChroma,
      lossless: wasLossless, engine: how,
    });

    // ── BUG-7 — a format change RENAMES the file, and every markdown / HTML / CSS / manifest reference to
    // the old name is now a dead link. We do not silently edit the user's source files (charter: we surface
    // and offer, we do not act on files nobody selected) — so we find the references and report them.
    const renamedFrom = path.basename(finalPath) !== path.basename(abs) ? path.basename(abs) : null;
    const referencedBy = renamedFrom ? await findReferences(abs, renamedFrom) : [];
    if (referencedBy.length > 0) {
      log.warn(
        "compress",
        `${renamedFrom} → ${path.basename(finalPath)}: ${referencedBy.length} file(s) still reference the old name — ${referencedBy.slice(0, 5).join(", ")}${referencedBy.length > 5 ? ", …" : ""}`,
      );
    }

    // §8.0 — capture the AFTER state on the RESULT file (exact hash + size, post perceptual fingerprint),
    // then append ONE per-file sidecar event + a history line to the owning repo, and re-stamp any team
    // decision across a format change. ALL best-effort (guarded): the bytes are already safely replaced by
    // this point, so a tracking-write failure must NEVER surface as a compression failure or lose the file.
    try {
      const repoRoot = findStorageRootForPath(finalPath);
      if (repoRoot) {
        const relFinal = relPosix(repoRoot, finalPath);
        // A format change (extension differs) is a CONVERT (HEIC→JPEG / GIF→PNG) and moves the file to a
        // new path; a same-extension re-encode is a COMPRESS in place. This split drives the event kind,
        // the format:{from,to} field, and whether a decision re-stamp is needed (only on a path change).
        const oldExt = path.extname(abs).toLowerCase();
        const isConvert = oldExt !== plan.ext.toLowerCase();

        const afterCap = exactHashAndSize(finalPath);
        const fingerprintAfter = await perceptualFingerprint(finalPath, media);

        const seed: SidecarSeed = {
          name: path.basename(finalPath),
          categories: [media === "images" ? "image" : "video"],
          size: afterCap.size ?? finalBytes,
          hash: afterCap.hash,
          fingerprint: fingerprintAfter,
        };
        const event: FileEventInput = {
          kind: isConvert ? "convert" : "compress",
          before: { hash: beforeCap.hash, size: beforeCap.size ?? beforeBytes },
          after: { hash: afterCap.hash, size: afterCap.size ?? finalBytes },
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
          summary:
            `${isConvert ? "Converted" : "Compressed"} ${relFinal} (${how}) ${srcCodec}→${plan.targetKey} ` +
            `${beforeBytes}→${finalBytes} bytes${wasLossless ? ", lossless (renders identically)" : ""}` +
            `${referencedBy.length ? `; ${referencedBy.length} file(s) still reference "${renamedFrom}"` : ""}`,
        });

        // §12 (decisions.mdx) — a format change moves the file to a new path, which the decision fold keys
        // on; re-stamp the team's existing pin/ignore choice onto the new path so a decided file stays
        // decided. Skipped for an in-place compress (same path → decision key unchanged).
        if (isConvert) {
          const folder = folderForRepoId(repoIdFromPath(repoRoot));
          if (folder) {
            const oldRel = relPosix(repoRoot, abs);
            await restampOnTransform(folder, oldRel, relFinal, o.by ?? null);
          }
        }
      }
    } catch (e) {
      log.warn("compress", `sidecar/history capture skipped: ${(e as Error).message}`);
    }

    return {
      path: finalPath,
      status: "compressed",
      reason: wasLossless ? "lossless — renders identically, smaller file" : null,
      beforeBytes,
      afterBytes: finalBytes,
      codec: check.targetCodec,
      renamedFrom: renamedFrom ?? undefined,
      staleReferences: referencedBy.length || undefined,
    };
  } finally {
    // BUG-9 — the ONE place a temp is swept, reached on every exit including a thrown exception. On the
    // happy path `tmpPath` was cleared at the rename, so this is a no-op there.
    if (tmpPath) tryUnlink(tmpPath);
  }
}

// ── the "already handled?" gate (§8.4) ─────────────────────────────────────────
/**
 * Ask all three sources whether this file is finished, and report which one answered.
 *
 * Cheapest first: the in-file marker is a bounded buffer read (or one ffprobe for video/audio), and the
 * ledger lookup is a couple of `stat`s. Both are far cheaper than the transcode they prevent.
 *
 * When one source knows and another does not, we BACKFILL the one that does not — so a file that arrived
 * from another computer already compressed gets a record here on first sight, and a file whose record
 * exists but whose bytes lost their marker gets re-marked. Otherwise the Compress status would keep
 * counting the file "compressible" forever on whichever machine holds the gap.
 */
async function alreadyHandled(
  abs: string,
  media: CompressMedia,
  tools: CompressTools,
  currentBytes: number | null,
): Promise<{ reason: string } | null> {
  const marker = await readMarker(abs, media, tools);
  const hasMarker = isAnyMarker(marker);

  const root = safeStorageRoot(abs);
  const rel = root ? relPosix(root, abs) : null;
  const hit = root && rel ? ledgerSaysDone(root, rel) : null;

  if (!hasMarker && !hit) return null;

  if (hasMarker && !hit && currentBytes != null) {
    // The marker rode in WITH the bytes — a peer compressed this file and it pinned over IPFS, or an older
    // engine did it here before records existed. This machine holds no record, so write one.
    recordOutcome(abs, abs, {
      outcome: "compressed", codec: markerCodec(marker), size: currentBytes, originalSize: currentBytes,
      reason: "recorded from the file's own marker (compressed elsewhere)", chroma: null,
      lossless: false, engine: marker,
    });
  }
  if (!hasMarker && hit && media === "images" && canStampInFile(abs)) {
    // The record says done but the bytes carry no marker — typically because the file was compressed by an
    // engine version that could not stamp this format. Stamp it now, so the file itself carries the answer
    // from here on and no computer that receives it has to consult a record at all.
    const codec = hit.record.compressed?.codec ?? path.extname(abs).replace(/^\./, "");
    if (stampImageMarker(abs, markerPayload(codec))) {
      log.debug("compress", `${abs}: back-stamped the in-file marker from the compression record`);
    }
  }

  if (hasMarker) return { reason: "already compressed (the file carries our marker)" };
  const outcome = hit?.record.outcome ?? "compressed";
  return {
    reason: outcome === "declined"
      ? `already reviewed — ${hit?.record.reason ?? "compressing it was not worth the quality cost"}`
      : "already compressed on this or another of your computers (compression record)",
  };
}

/** findStorageRootForPath, but it can never throw into the compress path. */
function safeStorageRoot(abs: string): string | null {
  try {
    return findStorageRootForPath(abs);
  } catch {
    return null;
  }
}

/**
 * Write the terminal outcome to the ledger — Local Storage, mirrored from there into the owning company /
 * Personal sync repo so the user's other computers inherit the answer. Called for EVERY terminal outcome,
 * `declined` included. Best-effort by contract; never throws into the compress path.
 */
function recordOutcome(
  originalAbs: string,
  finalAbs: string,
  args: {
    outcome: CompressionOutcome;
    codec: string | null;
    size: number;
    originalSize: number;
    reason: string | null;
    chroma: string | null;
    lossless: boolean;
    engine: string | null;
  },
): void {
  try {
    const root = safeStorageRoot(finalAbs);
    if (!root) return; // a file outside every tracked storage has only its in-file marker — by design
    const rel = relPosix(root, finalAbs);
    writeLedger(
      root,
      rel,
      buildRecord({
        rel,
        originalName: path.basename(originalAbs),
        originalExt: path.extname(originalAbs).replace(/^\./, ""),
        originalSize: args.originalSize,
        outcome: args.outcome,
        codec: args.codec,
        size: args.size,
        reason: args.reason,
        chroma: args.chroma,
        lossless: args.lossless,
        engine: args.engine,
      }),
    );
  } catch (e) {
    log.warn("compress", `compression record skipped: ${(e as Error).message}`);
  }
}

/** Is `after` a coarser video chroma than `before`? (yuv444 → yuv422 → yuv420.) Unknown → false. */
export function chromaCoarserPixFmt(before: string, after: string): boolean {
  const rank = (f: string): number => {
    const s = (f || "").toLowerCase();
    if (s.includes("444")) return 3;
    if (s.includes("422")) return 2;
    if (s.includes("420")) return 1;
    return 0;
  };
  const a = rank(before);
  const b = rank(after);
  return a > 0 && b > 0 && b < a;
}

/**
 * Which text files still point at a renamed image (BUG-7).
 *
 * We do NOT rewrite them. Compressing an image is consent to change THAT image, not consent to edit every
 * markdown and stylesheet in the repo — the same "surface and offer, never act on files nobody selected"
 * rule the charter applies to `.gitignore` entries. So this reports, and the report reaches the log, the
 * history line and the compress result.
 *
 * `git grep` is used when the file is inside a git work tree because it is indexed and bounded; outside
 * one we skip the search rather than walk an unbounded tree on an interactive path.
 */
async function findReferences(abs: string, oldBasename: string): Promise<string[]> {
  try {
    const dir = path.dirname(abs);
    // stableGitBin(), never a bare "git": a compress job runs on the queue worker, whose PATH need not
    // contain git — and a non-zero code here is read as "no references", so a missing binary would quietly
    // report a clean rename over files that still point at the old name.
    const top = await runAsync(stableGitBin(), ["-C", dir, "rev-parse", "--show-toplevel"], 10_000, {
      captureStdout: true,
    });
    const repo = top.out.trim();
    if (top.code !== 0 || !repo) return [];
    const r = await runAsync(
      stableGitBin(),
      // `core.quotepath=false` — git octal-escapes any non-ASCII path it PRINTS, so without this the
      // warning below names `"caf\303\251.md"` instead of the file the user would recognise.
      ["-c", "core.quotepath=false", "-C", repo, "grep", "-l", "--fixed-strings", "-I", "--", oldBasename],
      30_000,
      { captureStdout: true },
    );
    // git grep exits 1 when there are no matches — that is the normal, good case, not an error.
    if (r.code !== 0) return [];
    return r.out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 200);
  } catch {
    return [];
  }
}

/**
 * Produce the candidate output for an image, choosing between the LOSSLESS and the LOSSY route.
 *
 * This replaces the old `imageCommand()`, which built an ImageMagick argv and let ImageMagick decide
 * everything it was not told — including chroma subsampling, which it sets to 4:2:0 for any quality below
 * 90. Nothing is left to an encoder's default here.
 *
 * The extra intelligence over "just run the encoder" is the LOSSLESS REPACK for an already-lossy source. A
 * JPEG that arrived from a phone or a social network has already spent its quality; re-encoding it can only
 * add a second generation of loss. But its entropy coding can almost always be re-packed — same DCT
 * coefficients, same pixels, 3-10% fewer bytes — by `jpegtran`. So when the source is already at or below
 * our quality target, we take the free win and refuse the destructive one.
 */
async function encodeImageCandidate(
  plan: Plan,
  abs: string,
  out: string,
  prefs: CompressMediaPrefs,
  tools: CompressTools,
  srcQuality: number | null,
): Promise<{ ok: boolean; reason?: string; declined?: boolean; how: string; lossless: boolean }> {
  const quality = jpegQuality(prefs.quality);
  const srcExt = path.extname(abs).toLowerCase();
  const opts = {
    quality,
    lossless: plan.lossless === true,
    animated: plan.animated === true,
    tryPalette: prefs.pngPalette !== false,
  };

  // HEIC / HEIF / AVIF → the PRIMARY still only (images.mdx §4.1, LOCKED). A HEIC is a container that may
  // also hold thumbnails, depth/auxiliary images and (Live Photos) a motion clip; `page: 0` pins the pitm
  // primary image so none of those can be selected instead.
  if (HEIC_FAMILY_EXT.has(srcExt)) {
    const r = await encodeHeicPrimary(plan.targetKey, abs, out, opts);
    return { ok: r.ok, reason: r.reason, how: r.how, lossless: r.lossless };
  }

  // An already-lossy JPEG staying a JPEG. Prefer the free, lossless repack (BUG-6).
  const jpegInPlace = (srcExt === ".jpg" || srcExt === ".jpeg") && plan.targetKey === "jpeg" && plan.ext === srcExt;
  if (jpegInPlace && srcQuality != null && srcQuality <= quality + 2) {
    if (tools.jpegtran) {
      const r = await runAsync(
        jpegtranBin(),
        ["-copy", "all", "-optimize", "-progressive", "-outfile", out, abs],
        10 * 60_000,
      );
      if (r.code === 0 && safeSize(out)) {
        return { ok: true, how: `jpegtran lossless repack (source already q${srcQuality} ≤ target q${quality})`, lossless: true };
      }
      tryUnlink(out);
    }
    // No repacker available, and re-encoding would be pure generation loss. Declining is the right answer,
    // and `declined: true` makes the caller report it as a deliberate skip rather than a failure.
    return {
      ok: false,
      declined: true,
      how: "",
      lossless: false,
      reason: `kept the original — it is already at quality ${srcQuality}, at or below our target of ${quality}; re-encoding it would only lose detail`,
    };
  }

  const r = await encodeImage(plan.targetKey, abs, out, opts);
  return { ok: r.ok, reason: r.reason, how: r.how, lossless: r.lossless };
}

/** mozjpeg's `jpegtran` when it is installed (it re-packs measurably better), else the one on PATH. */
function jpegtranBin(): string {
  return onPath(MOZJPEG_JPEGTRAN) ? MOZJPEG_JPEGTRAN : "jpegtran";
}
const MOZJPEG_JPEGTRAN = "/opt/homebrew/opt/mozjpeg/bin/jpegtran";

/**
 * The source JPEG's quality, as ImageMagick estimates it from its quantisation tables.
 *
 * CAVEAT, and it matters: this is an ESTIMATE derived from the tables, and mozjpeg uses different tables
 * from libjpeg — a file we ourselves wrote at q92 reads back as roughly 80. So this number must never be
 * the only thing standing between a file and a re-encode. It is not: our own outputs carry the in-file
 * marker and never reach this function, and anything that does get re-encoded still has to clear the 20%
 * size floor afterwards. This is a heuristic that avoids obviously-pointless work, not a safety guard.
 */
async function jpegSourceQuality(abs: string, tools: CompressTools): Promise<number | null> {
  if (!tools.magick) return null;
  try {
    const r = await run(magickBin(), ["identify", "-format", "%Q", abs]);
    const q = Number(r.out.trim());
    return Number.isFinite(q) && q > 0 && q <= 100 ? q : null;
  } catch {
    return null;
  }
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

