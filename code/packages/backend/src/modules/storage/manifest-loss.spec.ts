// THE MANIFEST IS SHARED STATE, AND EVERY PATH THAT WRITES IT MUST BE ADDITIVE (storage_company.mdx §8.4.3).
//
// Reconstructed from the live `all` repo's sync-repo history on 2026-08-05: of the 92 commits that touched
// `repos/eb94a756b52e/manifest.yaml`, EIGHT deleted entries and SIX deleted pin claims. Two distinct defects
// produced them, and both are locked down here:
//
//   1. `mirrorToSyncRepo` copied the manifest wholesale. It already captured + unioned `decisions.yaml`
//      before the copy, but the manifest — the same kind of shared, multi-computer state — rode the plain
//      `copyTree`. Commit a6cf284e6 deleted 6 entries and 13 pin claims ONE COMMIT after the peer that owned
//      them pushed them (be953d0f5).
//   2. Duplicate `- path:` blocks were collapsed LAST-WINS. `manifest.yaml` carries `merge=union`, so a
//      conflicting merge legitimately concatenates both sides — 27 of those 92 commits held 29 blocks for 19
//      distinct paths. Every reader keyed that list straight into a Map, so whichever twin held the CID or a
//      peer's claim was silently discarded on read, before any merge rule could protect it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import YAML from "yaml";
import type { Manifest, ManifestFile } from "@lfb/shared";
import { foldManifestFiles, mergeManifests, serializeManifest } from "./manifest-merge.js";

const TOWER = "bryan-mac-pro";
const NAYAN = "nayan-desktop-tqau7t7";
const VIDEO = "jfk/training/videos/nayan/Plan and Pricing.mp4";

const file = (over: Partial<ManifestFile> = {}): ManifestFile => ({
  path: VIDEO,
  cid: "bafyNAYAN",
  size: 100,
  sha256: null,
  modified_at: "2026-08-05T00:00:00.000Z",
  pinned_by: [NAYAN],
  ...over,
});
const manifest = (files: ManifestFile[], unit: Manifest["unit"] = "repo"): Manifest => ({
  schema_version: 1,
  unit,
  files,
});

describe("foldManifestFiles — a union-merged duplicate must UNION, never last-wins", () => {
  it("keeps both twins' pin claims when the same path appears twice", () => {
    // The exact shape git's `merge=union` leaves behind: two blocks, one per computer.
    const folded = foldManifestFiles(
      [file({ pinned_by: [TOWER] }), file({ pinned_by: [NAYAN] })],
      "repo",
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]!.pinned_by.sort()).toEqual([NAYAN, TOWER].sort());
  });

  it("prefers the twin that knows the CID over one that does not", () => {
    const folded = foldManifestFiles([file({ cid: null }), file({ cid: "bafyREAL" })], "repo");
    expect(folded[0]!.cid).toBe("bafyREAL");
    // …in either order — a fold must not depend on which side git happened to write first.
    expect(foldManifestFiles([file({ cid: "bafyREAL" }), file({ cid: null })], "repo")[0]!.cid).toBe("bafyREAL");
  });

  it("resolves two known CIDs by the newer modified_at", () => {
    const older = file({ cid: "bafyOLD", modified_at: "2026-01-01T00:00:00.000Z" });
    const newer = file({ cid: "bafyNEW", modified_at: "2026-08-05T00:00:00.000Z" });
    expect(foldManifestFiles([older, newer], "repo")[0]!.cid).toBe("bafyNEW");
    expect(foldManifestFiles([newer, older], "repo")[0]!.cid).toBe("bafyNEW");
  });

  it("folds a `\\`-spelled twin against its `/` spelling", () => {
    const folded = foldManifestFiles(
      [file({ path: "jfk\\training\\clip.mp4", pinned_by: [TOWER] }), file({ path: "jfk/training/clip.mp4", pinned_by: [NAYAN] })],
      "repo",
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]!.path).toBe("jfk/training/clip.mp4");
    expect(folded[0]!.pinned_by.sort()).toEqual([NAYAN, TOWER].sort());
  });

  it("leaves a COMPUTER unit's absolute Windows paths alone", () => {
    // `C:\Users\…` is a legitimate key there — healing it would destroy the entry (repo__list_syns.mdx §6.1).
    const folded = foldManifestFiles([file({ path: "C:\\Users\\bryan\\movie.mp4" })], "computer");
    expect(folded[0]!.path).toBe("C:\\Users\\bryan\\movie.mp4");
  });
});

