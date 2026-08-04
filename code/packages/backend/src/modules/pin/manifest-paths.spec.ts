// Manifest paths are POSIX (`/`) on the wire (repo__list_syns.mdx §6.1). A Windows peer that built
// entries with `path.relative` recorded them with `\` — on macOS/Linux those read as literal filename
// characters, so files never matched the working tree and a pull materialized stray root files literally
// named `jfk\training\...` (the 2026-08-04 defect). These tests pin the heal: every read normalizes and
// folds separator-collisions, and every write re-serializes with `/` — verified through the REAL
// read/write functions, never a re-implementation.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-manifest-paths-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function svc() {
  return await import("./manifest.service.js");
}

describe("manifest path normalization (Windows peers)", () => {
  it("normalizes backslash paths to POSIX on read", async () => {
    const { readRepoTrackingManifest, repoTrackingManifestPath, writeRepoTrackingManifest } = await svc();
    const repoRoot = path.join(tmp, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    const file = repoTrackingManifestPath(repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "schema_version: 1",
        "unit: repo",
        "files:",
        String.raw`  - path: jfk\training\videos\sujan\clone project 4K.mp4`,
        "    cid: bafyexample1",
        "    size: 84675026",
        "    pinned_by:",
        "      - lenovo-laptop",
      ].join("\n"),
    );
    const m = readRepoTrackingManifest(repoRoot);
    expect(m.files).toHaveLength(1);
    expect(m.files[0]!.path).toBe("jfk/training/videos/sujan/clone project 4K.mp4");

    // And the WRITE side persists POSIX too — round-trip through the real writer.
    writeRepoTrackingManifest(repoRoot, m);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("\\");
    expect(raw).toContain("jfk/training/videos/sujan/clone project 4K.mp4");
  });

  it("folds a backslash and slash spelling of the SAME file, unioning pinned_by and keeping the CID-bearing entry", async () => {
    const { readRepoTrackingManifest, repoTrackingManifestPath } = await svc();
    const repoRoot = path.join(tmp, "repo2");
    fs.mkdirSync(repoRoot, { recursive: true });
    const file = repoTrackingManifestPath(repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "schema_version: 1",
        "unit: repo",
        "files:",
        String.raw`  - path: a\b\video.mp4`,
        "    cid: bafywindows",
        "    size: 10",
        "    pinned_by:",
        "      - lenovo-laptop",
        "  - path: a/b/video.mp4",
        "    cid: null",
        "    size: 10",
        "    pinned_by:",
        "      - mac-pro",
      ].join("\n"),
    );
    const m = readRepoTrackingManifest(repoRoot);
    expect(m.files).toHaveLength(1);
    const f = m.files[0]!;
    expect(f.path).toBe("a/b/video.mp4");
    expect(f.cid).toBe("bafywindows");
    expect([...f.pinned_by].sort()).toEqual(["lenovo-laptop", "mac-pro"]);
  });
});
