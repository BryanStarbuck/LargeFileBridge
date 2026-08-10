// THE RECONCILE MUST GO QUIET WHEN NOTHING ARRIVED.
//
// `reconcileFromSyncRepo` used to `return true` whenever the mirror directory merely EXISTED, regardless of
// whether a single byte had changed. Its caller, `reconcileMirroredRepos`, reads that answer as "a peer's
// state arrived", and pays for it per repo: a whole-unit-manifest merge, a decision-ledger re-parse, and a
// UI topic bump. So on a computer where nothing had happened at all, every mirrored repo did all of that on
// every backbone pass.
//
// Measured on Bryan_Tower 2026-08-10: "reconciled 106 mirrored repo(s)" every 20-30 seconds, forever, 943
// times in one log — against 106 repos whose manifests (2,091 entries for charlie-kirk alone) and six-figure
// decision ledgers had not moved. That is the allocation storm behind the memory the app was billed for:
// RSS pinned near 1 GB with heapUsed ~200 MB and nothing in flight, and on the 16 GB laptop it climbed to
// 4.5 GB and the OS killed the process — which silently stopped the 15-minute sync schedule with it.
//
// The fix is honesty: report whether the merge actually changed anything on disk.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { setSyncRepoMarker, reconcileFromSyncRepo } from "./tracking-sync.service.js";
import { repoStateDir } from "./tracking-root.service.js";

const REMOTE = "https://github.com/ACT3ai/charlie-kirk.git";
let tmp: string;
let repoRoot: string;
let mirrorDir: string;

const write = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
};

const manifest = (files: { path: string; cid: string }[]): string =>
  YAML.stringify({
    schema_version: 1,
    files: files.map((f) => ({ path: f.path, cid: f.cid, size: 10, pinned_by: ["tower"] })),
  });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-reconcile-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "charlie-kirk");
  fs.mkdirSync(repoRoot, { recursive: true });
  const syncRepo = path.join(tmp, "sdl");
  setSyncRepoMarker(repoRoot, syncRepo, REMOTE);
  const marker = fs.readFileSync(path.join(repoStateDir(repoRoot), ".sync-repo"), "utf8").split("\n");
  mirrorDir = path.join(syncRepo, "repos", marker[1]!.trim());
  fs.mkdirSync(mirrorDir, { recursive: true });
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("reconcileFromSyncRepo — an idempotent pass is not an arrival", () => {
  it("reports an arrival the FIRST time a peer's manifest shows up", () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
  });

  it("goes QUIET on every pass after that, and STAYS quiet — this is the storm, gone", () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true); // the arrival
    for (let i = 0; i < 10; i++) {
      expect(reconcileFromSyncRepo(repoRoot)).toBe(false); // ...and 10 idle passes cost nothing downstream
    }
  });

  it("speaks up again the moment something REAL arrives — the gate must not swallow the news", () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    expect(reconcileFromSyncRepo(repoRoot)).toBe(false);

    write(
      path.join(mirrorDir, "manifest.yaml"),
      manifest([
        { path: "videos/a.mp4", cid: "bafy1" },
        { path: "videos/b.mp4", cid: "bafy2" }, // the peer pinned a second video
      ]),
    );
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    expect(reconcileFromSyncRepo(repoRoot)).toBe(false); // and quiet again straight after
  });

  it("counts an arriving SIDECAR as news too — a peer's transcript is a real change", () => {
    write(path.join(mirrorDir, "manifest.yaml"), manifest([{ path: "videos/a.mp4", cid: "bafy1" }]));
    reconcileFromSyncRepo(repoRoot);
    expect(reconcileFromSyncRepo(repoRoot)).toBe(false);

    write(
      path.join(mirrorDir, "files", "videos/a.mp4.yaml"),
      YAML.stringify({ file: { events: [{ at: "2026-08-05T09:00:00.000Z", kind: "observed", on_device: "tower" }] } }),
    );
    expect(reconcileFromSyncRepo(repoRoot)).toBe(true);
    // A sidecar SETTLES on the pass after it lands: the first pass copies the peer's bytes verbatim, the
    // second rewrites them in our canonical serialization. Two passes, not forever — that is the property
    // that matters, so assert it explicitly rather than assuming one.
    reconcileFromSyncRepo(repoRoot);
    for (let i = 0; i < 5; i++) expect(reconcileFromSyncRepo(repoRoot)).toBe(false);
  });

  it("stays quiet with no mirror at all, rather than reporting an arrival from an empty directory", () => {
    expect(reconcileFromSyncRepo(repoRoot)).toBe(false);
  });
});
