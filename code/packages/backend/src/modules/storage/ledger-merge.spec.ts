// The decision-ledger UNION MERGE (ledger-merge.ts) — the regression these tests pin down is the
// 2026-07-20 "not backed up: 22 on the tower / 0 on the laptop" defect: the sync-repo mirror's
// decisions.yaml was COPIED wholesale in both directions, so whichever writer went last erased the other
// side's events. Decisions then survived only in the machine-local frozen cache — honored locally,
// unable to ever reach the user's other computers.
import { describe, it, expect } from "vitest";
import type { DecisionEvent } from "@lfb/shared";
import { unionLedgerEvents, parseLedgerBestEffort, serializeLedger } from "./ledger-merge.js";

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
