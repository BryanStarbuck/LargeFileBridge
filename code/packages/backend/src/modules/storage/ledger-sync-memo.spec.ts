// The ledger union is a PURE function of two files' contents — so running it again over two files that
// have not moved re-derives an answer already on disk.
//
// `writeIfDifferent` stopped the WRITE; it could not stop the work in front of it. On this machine
// `charlie-kirk/decisions.yaml` is 3.1 MB and `all/decisions.yaml` is 1.9 MB, and every mirror and every
// reconcile parsed BOTH sides and re-serialized the union. A CPU profile of the live backend attributed
// 1.38 s to `parseLedgerBestEffort` and 0.25 s to `serializeLedger` on a loop that was already blocking
// for seconds at a time (see performance.mdx P-40/P-44).
//
// The memo is of OUR OWN COMPLETED WORK, not of the data, and this file's job is to prove that distinction
// holds: any real edit to either side — a local decision, a git merge, a peer's push landing in the
// mirror — must still be merged.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { setSyncRepoMarker, reconcileFromSyncRepo, resetLedgerSyncMemo } from "./tracking-sync.service.js";
import { repoStateDir } from "./tracking-root.service.js";

const REMOTE = "https://github.com/ACT3ai/charlie-kirk.git";
let tmp: string;
let repoRoot: string;
let mirrorDir: string;

const write = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
};

const ledger = (events: { path: string; at: string }[]): string =>
  YAML.stringify({
    schema_version: 1,
    events: events.map((e) => ({
      sid: "s1",
      path: e.path,
      asked: true,
      ipfs: true,
      gitignore: true,
      decided_by: "tower",
      decided_at: e.at,
    })),
  });

const localLedger = (): string => path.join(repoStateDir(repoRoot), "decisions.yaml");
const eventPaths = (file: string): string[] =>
  ((YAML.parse(fs.readFileSync(file, "utf8")) as { events: { path: string }[] }).events ?? [])
    .map((e) => e.path)
    .sort();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-ledger-memo-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "charlie-kirk");
  fs.mkdirSync(repoRoot, { recursive: true });
  const syncRepo = path.join(tmp, "sdl");
  setSyncRepoMarker(repoRoot, syncRepo, REMOTE);
  const marker = fs.readFileSync(path.join(repoStateDir(repoRoot), ".sync-repo"), "utf8").split("\n");
  mirrorDir = path.join(syncRepo, "repos", marker[1]!.trim());
  fs.mkdirSync(mirrorDir, { recursive: true });
  resetLedgerSyncMemo();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the ledger union runs once per unchanged pair", () => {
  it("merges the peer's events the first time, then stops re-parsing on idle passes", () => {
    write(path.join(mirrorDir, "decisions.yaml"), ledger([{ path: "videos/peer.mp4", at: "2026-08-01T10:00:00Z" }]));
    write(localLedger(), ledger([{ path: "videos/mine.mp4", at: "2026-08-01T09:00:00Z" }]));

    reconcileFromSyncRepo(repoRoot);
    expect(eventPaths(localLedger())).toEqual(["videos/mine.mp4", "videos/peer.mp4"]); // union, both sides

    // Now the expensive half must not run again while nothing has moved.
    const parse = vi.spyOn(YAML, "parse");
    for (let i = 0; i < 5; i++) reconcileFromSyncRepo(repoRoot);
    const ledgerParses = parse.mock.calls.filter((c) => String(c[0]).includes("decided_at"));
    expect(ledgerParses).toHaveLength(0);
  });

  it("re-merges when the PEER pushes a new event into the mirror", () => {
    write(path.join(mirrorDir, "decisions.yaml"), ledger([{ path: "videos/peer.mp4", at: "2026-08-01T10:00:00Z" }]));
    write(localLedger(), ledger([{ path: "videos/mine.mp4", at: "2026-08-01T09:00:00Z" }]));
    reconcileFromSyncRepo(repoRoot);

    write(
      path.join(mirrorDir, "decisions.yaml"),
      ledger([
        { path: "videos/peer.mp4", at: "2026-08-01T10:00:00Z" },
        { path: "videos/second.mp4", at: "2026-08-02T10:00:00Z" },
      ]),
    );
    reconcileFromSyncRepo(repoRoot);
    expect(eventPaths(localLedger())).toEqual(["videos/mine.mp4", "videos/peer.mp4", "videos/second.mp4"]);
  });

  it("re-merges when THIS computer records a decision between passes", () => {
    write(path.join(mirrorDir, "decisions.yaml"), ledger([{ path: "videos/peer.mp4", at: "2026-08-01T10:00:00Z" }]));
    write(localLedger(), ledger([{ path: "videos/mine.mp4", at: "2026-08-01T09:00:00Z" }]));
    reconcileFromSyncRepo(repoRoot);

    // A local write the memo has never seen. Losing this is how a decision made here stops travelling.
    write(
      localLedger(),
      ledger([
        { path: "videos/mine.mp4", at: "2026-08-01T09:00:00Z" },
        { path: "videos/local-new.mp4", at: "2026-08-03T09:00:00Z" },
      ]),
    );
    reconcileFromSyncRepo(repoRoot);
    expect(eventPaths(localLedger())).toEqual([
      "videos/local-new.mp4",
      "videos/mine.mp4",
      "videos/peer.mp4", // the peer's event survives the re-merge
    ]);
  });
});
