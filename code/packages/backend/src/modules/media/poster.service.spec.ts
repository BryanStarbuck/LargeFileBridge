// Poster generation (duplicates.mdx §4.3a). CRITICAL ISOLATION RULE: the cache writes under the state
// root, so every test owns a temp LFB_STATE_DIR — never the real ~/T/_large_files_bridge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";

let tmpDir: string;
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.LFB_STATE_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-poster-"));
  process.env.LFB_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = savedStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** JPEG SOI marker — the only honest "this really is a JPEG" assertion. */
function isJpeg(file: string): boolean {
  const b = fs.readFileSync(file);
  return b.length > 2 && b[0] === 0xff && b[1] === 0xd8;
}

describe("poster.service", () => {
  it("classifies the kinds it can and cannot poster", async () => {
    const { posterKindFor } = await import("./poster.service.js");
    expect(posterKindFor("/a/b/clip.MOV")).toBe("video");
    expect(posterKindFor("/a/b/shot.mp4")).toBe("video");
    expect(posterKindFor("/a/b/pic.HEIC")).toBe("image");
    expect(posterKindFor("/a/b/pic.png")).toBe("image");
    // Audio has no picture, and a document is not media — both must 415 rather than spawn a decoder.
    expect(posterKindFor("/a/b/song.mp3")).toBeNull();
    expect(posterKindFor("/a/b/notes.pdf")).toBeNull();
  });

  it("snaps any requested width to an allowed bucket", async () => {
    const { normalizePosterWidth } = await import("./poster.service.js");
    // A free-form `w` would let one caller spray the cache with hundreds of near-identical entries.
    expect(normalizePosterWidth("640")).toBe(640);
    expect(normalizePosterWidth(300)).toBe(320);
    expect(normalizePosterWidth(99999)).toBe(960);
    expect(normalizePosterWidth("not-a-number")).toBe(640);
    expect(normalizePosterWidth(undefined)).toBe(640);
  });

  it("renders an image poster, downscales it, and serves the SAME file on the second call", async () => {
    const { ensurePoster } = await import("./poster.service.js");
    const src = path.join(tmpDir, "big.png");
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#3366cc" } })
      .png()
      .toFile(src);

    const first = await ensurePoster(src, 320);
    expect(isJpeg(first)).toBe(true);
    const meta = await sharp(first).metadata();
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(180); // aspect ratio kept (duplicates.mdx §4.3)

    // A cache HIT is the whole point — a group re-selected on hover must not re-decode anything.
    const second = await ensurePoster(src, 320);
    expect(second).toBe(first);
  });

  it("keys the cache on the file's CONTENT, so a replaced file gets a fresh poster", async () => {
    const { ensurePoster } = await import("./poster.service.js");
    const src = path.join(tmpDir, "swap.png");
    await sharp({ create: { width: 400, height: 400, channels: 3, background: "#ff0000" } })
      .png()
      .toFile(src);
    const before = await ensurePoster(src, 320);

    // Replace with different content AND a different size; a stale poster must not outlive it.
    await sharp({ create: { width: 800, height: 200, channels: 3, background: "#00ff00" } })
      .png()
      .toFile(src);
    fs.utimesSync(src, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const after = await ensurePoster(src, 320);

    expect(after).not.toBe(before);
    expect((await sharp(after).metadata()).height).toBe(80);
  });

  it("refuses a kind it cannot poster instead of guessing", async () => {
    const { ensurePoster } = await import("./poster.service.js");
    const src = path.join(tmpDir, "song.mp3");
    fs.writeFileSync(src, "not really audio");
    await expect(ensurePoster(src, 320)).rejects.toThrow(/not a previewable media file/);
  });
});