describe("mergeManifests — duplicates on either side survive the merge", () => {
  it("does not lose a claim carried only by the FIRST of two local twins", () => {
    // Keying the raw list into a Map (last wins) drops the Tower's claim before the merge rules ever run.
    const local = manifest([file({ pinned_by: [TOWER] }), file({ pinned_by: [] })]);
    const merged = mergeManifests(local, manifest([]));
    expect(merged.files).toHaveLength(1);
    expect(merged.files[0]!.pinned_by).toContain(TOWER);
  });

  it("does not lose a claim carried only by the FIRST of two incoming twins", () => {
    const incoming = manifest([file({ pinned_by: [NAYAN] }), file({ pinned_by: [] })]);
    const merged = mergeManifests(manifest([file({ pinned_by: [TOWER] })]), incoming);
    expect(merged.files[0]!.pinned_by.sort()).toEqual([NAYAN, TOWER].sort());
  });
});

describe("serializeManifest — one canonical spelling, so no writer re-dirties another's bytes", () => {
  it("is byte-identical when re-serializing an unchanged list", () => {
    const m = manifest([file({ path: "b.mp4" }), file({ path: "a.mp4" })]);
    const once = serializeManifest(m);
    expect(serializeManifest(YAML.parse(once) as Manifest)).toBe(once);
  });

  it("is independent of entry order and pinned_by order", () => {
    const a = manifest([file({ path: "a.mp4", pinned_by: [TOWER, NAYAN] }), file({ path: "b.mp4" })]);
    const b = manifest([file({ path: "b.mp4" }), file({ path: "a.mp4", pinned_by: [NAYAN, TOWER] })]);
    expect(serializeManifest(a)).toBe(serializeManifest(b));
  });

  it("emits POSIX separators and folds duplicates on the way out", () => {
    const out = serializeManifest(manifest([file({ path: "jfk\\a.mp4" }), file({ path: "jfk/a.mp4" })]));
    expect(out).not.toContain("\\");
    expect((YAML.parse(out) as Manifest).files).toHaveLength(1);
  });
});

