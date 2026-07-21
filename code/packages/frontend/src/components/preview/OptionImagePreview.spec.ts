// The four-corner geometry test for the Option-key image preview (option_image_preview.mdx §2):
// candidate rect per corner = (cursor moved 10px toward that corner) → (corner inset 5px); fit the
// aspect ratio; biggest fitted area wins; anchor at the far point; never upscale past natural size.
import { describe, expect, it } from "vitest";
import { bestPreviewPlacement } from "./OptionImagePreview.js";

const VIEW = { w: 1000, h: 800 };
const BIG = { w: 4000, h: 3000 }; // 4:3, larger than any candidate — scale is always the constraint

describe("bestPreviewPlacement", () => {
  it("picks the corner diagonally opposite the cursor (the biggest rectangle)", () => {
    // Cursor near the top-left → the bottom-right corner has the most room.
    const p = bestPreviewPlacement({ x: 100, y: 100 }, VIEW, BIG);
    expect(p?.corner).toBe("br");
    // Anchored at the far point: right/bottom edges sit exactly 5px in from the corner.
    expect(p!.left + p!.width).toBeCloseTo(VIEW.w - 5);
    expect(p!.top + p!.height).toBeCloseTo(VIEW.h - 5);
  });

  it("respects the 10px near-gap toward the tested corner", () => {
    // Cursor near the bottom-right → top-left wins. Candidate spans (5,5) → (cursor−10, cursor−10):
    // avail = (885, 685); 4:3 fit is height-bound → h=685, w=913.33… > 885 → width-bound: w=885, h=663.75.
    const p = bestPreviewPlacement({ x: 900, y: 700 }, VIEW, BIG);
    expect(p?.corner).toBe("tl");
    expect(p!.left).toBe(5);
    expect(p!.top).toBe(5);
    expect(p!.width).toBeCloseTo(885);
    expect(p!.height).toBeCloseTo(885 * (3 / 4));
  });

  it("keeps the aspect ratio (one axis not fully used)", () => {
    const tall = { w: 1000, h: 4000 }; // 1:4 portrait
    const p = bestPreviewPlacement({ x: 900, y: 700 }, VIEW, tall);
    expect(p).not.toBeNull();
    expect(p!.width / p!.height).toBeCloseTo(1 / 4);
    // Height-bound: h = 685, w = 171.25 — the horizontal axis is left mostly unused.
    expect(p!.height).toBeCloseTo(685);
    expect(p!.width).toBeCloseTo(685 / 4);
  });

  it("never upscales past the image's natural size", () => {
    const small = { w: 64, h: 64 };
    const p = bestPreviewPlacement({ x: 900, y: 700 }, VIEW, small);
    expect(p!.width).toBe(64);
    expect(p!.height).toBe(64);
    // Still anchored into the winning corner's far point.
    expect(p!.left).toBe(5);
    expect(p!.top).toBe(5);
  });

  it("a centered cursor: all four corners tie in area — a corner is still chosen deterministically", () => {
    const p = bestPreviewPlacement({ x: 500, y: 400 }, VIEW, BIG);
    expect(p).not.toBeNull();
    // Ties keep the FIRST best (top-left, the first corner tested).
    expect(p!.corner).toBe("tl");
  });

  it("wide landscape near a vertical edge flips to the side with room", () => {
    const wide = { w: 4000, h: 1000 }; // 4:1
    const p = bestPreviewPlacement({ x: 60, y: 400 }, VIEW, wide);
    // Right-side corners have ~935px of width vs ~45px on the left — a landscape image needs width.
    expect(p?.corner === "tr" || p?.corner === "br").toBe(true);
  });

  it("returns null when the cursor leaves no corner any room", () => {
    // A 12×10 viewport: every corner's candidate collapses below 1px after the 10px gap + 5px inset.
    const p = bestPreviewPlacement({ x: 6, y: 5 }, { w: 12, h: 10 }, BIG);
    expect(p).toBeNull();
  });

  it("returns null for degenerate natural dimensions", () => {
    expect(bestPreviewPlacement({ x: 500, y: 400 }, VIEW, { w: 0, h: 100 })).toBeNull();
  });
});
