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
//   * libpng + adaptive filtering — one of the LOSSLESS PNG candidates (see encodePng, and read the
//                    warning there about `effort`, which is a LOSSY option that nearly shipped as a
//                    lossless one).
// It also runs IN PROCESS: no fork per file, no argv quoting, and errors arrive as exceptions instead of a
// scraped stderr tail.
//
// sharp's global `concurrency(1)` / `cache(false)` arrive with the shared/sharp-runtime.js import below —
// that module is the only place sharp is configured, so these no longer depend on some other module having
// been imported first (they used to, and silently did not apply when it was not). They are deliberately NOT
// changed here: the compress queue already fans many single-threaded jobs out to the core budget, and
// mutating a process-global mid-flight would race the fingerprinting running alongside us.
import fs from "node:fs";
import path from "node:path";
import sharp from "../../shared/sharp-runtime.js";
import { redeflatePng } from "./png-redeflate.js";

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
  if (!o.lossless) return { ok: true, lossless: false, how: `webp q${o.quality} smart-subsample` };
  // "Lossless" is CHECKED, not asserted. libwebp's lossless mode is bit-exact on the pixels it is given,
  // but it is given them by the same decode pipeline that normalises alpha, so the claim still has to be
  // verified before it is made. An animated source is exempt: `rendersIdentically` compares the first page
  // only, so a pass would not be evidence about the rest, and claiming less is the safe direction.
  const verified = !o.animated && (await rendersIdentically(src, out));
  return {
    ok: true,
    lossless: verified,
    how: verified ? "webp lossless (verified renders identically)" : "webp lossless",
  };
}

/**
 * Does `b` RENDER IDENTICALLY to `a`? The precise definition of "lossless" this module is willing to claim.
 *
 * Byte-equality of the two raw buffers is NOT the test, because two encodings can differ in ways that no
 * viewer can ever show — and refusing those would throw away most of the available saving. Two differences
 * are treated as no difference, and they are exactly the two that every PNG optimiser makes:
 *
 *   1. A FULLY-OPAQUE alpha channel may be dropped. An alpha channel that is 255 everywhere carries no
 *      information; RGB and RGBA render the same. (A channel with ANY non-opaque pixel is never dropped —
 *      the comparison below fails immediately if it were.)
 *   2. The RGB under a FULLY-TRANSPARENT pixel may change. Those samples are not drawn, by definition.
 *
 * Anything else — one changed visible sample, a different dimension, a different frame count — fails.
 *
 * This is a real decode of both images, so it is bounded by the caller's pixel budget.
 */
