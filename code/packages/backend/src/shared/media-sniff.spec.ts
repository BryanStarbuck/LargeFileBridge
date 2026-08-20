// The bytes decide the pipeline, not the extension (ocr.mdx §1.7.2).
//
// Written against real headers because the bug was a real file: 28 of the 151 `*.mp4` files in
// charlie-kirk/videos/ are JPEG or PNG, and routing them to the video pipeline cost 28 OCR artifacts
// outright and gave 28 more a confidently-wrong "this clip" video description.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sniffMediaKind, effectiveMediaKind } from "./media-sniff.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-sniff-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write `bytes` under `name` and return the absolute path. The NAME is deliberately allowed to lie. */
function plant(name: string, bytes: number[]): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 4, 5, 6, 7];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const bmff = (brand: string): number[] => [0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii(brand), 0, 0, 0, 0];

describe("sniffMediaKind — what the file actually is", () => {
  it("calls a JPEG an image even when it is named .mp4 — THE bug", () => {
    expect(sniffMediaKind(plant("QmYGg8.mp4", JPEG))).toBe("image");
  });

  it("calls a PNG an image even when it is named .mp4", () => {
    expect(sniffMediaKind(plant("QmNvfM.mp4", PNG))).toBe("image");
  });

  it("still calls a real MP4 a video — the correction must not fire on the other 123 files", () => {
    expect(sniffMediaKind(plant("clip.mp4", bmff("isom")))).toBe("video");
    expect(sniffMediaKind(plant("clip.mov", bmff("qt  ")))).toBe("video");
  });

  it("splits the ISO-BMFF container by BRAND — HEIC/AVIF are stills, not video", () => {
    expect(sniffMediaKind(plant("photo.heic", bmff("heic")))).toBe("image");
    expect(sniffMediaKind(plant("photo.avif", bmff("avif")))).toBe("image");
    expect(sniffMediaKind(plant("mislabeled.mp4", bmff("mif1")))).toBe("image");
  });

  it("splits the RIFF container by form type — WEBP/WAVE/AVI are three different kinds", () => {
    const riff = (form: string): number[] => [...ascii("RIFF"), 0, 0, 0, 0, ...ascii(form), 0, 0, 0, 0];
    expect(sniffMediaKind(plant("a.webp", riff("WEBP")))).toBe("image");
    expect(sniffMediaKind(plant("a.wav", riff("WAVE")))).toBe("audio");
    expect(sniffMediaKind(plant("a.avi", riff("AVI ")))).toBe("video");
  });

  it("reads TIFF in BOTH byte orders — the signatures contain a NUL", () => {
    expect(sniffMediaKind(plant("le.tif", [0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]))).toBe("image");
    expect(sniffMediaKind(plant("be.tif", [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 0]))).toBe("image");
  });

  it("recognizes PDF, GIF, Matroska and ID3 audio", () => {
    expect(sniffMediaKind(plant("d.pdf", ascii("%PDF-1.7 aaaaaaa")))).toBe("pdf");
    expect(sniffMediaKind(plant("a.gif", ascii("GIF89a aaaaaaaaa")))).toBe("image");
    expect(sniffMediaKind(plant("v.webm", [0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe("video");
    expect(sniffMediaKind(plant("a.mp3", ascii("ID3 aaaaaaaaaaaa")))).toBe("audio");
  });

  it("has NO OPINION on an unknown header, a missing file, or a too-short one", () => {
    expect(sniffMediaKind(plant("x.mp4", [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))).toBeNull();
    expect(sniffMediaKind(path.join(tmp, "does-not-exist.mp4"))).toBeNull();
    expect(sniffMediaKind(plant("tiny.mp4", [0xff]))).toBeNull();
  });
});

describe("effectiveMediaKind — correct the pipeline, but only when it is safe", () => {
  const OCR = ["image", "video", "pdf"] as const;
  const DESCRIBE = ["image", "video"] as const;

  it("corrects video -> image for a JPEG named .mp4, in BOTH pipelines", () => {
    const f = plant("QmYGg8.mp4", JPEG);
    expect(effectiveMediaKind(f, "video", OCR)).toBe("image");
    expect(effectiveMediaKind(f, "video", DESCRIBE)).toBe("image");
  });

  it("leaves a correctly-named file alone", () => {
    expect(effectiveMediaKind(plant("clip.mp4", bmff("isom")), "video", OCR)).toBe("video");
    expect(effectiveMediaKind(plant("a.jpg", JPEG), "image", OCR)).toBe("image");
  });

  it("KEEPS the name's answer when the sniffed kind is one the pipeline cannot run", () => {
    // An MP3 wearing `.mp4`. Describe has no audio pipeline, so switching would swap a clean failure for a
    // crash — the name stands and the file fails exactly as it does today.
    const f = plant("actually-audio.mp4", ascii("ID3 aaaaaaaaaaaa"));
    expect(sniffMediaKind(f)).toBe("audio");
    expect(effectiveMediaKind(f, "video", DESCRIBE)).toBe("video");
    // ...and a PDF named `.mp4` IS actionable for OCR, which handles pdf.
    const g = plant("actually-pdf.mp4", ascii("%PDF-1.7 aaaaaaa"));
    expect(effectiveMediaKind(g, "video", OCR)).toBe("pdf");
    expect(effectiveMediaKind(g, "video", DESCRIBE)).toBe("video");
  });

  it("changes nothing when the sniff has no opinion — no regression on odd files", () => {
    const f = plant("weird.mp4", [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    expect(effectiveMediaKind(f, "video", OCR)).toBe("video");
  });
});
