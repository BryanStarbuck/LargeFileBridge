// The heavy merges run on the merge WORKER THREAD under the interruptible drivers (performance.mdx P-59) —
// and doing so must never cost a decision. Real worker, real files.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { setSyncRepoMarker, reconcileFromSyncRepoYielding, resetLedgerSyncMemo } from "./tracking-sync.service.js";
import { repoStateDir } from "./tracking-root.service.js";
import { stopMergeWorker } from "./merge-offload.js";

let tmp: string;
let repoRoot: string;
let mirrorDir: string;
const localLedger = (): string => path.join(repoStateDir(repoRoot), "decisions.yaml");
const ledger = (...paths: string[]): string =>
  YAML.stringify({
    schema_version: 1,
    events: paths.map((p, i) => ({
      sid: "s1",
      path: p,
      asked: true,
      ipfs: true,
      gitignore: false,
      decided_by: "tower",
      decided_at: `2026-09-27T1${i}:00:00.000Z`,
    })),
  });
const paths = (file: string): string[] =>
  ((YAML.parse(fs.readFileSync(file, "utf8")) as { events: { path: string }[] }).events ?? []).map((e) => e.path).sort();

beforeEach(() => {
  process.env.LFB_MERGE_WORKER = "on";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-merge-offload-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "charlie-kirk");
  fs.mkdirSync(repoRoot, { recursive: true });
  const syncRepo = path.join(tmp, "sdl");
  setSyncRepoMarker(repoRoot, syncRepo, "https://github.com/ACT3ai/charlie-kirk.git");
  const uid = fs.readFileSync(path.join(repoStateDir(repoRoot), ".sync-repo"), "utf8").split("\n")[1]!.trim();
  mirrorDir = path.join(syncRepo, "repos", uid);
  fs.mkdirSync(mirrorDir, { recursive: true });
  resetLedgerSyncMemo();
});
afterEach(async () => {
  await stopMergeWorker();
  delete process.env.LFB_MERGE_WORKER;
  delete process.env.LFB_STATE_DIR;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the merge worker", () => {
  it("merges a peer's ledger with NO ledger parse on the main thread", async () => {
    fs.writeFileSync(path.join(mirrorDir, "decisions.yaml"), ledger("videos/peer.mp4"));
    fs.writeFileSync(localLedger(), ledger("videos/mine.mp4"));
    const parse = vi.spyOn(YAML, "parse"); // this spy sees the MAIN thread only
    await reconcileFromSyncRepoYielding(repoRoot);
    const mainThreadLedgerParses = parse.mock.calls.filter((c) => String(c[0]).includes("decided_at")).length;
    expect(mainThreadLedgerParses).toBe(0);
    expect(paths(localLedger())).toEqual(["videos/mine.mp4", "videos/peer.mp4"]);
  }, 60_000);

  it("never overwrites a decision recorded while the worker was merging", async () => {
    fs.writeFileSync(path.join(mirrorDir, "decisions.yaml"), ledger("videos/peer.mp4"));
    fs.writeFileSync(localLedger(), ledger("videos/mine.mp4"));
    const pass = reconcileFromSyncRepoYielding(repoRoot);
    // The user clicks while the merge is in flight — on this thread, before the worker has answered.
    fs.writeFileSync(localLedger(), ledger("videos/mine.mp4", "videos/clicked.mp4"));
    await pass;
    expect(paths(localLedger())).toContain("videos/clicked.mp4");
    // …and the next pass completes the merge from what is actually on disk.
    await reconcileFromSyncRepoYielding(repoRoot);
    expect(paths(localLedger())).toEqual(["videos/clicked.mp4", "videos/mine.mp4", "videos/peer.mp4"]);
  }, 60_000);
});
