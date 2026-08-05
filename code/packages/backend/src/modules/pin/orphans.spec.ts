// Deleting a synced file used to accomplish NOTHING: the file vanished from disk, the decision stayed
// "sync", and the next pin pass fetched it straight back from this computer's own pin — forever. These
// tests lock the rule that fixes it (decisions.mdx §12), and the one it must never break: on a SECOND
// computer an absent decided file is the healthy pull-down offer and must keep being fetched.
import { describe, it, expect } from "vitest";
import { classifyAbsent, type OrphanRecord } from "./orphans.service.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const ME = "tower";
const PEER = "laptop";

function run(opts: {
  absent: string[];
  entries?: Record<string, { cid: string | null; pinned_by: string[] }>;
  pinset?: string[];
  prior?: Record<string, OrphanRecord>;
  nowMs?: number;
}) {
  const entries = opts.entries ?? {};
  const pinset = new Set(opts.pinset ?? []);
  return classifyAbsent({
    absent: opts.absent,
    entryFor: (rel) => entries[rel],
    heldHere: (cid) => pinset.has(cid),
    label: ME,
    prior: opts.prior ?? {},
    nowMs: opts.nowMs ?? NOW,
    graceMs: DAY,
  });
}

describe("classifyAbsent — deleted here vs. never here", () => {
  it("treats a file only a PEER ever pinned as never-here, not a deletion", () => {
    const r = run({
      absent: ["video.mp4"],
      entries: { "video.mp4": { cid: "bafy1", pinned_by: [PEER] } },
    });
    expect(r.missing).toEqual(["video.mp4"]);
    expect(r.orphans).toEqual({});
    expect(r.stale).toEqual([]);
  });

  it("treats a file THIS computer claimed as a deletion and starts its grace period", () => {
    const r = run({
      absent: ["video.mp4"],
      entries: { "video.mp4": { cid: "bafy1", pinned_by: [ME, PEER] } },
    });
    expect(r.missing).toEqual([]);
    expect(r.orphans["video.mp4"]).toEqual({ first_seen_at: new Date(NOW).toISOString(), cid: "bafy1" });
    expect(r.stale).toEqual([]); // held, not staled — an unmounted drive gets its day
  });

  it("reads OUR OWN PINSET as the delete signal too, even when the manifest claim was lost", () => {
    // The pin-cache reconcile drops a self-claim whenever a pass can't see the pin; a claim-only test would
    // then mis-read a real deletion as "never here" and re-fetch the file.
    const r = run({
      absent: ["video.mp4"],
      entries: { "video.mp4": { cid: "bafy1", pinned_by: [] } },
      pinset: ["bafy1"],
    });
    expect(r.missing).toEqual([]);
    expect(Object.keys(r.orphans)).toEqual(["video.mp4"]);
  });

  it("never calls a file with no recorded CID a deletion", () => {
    const r = run({ absent: ["never-added.mp4"], entries: { "never-added.mp4": { cid: null, pinned_by: [ME] } } });
    expect(r.missing).toEqual(["never-added.mp4"]);
    expect(r.orphans).toEqual({});
  });

  it("never calls a file with no manifest entry at all a deletion", () => {
    const r = run({ absent: ["unknown.mp4"] });
    expect(r.missing).toEqual(["unknown.mp4"]);
    expect(r.orphans).toEqual({});
  });
});

describe("classifyAbsent — the grace period", () => {
  const prior = { "video.mp4": { first_seen_at: new Date(NOW - 2 * DAY).toISOString(), cid: "bafy1" } };
  const entries = { "video.mp4": { cid: "bafy1", pinned_by: [ME] } };

  it("carries the ORIGINAL first-seen forward instead of restarting the clock every pass", () => {
    const r = run({ absent: ["video.mp4"], entries, prior });
    expect(r.orphans["video.mp4"]!.first_seen_at).toBe(prior["video.mp4"].first_seen_at);
  });

  it("stales once the grace period has elapsed", () => {
    const r = run({ absent: ["video.mp4"], entries, prior });
    expect(r.stale).toEqual(["video.mp4"]);
  });

  it("does NOT stale a hair before the deadline", () => {
    const justUnder = { "video.mp4": { first_seen_at: new Date(NOW - DAY + 1000).toISOString(), cid: "bafy1" } };
    const r = run({ absent: ["video.mp4"], entries, prior: justUnder });
    expect(r.stale).toEqual([]);
  });

  it("drops a held record the moment the bytes come back — no stale, no re-ask", () => {
    // The file is no longer absent, so it is simply not in `absent` this pass.
    const r = run({ absent: [], entries, prior });
    expect(r.orphans).toEqual({});
    expect(r.stale).toEqual([]);
  });

  it("does not stale on a corrupt first-seen timestamp", () => {
    const bad = { "video.mp4": { first_seen_at: "not-a-date", cid: "bafy1" } };
    const r = run({ absent: ["video.mp4"], entries, prior: bad });
    expect(r.stale).toEqual([]);
  });
});
