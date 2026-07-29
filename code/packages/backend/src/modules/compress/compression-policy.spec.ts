// The compression POLICY — the decisions taken before any encoder runs (compression.mdx §2.1, §3.1).
//
// Every assertion here corresponds to a decision the old engine got wrong on 2026-07-09. The encoders are
// not exercised (compression-invariants.spec.ts does that); this pins the choices.
import { describe, expect, it } from "vitest";
import type { CompressMediaPrefs, CompressTools } from "@lfb/shared";

import { jpegQuality, videoCrf, pickImageTarget, videoPixFmt, chromaCoarserPixFmt } from "./compression.service.js";

const TOOLS: CompressTools = {
  ffmpeg: true, ffprobe: true, magick: true, oxipng: false, cwebp: true,
  cjpeg: true, jpegoptim: false, heif: true, jpegtran: true, webpmux: true, sharp: true,
};

function prefs(over: Partial<CompressMediaPrefs> = {}): CompressMediaPrefs {
  return {
    enabled: true,
    quality: "medium",
    prefer: ["webp", "jpeg"],
    deny: ["jpeg2000"],
    convertTypes: true,
    skipExts: [],
    allowLosslessToLossy: false,
    pngPalette: true,
    guardChroma: true,
    preserveChroma: true,
    preset: "slow",
    ...over,
  };
}

describe("R2 — quality sits 75% toward BEST, not at the midpoint", () => {
  it("maps the default 'medium' to q93, not the old q85", () => {
    // 70 + 0.75 × (100 − 70) = 92.5, and ties round TOWARD quality → q93. The old ladder returned 85, the
    // exact middle, and that is the number that rewrote 3,248 images.
    expect(jpegQuality("medium")).toBe(93);
  });

  it("keeps the ladder ordered and inside the usable band", () => {
    expect(jpegQuality("low")).toBeLessThan(jpegQuality("medium"));
    expect(jpegQuality("medium")).toBeLessThan(jpegQuality("high"));
    expect(jpegQuality("high")).toBeLessThan(jpegQuality("lossless"));
    expect(jpegQuality("lossless")).toBe(100);
    expect(jpegQuality("low")).toBeGreaterThanOrEqual(70);
  });

  it("applies the same 75/25 policy to video, where lower CRF is better", () => {
    expect(videoCrf("h264", "medium")).toBe(20); // 28 − 0.75 × 10 = 20.5, floored toward quality
    expect(videoCrf("hevc", "medium")).toBe(23);
    expect(videoCrf("h264", "high")).toBeLessThan(videoCrf("h264", "medium"));
    expect(videoCrf("h264", "low")).toBeGreaterThan(videoCrf("h264", "medium"));
    expect(videoCrf("h264", "lossless")).toBe(0);
  });
});

describe("R4 — a lossless source is NOT offered to a lossy encoder", () => {
  it("routes an opaque PNG to a lossless PNG re-encode, not to JPEG", () => {
    // THE regression. alphaUsed=false is an OPAQUE screenshot — the state that let the alpha guard wave
    // 3,248 of these through to a quality-85 JPEG while the .png originals were deleted.
    const plan = pickImageTarget(prefs(), TOOLS, ".png", false);
    expect(plan).toMatchObject({ targetKey: "png", ext: ".png", lossless: true, losslessSource: true });
  });

  it("still refuses even when the user's prefer list puts JPEG first", () => {
    const plan = pickImageTarget(prefs({ prefer: ["jpeg", "webp"] }), TOOLS, ".png", false);
    expect(plan).toMatchObject({ targetKey: "png", lossless: true });
  });

  it("keeps the extension, so no markdown/HTML/CSS reference can break (R6)", () => {
    const plan = pickImageTarget(prefs(), TOOLS, ".png", false);
    expect("ext" in plan && plan.ext).toBe(".png");
  });

  it("allows the lossy conversion ONLY when the user explicitly opts in", () => {
    const plan = pickImageTarget(prefs({ allowLosslessToLossy: true, prefer: ["jpeg"] }), TOOLS, ".png", false);
    // Opted in → a lossy target is reachable, and it is still flagged as a lossless SOURCE so the caller
    // applies the 50% floor rather than the ordinary 20% one.
    expect(plan).toMatchObject({ targetKey: "jpeg", lossless: false, losslessSource: true });
  });

  it("never picks a no-alpha target for an image whose transparency is actually used", () => {
    const plan = pickImageTarget(prefs({ allowLosslessToLossy: true, prefer: ["jpeg", "webp"] }), TOOLS, ".png", true);
    expect("targetKey" in plan && plan.targetKey).not.toBe("jpeg");
  });
});

describe("BUG-8 — a multi-frame source never reaches a still encoder", () => {
  it("routes an animated GIF to animated WebP, carrying every frame", () => {
    const plan = pickImageTarget(prefs(), TOOLS, ".gif", false, 12);
    expect(plan).toMatchObject({ targetKey: "webp", animated: true, lossless: true });
  });

  it("skips with a clear reason rather than dropping frames when it cannot convert", () => {
    const plan = pickImageTarget(prefs({ convertTypes: false }), TOOLS, ".gif", false, 12);
    expect("skip" in plan && plan.skip).toMatch(/animated/i);
  });
});

describe("§3.1 — an already-lossy source stays format-preserving by default", () => {
  it("re-encodes a JPEG as a JPEG rather than renaming it", () => {
    const plan = pickImageTarget(prefs({ prefer: ["jpeg"] }), TOOLS, ".jpg", false);
    expect(plan).toMatchObject({ targetKey: "jpeg", ext: ".jpg" });
    expect("losslessSource" in plan && plan.losslessSource).toBeFalsy();
  });

  it("treats HEIC as a COMPATIBILITY convert, exempt from the size floors", () => {
    const plan = pickImageTarget(prefs(), TOOLS, ".heic", false);
    expect(plan).toMatchObject({ targetKey: "jpeg", ext: ".jpg", formatConvert: true });
  });
});

describe("R1 for video — chroma is not silently dropped to 4:2:0", () => {
  it("preserves a 4:4:4 / 4:2:2 source instead of hard-coding yuv420p", () => {
    expect(videoPixFmt("yuv444p", prefs(), false)).toBe("yuv444p");
    expect(videoPixFmt("yuv422p", prefs(), false)).toBe("yuv422p");
    expect(videoPixFmt("yuv444p10le", prefs(), false)).toBe("yuv444p10le");
  });

  it("leaves an already-4:2:0 source alone (no reduction to avoid)", () => {
    expect(videoPixFmt("yuv420p", prefs(), false)).toBe("yuv420p");
    expect(videoPixFmt("", prefs(), false)).toBe("yuv420p");
  });

  it("normalises to yuv420p for a COMPATIBILITY convert, where playability is the point", () => {
    expect(videoPixFmt("yuv444p", prefs(), true)).toBe("yuv420p");
  });

  it("ranks video chroma so a coarsening is caught", () => {
    expect(chromaCoarserPixFmt("yuv444p", "yuv420p")).toBe(true);
    expect(chromaCoarserPixFmt("yuv420p", "yuv420p")).toBe(false);
    expect(chromaCoarserPixFmt("yuv420p", "yuv444p")).toBe(false);
    expect(chromaCoarserPixFmt("", "yuv420p")).toBe(false);
  });
});
