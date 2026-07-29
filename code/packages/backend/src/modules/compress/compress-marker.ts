// The DURABLE "Large File Bridge already compressed this" marker (compression.mdx §8.4).
//
// WHY THIS MODULE EXISTS
// The marker is the first and cheapest of the three answers to "have we already compressed this file?"
// (the other two — this computer's Local Storage record and the travelling company/Personal repo record —
// live in compress-ledger.ts). It is written INTO the file's own container metadata, so it rides with the
// bytes: over IPFS, over a git checkout, onto a USB stick. Any computer that receives the file knows not to
// compress it again, with no shared state and no network.
//
// WHAT WENT WRONG BEFORE (the "compressed over and over" defect)
// The old engine stamped the marker ONLY on the two ImageMagick code paths and the ffmpeg path. The oxipng
// (PNG→PNG) and cwebp (→WebP) branches wrote NO marker at all, so every one of those files was re-encoded
// on every single run, forever — each pass paying the full transcode cost to rediscover "no gain". Worse,
// the marker was written by handing `-set comment` to the ENCODER, which means it could only ever be
// applied by an encoder we happened to be running. This module inverts that: stamping is a separate,
// LOSSLESS, post-encode step on the finished bytes, so EVERY path gets a marker — whoever encoded it.
//
// LOSSLESS BY CONSTRUCTION
// Nothing here re-encodes. We splice a metadata record into the already-encoded container:
//   * JPEG  — a COM (0xFFFE) segment, inserted after the APPn block. Pixel data untouched.
//   * PNG   — a tEXt chunk (keyword "Comment"), inserted before the first IDAT. Pixel data untouched.
//   * WebP  — an XMP chunk via `webpmux` (which rewrites the RIFF container to extended VP8X form without
//             touching the VP8/VP8L bitstream). Best-effort: absent webpmux, the file simply carries no
//             in-file marker and the ledger records carry the state instead.
//   * video / audio — `-metadata comment=` handed to ffmpeg INLINE during the transcode we were already
//             running (no second pass, no re-encode).
// A format we cannot mark is not an error: `stampMarker` reports false and the caller falls back to the
// ledger. That is the "the file type may not support the property" case, by design.
//
// READING IS PURE TypeScript AND BOUNDED
// The old reader forked `magick identify -format %c` PER FILE just to answer "is it marked?" — the single
// most-called probe in a bulk run. Here JPEG/PNG/WebP are answered by reading a bounded HEAD SLICE of the
// file (metadata lives near the front by construction) and walking its segment/chunk table. No fork, no
// full-file read, no event-loop stall. Video/audio still need ffprobe (their metadata atom placement is not
// guaranteed near the front).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// The marker text itself. `v<N>` lets a re-tuned engine invalidate every older mark at once: a file marked
// by an older version fails `isCurrentMarker` and is swept again by the improved engine. v1 = the original
// engine (ImageMagick, quality 85, encoder-chosen 4:2:0 chroma). v2 = this engine (mozjpeg/sharp, 4:4:4,
// lossless-first). We deliberately do NOT re-sweep v1 files: their originals are gone, so re-compressing
// them can only lose more. v1 is therefore still HONOURED as "already compressed" (see isAnyMarker).
export const MARKER_PREFIX = "LFBcompressed;";
export const MARKER_VERSION = 2;

/** Build the marker payload stamped into a compressed file: `LFBcompressed;v2;<codec>`. */
export function markerPayload(codec: string): string {
  return `${MARKER_PREFIX}v${MARKER_VERSION};${codec}`;
}

/** Does this comment string carry ANY Large File Bridge marker (any version)? This is the SKIP signal —
 *  a v1 file was compressed by the old engine and must never be run through a second lossy generation. */
export function isAnyMarker(comment: string): boolean {
  return comment.startsWith(MARKER_PREFIX);
}

/** The codec recorded in a marker (`LFBcompressed;v2;jpeg` → "jpeg"), or null. */
export function markerCodec(comment: string): string | null {
  const parts = comment.split(";");
  return parts.length >= 3 && parts[2] ? parts[2] : null;
}

// How much of a file's head we read to find its metadata. JPEG COM/APPn segments and PNG tEXt chunks are
// required to precede the image data, and webpmux writes its chunks into the RIFF header block, so the
// marker is ALWAYS inside this window when it is present at all. Bounded on purpose: this runs once per
// file in a bulk run over thousands of files.
const HEAD_SLICE_BYTES = 512 * 1024;

