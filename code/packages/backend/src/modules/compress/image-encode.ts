// The IMAGE ENCODER (compression.mdx §2 / §3.1). One module, one job: turn a source image into the best
// candidate output the policy allows, without ever losing pixels we were not explicitly told to trade away.
//
// WHY THIS REPLACED THE ImageMagick COMMAND BUILDER
// The old engine shelled out to `magick <src> -quality 85 <out>` and let ImageMagick pick everything it was
// not told. ImageMagick picks 4:2:0 chroma subsampling for any quality below 90 — so every JPEG this app
// wrote stored its two COLOUR planes at half width AND half height, a quarter of the colour detail. On
// photographs that is nearly invisible; on the thousands of screenshots this app rewrote (coloured text,
// thin red annotation arrows) it is the dominant artifact, and it slipped past the "never downscale" guard
// because that guard reads `%w %h`, which are the LUMA dimensions only. Chroma is now always stated
// explicitly and never inferred (see CHROMA_444).
//
// WHY sharp
// sharp is already a dependency of this app (posters, perceptual fingerprints) and it bundles exactly the
// encoders the spec always claimed we used and never did:
//   * mozjpeg      — 15-25% smaller JPEGs than libjpeg-turbo at the SAME visual quality. That saving is
//                    what pays for raising the quality target instead of lowering it.
//   * libwebp 1.6  — lossless and near-lossless WebP.
//   * libpng/zlib-ng at effort 10 — a lossless PNG re-deflate. Measured on the 16 real originals this app
//                    destroyed on 2026-07-20, this alone returns 60-78% of the bytes with ZERO pixel
//                    change, where the lossy JPEG conversion took 84-92% AND threw the image away.
//                    That measurement is why lossless is now the DEFAULT for lossless sources.
// It also runs IN PROCESS: no fork per file, no argv quoting, and errors arrive as exceptions instead of a
// scraped stderr tail.
//
// sharp's global `concurrency(1)` / `cache(false)` are set once by media/perceptual.service.ts and are
// deliberately NOT changed here: the compress queue already fans many single-threaded jobs out to the core
// budget, and mutating a process-global mid-flight would race the fingerprinting running alongside us.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

// LOCKED (compression.mdx §2.1 R1). Every lossy image this app writes stores its colour planes at FULL
// resolution. There is no setting for this and no code path that may choose otherwise: 4:2:0 is a
// resolution reduction of two of the three planes, and the resolution rule is absolute.
export const CHROMA_444 = "4:4:4" as const;

/** What an encode attempt produced. `ok:false` carries the reason for the caller's status line. */
export interface EncodeResult {
  ok: boolean;
  reason?: string;
  /** true when the output is provably pixel-identical to the source (lossless path). */
  lossless: boolean;
  /** A short note for the log/history line, e.g. "mozjpeg q92 4:4:4" or "png deflate(e10)+palette". */
  how: string;
}

const fail = (reason: string): EncodeResult => ({ ok: false, reason, lossless: false, how: "" });

/** Pixel budget above which we do NOT attempt the raw-buffer palette check (memory.mdx — a raw RGBA decode
 *  is 4 bytes/pixel and the compress queue runs many jobs at once). 8 MP ≈ 32 MB transient, once. */
const PALETTE_PIXEL_BUDGET = 8_000_000;

/** Colours a PNG may hold and still be representable as an exact 8-bit palette. */
const PALETTE_MAX_COLOURS = 256;

export interface EncodeOpts {
  /** 0-100 quality for the lossy encoders. */
  quality: number;
  /** Produce a provably lossless output (PNG re-deflate / lossless WebP). */
  lossless: boolean;
  /** Source is animated (pages > 1) — the encode must carry every frame. */
  animated: boolean;
  /** Attempt the lossless-palette PNG variant (verified pixel-exact before it is accepted). */
  tryPalette: boolean;
}

