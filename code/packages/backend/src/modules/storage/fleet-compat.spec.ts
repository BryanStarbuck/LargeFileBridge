// FLEET COMPATIBILITY — a newer build must never be dragged into a fight by an older one
// (backward_compatibility.md). Each block pins one defence:
//   §3   writer stamps — carried, preferred, and never part of an event's identity;
//   §4.2 the semantic write gate — a shared copy is not rewritten for a difference no reader can see;
//   §5   the tug-of-war breaker — a repeated EXTERNAL reversal of the same bytes stops being answered.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { DecisionEvent, DeletionRecord, Deletions } from "@lfb/shared";
import { unionLedgerEvents, ledgerMeaning, serializeLedger } from "./ledger-merge.js";
import { deletionsMeaning, serializeDeletions, emptyDeletions } from "../pin/deletions-merge.js";
import { writeSharedIfDifferent, listSyncFights, resetSyncFights } from "./sync-fight.js";
import { setSyncRepoMarker, mirrorToSyncRepoNow, resetLedgerSyncMemo } from "./tracking-sync.service.js";
import { repoStateDir } from "./tracking-root.service.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-fleet-compat-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  resetSyncFights();
  resetLedgerSyncMemo();
});
afterEach(() => {
  resetSyncFights();
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ev = (over: Partial<DecisionEvent> = {}): DecisionEvent => ({
  sid: "r:1",
  path: "videos/a.mp4",
  fingerprint: null,
  asked: true,
  ipfs: true,
  gitignore: false,
  decided_by: "bryan",
  decided_at: "2026-09-27T10:00:00.000Z",
  ...over,
});

describe("§3 writer stamps", () => {
  it("the same event with and without a stamp is ONE event, and the stamped copy wins either way round", () => {
    const stamped = ev({ writer_build: 7, writer_device: "tower" });
    const stripped = ev(); // what an older build leaves after re-serializing it
    for (const [a, b] of [[[stamped], [stripped]], [[stripped], [stamped]]] as const) {
      const u = unionLedgerEvents([...a], [...b]);
      expect(u).toHaveLength(1);
      expect(u[0]!.writer_build).toBe(7);
    }
  });

  it("a stamp survives a serialize → parse round trip, and an unstamped event gains nothing", () => {
    const text = serializeLedger([ev({ writer_build: 7, writer_device: "tower" }), ev({ path: "b.mp4" })]);
    const back = (YAML.parse(text) as { events: Record<string, unknown>[] }).events;
    expect(back.find((e) => e.path === "videos/a.mp4")).toMatchObject({ writer_build: 7, writer_device: "tower" });
    expect(back.find((e) => e.path === "b.mp4")).not.toHaveProperty("writer_build");
  });
});

describe("§4.2 the ledger's meaning", () => {
  it("ignores order, stripped stamps, and repeated statements of the same decision", () => {
    const a = [ev({ writer_build: 7 }), ev({ path: "b.mp4", decided_at: "2026-09-27T11:00:00.000Z" })];
    const b = [
      ev({ path: "b.mp4", decided_at: "2026-09-27T11:00:00.000Z" }),
      ev({ decided_at: "2026-09-27T09:00:00.000Z" }), // superseded history an older copy still carries
      ev(),
    ];
    expect(ledgerMeaning(a)).toBe(ledgerMeaning(b));
  });

  it("changes when any reader's answer changes — a new decision, or the same file decided differently", () => {
    const base = [ev()];
    expect(ledgerMeaning([...base, ev({ path: "new.mp4" })])).not.toBe(ledgerMeaning(base));
    expect(ledgerMeaning([...base, ev({ asked: false, decided_at: "2026-09-27T12:00:00.000Z" })])).not.toBe(
      ledgerMeaning(base),
    );
  });
});

describe("§4.2 the deletion ledger's meaning", () => {
  const rec = (over: Partial<DeletionRecord> = {}): DeletionRecord => ({
    path: "img/x.jpg",
    cid: "bafyX",
    cid_alternates: [],
    sha256: "aa",
    size: 1,
    scope: "fleet",
    reason: "",
    removed_at: "2026-09-20T00:00:00.000Z",
    removed_by: "",
    removed_on_device: "tower",
    actions: { delete_bytes: true, unpin: true },
    enforced_by: [],
    undeleted_at: null,
    undeleted_by: null,
    undelete_reason: null,
    ...over,
  });
  const doc = (...r: DeletionRecord[]): Deletions => ({ ...emptyDeletions(), deletions: r });

  it("ignores writer stamps, twins and order", () => {
    const ours = doc(rec({ writer_build: 7, writer_device: "tower" }), rec({ path: "img/y.jpg" }));
    const oldBuild = doc(rec({ path: "img/y.jpg" }), rec({ sha256: null }), rec());
    expect(deletionsMeaning(ours)).toBe(deletionsMeaning(oldBuild));
  });

  it("changes when a tombstone is added or undeleted", () => {
    const base = doc(rec());
    expect(deletionsMeaning(doc(rec(), rec({ path: "img/z.jpg" })))).not.toBe(deletionsMeaning(base));
    expect(deletionsMeaning(doc(rec({ undeleted_at: "2026-09-21T00:00:00.000Z" })))).not.toBe(deletionsMeaning(base));
  });

  it("serializes a stamp only when the record has one", () => {
    expect(serializeDeletions(doc(rec({ writer_build: 7 })))).toContain("writer_build: 7");
    expect(serializeDeletions(doc(rec()))).not.toContain("writer_build");
  });
});

describe("§5 the tug-of-war breaker", () => {
  const file = (): string => path.join(tmp, "sdl", "repos", "x", "decisions.yaml");
  const peerWrites = (text: string): void => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), text);
  };

  it("stops re-answering after the same external reversal three times, and says so", () => {
    peerWrites("theirs\n");
    for (let i = 0; i < 3; i++) {
      expect(writeSharedIfDifferent(file(), "ours\n")).toBe(true);
      peerWrites("theirs\n"); // the older build turns it back
    }
    expect(writeSharedIfDifferent(file(), "ours\n")).toBe(false); // the fourth time: held
    expect(fs.readFileSync(file(), "utf8")).toBe("theirs\n");
    expect(listSyncFights().map((f) => f.file)).toEqual([file()]);
  });

  it("never holds a REAL change — new bytes are a new pair", () => {
    peerWrites("theirs\n");
    for (let i = 0; i < 3; i++) {
      writeSharedIfDifferent(file(), "ours\n");
      peerWrites("theirs\n");
    }
    expect(writeSharedIfDifferent(file(), "ours\n")).toBe(false);
    expect(writeSharedIfDifferent(file(), "ours plus a new decision\n")).toBe(true);
    expect(listSyncFights()).toEqual([]); // the other side can now move on
  });

  it("never counts OUR OWN back-and-forth — a user toggling a decision is not a fight", () => {
    peerWrites("a\n");
    for (let i = 0; i < 6; i++) {
      expect(writeSharedIfDifferent(file(), "b\n")).toBe(true);
      expect(writeSharedIfDifferent(file(), "a\n")).toBe(true);
    }
    expect(listSyncFights()).toEqual([]);
  });
});

