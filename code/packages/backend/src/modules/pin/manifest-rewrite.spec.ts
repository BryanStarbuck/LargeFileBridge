// AN UNCHANGED MANIFEST MUST NOT MOVE ON DISK (performance.mdx P-55).
//
// `writeManifestFile` writes atomically — temp file, fsync, rename — which is correct and which also hands
// the destination a NEW INODE AND A NEW mtime every time it runs. That triple (ino, size, mtimeNs) is the
// identity every memo in `tracking-sync.service.ts` is keyed on, so an unconditional rewrite of an
// unchanged manifest silently destroys them: `sameBytes`'s equality memo and `pairSettled`'s merge memo
// both go cold, and the next reconcile re-parses BOTH copies of a multi-megabyte document.
//
// On the reference machine that was `charlie-kirk`'s 1.07 MB tracking manifest, rewritten byte-identically
// on every pin pass, and it was the whole of the remaining `EVENT LOOP BLOCKED … up to 1353ms`. A
// multi-megabyte `YAML.parse` is the one atom no yield point can split, so the only way not to pay it is
// not to need it.
//
// THIS PROPERTY IS INVISIBLE IN THE OUTPUT — a manifest rewritten identically has exactly the same
// contents as one that was left alone — so no other test in this suite can tell the two apart. That is
// precisely why it is pinned here, and it is pinned on the FILE IDENTITY rather than on a call count,
// because the identity is the thing the memos actually read.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-manifest-rewrite-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function svc() {
  return await import("./manifest.service.js");
}

/** The exact triple the memos in tracking-sync.service.ts key on. */
function identity(file: string): string {
  const s = fs.statSync(file, { bigint: true });
  return `${s.ino},${s.size},${s.mtimeNs}`;
}

const FILES = [
  { path: "videos/one.mp4", size: 100, cid: null, sha256: null, pinned_by: [] },
  { path: "videos/two.mp4", size: 200, cid: null, sha256: null, pinned_by: [] },
];

describe("writeRepoTrackingManifest — an identical manifest leaves the file untouched", () => {
  it("does not change the file's (ino, size, mtimeNs) when nothing changed", async () => {
    const { writeRepoTrackingManifest, readRepoTrackingManifest, repoTrackingManifestPath } = await svc();
    const repoRoot = path.join(tmp, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    const file = repoTrackingManifestPath(repoRoot);

    // CONVERGE FIRST. A hand-built manifest is not a fixed point: `readRepoTrackingManifest` fills in the
    // schema's defaults, so the first read-then-write legitimately rewrites the file with the fuller
    // document. The property under test is about the SETTLED state — which is the state the pin pass is
    // in on every pass but the first — so reach it before measuring.
    writeRepoTrackingManifest(repoRoot, { schema_version: 1, unit: "repo", files: FILES });
    writeRepoTrackingManifest(repoRoot, readRepoTrackingManifest(repoRoot));
    const settled = identity(file);

    // Now the pass the product actually repeats, three times over: read, change nothing, write back.
    for (let i = 0; i < 3; i++) writeRepoTrackingManifest(repoRoot, readRepoTrackingManifest(repoRoot));

    expect(identity(file)).toBe(settled);
  });

  it("still writes — and moves the identity — the moment the content really changes", async () => {
    // The other half, and the one whose loss would be silent DATA LOSS: skipping an identical write must
    // never become skipping a real one.
    const { writeRepoTrackingManifest, readRepoTrackingManifest, repoTrackingManifestPath } = await svc();
    const repoRoot = path.join(tmp, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    const file = repoTrackingManifestPath(repoRoot);

    writeRepoTrackingManifest(repoRoot, { schema_version: 1, unit: "repo", files: FILES });
    const before = identity(file);

    writeRepoTrackingManifest(repoRoot, {
      schema_version: 1,
      unit: "repo",
      files: [...FILES, { path: "videos/three.mp4", size: 300, cid: null, sha256: null, pinned_by: [] }],
    });

    expect(identity(file)).not.toBe(before);
    expect(readRepoTrackingManifest(repoRoot).files.map((f) => f.path)).toContain("videos/three.mp4");
  });

  it("writes when the file is absent (the skip must not swallow the first write)", async () => {
    const { writeRepoTrackingManifest, repoTrackingManifestPath } = await svc();
    const repoRoot = path.join(tmp, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    const file = repoTrackingManifestPath(repoRoot);
    expect(fs.existsSync(file)).toBe(false);

    writeRepoTrackingManifest(repoRoot, { schema_version: 1, unit: "repo", files: FILES });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("writes over an unreadable file rather than skipping it", async () => {
    // The comparison read is wrapped in try/catch so a corrupt destination falls through to the write. A
    // skip here would leave garbage in place forever.
    const { writeRepoTrackingManifest, repoTrackingManifestPath } = await svc();
    const repoRoot = path.join(tmp, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    const file = repoTrackingManifestPath(repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "this is not a manifest\n");

    writeRepoTrackingManifest(repoRoot, { schema_version: 1, unit: "repo", files: FILES });
    expect(fs.readFileSync(file, "utf8")).toContain("videos/one.mp4");
  });
});
