// The duplicate-row defect, pinned at the two places it was actually made (repo__list_syns.mdx §6.1).
//
// `manifest.service.ts` healed the committed + tracking manifests, but the UNIT manifest was read straight
// out of the state store, unhealed. So a `\` entry from a Windows peer survived in `pin/r/<repo>/
// manifest.yaml` forever, `mergeManifests` (which keys by exact path) never folded it against the `/`
// spelling, and `remoteOnlyRows` emitted a SECOND red pull-down row for the same file — one the user could
// never clear, because a `\` path cannot match anything in the working tree.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest, RepoUnitConfig } from "@lfb/shared";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-unit-manifest-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function svc() {
  return await import("./units.service.js");
}

function writeUnit(folder: string, files: string[], extra: string[] = []): void {
  const dir = path.join(tmp, "state", "pin", "r", folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.yaml"),
    ["schema_version: 1", "unit: repo", "files:", ...files].join("\n"),
  );
  if (extra.length) fs.writeFileSync(path.join(dir, "config.yaml"), extra.join("\n"));
}

const entry = (p: string, cid: string, device: string): string[] => [
  `  - path: ${p}`,
  `    cid: ${cid}`,
  "    size: 351000000",
  "    pinned_by:",
  `      - ${device}`,
];

describe("getRepoManifest — the unit manifest is healed like every other manifest", () => {
  it("normalizes a Windows peer's `\\` entry", async () => {
    const { getRepoManifest } = await svc();
    writeUnit("all", entry(String.raw`jfk\videos\sujan\preview and sets 4k.mp4`, "bafywin", "lenovo-laptop"));
    const m = getRepoManifest("all");
    expect(m.files.map((f) => f.path)).toEqual(["jfk/videos/sujan/preview and sets 4k.mp4"]);
  });

  it("FOLDS the `\\` and `/` spellings into one entry, unioning the pin claims", async () => {
    const { getRepoManifest } = await svc();
    writeUnit("all", [
      ...entry(String.raw`jfk\videos\sujan\preview and sets 4k.mp4`, "bafywin", "lenovo-laptop"),
      ...entry("jfk/videos/sujan/preview and sets 4k.mp4", "bafywin", "bryan-mac-pro"),
    ]);
    const m = getRepoManifest("all");
    expect(m.files).toHaveLength(1);
    expect([...m.files[0]!.pinned_by].sort()).toEqual(["bryan-mac-pro", "lenovo-laptop"]);
  });
});

describe("remoteOnlyRows — one file, one row", () => {
  const cfg = (repoPath: string): RepoUnitConfig =>
    ({ repo: { path: repoPath, name: "all", remote: null }, decisions: {} }) as unknown as RepoUnitConfig;

  const manifest = (files: Manifest["files"]): Manifest => ({ schema_version: 1, unit: "repo", files });

  const file = (p: string, device: string): Manifest["files"][number] =>
    ({ path: p, cid: "bafyexample", size: 351_000_000, sha256: null, pinned_by: [device] });

  it("emits ONE pull-down row for a file a peer spelled both ways", async () => {
    const { remoteOnlyRows } = await svc();
    const { normalizeManifestPaths } = await import("../pin/manifest-normalize.js");
    const repo = path.join(tmp, "all");
    fs.mkdirSync(repo, { recursive: true });

    const both = manifest([
      file(String.raw`jfk\videos\clip.mp4`, "lenovo-laptop"),
      file("jfk/videos/clip.mp4", "lenovo-laptop"),
    ]);
    // BEFORE the heal this is the bug, verbatim: two rows for one file.
    expect(await remoteOnlyRows(cfg(repo), both, [], repo, "bryan-mac-pro")).toHaveLength(2);
    // AFTER it — which is what every manifest reader now does — one.
    const healed = normalizeManifestPaths(both, "test");
    const rows = await remoteOnlyRows(cfg(repo), healed, [], repo, "bryan-mac-pro");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe("jfk/videos/clip.mp4");
  });

  it("does not offer a pull for a file that IS on this disk under its POSIX name", async () => {
    const { remoteOnlyRows } = await svc();
    const { normalizeManifestPaths } = await import("../pin/manifest-normalize.js");
    const repo = path.join(tmp, "all2");
    fs.mkdirSync(path.join(repo, "jfk", "videos"), { recursive: true });
    fs.writeFileSync(path.join(repo, "jfk", "videos", "clip.mp4"), "BYTES");

    const m = normalizeManifestPaths(manifest([file(String.raw`jfk\videos\clip.mp4`, "lenovo-laptop")]), "test");
    // The whole "the pull-down list never clears" symptom: unhealed, existsSync(`repo/jfk\videos\clip.mp4`)
    // is false forever, so the row is re-offered on every single pass even though the bytes are right here.
    expect(await remoteOnlyRows(cfg(repo), m, [], repo, "bryan-mac-pro")).toHaveLength(0);
  });
});
