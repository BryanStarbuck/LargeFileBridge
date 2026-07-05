// Media streaming + probe backend (media_viewer.mdx §2). Three concerns:
//   1. Signed grants  — a short-lived HMAC over (absPath, expMs) so a plain <img>/<video> element
//      (which cannot send a Bearer header) can load bytes the allow-listed session was granted.
//   2. Raw streaming  — same-origin file serving with HTTP Range (206) so video seeks/streams. This is
//      ordinary file serving to the signed-in user's OWN browser — NOT an IPFS gateway/relay (charter).
//   3. Probe          — a best-effort, LOCAL-ONLY, NO-SHELL sniff of container/codec/dimensions. The
//      charter forbids shell (no ffprobe); we read a bounded header (+ tail for video) and report only
//      what we can determine. Every field degrades to null.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { MediaProbe } from "@lfb/shared";
import { expandHome } from "../fs/badges.js";
import { assertAllowedPath } from "../fs/allow-root.js";
import { log } from "../../shared/logging.js";

// Per-process signing key. Tokens naturally invalidate on restart — fine for a viewer (media_viewer §2).
const MEDIA_SECRET = crypto.randomBytes(32);
// Short grant TTL (security audit finding 10): the URL is a bearer capability (a plain <img>/<video>
// can't send a Bearer header), so keep the window small — minutes, enough to (re)buffer a viewing
// session — rather than the old ≈6h that turned a leaked URL into a long-lived read capability.
const GRANT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface ResolvedFile {
  abs: string;
  size: number;
}

/** Resolve to an existing REGULAR file (never a directory), confined to the allow-roots, or throw.
 *  Shared by grant + raw (security audit finding 2 — never stream a file outside the browse roots). */
export function resolveMediaFile(input: string | undefined): ResolvedFile {
  const raw = (input && input.trim()) || "";
  if (!raw) throw new Error("path required");
  const abs = path.resolve(expandHome(raw));
  if (abs.includes("\0")) throw new Error("invalid path");
  const confined = assertAllowedPath(abs); // throws "path not allowed" for an out-of-root/secret path
  const st = fs.statSync(confined); // throws ENOENT → 404 upstream
  if (!st.isFile()) throw new Error("not a file");
  return { abs: confined, size: st.size };
}

// ── Signed grants ──────────────────────────────────────────────────────────────
// The grant binds the absolute path, the expiry, AND the minting session id (security audit
// finding 10): a tampered sid changes the signature, so a grant is scoped to the session that minted
// it and can't be silently re-attributed.
function sign(abs: string, expMs: number, sid: string): string {
  return crypto.createHmac("sha256", MEDIA_SECRET).update(`${abs}\n${expMs}\n${sid}`).digest("hex");
}

/** Mint a same-origin, Range-capable URL for one file. Caller must be allow-listed (router gates it);
 *  `sid` is the caller's session id, bound into the signed grant. */
export function mintGrant(input: string | undefined, sid: string | null): { url: string } {
  const { abs } = resolveMediaFile(input);
  const session = sid || "anon";
  const expMs = Date.now() + GRANT_TTL_MS;
  const t = sign(abs, expMs, session);
  const qs = new URLSearchParams({ path: abs, e: String(expMs), s: session, t });
  return { url: `/api/media/raw?${qs.toString()}` };
}

/** Verify a raw request's token. Returns the resolved file, or throws on expiry/forgery/missing file. */
export function verifyGrant(
  input: string | undefined,
  e: string | undefined,
  s: string | undefined,
  t: string | undefined,
): ResolvedFile {
  const file = resolveMediaFile(input); // also re-checks it's still a real file (and still confined)
  const expMs = Number(e);
  if (!Number.isFinite(expMs) || expMs < Date.now()) throw new Error("grant expired");
  const expected = sign(file.abs, expMs, s || "anon");
  const got = (t || "").trim();
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    throw new Error("bad grant");
  }
  return file;
}

// ── MIME (raw Content-Type) ──────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".webm": "video/webm", ".avi": "video/x-msvideo", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
  ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv", ".ts": "video/mp2t",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".heic": "image/heic", ".heif": "image/heif", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".aac": "audio/aac",
  ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
  ".aiff": "audio/aiff", ".aif": "audio/aiff", ".wma": "audio/x-ms-wma",
};

export function mimeFor(abs: string): string {
  return MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
}

