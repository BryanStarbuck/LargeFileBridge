// The tracking index must never under-report SILENTLY (storages.mdx §4.1a).
//
// The bug these tests pin down: `indexStorageFiles` capped the index at 5,000 entries and logged a vague
// "some files not indexed". Files past the cap were never fingerprinted — therefore never pinned, never
// synced to the user's other computers, and never counted in the compression / big-file / git-ignore
// rollups — and nothing in the product ever said so. The contract now is: the cap is an OOM backstop far
// above any real tree, and when it IS hit the exact shortfall is written INTO the index (`dropped_files`)
// so every consumer can mark its counts as incomplete.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { indexStorageFiles, storageIndexDroppedFiles, readStorageIndex, invalidateStorageIndexCache } from "./tracking.service.js";

let tmp: string;
let prevState: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-index-trunc-"));
  prevState = process.env.LFB_STATE_DIR;
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  invalidateStorageIndexCache();
});

afterEach(() => {
  if (prevState === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = prevState;
  fs.rmSync(tmp, { recursive: true, force: true });
  invalidateStorageIndexCache();
});

/** A personal SDL root — its index is committed to `<root>/files.yaml`, so the test can read it directly. */
function sdlRoot(): string {
  const root = path.join(tmp, "sdl");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "storage.yaml"), YAML.stringify({ schema_version: 1, type: "personal", name: "T" }), "utf8");
  return root;
}

describe("storageIndexDroppedFiles — 'is this index complete?' is answerable, cheaply", () => {
  it("reads the exact shortfall a truncated build recorded", () => {
    const root = sdlRoot();
    fs.writeFileSync(
      path.join(root, "files.yaml"),
      YAML.stringify({ dropped_files: 1234, files: { "a.mp4": { size: 1 } } }),
      "utf8",
    );
    // The number, not a boolean: "some files are missing" is exactly the report this bug was about.
    expect(storageIndexDroppedFiles(root)).toBe(1234);
  });

  it("reads 0 for a complete index, a legacy index with no such field, and a missing one", () => {
    const root = sdlRoot();
    expect(storageIndexDroppedFiles(root)).toBe(0); // never indexed
    fs.writeFileSync(path.join(root, "files.yaml"), YAML.stringify({ files: { "a.mp4": { size: 1 } } }), "utf8");
    expect(storageIndexDroppedFiles(root)).toBe(0); // complete / written before the field existed
  });

  it("is not fooled by a file PATH that looks like the marker", () => {
    // `dropped_files` counts only at column 0; every index entry is indented under `files:`.
    const root = sdlRoot();
    fs.writeFileSync(
      path.join(root, "files.yaml"),
      YAML.stringify({ files: { "dropped_files: 99": { size: 1 } } }),
      "utf8",
    );
    expect(storageIndexDroppedFiles(root)).toBe(0);
  });
});

describe("indexStorageFiles — a complete build says so, and stays byte-clean", () => {
  it("indexes every large file and writes NO truncation marker", async () => {
    const root = sdlRoot();
    const big = Buffer.alloc(200 * 1024, 7);
    fs.mkdirSync(path.join(root, "media"), { recursive: true });
    for (const rel of ["media/a.mp4", "media/b.mov", "c.mp4"]) fs.writeFileSync(path.join(root, rel), big);
    // A tiny file must not be indexed at all — it is below the big-file threshold, not "dropped".
    fs.writeFileSync(path.join(root, "small.txt"), "hi");

    // Index everything at/over 100 KB so the fixture stays fast.
    const { getAppConfig } = await import("../store-model/config.service.js");
    const prev = getAppConfig().big_file.threshold_bytes;
    getAppConfig().big_file.threshold_bytes = 100 * 1024;
    try {
      const n = await indexStorageFiles(root);
      expect(n).toBe(3);
    } finally {
      getAppConfig().big_file.threshold_bytes = prev;
    }

    const doc = YAML.parse(fs.readFileSync(path.join(root, "files.yaml"), "utf8"));
    expect(Object.keys(doc.files)).toHaveLength(3);
    expect(doc.dropped_files).toBeUndefined(); // a complete index carries no marker at all
    expect(storageIndexDroppedFiles(root)).toBe(0);
    expect(readStorageIndex(root)).toHaveLength(3);
  });
});