/** Probe a source image without decoding its pixels: dimensions, frame count, alpha, format. */
export async function probeImage(abs: string): Promise<{
  width: number;
  height: number;
  pages: number;
  hasAlpha: boolean;
  format: string;
} | null> {
  try {
    const m = await sharp(abs, { failOn: "none" }).metadata();
    if (!m.width || !m.height) return null;
    return {
      width: m.width,
      height: m.height,
      // `pages` is set for multi-frame GIF/WebP/TIFF; absent means a single still.
      pages: m.pages ?? 1,
      hasAlpha: m.hasAlpha === true,
      format: m.format ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Encode `src` → `out` as a JPEG.
 *
 * mozjpeg, 4:4:4 chroma, progressive, with trellis quantisation and overshoot deringing on — the settings
 * that buy back the bytes the higher quality costs. `optimiseScans` + `mozjpeg:true` is what makes this
 * meaningfully smaller than the ImageMagick path the spec used to describe (and never called).
 */
async function encodeJpeg(src: string, out: string, o: EncodeOpts): Promise<EncodeResult> {
  await sharp(src, { failOn: "none" })
    // The container's EXIF orientation must be BAKED IN before we drop to a format that may not carry it,
    // or the image silently rotates when a viewer stops honouring the tag.
    .rotate()
    .jpeg({
      quality: o.quality,
      chromaSubsampling: CHROMA_444, // LOCKED — never inferred (see CHROMA_444)
      mozjpeg: true,
      progressive: true,
      optimiseScans: true,
      trellisQuantisation: true,
      overshootDeringing: true,
    })
    .keepMetadata()
    .toFile(out);
  return { ok: true, lossless: false, how: `mozjpeg q${o.quality} ${CHROMA_444}` };
}

/**
 * Encode `src` → `out` as a WebP. Lossless when asked (the default for a lossless source); otherwise the
 * quality band with `smartSubsample` on, which is libwebp's sharp-YUV path and the WebP analogue of the
 * chroma rule above — it stops thin coloured lines from fringing.
 */
async function encodeWebp(src: string, out: string, o: EncodeOpts): Promise<EncodeResult> {
  await sharp(src, { failOn: "none", animated: o.animated })
    .webp(
      o.lossless
        ? { lossless: true, effort: 6 }
        : { quality: o.quality, smartSubsample: true, effort: 6 },
    )
    .keepMetadata()
    .toFile(out);
  return { ok: true, lossless: o.lossless, how: o.lossless ? "webp lossless" : `webp q${o.quality} smart-subsample` };
}

/**
 * Re-encode `src` → `out` as a PNG, LOSSLESSLY. Two candidates, and we keep the smaller:
 *
 *   1. A maximum-effort deflate (`compressionLevel 9, effort 10`). Same pixels, smaller file — this is the
 *      oxipng role, done in-process (and oxipng is frequently not even installed).
 *   2. An 8-bit PALETTE encode, attempted only when the image genuinely holds ≤256 distinct colours, which
 *      is the common case for the UI screenshots this app is most often pointed at. A palette PNG of a
 *      ≤256-colour image is exactly representable — but we never take that on trust: the candidate is
 *      decoded back and compared to the source buffer byte-for-byte, and it is discarded unless identical.
 *      That verification is what makes "lossless" a fact here rather than a claim.
 */
async function encodePng(src: string, out: string, o: EncodeOpts): Promise<EncodeResult> {
  const base = sharp(src, { failOn: "none", animated: o.animated });
  await base.png({ compressionLevel: 9, effort: 10 }).keepMetadata().toFile(out);
  let how = "png deflate(effort 10)";

  if (!o.tryPalette || o.animated) return { ok: true, lossless: true, how };

  const meta = await probeImage(src);
  if (!meta || meta.width * meta.height > PALETTE_PIXEL_BUDGET) return { ok: true, lossless: true, how };

  try {
    // ONE raw decode, reused for both the colour count and the verification compare.
    const srcRaw = await sharp(src, { failOn: "none" }).ensureAlpha().raw().toBuffer();
    if (countColours(srcRaw, PALETTE_MAX_COLOURS) > PALETTE_MAX_COLOURS) {
      return { ok: true, lossless: true, how }; // a photo/gradient — palette would be lossy, don't try
    }
    const cand = `${out}.palette.tmp`;
    await sharp(src, { failOn: "none" })
      .png({ compressionLevel: 9, effort: 10, palette: true, quality: 100, colours: PALETTE_MAX_COLOURS, dither: 0 })
      .keepMetadata()
      .toFile(cand);
    const candRaw = await sharp(cand, { failOn: "none" }).ensureAlpha().raw().toBuffer();
    const identical = srcRaw.equals(candRaw);
    if (identical && fs.statSync(cand).size < fs.statSync(out).size) {
      fs.renameSync(cand, out);
      how = "png palette (verified pixel-exact)";
    } else {
      fs.rmSync(cand, { force: true });
    }
  } catch {
    /* the palette attempt is an optimisation — its failure leaves the verified deflate output in place */
  }
  return { ok: true, lossless: true, how };
}

/** Count distinct RGBA pixels, stopping as soon as the cap is exceeded (so a photo costs almost nothing). */
function countColours(raw: Buffer, cap: number): number {
  const seen = new Set<number>();
  for (let i = 0; i + 3 < raw.length; i += 4) {
    // Pack RGBA into one number (>2^32, so a Number key, not a bitwise int — bitwise would sign-flip).
    seen.add(raw[i] * 16777216 + raw[i + 1] * 65536 + raw[i + 2] * 256 + raw[i + 3]);
    if (seen.size > cap) return cap + 1;
  }
  return seen.size;
}

/**
 * The one entry point: produce `out` from `src` for the given target.
 *
 * Never resizes — there is no `.resize()` anywhere in this module, which is the structural half of the
 * resolution guarantee (the verifying half is the post-encode probe in compression.service.ts).
 */
export async function encodeImage(
  targetKey: string,
  src: string,
  out: string,
  o: EncodeOpts,
): Promise<EncodeResult> {
  try {
    if (targetKey === "jpeg") {
      if (o.animated) return fail("animated source cannot be encoded as a still JPEG");
      return await encodeJpeg(src, out, o);
    }
    if (targetKey === "webp") return await encodeWebp(src, out, o);
    if (targetKey === "png") return await encodePng(src, out, o);
    return fail(`no encoder for target "${targetKey}"`);
  } catch (e) {
    return fail((e as Error).message);
  }
}

/**
 * Decode the PRIMARY still out of a HEIC/HEIF/AVIF container → `out`.
 *
 * A HEIC is a container that may also hold thumbnails, depth/auxiliary images, and (Live Photos) a motion
 * clip. `page: 0` pins the primary image, and we pass no auxiliary/coalesce option, so no preview, depth
 * map, or motion frame can be selected instead (images.mdx §4.1, LOCKED). `.rotate()` bakes in the
 * container's orientation, which JPEG consumers otherwise disagree about.
 */
export async function encodeHeicPrimary(
  targetKey: string,
  src: string,
  out: string,
  o: EncodeOpts,
): Promise<EncodeResult> {
  try {
    const pipeline = sharp(src, { failOn: "none", page: 0 }).rotate();
    if (targetKey === "webp") {
      await pipeline
        .webp(o.lossless ? { lossless: true, effort: 6 } : { quality: o.quality, smartSubsample: true, effort: 6 })
        .keepMetadata()
        .toFile(out);
      return { ok: true, lossless: o.lossless, how: o.lossless ? "webp lossless (HEIC primary)" : `webp q${o.quality} (HEIC primary)` };
    }
    await pipeline
      .jpeg({
        quality: o.quality,
        chromaSubsampling: CHROMA_444,
        mozjpeg: true,
        progressive: true,
        optimiseScans: true,
        trellisQuantisation: true,
        overshootDeringing: true,
      })
      .keepMetadata()
      .toFile(out);
    return { ok: true, lossless: false, how: `mozjpeg q${o.quality} ${CHROMA_444} (HEIC primary)` };
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** The chroma sampling an encoded JPEG actually carries, read from its SOF header — the verifying half of
 *  the chroma rule. "" for a non-JPEG or an unreadable header.
 *
 *  Returned in ImageMagick's notation ("1x1,1x1,1x1" = 4:4:4, "2x2,1x1,1x1" = 4:2:0) so it is directly
 *  comparable to what the forensic tooling and the old records report. Pure buffer walk — no fork. */
export function jpegChromaSampling(abs: string): string {
  let fd: number | null = null;
  try {
    const size = fs.statSync(abs).size;
    const len = Math.min(256 * 1024, size);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(abs, "r");
    fs.readSync(fd, buf, 0, len, 0);
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return "";
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return "";
      const marker = buf[i + 1];
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const segLen = buf.readUInt16BE(i + 2);
      if (segLen < 2) return "";
      // SOF0/1/2/3, 5-7, 9-11, 13-15 — every non-differential/differential frame header. DHT(C4), DAC(CC)
      // and JPG(C8) share the 0xCn range and are NOT frame headers.
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        // SOF payload: precision(1) height(2) width(2) numComponents(1) then per component id(1)
        // sampling(1: high nibble = h factor, low nibble = v) quantTable(1).
        const n = buf[i + 9];
        const parts: string[] = [];
        for (let c = 0; c < n; c++) {
          const s = buf[i + 11 + c * 3];
          parts.push(`${s >> 4}x${s & 0x0f}`);
        }
        return parts.join(",");
      }
      if (marker === 0xda) return ""; // reached the scan without a frame header
      i += 2 + segLen;
    }
    return "";
  } catch {
    return "";
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

/** Is `after`'s chroma sampling COARSER than `before`'s? (i.e. did colour resolution drop?) Compares the
 *  luma component's sampling factors, which is what "4:2:0 vs 4:4:4" means: a luma factor above 1x1 says
 *  the colour planes are stored subsampled relative to it. Unknown on either side → false (never block on
 *  a probe we could not make). */
export function chromaGotCoarser(before: string, after: string): boolean {
  const area = (s: string): number => {
    const m = /^(\d+)x(\d+)/.exec(s.trim());
    return m ? Number(m[1]) * Number(m[2]) : 0;
  };
  const a = area(before);
  const b = area(after);
  if (!a || !b) return false;
  return b > a;
}

/** True when a name is one of the still-image formats this module encodes. */
export function isEncodableImage(name: string): boolean {
  return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".heic", ".heif", ".avif"].includes(
    path.extname(name).toLowerCase(),
  );
}
