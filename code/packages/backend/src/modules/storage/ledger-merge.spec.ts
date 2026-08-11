// The decision-ledger UNION MERGE (ledger-merge.ts) — the regression these tests pin down is the
// 2026-07-20 "not backed up: 22 on the tower / 0 on the laptop" defect: the sync-repo mirror's
// decisions.yaml was COPIED wholesale in both directions, so whichever writer went last erased the other
// side's events. Decisions then survived only in the machine-local frozen cache — honored locally,
// unable to ever reach the user's other computers.
import { describe, it, expect } from "vitest";
import type { DecisionEvent } from "@lfb/shared";
import { unionLedgerEvents, parseLedgerBestEffort, serializeLedger, compactLedger } from "./ledger-merge.js";

function ev(path: string, decidedAt: string, over: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    sid: "r:1298871ad952",
    path,
    fingerprint: null,
    asked: true,
    ipfs: true,
    gitignore: false,
    decided_by: "u_ebd7ef1c147d",
    decided_at: decidedAt,
    ...over,
  };
}

describe("unionLedgerEvents", () => {
  it("keeps events present on EITHER side — a merge is never last-writer-wins", () => {
    const towerOnly = ev("videos/a.mp4", "2026-07-20T19:09:03.446Z");
    const laptopOnly = ev("videos/b.mp4", "2026-07-20T18:00:00.000Z");
    const shared = ev("cover_image/c.png", "2026-07-20T19:08:27.841Z");
    const merged = unionLedgerEvents([towerOnly, shared], [laptopOnly, shared]);
    expect(merged).toHaveLength(3);
    expect(merged.map((e) => e.path).sort()).toEqual(["cover_image/c.png", "videos/a.mp4", "videos/b.mp4"]);
  });

  it("collapses exact duplicates but keeps a decide/tombstone pair for the same path", () => {
    const decide = ev("videos/a.mp4", "2026-07-20T10:00:00.000Z");
    const tombstone = ev("videos/a.mp4", "2026-07-20T11:00:00.000Z", { asked: false, ipfs: false });
    const merged = unionLedgerEvents([decide, tombstone], [decide]);
    expect(merged).toHaveLength(2); // duplicate `decide` collapsed; the tombstone survives to fold
  });

  it("sorts deterministically (decided_at, sid, path, decided_by) so re-serialization never churns", () => {
    const a = ev("z.mp4", "2026-07-20T10:00:00.000Z");
    const b = ev("a.mp4", "2026-07-20T10:00:00.000Z");
    const c = ev("m.mp4", "2026-07-19T10:00:00.000Z");
    expect(unionLedgerEvents([a], [b, c]).map((e) => e.path)).toEqual(["m.mp4", "a.mp4", "z.mp4"]);
    expect(serializeLedger([a, b, c])).toEqual(serializeLedger([c, b, a]));
  });
});

describe("parseLedgerBestEffort", () => {
  it("yields [] for missing/corrupt/conflicted input so a bad copy can never erase the other side", () => {
    expect(parseLedgerBestEffort(null)).toEqual([]);
    expect(parseLedgerBestEffort("not: [valid")).toEqual([]);
    expect(parseLedgerBestEffort("<<<<<<< HEAD\nevents: []\n=======\n>>>>>>> theirs\n")).toEqual([]);
  });

  it("round-trips through serializeLedger", () => {
    const events = [ev("videos/a.mp4", "2026-07-20T19:09:03.446Z")];
    expect(parseLedgerBestEffort(serializeLedger(events))).toEqual(events);
  });
});

// COMPACTION — the ledger is append-only and union-merged, so a writer that re-appends an unchanged
// decision every pass grows it without bound and nothing can ever shrink it again. That is what the
// Windows-separator mismatch in `reconcile` did: 21,142 events for 2,059 files on the live company repo,
// 5 MB parsed on every decision, one file re-stamped 1,585 times in two days.
describe("compactLedger", () => {
  const restamps = (n: number): DecisionEvent[] =>
    Array.from({ length: n }, (_, i) => ev("videos/a.mp4", `2026-08-04T0${i}:00:00.000Z`, { decided_by: "migrated" }));

  it("keeps the FIRST and LAST statement of an unchanged decision and drops the middle", () => {
    const kept = compactLedger(restamps(5));
    expect(kept.map((e) => e.decided_at)).toEqual(["2026-08-04T00:00:00.000Z", "2026-08-04T04:00:00.000Z"]);
  });

  it("never changes what `foldLedger` answers — the latest event of every group survives", () => {
    const events = [...restamps(5), ev("videos/a.mp4", "2026-08-05T00:00:00.000Z", { ipfs: false })];
    const kept = compactLedger(events);
    const latest = [...kept].sort((a, b) => b.decided_at.localeCompare(a.decided_at))[0]!;
    expect(latest.decided_at).toBe("2026-08-05T00:00:00.000Z");
    expect(latest.ipfs).toBe(false);
  });

  it("keeps every CHANGE of decision, however many times each was re-stamped", () => {
    const kept = compactLedger([
      ...restamps(4),
      ev("videos/a.mp4", "2026-08-04T05:00:00.000Z", { ipfs: false, decided_by: "u_a" }),
      ev("videos/a.mp4", "2026-08-04T06:00:00.000Z", { gitignore: true, decided_by: "u_a" }),
    ]);
    expect(kept).toHaveLength(4);
    expect(kept.filter((e) => !e.ipfs)).toHaveLength(1);
    expect(kept.filter((e) => e.gitignore)).toHaveLength(1);
  });

  it("collapses a Windows peer's re-stamp against this computer's — the fold's own path normalization", () => {
    // Two spellings of ONE file is exactly how the defect doubled: `jfk\\training\\…` from a Windows
    // teammate never matched `jfk/training/…` here, so both lines lived on forever.
    const kept = compactLedger([
      ev("jfk\\training\\a.mp4", "2026-08-04T00:00:00.000Z", { decided_by: "migrated" }),
      ev("jfk/training/a.mp4", "2026-08-04T01:00:00.000Z", { decided_by: "migrated" }),
      ev("jfk\\training\\a.mp4", "2026-08-04T02:00:00.000Z", { decided_by: "migrated" }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("is IDEMPOTENT and order-independent, so two computers converge instead of ping-ponging", () => {
    const events = [...restamps(6), ev("videos/b.mp4", "2026-08-04T09:00:00.000Z")];
    const once = serializeLedger(events);
    expect(serializeLedger(parseLedgerBestEffort(once))).toBe(once);
    expect(serializeLedger([...events].reverse())).toBe(once);
    // And the union of a compacted copy with an UNCOMPACTED peer's still lands on that one answer.
    expect(serializeLedger(unionLedgerEvents(parseLedgerBestEffort(once), events))).toBe(once);
  });
});
