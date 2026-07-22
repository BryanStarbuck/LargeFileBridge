// The pure duplicate grouping engine (duplicates.mdx §8.2) with INJECTED hashes/fingerprints — no disk,
// no ffmpeg, no media decode: exactly the §7.8 promise that grouping is a pure function over stored
// values. Also covers the vPDQ stored-list matchers (symmetric fraction + contiguous run).
import { describe, expect, it } from "vitest";
import type { PerceptualFingerprint } from "@lfb/shared";
import { computeDuplicateGroups, type DedupeFileInfo } from "./dedupe.service.js";
import {
  anySampledFrameMatch,
  parseVpdq,
  serializeVpdq,
  symmetricSharedFraction,
  longestSharedRun,
  type VpdqFrame,
} from "./vpdq.service.js";

const ZEROS = "0".repeat(64);
const ONES = "f".repeat(64);
// One nibble different from ZEROS → Hamming 4 (within the strict ≤24 image threshold).
const NEAR_ZEROS = "f" + "0".repeat(63);

function fp(value: string, quality = 50): PerceptualFingerprint {
  return { algo: "blockhash", value, quality } as PerceptualFingerprint;
}

function file(over: Partial<DedupeFileInfo> & { path: string }): DedupeFileInfo {
  return {
    sizeBytes: 100,
    kind: "image",
    sha256: `sha-${over.path}`,
    attrs: { durationS: null, width: 640, height: 480, codec: "png" },
    imageFp: null,
    frames: null,
    ...over,
  };
}

function frames(hexes: string[], startTs = 0): VpdqFrame[] {
  return hexes.map((hex, i) => ({ n: i, hex, quality: 50, ts: startTs + i }));
}