describe("§4.2 end to end: the mirror is not rewritten for spelling", () => {
  it("leaves a shared ledger an older build wrote (unstamped, uncompacted, reordered) exactly as it is", () => {
    const repoRoot = path.join(tmp, "charlie-kirk");
    fs.mkdirSync(repoRoot, { recursive: true });
    const syncRepo = path.join(tmp, "sdl");
    setSyncRepoMarker(repoRoot, syncRepo, "https://github.com/ACT3ai/charlie-kirk.git");
    const uid = fs.readFileSync(path.join(repoStateDir(repoRoot), ".sync-repo"), "utf8").split("\n")[1]!.trim();
    const mirror = path.join(syncRepo, "repos", uid, "decisions.yaml");
    const local = path.join(repoStateDir(repoRoot), "decisions.yaml");

    // Local (this build): compacted and stamped.
    fs.writeFileSync(local, serializeLedger([ev({ writer_build: 7, writer_device: "tower" })]));
    // Mirror (an older build): the same decision, unstamped, plus a superseded restatement.
    const legacy = YAML.stringify({ schema_version: 1, events: [ev(), ev({ decided_at: "2026-09-27T08:00:00.000Z" })] });
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    fs.writeFileSync(mirror, legacy);

    mirrorToSyncRepoNow(repoRoot);
    expect(fs.readFileSync(mirror, "utf8")).toBe(legacy); // untouched: same meaning

    // …but a real new decision here still travels.
    fs.writeFileSync(local, serializeLedger([ev({ writer_build: 7 }), ev({ path: "videos/new.mp4", writer_build: 7 })]));
    mirrorToSyncRepoNow(repoRoot);
    expect(fs.readFileSync(mirror, "utf8")).toContain("videos/new.mp4");
  });
});