/** Parse an HTTP Range header against a known size. Returns null (whole file) or a byte slice, or "unsat". */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // ignore multi-range / malformed → serve whole
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "") {
    // suffix: last N bytes
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Number(b);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "unsatisfiable";
  if (end >= size) end = size - 1;
  return { start, end };
}

// ── Probe (no-shell sniff) ─────────────────────────────────────────────────────
const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv", ".ts",
]);
const IMAGE_LOSSLESS = new Set([".png", ".bmp", ".tif", ".tiff", ".gif"]);
const IMAGE_LOSSY = new Set([".jpg", ".jpeg", ".webp", ".heic", ".heif", ".avif"]);
// Audio containers → label for the property grid's Codec cell. Kept in step with @lfb/shared AUDIO_EXT.
const AUDIO_CONTAINER: Record<string, string> = {
  ".mp3": "MP3", ".wav": "WAV (PCM)", ".flac": "FLAC (lossless)", ".aac": "AAC", ".m4a": "AAC (M4A)",
  ".ogg": "Ogg Vorbis", ".oga": "Ogg", ".opus": "Opus", ".aiff": "AIFF (PCM)", ".aif": "AIFF (PCM)",
  ".wma": "WMA",
};

const HEAD_BYTES = 512 * 1024; // enough to reach a front-placed moov / image header
const TAIL_BYTES = 256 * 1024; // catch a tail-placed moov (common in freshly-recorded MOV/MP4)

function readSlice(fd: number, start: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return n === len ? buf : buf.subarray(0, n);
}

/** Best-effort probe. Never throws for a readable file; returns nulls when it can't tell. */
export function probeMedia(input: string | undefined): MediaProbe {
  const { abs, size } = resolveMediaFile(input);
  const ext = path.extname(abs).toLowerCase();
  const isVideo = VIDEO_EXT.has(ext);
  const isImage = IMAGE_LOSSLESS.has(ext) || IMAGE_LOSSY.has(ext);
  const isAudio = ext in AUDIO_CONTAINER;
  const kind: MediaProbe["kind"] = isVideo ? "video" : isImage ? "image" : isAudio ? "audio" : "other";
  const compressState: MediaProbe["compressState"] = isImage
    ? IMAGE_LOSSY.has(ext) ? "done" : "should"
    : isVideo
      ? /(compress|h264|x264|hevc|x265|av1|reenc|shrunk|small)/i.test(path.basename(abs)) ? "done" : "should"
      : null; // audio is not a compressible kind (charter) → null

  // Audio needs no header sniff — the container/codec is fully implied by the extension, and dimensions
  // don't apply. Duration is read client-side from the media element (media_viewer.mdx §4.3).
  if (isAudio) {
    return { kind, container: AUDIO_CONTAINER[ext], codec: AUDIO_CONTAINER[ext], width: null, height: null, compressState };
  }

  const base: MediaProbe = { kind, container: null, codec: null, width: null, height: null, compressState };

  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, "r");
    const head = readSlice(fd, 0, Math.min(HEAD_BYTES, size));
    if (isImage) return { ...base, ...sniffImage(ext, head) };
    if (isVideo) {
      const tail = size > head.length ? readSlice(fd, Math.max(0, size - TAIL_BYTES), Math.min(TAIL_BYTES, size)) : Buffer.alloc(0);
      return { ...base, ...sniffVideo(ext, head, tail) };
    }
    return base;
  } catch (e) {
    // Best-effort sniff — an unreadable/short header just yields nulls; not a fault (debug only).
    log.debug("media", `probe read fell back to defaults for ${abs}: ${(e as Error).message}`);
    return base;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function sniffImage(ext: string, b: Buffer): Partial<MediaProbe> {
  // PNG — 8-byte signature, IHDR width/height at 16/20 (BE).
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { container: "PNG", codec: "PNG (lossless)", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // GIF — "GIFyya", logical screen width/height at 6/8 (LE).
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") {
    return { container: "GIF", codec: "GIF (lossless)", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  // BMP — "BM", width/height at 18/22 (LE int32).
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { container: "BMP", codec: "BMP (uncompressed)", width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  }
  // JPEG — FFD8, scan for an SOFn marker (baseline/progressive/etc.).
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const dims = jpegDims(b);
    return { container: "JPEG", codec: "JPEG (lossy)", ...dims };
  }
  // WebP — RIFF … WEBP; parse VP8X canvas (extended) when present.
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const fourcc = b.toString("ascii", 12, 16);
    if (fourcc === "VP8X" && b.length >= 30) {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { container: "WebP", codec: "WebP", width: w, height: h };
    }
    return { container: "WebP", codec: "WebP", width: null, height: null };
  }
  // TIFF / HEIC / AVIF — recognized, but dimensions need deeper parsing; report the family only.
  if (ext === ".tif" || ext === ".tiff") return { container: "TIFF", codec: "TIFF" };
  if (ext === ".heic" || ext === ".heif") return { container: "HEIF", codec: "HEVC (HEIF)" };
  if (ext === ".avif") return { container: "AVIF", codec: "AV1 (AVIF)" };
  return {};
}

function jpegDims(b: Buffer): { width: number | null; height: number | null } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    // SOF0..SOF15 carry frame dimensions (skip DHT/DAC/RSTn/SOS non-SOF markers).
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const segLen = b.readUInt16BE(i + 2);
    if (isSOF) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS — pixel data begins
    i += 2 + segLen;
  }
  return { width: null, height: null };
}

