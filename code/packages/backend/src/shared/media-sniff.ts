// WHAT A FILE ACTUALLY IS, from its first bytes — not from its extension (ocr.mdx §1.7.2).
//
// THE DEFECT THIS CLOSES. `~/BGit/Bryan_git/charlie-kirk/videos/` holds 151 files named `*.mp4`, and 28 of
// them are not video at all: 25 are JPEG and 3 are PNG, downloaded under an IPFS-CID filename that was
// given a `.mp4` suffix by whatever fetched them. The name-only classifier (`mediaKindForName`) calls all
// 151 "video", and the two analysis pipelines then did the wrong thing in two different ways:
//
//   * OCR routed them to the VIDEO path, which asks ffmpeg for a duration to plan its frame stride. A JPEG
//     has no duration, so it emitted zero frames and the task FAILED — 28 files with no OCR text, twice
//     retried, then quarantined. Silent data loss in the one direction the product exists to prevent.
//   * DESCRIBE routed them to the VIDEO prompt and produced a real description that is subtly WRONG:
//     `kind: video`, opening "This clip presents…" for what is a static screenshot. Worse than failing,
//     because nothing looks broken.
//
// So the pipeline must ask the BYTES. This is deliberately narrow: a confident magic-number match only, and
// it never invents a kind — an unrecognized header returns null and the caller keeps its name-based answer.
// Extension stays the right answer for DISCOVERY (cheap, no I/O, and an `.mp4` is admitted to both pipelines
// either way); the sniff decides only WHICH PIPELINE RUNS, once, on a file we are about to read anyway.
import fs from "node:fs";

/** The kinds a sniff can assert. Mirrors `MediaKind` plus `pdf`; never "other". */
export type SniffedKind = "image" | "video" | "audio" | "pdf";

// 16 bytes is enough for every signature below, including ISO-BMFF's `ftyp` brand at offset 8.
const HEADER_BYTES = 16;

// ISO base media file format (`....ftyp<brand>`) covers BOTH MP4/MOV video AND HEIC/AVIF stills, so the
// container alone does not settle it — the BRAND does. These are the still-image brands; anything else
// carrying `ftyp` is video.
const IMAGE_FTYP_BRANDS = new Set([
  "heic", "heix", "heim", "heis", "hevc", "hevm", "hevs", "mif1", "msf1", // HEIF / HEIC
  "avif", "avis", // AVIF
]);

/**
 * The kind `absFile`'s first bytes assert, or **null** when the header is unrecognized or unreadable.
 *
 * Null is a real answer meaning "no opinion" — the caller must keep whatever the filename said. This
 * function never guesses and never throws.
 */
export function sniffMediaKind(absFile: string): SniffedKind | null {
  const b = readHeader(absFile);
  if (!b || b.length < 4) return null;

  // ── images ──
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image"; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image"; // PNG
  if (ascii(b, 0, 3) === "GIF") return "image";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image"; // BMP
  // TIFF: II 2a 00 (little-endian) or MM 00 2a (big-endian). Compared as BYTES on purpose — both
  // signatures contain a NUL, and a NUL inside a source string literal is unreadable and easy to break.
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return "image";
  if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return "image";

  // ── RIFF: one container, three kinds — the form type at offset 8 decides ──
  if (ascii(b, 0, 4) === "RIFF") {
    const form = ascii(b, 8, 4);
    if (form === "WEBP") return "image";
    if (form === "WAVE") return "audio";
    if (form === "AVI ") return "video";
    return null; // some other RIFF payload — no opinion
  }

  // ── ISO-BMFF: MP4/MOV video vs HEIC/AVIF stills, decided by the brand ──
  if (ascii(b, 4, 4) === "ftyp") {
    return IMAGE_FTYP_BRANDS.has(ascii(b, 8, 4).toLowerCase()) ? "image" : "video";
  }

  // ── documents ──
  if (ascii(b, 0, 5) === "%PDF-") return "pdf";

  // ── audio ──
  if (ascii(b, 0, 3) === "ID3") return "audio"; // MP3 with an ID3 tag
  if (b[0] === 0xff && b[1] !== undefined && (b[1] & 0xe0) === 0xe0) return "audio"; // bare MPEG audio frame
  if (ascii(b, 0, 4) === "OggS") return "audio";
  if (ascii(b, 0, 4) === "fLaC") return "audio";

  // ── remaining video containers ──
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video"; // Matroska / WebM
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return "video"; // ASF / WMV
  if (ascii(b, 0, 3) === "FLV") return "video";

  return null;
}

/**
 * The kind a pipeline should actually RUN for `absFile`, given what its NAME said and which kinds that
 * pipeline can actually handle.
 *
 * `allowed` is not a formality — it is the safety rail. OCR handles image|video|pdf and describe handles
 * image|video, so an `.mp4` that sniffs as **audio** (a mislabeled MP3) must NOT be handed to either as
 * "audio": there is no such pipeline, and silently switching would trade a clear failure for a crash. In
 * that case the name's answer stands and the file fails the way it already did.
 *
 * The correction therefore only ever fires when the sniff is CONFIDENT *and* the pipeline can act on it.
 * A null sniff (unknown header, unreadable file, a network mount momentarily away) changes nothing, so the
 * worst case is exactly today's behavior.
 */
export function effectiveMediaKind<T extends SniffedKind>(absFile: string, nameKind: T, allowed: readonly T[]): T {
  const sniffed = sniffMediaKind(absFile);
  if (!sniffed || sniffed === nameKind) return nameKind;
  return (allowed as readonly string[]).includes(sniffed) ? (sniffed as T) : nameKind;
}

function readHeader(absFile: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(absFile, "r");
    const buf = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    return read > 0 ? buf.subarray(0, read) : null;
  } catch {
    return null; // missing, unreadable, or a directory — no opinion
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

function ascii(b: Buffer, start: number, len: number): string {
  return b.length >= start + len ? b.subarray(start, start + len).toString("latin1") : "";
}
