// OCR unit tests (ocr.mdx). These cover the three rules that are easy to regress and expensive to get
// wrong, each of which the spec marks LOCKED:
//
//   1. §2.3 EMPTY IS A SUCCESS. Most images have no text. If an empty read is mistaken for "no artifact",
//      every text-free file in the tree is re-offered FOREVER — the popup says "2,000 files can be OCR'd"
//      the morning after OCR'ing 2,000 files. This is the single most consequential rule in the feature.
//   2. §2.2.3 CONSECUTIVE DUPLICATES COLLAPSE. A slide on screen 3 minutes yields 12 identical frames; all
//      12 in the artifact would wreck the timecode index. The match is a SIMILARITY threshold, because two
//      fast-level passes over the same pixels genuinely differ by a character.
//   3. §2.2.2 THE HALF-STRIDE PHASE. Frame 0 of a real video is reliably black/a fade/a splash.
import { describe, it, expect } from "vitest";
import { collapseDuplicates, frameCountFor } from "./frames.js";

describe("collapseDuplicates (ocr.mdx §2.2.3)", () => {
  const S = 15;

  it("collapses a slide held across many samples into ONE time-ranged entry", () => {
    // A slide on screen from 3:00 to 6:15 — 13 samples of identical text.
    const entries = Array.from({ length: 13 }, (_, i) => ({
      at: 187.5 + i * S,
      text: "Q3 Revenue — $4.2M",
      confidence: 0.97,
    }));
    const out = collapseDuplicates(entries, S);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Q3 Revenue — $4.2M");
    // The range spans the whole run: from the first sample's window start to the last sample's window end.
    expect(out[0].start).toBeCloseTo(180, 1);
    expect(out[0].end).toBeCloseTo(187.5 + 12 * S + S / 2, 1);
  });

  it("collapses across a one-character OCR wobble — strict equality would NOT (the reason for the threshold)", () => {
    // The SAME static slide read twice by the fast level, differing by one character. This is not
    // hypothetical: a measured fast-level pass turned "$29/mo" into "$291mo" on identical pixels.
    const out = collapseDuplicates(
      [
        { at: 7.5, text: "Creator $29/mo — unlimited exports", confidence: 0.5 },
        { at: 22.5, text: "Creator $291mo — unlimited exports", confidence: 0.5 },
      ],
      S,
    );
    expect(out).toHaveLength(1);
  });

  it("does NOT collapse genuinely different slides", () => {
    const out = collapseDuplicates(
      [
        { at: 7.5, text: "Q3 Revenue — $4.2M", confidence: 0.9 },
        { at: 22.5, text: "Q4 Forecast — $5.1M", confidence: 0.9 },
      ],
      S,
    );
    expect(out).toHaveLength(2);
  });

  it("does NOT collapse a NON-adjacent repeat — a slide returned to is a separate appearance", () => {
    // The user searching for this slide wants BOTH timecodes (ocr.mdx §2.2.3).
    const out = collapseDuplicates(
      [
        { at: 7.5, text: "Agenda", confidence: 0.9 },
        { at: 22.5, text: "Q3 Revenue — $4.2M", confidence: 0.9 },
        { at: 37.5, text: "Agenda", confidence: 0.9 },
      ],
      S,
    );
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.text)).toEqual(["Agenda", "Q3 Revenue — $4.2M", "Agenda"]);
  });

  it("never reports a negative start (the first window's center is half a stride in)", () => {
    const out = collapseDuplicates([{ at: 7.5, text: "Title card", confidence: 0.9 }], S);
    expect(out[0].start).toBe(0);
  });

  it("returns nothing for a video with no text on any frame — an empty result, not an error", () => {
    expect(collapseDuplicates([], S)).toEqual([]);
  });
});

describe("frameCountFor (ocr.mdx §2.2.1 / §15)", () => {
  it("computes the spec's worked examples at the 15s stride", () => {
    expect(frameCountFor(5 * 60, 15, 1000)).toBe(20); // 5 min → 20 frames
    expect(frameCountFor(40 * 60, 15, 1000)).toBe(160); // the §1.2 deck: 40 min → 160 frames
    expect(frameCountFor(139 * 60, 15, 1000)).toBe(556); // the longest real file
  });

  it("bounds a pathological input at max_frames (§15.2 rule 7)", () => {
    // A 10-hour stream would otherwise emit 2,400 frames.
    expect(frameCountFor(10 * 3600, 15, 1000)).toBe(1000);
  });

  it("returns null when the duration is unknown rather than guessing", () => {
    expect(frameCountFor(null, 15, 1000)).toBeNull();
  });

  it("always yields at least one frame for a clip shorter than the stride", () => {
    expect(frameCountFor(3, 15, 1000)).toBe(1);
    expect(frameCountFor(12, 15, 1000)).toBe(1); // extractFrames' short-clip branch: one frame at D/2
    expect(frameCountFor(14.9, 15, 1000)).toBe(1);
  });

  // The hint MUST equal what extractFrames actually emits (§9.2) — the popup promising 3 frames for a clip
  // that yields 2 is a promise the run cannot keep. `ceil(D / stride)` over-counted every clip whose tail
  // fell inside a partial window; the real ffmpeg `fps` filter rounds to the NEAREST slot on the phased
  // grid, i.e. round((D - stride/2) / stride). These numbers were MEASURED against ffmpeg, not derived.
  it("matches ffmpeg's measured emission on a phased grid (§2.2.2)", () => {
    expect(frameCountFor(16, 15, 1000)).toBe(1); // measured: 1 (ceil said 2)
    expect(frameCountFor(40, 15, 1000)).toBe(2); // measured: 2 (ceil said 3)
    expect(frameCountFor(100, 15, 1000)).toBe(6); // measured: 6 (ceil said 7)
    expect(frameCountFor(300, 15, 1000)).toBe(20); // measured: 20 — agrees
  });
});