// ── the mirror itself: the write path that produced a6cf284e6 ────────────────────────────────────────
describe("mirrorToSyncRepo — the mirror is MERGED, never stamped over (§8.4.3)", () => {
  let stateDir: string;
  let repoRoot: string;
  let syncRepo: string;
  let mirrorDir: string;
  let mirrorToSyncRepo: (repoRoot: string) => boolean;
  let computerLabel: () => string;
  let localManifestPath: string;
  let prevStateDir: string | undefined;

  // A PEER label that cannot collide with whichever computer runs this suite. Every assertion below turns on
  // "is this claim ours or a peer's?", so a hard-coded real device name makes the test pass everywhere EXCEPT
  // on that device — where the merge correctly republishes it as OUR claim and the expectation is simply
  // wrong. `TOWER` here did exactly that: on bryan-mac-pro, `computerLabel()` IS "bryan-mac-pro", so
  // "does NOT re-publish a peer claim" failed on Bryan's machine alone while passing in every other checkout.
  // Deriving from the local label keeps it foreign by construction (strictly longer than it, so never equal).
  let peer: string;

  const REMOTE = "https://github.com/ACT3ai/all.git";

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-mirror-state-"));
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-mirror-repo-"));
    syncRepo = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-mirror-sync-"));
    // Own state root, SAVED AND RESTORED: the vitest baseline root is shared, and a spec that walks off
    // with it leaves the next file resolving state somewhere it did not choose.
    prevStateDir = process.env.LFB_STATE_DIR;
    process.env.LFB_STATE_DIR = stateDir;

    const mod = await import("./tracking-sync.service.js");
    const { repoStateDir, resolveStateSyncRepo } = await import("./tracking-root.service.js");
    mirrorToSyncRepo = mod.mirrorToSyncRepo;
    computerLabel = (await import("../store-model/config.service.js")).computerLabel;
    mod.setSyncRepoMarker(repoRoot, syncRepo, REMOTE);
    mirrorDir = resolveStateSyncRepo(repoRoot)!;
    localManifestPath = path.join(repoStateDir(repoRoot), "manifest.yaml");
    peer = `peer-${computerLabel()}-elsewhere`;
  });

  it("uses a peer label that is not this computer — the premise every case below rests on", () => {
    expect(peer).not.toBe(computerLabel());
  });

  afterAll(() => {
    if (prevStateDir === undefined) delete process.env.LFB_STATE_DIR;
    else process.env.LFB_STATE_DIR = prevStateDir;
    for (const d of [stateDir, repoRoot, syncRepo]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("keeps a peer's entry that this computer has never heard of", () => {
    // The mirror already holds the peer's push; Local Storage does not (the reconcile has not run, or ran
    // before the peer pushed). A wholesale copy is exactly how 6 files stopped existing for everyone.
    fs.mkdirSync(mirrorDir, { recursive: true });
    fs.writeFileSync(
      path.join(mirrorDir, "manifest.yaml"),
      serializeManifest(manifest([file({ path: VIDEO, pinned_by: [peer] })])),
      "utf8",
    );
    fs.writeFileSync(
      localManifestPath,
      serializeManifest(manifest([file({ path: "jfk/mine.mp4", cid: "bafyMINE", pinned_by: [computerLabel()] })])),
      "utf8",
    );

    expect(mirrorToSyncRepo(repoRoot)).toBe(true);

    const after = YAML.parse(fs.readFileSync(path.join(mirrorDir, "manifest.yaml"), "utf8")) as Manifest;
    expect(after.files.map((f) => f.path).sort()).toEqual([VIDEO, "jfk/mine.mp4"].sort());
    expect(after.files.find((f) => f.path === VIDEO)!.pinned_by).toEqual([peer]);
  });

  it("keeps a peer's pin claim on an entry both computers know", () => {
    // The 13 stripped `nayan-desktop-tqau7t7` claims in a6cf284e6, in one assertion: the claim is on the
    // MIRROR, and publishing must not stamp over it.
    const shared = "jfk/training/videos/shared.mp4";
    fs.writeFileSync(
      path.join(mirrorDir, "manifest.yaml"),
      serializeManifest(manifest([file({ path: shared, pinned_by: [peer] })])),
      "utf8",
    );
    fs.writeFileSync(
      localManifestPath,
      serializeManifest(manifest([file({ path: shared, pinned_by: [] })])),
      "utf8",
    );

    mirrorToSyncRepo(repoRoot);

    const after = YAML.parse(fs.readFileSync(path.join(mirrorDir, "manifest.yaml"), "utf8")) as Manifest;
    expect(after.files.find((f) => f.path === shared)!.pinned_by).toEqual([peer]);
  });

  it("does NOT re-publish a peer claim the mirror no longer carries", () => {
    // The other half of the same rule, and the one that stops the churn. Only the device named by a claim
    // can know it is still true, so on the wire every OTHER device's claim is the MIRROR's to state: we
    // pass through what it says and never add back what we happen to remember. Without this, a withdrawal
    // survives exactly one hop — measured 2026-08-11, `bryan-mac-pro` dropped 10 unbacked claims and the
    // second computer re-unioned every one from its stale copy, one commit each way, all day.
    const shared = "jfk/training/videos/shared.mp4";
    fs.writeFileSync(
      path.join(mirrorDir, "manifest.yaml"),
      serializeManifest(manifest([file({ path: shared, pinned_by: [] })])), // the peer withdrew it here
      "utf8",
    );
    fs.writeFileSync(
      localManifestPath,
      serializeManifest(manifest([file({ path: shared, pinned_by: [peer] })])), // our stale memory of it
      "utf8",
    );

    mirrorToSyncRepo(repoRoot);

    const after = YAML.parse(fs.readFileSync(path.join(mirrorDir, "manifest.yaml"), "utf8")) as Manifest;
    expect(after.files.find((f) => f.path === shared)!.pinned_by).toEqual([]);
  });

  it("still publishes OUR OWN claim from the local copy, not the mirror's view of it", () => {
    // The asymmetry that makes the rule above safe: a peer's claim comes from the wire, but ours comes from
    // US — it is the one claim this computer can actually prove, and the mirror's copy of it is only ever
    // our own past statement coming back.
    const shared = "jfk/training/videos/ours.mp4";
    fs.writeFileSync(
      path.join(mirrorDir, "manifest.yaml"),
      serializeManifest(manifest([file({ path: shared, pinned_by: [peer] })])),
      "utf8",
    );
    fs.writeFileSync(
      localManifestPath,
      serializeManifest(manifest([file({ path: shared, pinned_by: [computerLabel()] })])),
      "utf8",
    );

    mirrorToSyncRepo(repoRoot);

    const after = YAML.parse(fs.readFileSync(path.join(mirrorDir, "manifest.yaml"), "utf8")) as Manifest;
    expect(after.files.find((f) => f.path === shared)!.pinned_by.sort()).toEqual([peer, computerLabel()].sort());
  });

  it("leaves an unparseable mirror alone instead of stamping over it", () => {
    // `readManifestBestEffort` answers "nothing" for a file that EXISTS but will not parse, and the merge
    // is skipped in exactly that case — so before this, `copyTree` silently REPLACED a conflicted mirror
    // with this computer's copy: the wholesale overwrite the whole block exists to prevent, through the one
    // door left open.
    const conflicted = "<<<<<<< HEAD\nschema_version: 1\n=======\nfiles: []\n>>>>>>> origin/main\n";
    fs.writeFileSync(path.join(mirrorDir, "manifest.yaml"), conflicted, "utf8");
    fs.writeFileSync(localManifestPath, serializeManifest(manifest([file({ pinned_by: [] })])), "utf8");

    mirrorToSyncRepo(repoRoot);

    expect(fs.readFileSync(path.join(mirrorDir, "manifest.yaml"), "utf8")).toBe(conflicted);
  });

  it("writes byte-stable bytes — a mirror of unchanged state produces no diff to commit", () => {
    const before = fs.readFileSync(path.join(mirrorDir, "manifest.yaml"), "utf8");
    mirrorToSyncRepo(repoRoot);
    expect(fs.readFileSync(path.join(mirrorDir, "manifest.yaml"), "utf8")).toBe(before);
  });
});
