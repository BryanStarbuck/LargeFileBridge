// Candidate FRESHNESS (duplicates.mdx §8.4) — the union of the persisted census with a live media
// sweep. This is the regression guard for the field defect that made duplicate detection look broken:
// a file copied minutes before pressing "Start scan" was absent from the persisted census (26,547
// candidates, and the new copy was not one of them), so the engine only ever held ONE member of the
// pair and could not report a group no matter how correct the hashing was.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaKind } from "@lfb/shared";
import { freshenFromDisk, EMPTY_ICON_STATE, type KnownMediaFile } from "./known-media.js";

const KINDS: ReadonlySet<MediaKind> = new Set<MediaKind>(["video", "image"]);

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "lfb-freshen-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function persisted(...abs: string[]): Map<string, KnownMediaFile> {
  return new Map(
    abs.map((a) => [
      a,
      { abs: a, sizeBytes: 1, kind: "image" as MediaKind, icon: { ...EMPTY_ICON_STATE, gitIgnored: true } },
    ]),
  );
}

describe("freshenFromDisk (duplicates.mdx §8.4)", () => {
  it("adds the just-copied file the persisted census never saw — the whole defect", async () => {
    const original = path.join(root, "2078856527541362697_3.jpg");
    const copy = path.join(root, "mr_dup.jpg");
    await fsp.writeFile(original, "same-bytes");
    await fsp.copyFile(original, copy);

    // The census knows the original only — exactly the state after a repo scan that predates the copy.
    const byAbs = persisted(original);
    expect(byAbs.has(copy)).toBe(false);

    await freshenFromDisk(byAbs, new Set([root]), KINDS);

    // BOTH members of the pair are now candidates, which is the precondition for grouping them at all.
    expect(byAbs.has(original)).toBe(true);
    expect(byAbs.has(copy)).toBe(true);
    expect(byAbs.get(copy)!.sizeBytes).toBe("same-bytes".length);
    expect(byAbs.get(copy)!.kind).toBe("image");
  });

  it("never downgrades a persisted row — the richer icon state survives the sweep", async () => {
    const known = path.join(root, "known.jpg");
    await fsp.writeFile(known, "x");
    const byAbs = persisted(known);
    await freshenFromDisk(byAbs, new Set([root]), KINDS);
    expect(byAbs.size).toBe(1);
    expect(byAbs.get(known)!.icon.gitIgnored).toBe(true); // not replaced by a default-state row
  });

  it("sweeps subdirectories but skips HARD_SKIP, dot-dirs, and our own artifact homes", async () => {
    await fsp.mkdir(path.join(root, "nested"), { recursive: true });
    await fsp.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fsp.mkdir(path.join(root, ".lfbridge"), { recursive: true });
    await fsp.mkdir(path.join(root, ".git"), { recursive: true });
    await fsp.writeFile(path.join(root, "nested", "deep.mp4"), "v");
    await fsp.writeFile(path.join(root, "node_modules", "dep.jpg"), "x");
    await fsp.writeFile(path.join(root, ".lfbridge", "artifact.jpg"), "x");
    await fsp.writeFile(path.join(root, ".git", "blob.jpg"), "x");

    const byAbs = new Map<string, KnownMediaFile>();
    await freshenFromDisk(byAbs, new Set([root]), KINDS);

    expect([...byAbs.keys()]).toEqual([path.join(root, "nested", "deep.mp4")]);
  });

  it("ignores non-media files and honours the requested kinds", async () => {
    await fsp.writeFile(path.join(root, "notes.txt"), "t");
    await fsp.writeFile(path.join(root, "clip.mp4"), "v");
    await fsp.writeFile(path.join(root, "pic.jpg"), "i");

    const videosOnly = new Map<string, KnownMediaFile>();
    await freshenFromDisk(videosOnly, new Set([root]), new Set<MediaKind>(["video"]));
    expect([...videosOnly.keys()]).toEqual([path.join(root, "clip.mp4")]);
  });

  it("an unreadable root contributes nothing and never throws", async () => {
    const byAbs = new Map<string, KnownMediaFile>();
    await expect(freshenFromDisk(byAbs, new Set([path.join(root, "does-not-exist")]), KINDS)).resolves.toBeUndefined();
    expect(byAbs.size).toBe(0);
  });
});
