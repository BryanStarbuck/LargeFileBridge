// The three path operations must stay DISTINCT (repo__list_syns.mdx §6.1). Collapsing them is the bug:
// a character-blind `\` → `/` applied to a path this computer just read off its own disk destroys a legal
// POSIX filename, and a native `path.join` applied to a stored POSIX key writes a stray file whose whole
// relative path is its name.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { relPosix, toPosixRel, joinRel, healWindowsPath, hasWindowsSeparator, healPathKeyedMap } from "./rel-path.js";

describe("relPosix / toPosixRel — producing a stored key", () => {
  it("produces `/`-separated keys from this OS's own paths", () => {
    const root = path.resolve("/tmp/repo");
    expect(relPosix(root, path.join(root, "jfk", "videos", "clip.mp4"))).toBe("jfk/videos/clip.mp4");
  });

  it("is separator-AWARE: on POSIX a backslash is a filename character and survives", () => {
    if (path.sep !== "/") return; // on Windows `\` IS the separator — covered by the case above
    const root = path.resolve("/tmp/repo");
    expect(relPosix(root, path.join(root, "weird\\name.mp4"))).toBe("weird\\name.mp4");
    expect(toPosixRel("a/b\\c.mp4")).toBe("a/b\\c.mp4");
  });
});

describe("joinRel — consuming a stored key", () => {
  it("splits the POSIX key into real segments", () => {
    const root = path.resolve("/tmp/repo");
    expect(joinRel(root, "jfk/videos/clip.mp4")).toBe(path.join(root, "jfk", "videos", "clip.mp4"));
  });

  it("round-trips with relPosix", () => {
    const root = path.resolve("/tmp/repo");
    const abs = path.join(root, "a", "b", "c.mp4");
    expect(joinRel(root, relPosix(root, abs))).toBe(abs);
  });

  it("an empty key resolves to the root itself", () => {
    const root = path.resolve("/tmp/repo");
    expect(joinRel(root, "")).toBe(root);
  });
});

describe("healWindowsPath — repairing a peer's key", () => {
  it("rewrites every separator", () => {
    expect(healWindowsPath(String.raw`jfk\training\clip.mp4`)).toBe("jfk/training/clip.mp4");
    expect(hasWindowsSeparator(String.raw`a\b`)).toBe(true);
  });

  it("returns a clean path unchanged (identity, so callers can skip work)", () => {
    const clean = "jfk/training/clip.mp4";
    expect(healWindowsPath(clean)).toBe(clean);
  });
});

describe("healPathKeyedMap", () => {
  it("returns the SAME object when nothing needs healing", () => {
    const map = { "a/b.mp4": "sync" };
    expect(healPathKeyedMap(map)).toBe(map);
  });

  it("folds the two spellings of one file, letting the already-POSIX entry win", () => {
    const healed = healPathKeyedMap(
      { [String.raw`a\b.mp4`]: "ignore", "a/b.mp4": "sync", "c.mp4": "undecided" },
      (posix) => posix,
    );
    expect(healed).toEqual({ "a/b.mp4": "sync", "c.mp4": "undecided" });
  });

  it("keeps a Windows-only entry under its POSIX spelling", () => {
    expect(healPathKeyedMap({ [String.raw`a\b.mp4`]: "sync" })).toEqual({ "a/b.mp4": "sync" });
  });
});