async function rendersIdentically(a: string, b: string): Promise<boolean> {
  try {
    const [ra, rb] = await Promise.all([
      sharp(a, { failOn: "none" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(b, { failOn: "none" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return false;
    if (ra.data.length !== rb.data.length) return false;
    const A = ra.data;
    const B = rb.data;
    for (let i = 0; i + 3 < A.length; i += 4) {
      if (A[i + 3] !== B[i + 3]) return false; // alpha itself must match exactly
      if (A[i + 3] === 0) continue; // invisible sample — its RGB is not rendered
      if (A[i] !== B[i] || A[i + 1] !== B[i + 1] || A[i + 2] !== B[i + 2]) return false;
    }
    return true;
  } catch {
    return false; // could not verify → must not claim lossless
  }
}

/**
 * Re-encode `src` → `out` as a PNG, LOSSLESSLY — and PROVE it rather than assume it.
 *
 * A WARNING WORTH KEEPING, because it nearly shipped: sharp's `png({ effort: 10 })` is NOT a lossless
 * option. `effort` drives sharp's PALETTE QUANTISER, and passing it silently turns a truecolour PNG into a
 * quantised 8-bit one. Measured on this app's own damaged corpus it "won" 60-78% — and changed up to 4.2
 * MILLION pixels per image with deltas as large as 72. It looks exactly like a spectacular lossless result
 * and it is real, visible degradation. The verification below is what caught it. Do not add `effort` here.
 *
 * Candidates, smallest verified one wins:
 *   1. STRICT RE-DEFLATE of the source (png-redeflate.ts) — lossless by construction, no decode at all.
 *   2. sharp's ADAPTIVE-FILTERING re-encode (which re-chooses per-scanline filters and IS lossless), then
 *      re-deflated by (1). Sometimes beats (1) alone, sometimes loses to it — so both are measured.
 *   3. An 8-bit PALETTE encode, attempted only when the image genuinely holds ≤256 distinct colours (the
 *      common case for flat-colour UI screenshots), where a palette is an exact representation.
 * Every candidate that involves a decode is checked with `rendersIdentically` before it can be taken.
 *
 * Honest expectations: on real files this returns roughly 0-23%. That is far less than the 84-92% the old
 * engine "achieved" by converting to lossy JPEG — but it does it without throwing the image away, and when
 * it cannot clear the size floor the caller keeps the original, which is the correct outcome.
 */
async function encodePng(src: string, out: string, o: EncodeOpts): Promise<EncodeResult> {
  const meta = await probeImage(src);
  const pixels = meta ? meta.width * meta.height : Number.MAX_SAFE_INTEGER;
  const srcSize = fs.statSync(src).size;

  let have = false;
  let how = "";

  // Candidate 1 — lossless by construction. No decode, so no verification is possible OR needed.
  if (redeflatePng(src, out)) {
    have = true;
    how = "png re-deflate (bit-exact)";
  }

  /** Take `cand` if it is smaller than what we have AND it verifies. Always consumes the candidate file. */
  const consider = async (cand: string, label: string, needsVerify: boolean): Promise<void> => {
    try {
      const size = fs.statSync(cand).size;
      const target = have ? fs.statSync(out).size : srcSize;
      if (size >= target) {
        fs.rmSync(cand, { force: true });
        return;
      }
      if (needsVerify && !(await rendersIdentically(src, cand))) {
        fs.rmSync(cand, { force: true });
        return;
      }
      fs.renameSync(cand, out);
      have = true;
      how = label;
    } catch {
      fs.rmSync(cand, { force: true });
    }
  };

  // Animated PNGs and images past the verification budget stop at candidate 1: we will not claim a
  // losslessness we cannot check, and decoding a very large image twice is not worth the extra few percent.
  if (!o.animated && pixels <= VERIFY_PIXEL_BUDGET) {
    // Candidate 2 — re-filter, then re-deflate the re-filtered stream.
    const filtered = `${out}.filtered.tmp`;
    try {
      await sharp(src, { failOn: "none" })
        .png({ compressionLevel: 9, adaptiveFiltering: true }) // NO `effort` — see the warning above
        .keepMetadata()
        .toFile(filtered);
      const packed = `${out}.filtered.rd.tmp`;
      if (redeflatePng(filtered, packed)) {
        // The re-deflate is bit-exact w.r.t. `filtered`, so verifying `filtered` covers both.
        if (await rendersIdentically(src, filtered)) {
          await consider(packed, "png re-filter + re-deflate (verified)", false);
        } else {
          fs.rmSync(packed, { force: true });
        }
      }
      await consider(filtered, "png re-filter (verified)", true);
    } catch {
      fs.rmSync(filtered, { force: true });
      fs.rmSync(`${out}.filtered.rd.tmp`, { force: true });
    }

    // Candidate 3 — the exact palette, for images that can hold one.
    if (o.tryPalette && pixels <= PALETTE_PIXEL_BUDGET) {
      const pal = `${out}.palette.tmp`;
      try {
        const srcRaw = await sharp(src, { failOn: "none" }).ensureAlpha().raw().toBuffer();
        if (countColours(srcRaw, PALETTE_MAX_COLOURS) <= PALETTE_MAX_COLOURS) {
          await sharp(src, { failOn: "none" })
            .png({ compressionLevel: 9, palette: true, quality: 100, colours: PALETTE_MAX_COLOURS, dither: 0 })
            .keepMetadata()
            .toFile(pal);
          await consider(pal, "png palette (verified renders identically)", true);
        }
      } catch {
        fs.rmSync(pal, { force: true });
      }
    }
  }

  if (have) return { ok: true, lossless: true, how };

  // NOTHING beat the source losslessly. We must NOT fall back to writing a lossy candidate here — that is
  // precisely the substitution this whole rewrite exists to prevent. Copy the source through instead, so
  // the caller's size-gain floor sees a truthful zero and keeps (and records) the original.
  fs.copyFileSync(src, out);
  return { ok: true, lossless: true, how: "no lossless candidate was smaller — original kept" };
}

/** Above this many pixels we do not run the decode-and-compare verification (2 raw RGBA decodes ≈ 8
 *  bytes/pixel of transient memory, and the compress queue runs many jobs at once). Past it, only the
 *  lossless-by-construction re-deflate is used — a smaller win, but never an unverified claim. */
const VERIFY_PIXEL_BUDGET = 30_000_000;

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