describe("computeDuplicateGroups", () => {
  it("pass 1: groups byte-identical files by sha256, basis sha256", () => {
    const a = file({ path: "/a.png", sha256: "same" });
    const b = file({ path: "/b.png", sha256: "same" });
    const c = file({ path: "/c.png", sha256: "other" });
    const groups = computeDuplicateGroups([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0].basis).toBe("sha256");
    expect(groups[0].members.map((m) => m.path).sort()).toEqual(["/a.png", "/b.png"]);
  });

  it("pass 2: groups images whose stored fingerprints match strictly; a far hash stays out", () => {
    const a = file({ path: "/a.png", imageFp: fp(ZEROS) });
    const b = file({ path: "/b.jpg", imageFp: fp(NEAR_ZEROS) });
    const c = file({ path: "/c.jpg", imageFp: fp(ONES) });
    const groups = computeDuplicateGroups([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0].basis).toBe("fingerprint");
    expect(groups[0].members.map((m) => m.path).sort()).toEqual(["/a.png", "/b.jpg"]);
  });

  it("quality gate: a junk (flat/black) fingerprint never auto-matches", () => {
    const a = file({ path: "/a.png", imageFp: fp(ZEROS, 2) }); // below the quality floor
    const b = file({ path: "/b.png", imageFp: fp(ZEROS, 2) });
    expect(computeDuplicateGroups([a, b])).toHaveLength(0);
  });

  it("byte-grouped members never re-enter the fingerprint pass", () => {
    const a = file({ path: "/a.png", sha256: "same", imageFp: fp(ZEROS) });
    const b = file({ path: "/b.png", sha256: "same", imageFp: fp(ZEROS) });
    const c = file({ path: "/c.png", sha256: "unique", imageFp: fp(ZEROS) });
    const groups = computeDuplicateGroups([a, b, c]);
    // a+b group on sha256; c matches neither group again (it would need a second member).
    expect(groups).toHaveLength(1);
    expect(groups[0].basis).toBe("sha256");
  });

  it("videos: symmetric shared-frame fraction groups codec-variant copies", () => {
    const shared = [ZEROS, NEAR_ZEROS, ONES, "a".repeat(64), "5".repeat(64)];
    const a = file({
      path: "/a.mov",
      kind: "video",
      attrs: { durationS: 5, width: 1920, height: 1080, codec: "prores" },
      frames: frames(shared),
    });
    const b = file({
      path: "/b.mp4",
      kind: "video",
      attrs: { durationS: 5, width: 1280, height: 720, codec: "h264" },
      frames: frames(shared),
    });
    const groups = computeDuplicateGroups([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].basis).toBe("fingerprint");
  });

  it("videos: a much-shorter same-content file is SUBSET territory, never a duplicate", () => {
    const supFrames = frames([ZEROS, NEAR_ZEROS, ONES, "a".repeat(64), "5".repeat(64), "3".repeat(64)]);
    const clip = file({
      path: "/clip.mp4",
      kind: "video",
      attrs: { durationS: 2, width: 1920, height: 1080, codec: "h264" },
      frames: supFrames.slice(0, 2),
    });
    const full = file({
      path: "/full.mp4",
      kind: "video",
      attrs: { durationS: 6, width: 1920, height: 1080, codec: "h264" },
      frames: supFrames,
    });
    expect(computeDuplicateGroups([clip, full])).toHaveLength(0);
  });

  it("never groups across media kinds, and connected components fold transitively", () => {
    const img = file({ path: "/x.png", imageFp: fp(ZEROS) });
    const vid = file({
      path: "/x.mp4",
      kind: "video",
      attrs: { durationS: 3, width: 1, height: 1, codec: "h264" },
      frames: frames([ZEROS, ZEROS, ZEROS]),
    });
    expect(computeDuplicateGroups([img, vid])).toHaveLength(0);

    // Transitive: a≈b and b≈c ⇒ one component of three.
    const a = file({ path: "/a.png", imageFp: fp(ZEROS) });
    const b = file({ path: "/b.png", imageFp: fp(NEAR_ZEROS) });
    const c = file({ path: "/c.png", imageFp: fp(NEAR_ZEROS) });
    const groups = computeDuplicateGroups([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });
});

describe("vpdq stored-list matchers", () => {
  it("serialize/parse round-trips the text-line format", () => {
    const fs1 = frames([ZEROS, ONES]);
    const text = serializeVpdq(fs1);
    expect(text).toContain(`0,${ZEROS},50,0.00`);
    const back = parseVpdq(text);
    expect(back).toHaveLength(2);
    expect(back[1].hex).toBe(ONES);
    expect(back[1].ts).toBe(1);
    // Tolerant: junk lines are skipped, not fatal.
    expect(parseVpdq("not,a,line\n\n" + text)).toHaveLength(2);
  });

  it("symmetricSharedFraction is high both ways for duplicates, low one way for subsets", () => {
    const full = frames([ZEROS, ONES, "a".repeat(64), "5".repeat(64)]);
    const dup = frames([NEAR_ZEROS, ONES, "a".repeat(64), "5".repeat(64)]);
    const clip = frames([ONES, "a".repeat(64)]);
    expect(symmetricSharedFraction(full, dup)).toBe(1);
    // The clip matches fully INTO the long video, but the long video only half-matches back — the
    // minimum (symmetric) fraction is what keeps a subset from reading as a duplicate.
    expect(symmetricSharedFraction(clip, full)).toBe(0.5);
  });

  it("longestSharedRun finds the contiguous containment run and its superset offsets", () => {
    const sup = frames(["1".repeat(64), "2".repeat(64), ZEROS, ONES, "a".repeat(64), "9".repeat(64)]);
    const sub = frames([ZEROS, ONES, "a".repeat(64)]);
    const run = longestSharedRun(sub, sup);
    expect(run).not.toBeNull();
    expect(run!.frames).toBe(3);
    expect(run!.supStartTs).toBe(2); // the run begins at superset frame index 2 (ts = 2)
    expect(run!.supEndTs).toBe(4);
    expect(run!.coverage).toBe(1);
    // No run of ≥3 → null (1–2 matched frames are noise, not containment).
    expect(longestSharedRun(frames([ZEROS]), sup)).toBeNull();
  });

  it("anySampledFrameMatch passes real matches (incl. long lists) and rejects all-miss pairs", () => {
    const shared = frames([ZEROS, ONES, "a".repeat(64)]);
    expect(anySampledFrameMatch(shared, shared)).toBe(true);
    expect(anySampledFrameMatch(shared, frames(["9".repeat(64), "3".repeat(64)]))).toBe(false);
    expect(anySampledFrameMatch(shared, [])).toBe(false);
    // A long subset whose containment run covers ≥70% of its timeline must never be prefiltered out:
    // 100 frames, the first 25 unique junk, the remaining 75 present in the superset — evenly spaced
    // samples cannot all land in the 25% miss region.
    const hex = (i: number) => i.toString(16).padStart(2, "0").repeat(32);
    const longSub = frames(Array.from({ length: 100 }, (_, i) => (i < 25 ? hex(i) : hex(100 + i))));
    const sup = frames(Array.from({ length: 100 }, (_, i) => hex(125 + i)));
    expect(anySampledFrameMatch(longSub, sup)).toBe(true);
  });
});
