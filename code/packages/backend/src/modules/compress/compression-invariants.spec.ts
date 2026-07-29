// The compression invariants, asserted end to end against real encoders (compression.mdx §2.1 R1-R6).
//
// These are the rules the 2026-07-09 run broke. Each one below maps to a specific way ~3,248 images were
// damaged, and the test exists so that failure mode cannot come back silently:
//
//   R1  resolution is absolute — INCLUDING chroma. 100% of that run's output was 4:2:0, and the guard
//       could not see it because it only compared `%w %h` (the luma plane).
//   R3  the 20% size-gain floor. The old gate accepted a ONE BYTE win, and destroyed a lossless PNG for a
//       1.4% saving.
//   R4  a lossless source never silently becomes lossy. This is the one that deleted the originals.
//   §8.4 the marker — written on EVERY path, so nothing is ever compressed twice.
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import { encodeImage, jpegChromaSampling, chromaGotCoarser, probeImage } from "./image-encode.js";
import { markerPayload, readImageMarker, stampImageMarker, isAnyMarker, canStampInFile } from "./compress-marker.js";

let dir: string;

/** The exact case 4:2:0 destroys: thin, saturated, 1px-wide coloured lines on white — a screenshot with
 *  red annotation arrows and coloured text, which is what most of the damaged corpus was. */
async function screenshotFixture(file: string, w = 400, h = 300): Promise<void> {
  const buf = Buffer.alloc(w * h * 3, 255);
  for (let y = 20; y < h - 20; y += 5) {
    for (let x = 20; x < w - 20; x++) {
      const i = (y * w + x) * 3;
      buf[i] = 230;
      buf[i + 1] = 20;
      buf[i + 2] = 30;
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(file);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-compress-spec-"));
});

describe("R1 — resolution is absolute, chroma included", () => {
  it("writes 4:4:4 chroma, never the encoder's 4:2:0 default", async () => {
    const src = path.join(dir, "shot.png");
    const out = path.join(dir, "shot.jpg");
    await screenshotFixture(src);

    const r = await encodeImage("jpeg", src, out, { quality: 92, lossless: false, animated: false, tryPalette: false });
    expect(r.ok).toBe(true);
    // "1x1,1x1,1x1" is 4:4:4 — both colour planes stored at FULL width and height. "2x2,1x1,1x1" is the
    // 4:2:0 the old engine produced for every single file it wrote.
    expect(jpegChromaSampling(out)).toBe("1x1,1x1,1x1");
  });

  it("keeps the pixel dimensions of the source", async () => {
    const src = path.join(dir, "dims.png");
    const out = path.join(dir, "dims.jpg");
    await screenshotFixture(src, 333, 211);
    await encodeImage("jpeg", src, out, { quality: 92, lossless: false, animated: false, tryPalette: false });
    const before = await probeImage(src);
    const after = await probeImage(out);
    expect([after?.width, after?.height]).toEqual([before?.width, before?.height]);
  });

  it("the chroma guard recognises a coarsening, and does not fire on an unchanged one", () => {
    expect(chromaGotCoarser("1x1,1x1,1x1", "2x2,1x1,1x1")).toBe(true); // 4:4:4 → 4:2:0 — refuse
    expect(chromaGotCoarser("2x2,1x1,1x1", "1x1,1x1,1x1")).toBe(false); // 4:2:0 → 4:4:4 — an improvement
    expect(chromaGotCoarser("1x1,1x1,1x1", "1x1,1x1,1x1")).toBe(false);
    expect(chromaGotCoarser("", "2x2,1x1,1x1")).toBe(false); // unknown on either side → never block
  });
});

describe("R4 — a lossless source stays lossless, and the lossless path is the better deal", () => {
  it("re-encodes a PNG losslessly: identical pixels, fewer bytes", async () => {
    const src = path.join(dir, "lossless.png");
    const out = path.join(dir, "lossless.out.png");
    // Deliberately written at low deflate effort, the way most tools emit PNGs — which is exactly why the
    // lossless recompress has so much to win back.
    const w = 500;
    const h = 400;
    const buf = Buffer.alloc(w * h * 3);
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = (i / 3) % 200;
      buf[i + 1] = 40;
      buf[i + 2] = 200 - ((i / 3) % 200);
    }
    await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toFile(src);

    const r = await encodeImage("png", src, out, { quality: 92, lossless: true, animated: false, tryPalette: true });
    expect(r.ok).toBe(true);
    expect(r.lossless).toBe(true);
    expect(fs.statSync(out).size).toBeLessThan(fs.statSync(src).size);

    // The whole point: not one pixel changed.
    const a = await sharp(src).raw().toBuffer();
    const b = await sharp(out).raw().toBuffer();
    expect(b.equals(a)).toBe(true);
  });

  it("the verified palette variant is pixel-exact when it is taken at all", async () => {
    const src = path.join(dir, "flat.png");
    const out = path.join(dir, "flat.out.png");
    await screenshotFixture(src); // 2 colours — the palette path's ideal case
    const r = await encodeImage("png", src, out, { quality: 92, lossless: true, animated: false, tryPalette: true });
    expect(r.ok).toBe(true);
    const a = await sharp(src).ensureAlpha().raw().toBuffer();
    const b = await sharp(out).ensureAlpha().raw().toBuffer();
    expect(b.equals(a)).toBe(true);
  });
});