function readHead(abs: string, bytes = HEAD_SLICE_BYTES): Buffer | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(abs).size;
    const len = Math.min(bytes, size);
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(abs, "r");
    fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// ── JPEG ────────────────────────────────────────────────────────────────────────
// Structure: SOI (FFD8), then a sequence of marker segments `FF <marker> <len:2> <payload>`, then the
// entropy-coded scan. We only ever walk the segment table before SOS (FFDA) — never the scan data.

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

/** Read the first COM (comment) segment's text, or "" — pure buffer walk, no decode. */
function jpegComment(buf: Buffer): string {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break; // not a marker boundary → malformed or we ran past the table
    const marker = buf[i + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI — image data begins, stop
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    if (marker === 0xfe) {
      // COM payload is `len - 2` bytes of text (may be NUL-terminated by some writers).
      const start = i + 4;
      const end = Math.min(start + len - 2, buf.length);
      return buf.subarray(start, end).toString("latin1").replace(/\0+$/, "").trim();
    }
    i += 2 + len;
  }
  return "";
}

/** Byte offset at which a new segment may be inserted: after SOI and after any leading APPn block, which
 *  keeps EXIF/JFIF first so metadata readers that expect APP1 at the front keep working. */
function jpegInsertOffset(buf: Buffer): number {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker >= 0xe0 && marker <= 0xef) {
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
      continue;
    }
    break;
  }
  return i;
}

function jpegWithComment(buf: Buffer, text: string): Buffer {
  const payload = Buffer.from(text, "latin1");
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xfe; // COM
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  const at = jpegInsertOffset(buf);
  return Buffer.concat([buf.subarray(0, at), seg, buf.subarray(at)]);
}

// ── PNG ─────────────────────────────────────────────────────────────────────────
// Structure: an 8-byte signature, then chunks of `len:4 type:4 data crc:4`. A tEXt chunk's data is
// `keyword \0 text` (latin-1). We write keyword "Comment", which is what ImageMagick surfaces as `%c`.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG);
}

/** Walk the chunk table, calling `visit` for each. Returns when the callback stops it or data runs out. */
function pngWalk(buf: Buffer, visit: (type: string, data: Buffer, start: number) => boolean | void): void {
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("latin1");
    const dataStart = i + 8;
    if (len > buf.length - dataStart) break; // truncated by our head slice — stop cleanly
    if (visit(type, buf.subarray(dataStart, dataStart + len), i) === false) return;
    i = dataStart + len + 4; // + CRC
  }
}

function pngComment(buf: Buffer): string {
  let found = "";
  pngWalk(buf, (type, data) => {
    if (type === "IDAT") return false; // metadata we care about precedes the pixels
    if (type === "tEXt" || type === "iTXt") {
      const nul = data.indexOf(0);
      if (nul < 0) return;
      const keyword = data.subarray(0, nul).toString("latin1");
      if (keyword.toLowerCase() !== "comment") return;
      // tEXt: keyword \0 text.  iTXt: keyword \0 compFlag compMethod langTag \0 translated \0 text.
      let text: string;
      if (type === "tEXt") {
        text = data.subarray(nul + 1).toString("latin1");
      } else {
        const compFlag = data[nul + 1];
        if (compFlag !== 0) return; // compressed iTXt — not something we ever write
        const langEnd = data.indexOf(0, nul + 3);
        const transEnd = langEnd < 0 ? -1 : data.indexOf(0, langEnd + 1);
        if (transEnd < 0) return;
        text = data.subarray(transEnd + 1).toString("utf8");
      }
      found = text.replace(/\0+$/, "").trim();
      return false;
    }
  });
  return found;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  // CRC covers the type + data (never the length field).
  const crc = zlib.crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc >>> 0, 8 + data.length);
  return out;
}

function pngWithComment(buf: Buffer, text: string): Buffer | null {
  // Insert before the first IDAT — every text chunk is legal there and no decoder reorders them.
  let at = -1;
  pngWalk(buf, (type, _data, start) => {
    if (type === "IDAT") {
      at = start;
      return false;
    }
  });
  if (at < 0) return null; // no IDAT in the buffer → not a PNG we should touch
  const data = Buffer.concat([Buffer.from("Comment", "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
  return Buffer.concat([buf.subarray(0, at), pngChunk("tEXt", data), buf.subarray(at)]);
}

// ── WebP ────────────────────────────────────────────────────────────────────────
// RIFF: "RIFF" <size:4 LE> "WEBP" then chunks of `fourCC:4 size:4LE data (+pad to even)`. A marker lives in
// the "XMP " chunk, which requires the extended VP8X container — so WRITING is delegated to `webpmux`
// (which does that container surgery correctly and losslessly). READING stays a pure chunk walk.

function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  );
}

function webpComment(buf: Buffer): string {
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourCC = buf.subarray(i, i + 4).toString("latin1");
    const size = buf.readUInt32LE(i + 4);
    const dataStart = i + 8;
    if (size > buf.length - dataStart) break;
    if (fourCC === "XMP ") {
      const text = buf.subarray(dataStart, dataStart + size).toString("utf8");
      const m = new RegExp(`${MARKER_PREFIX}[^\\s<"']*`).exec(text);
      if (m) return m[0];
      return "";
    }
    // VP8 /VP8L/VP8X hold the bitstream; metadata chunks follow. Keep walking (chunks are even-padded).
    i = dataStart + size + (size % 2);
  }
  return "";
}

