// STRICTLY-LOSSLESS PNG recompression — lossless BY CONSTRUCTION, not by inspection.
//
// WHY THIS EXISTS ALONGSIDE THE sharp ENCODER
// sharp re-encodes a PNG by DECODING it into libvips' pipeline and encoding the result. That produces much
// smaller files (it re-chooses the per-scanline filters), but the pipeline is not a bit-exact round trip:
//   * a fully-opaque alpha channel is dropped (RGBA → RGB), and
//   * the RGB underneath fully-transparent pixels is zeroed.
// Both render identically — this is what every PNG optimiser does — but neither is byte-exact, so a
// "lossless" claim based on sharp alone would be a claim we had not actually verified. In a module whose
// entire job is to stop this app from quietly degrading the user's images, an unverified claim is not good
// enough.
//
// WHAT THIS DOES
// It never decodes an image. A PNG's pixels live in the IDAT chunks as a zlib stream of FILTERED scanline
// bytes. We inflate that stream, re-deflate the identical bytes harder (three zlib strategies, keep the
// smallest), and rebuild the file around it. IHDR is untouched and the filtered bytes are unchanged, so the
// decoded image cannot differ — there is no comparison to run and no way for it to be wrong.
//
// It wins less than sharp (measured 1-23% against sharp's 29-78% on the same corpus), so it is the FLOOR,
// not the goal: the caller prefers a sharp candidate that has been verified to render identically, and
// falls back to this when verification fails or the image is too large to verify affordably.
import fs from "node:fs";
import zlib from "node:zlib";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  type: string;
  data: Buffer;
}

function readChunks(buf: Buffer): Chunk[] | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Chunk[] = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("latin1");
    const start = i + 8;
    if (len > buf.length - start - 4) return null; // truncated → refuse to touch it
    out.push({ type, data: buf.subarray(start, start + len) });
    i = start + len + 4;
    if (type === "IEND") break;
  }
  return out.length ? out : null;
}

function writeChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
}

/**
 * Re-deflate `src` → `out`. Returns true when a SMALLER file was written; false when the source could not
 * be parsed, is an interlaced/APNG layout we will not touch, or simply could not be beaten.
 *
 * Never throws — a failure here just means the caller keeps whatever other candidate it has.
 */
export function redeflatePng(src: string, out: string): boolean {
  try {
    const buf = fs.readFileSync(src);
    const chunks = readChunks(buf);
    if (!chunks) return false;

    const ihdr = chunks.find((c) => c.type === "IHDR");
    if (!ihdr || ihdr.data.length < 13) return false;
    // Interlaced (Adam7) PNGs store their scanlines in seven passes. Re-deflating the stream is still
    // bit-exact, but they are rare and not worth the risk surface — leave them alone.
    if (ihdr.data[12] !== 0) return false;
    // An animated PNG keeps later frames in fdAT chunks; we only re-pack IDAT, so leave APNG untouched
    // rather than produce a file whose first frame is repacked and whose rest is not.
    if (chunks.some((c) => c.type === "acTL" || c.type === "fdAT")) return false;

    const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
    if (idat.length === 0) return false;

    // The ONE decode-free round trip: inflate the filtered scanline bytes, re-deflate the SAME bytes.
    const filtered = zlib.inflateSync(idat);
    let best: Buffer | null = null;
    for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED, zlib.constants.Z_RLE]) {
      const d = zlib.deflateSync(filtered, { level: 9, memLevel: 9, strategy, windowBits: 15 });
      if (!best || d.length < best.length) best = d;
    }
    if (!best) return false;

    const parts: Buffer[] = [PNG_SIG];
    let wroteIdat = false;
    for (const c of chunks) {
      if (c.type === "IDAT") {
        // Many small IDATs become one — same stream, less per-chunk overhead.
        if (!wroteIdat) {
          parts.push(writeChunk("IDAT", best));
          wroteIdat = true;
        }
        continue;
      }
      parts.push(writeChunk(c.type, c.data));
    }
    const result = Buffer.concat(parts);
    if (result.length >= buf.length) return false; // no win — do not write a bigger file
    fs.writeFileSync(out, result);
    return true;
  } catch {
    return false;
  }
}