// Video codec fourccs (ISO-BMFF visual sample entries) and their labels.
const BMFF_CODECS: Array<[string, string]> = [
  ["avc1", "H.264"], ["avc3", "H.264"], ["hvc1", "HEVC"], ["hev1", "HEVC"], ["av01", "AV1"],
  ["vp09", "VP9"], ["vp08", "VP8"], ["mp4v", "MPEG-4"], ["ap4h", "ProRes"], ["apcn", "ProRes"],
  ["apcs", "ProRes"], ["apco", "ProRes"], ["ap4x", "ProRes"], ["dvh1", "Dolby Vision"],
];
// Matroska/WebM CodecID strings.
const EBML_CODECS: Array<[string, string]> = [
  ["V_MPEGH/ISO/HEVC", "HEVC"], ["V_MPEG4/ISO/AVC", "H.264"], ["V_AV1", "AV1"], ["V_VP9", "VP9"],
  ["V_VP8", "VP8"], ["V_MPEG4/ISO/ASP", "MPEG-4"], ["V_MPEG2", "MPEG-2"],
];

function sniffVideo(ext: string, head: Buffer, tail: Buffer): Partial<MediaProbe> {
  const container =
    ext === ".mov" ? "QuickTime"
    : ext === ".mp4" || ext === ".m4v" ? "MP4"
    : ext === ".mkv" ? "Matroska"
    : ext === ".webm" ? "WebM"
    : ext === ".avi" ? "AVI"
    : ext === ".mpg" || ext === ".mpeg" ? "MPEG"
    : ext === ".ts" ? "MPEG-TS"
    : ext.slice(1).toUpperCase();

  const buf = tail.length ? Buffer.concat([head, tail]) : head;
  const ascii = buf.toString("latin1"); // 1:1 byte→char, safe for fourcc/CodecID substring search

  if (ext === ".mkv" || ext === ".webm") {
    for (const [id, label] of EBML_CODECS) if (ascii.includes(id)) return { container, codec: label };
    return { container };
  }

  if (ext === ".avi") {
    // AVI stores the codec fourcc in the stream format; a substring scan is good enough.
    const marks: Array<[RegExp, string]> = [
      [/H264|h264|avc1|X264/, "H.264"], [/HEVC|hvc1|hev1|H265/, "HEVC"], [/AV01/, "AV1"],
      [/XVID|xvid/, "Xvid"], [/DIVX|DX50/, "DivX"], [/MJPG|mjpg/, "Motion JPEG"],
    ];
    for (const [re, label] of marks) if (re.test(ascii)) return { container, codec: label };
    return { container };
  }

  // ISO-BMFF family (mp4 / m4v / mov): find the first known visual sample-entry fourcc.
  for (const [fourcc, label] of BMFF_CODECS) {
    const at = buf.indexOf(fourcc, 0, "latin1");
    if (at < 0) continue;
    // VisualSampleEntry: width is 24 bytes past the end of the 4-byte fourcc (media_viewer.mdx §2).
    let width: number | null = null;
    let height: number | null = null;
    const wOff = at + 4 + 24;
    if (wOff + 4 <= buf.length) {
      const w = buf.readUInt16BE(wOff);
      const h = buf.readUInt16BE(wOff + 2);
      if (w > 0 && h > 0 && w <= 16384 && h <= 16384) { width = w; height = h; }
    }
    return { container, codec: label, width, height };
  }
  return { container };
}