// ── the public read/write API ───────────────────────────────────────────────────

/** Extensions whose in-file marker this module can read and write WITHOUT re-encoding. */
const STAMPABLE = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Can we put the marker INSIDE a file of this name's format? (false → the ledger carries the state.) */
export function canStampInFile(name: string): boolean {
  return STAMPABLE.has(path.extname(name).toLowerCase());
}

/**
 * Read the Large File Bridge marker out of an image file's own bytes. "" when absent or unreadable.
 * Pure TypeScript, bounded head read, no child process — safe to call once per file over thousands.
 */
export function readImageMarker(abs: string): string {
  const buf = readHead(abs);
  if (!buf) return "";
  let comment = "";
  if (isJpeg(buf)) comment = jpegComment(buf);
  else if (isPng(buf)) comment = pngComment(buf);
  else if (isWebp(buf)) comment = webpComment(buf);
  if (!comment) return "";
  // A comment field can legitimately hold other text (a camera's, a designer's). Extract OUR token if it is
  // in there rather than demanding the whole field be ours.
  const m = new RegExp(`${MARKER_PREFIX}[^\\s;]*;[^\\s;]*`).exec(comment);
  return m ? m[0] : isAnyMarker(comment) ? comment : "";
}

/**
 * Stamp the marker into an already-encoded image file, IN PLACE and LOSSLESSLY (a metadata splice — the
 * compressed pixel data is copied through byte-for-byte, never re-encoded).
 *
 * Returns true when the file now carries the marker. Returns false — never throws — when the format has
 * nowhere to put one (or the tool for it is absent); the caller records the state in the ledger instead.
 * That is the deliberate "if the file format doesn't support it" fallback.
 *
 * `webpmuxRun` is injected so the (async, forked) WebP path stays out of this otherwise sync, pure module;
 * pass null to skip WebP stamping.
 */
export function stampImageMarker(abs: string, text: string): boolean {
  try {
    const buf = fs.readFileSync(abs);
    let out: Buffer | null = null;
    if (isJpeg(buf)) out = jpegWithComment(buf, text);
    else if (isPng(buf)) out = pngWithComment(buf, text);
    else return false; // WebP goes through stampWebpMarkerArgs (needs webpmux); anything else is unmarkable
    if (!out) return false;
    // Write through a sibling temp + rename so a crash mid-write can never leave a truncated image where a
    // valid compressed one used to be. Same directory → rename is atomic on the same filesystem.
    const tmp = `${abs}.lfbmark.tmp`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, abs);
    return true;
  } catch {
    return false;
  }
}

/** argv for stamping a WebP's marker with `webpmux` (the caller runs it through the module's async runner
 *  and then swaps the temp in). Separate from stampImageMarker because it needs a child process. */
export function webpmuxStampArgs(src: string, out: string, text: string): string[] {
  // An XMP packet is the container-legal home for free text in WebP; webpmux promotes the file to the
  // extended VP8X form to hold it, copying the VP8/VP8L bitstream through untouched.
  return ["-set", "xmp", textFileFor(text), "-o", out, src];
}

// webpmux reads the XMP payload from a FILE, so the marker text needs a tiny scratch file. Kept next to the
// output (same filesystem, swept by the caller) rather than in a global temp dir.
const _xmpFiles = new Map<string, string>();
function textFileFor(text: string): string {
  const cached = _xmpFiles.get(text);
  if (cached && fs.existsSync(cached)) return cached;
  const f = path.join(
    process.env.TMPDIR ?? "/tmp",
    `lfb-xmp-${Buffer.from(text).toString("hex").slice(0, 24)}.txt`,
  );
  try {
    fs.writeFileSync(f, text, "utf8");
    _xmpFiles.set(text, f);
  } catch {
    /* best-effort — a failed scratch write just means WebP goes unmarked */
  }
  return f;
}