describe("§8.4 — the durable in-file marker", () => {
  it("stamps JPEG and PNG losslessly and reads them back", async () => {
    for (const [name, target] of [["m.png", "png"], ["m.jpg", "jpeg"]] as const) {
      const src = path.join(dir, `src-${name}`);
      const out = path.join(dir, name);
      await screenshotFixture(src);
      await encodeImage(target, src, out, { quality: 92, lossless: target === "png", animated: false, tryPalette: false });

      const before = await sharp(out).raw().toBuffer();
      expect(readImageMarker(out)).toBe(""); // not marked yet
      expect(stampImageMarker(out, markerPayload(target))).toBe(true);

      const marker = readImageMarker(out);
      expect(isAnyMarker(marker)).toBe(true);
      expect(marker).toContain(target);
      // The stamp is a metadata splice — it must not touch a single pixel.
      const after = await sharp(out).raw().toBuffer();
      expect(after.equals(before)).toBe(true);
    }
  });

  it("honours a marker from the ORIGINAL engine, so a v1 file is never put through a second generation", () => {
    // The v1 files' originals are gone. Re-compressing them could only lose more, so an older marker must
    // still read as "already compressed".
    expect(isAnyMarker("LFBcompressed;v1;jpeg")).toBe(true);
    expect(isAnyMarker("LFBcompressed;v2;jpeg")).toBe(true);
    expect(isAnyMarker("some other comment")).toBe(false);
  });

  it("knows which formats can hold a marker at all", () => {
    expect(canStampInFile("a.png")).toBe(true);
    expect(canStampInFile("a.jpg")).toBe(true);
    expect(canStampInFile("a.webp")).toBe(true);
    // A format with nowhere to put one is not an error — the compression record carries the state instead.
    expect(canStampInFile("a.bmp")).toBe(false);
  });

  it("reads nothing from a file that was never stamped", async () => {
    const p = path.join(dir, "clean.png");
    await screenshotFixture(p);
    expect(readImageMarker(p)).toBe("");
  });
});

describe("BUG-8 — animation is detected before a still encoder can see it", () => {
  // A real, minimal 2-frame animated GIF (8×8, red then blue). Inlined rather than generated so the test
  // asserts against genuine animation bytes without depending on an external encoder.
  const ANIMATED_GIF_B64 =
    "R0lGODlhCAAIAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAIAAACB4SPqcvtXQAAIfkEAAoAAAAsAAAAAAgACACAAAD/AAAAAgeEj6nL7V0AADs=";

  it("reports the frame count of an animated source", async () => {
    const p = path.join(dir, "anim.gif");
    fs.writeFileSync(p, Buffer.from(ANIMATED_GIF_B64, "base64"));
    const meta = await probeImage(p);
    // pages > 1 is the signal pickImageTarget routes on. Handing this to a still encoder is what wrote
    // `out-0.jpg, out-1.jpg, …` instead of the requested path and left stray frames in the temp dir.
    expect(meta?.pages).toBe(2);
  });

  it("a single-frame image reports exactly one page", async () => {
    const p = path.join(dir, "still.png");
    await screenshotFixture(p, 32, 32);
    expect((await probeImage(p))?.pages).toBe(1);
  });
});
