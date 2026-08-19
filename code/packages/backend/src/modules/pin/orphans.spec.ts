// Deleting a synced file used to accomplish NOTHING: the file vanished from disk, the decision stayed
// "sync", and the next pin pass fetched it straight back from this computer's own pin — forever. These
// tests lock the rule that fixes it (decisions.mdx §12), and the one it must never break: on a SECOND
// computer an absent decided file is the healthy pull-down offer and must keep being fetched.
import { describe, it, expect } from "vitest";
import { classifyAbsent, mergeOrphans, type OrphanRecord } from "./orphans.service.js";

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
  twinHas?: string[];
}) {
  const entries = opts.entries ?? {};
  const pinset = new Set(opts.pinset ?? []);
  const twin = opts.twinHas ? new Set(opts.twinHas) : null;
  return classifyAbsent({
    absent: opts.absent,
    entryFor: (rel) => entries[rel],
    heldHere: (cid) => pinset.has(cid),
    label: ME,
    prior: opts.prior ?? {},
    nowMs: opts.nowMs ?? NOW,
    graceMs: DAY,
    ...(twin ? { bytesHeldByLocalTwin: (rel: string) => twin.has(rel) } : {}),
  });
}

// The same repo registered TWICE on one computer (two clones of one remote). Both delete signals —
// `pinned_by` carrying this computer's label, and the shared IPFS pinset — are computer-wide, so the clone
// that HAS the bytes makes the clone that does not look like it deleted them. Measured on bryan-mac-pro
// 2026-08-19: 41 charlie-kirk videos arrived from the laptop, were pinned on this node by the OTHER clone,
// and every pass logged `deleted here 41` while never writing one of them into this clone's working tree.
describe("classifyAbsent — a twin registration is not a deletion", () => {
  it("stays a pull-down offer when a twin unit on this computer holds the bytes", () => {
    const r = run({
      absent: ["videos/clip.mp4"],
      entries: { "videos/clip.mp4": { cid: "bafy1", pinned_by: [ME, PEER] } },
      pinset: ["bafy1"],
      twinHas: ["videos/clip.mp4"],
    });
    expect(r.missing).toEqual(["videos/clip.mp4"]);
    expect(r.orphans).toEqual({});
    expect(r.stale).toEqual([]);
  });

  it("never stales a twin-held file, even long past the grace period", () => {
    const r = run({
      absent: ["videos/clip.mp4"],
      entries: { "videos/clip.mp4": { cid: "bafy1", pinned_by: [ME] } },
      pinset: ["bafy1"],
      twinHas: ["videos/clip.mp4"],
      prior: { "videos/clip.mp4": { first_seen_at: new Date(NOW - 30 * DAY).toISOString(), cid: "bafy1" } },
      nowMs: NOW,
    });
    expect(r.stale).toEqual([]);
    expect(r.missing).toEqual(["videos/clip.mp4"]);
  });

  it("still reads a real deletion as a deletion when the twin does NOT have the file", () => {
    const r = run({
      absent: ["videos/clip.mp4"],
      entries: { "videos/clip.mp4": { cid: "bafy1", pinned_by: [ME] } },
      pinset: ["bafy1"],
      twinHas: ["videos/other.mp4"],
    });
    expect(r.missing).toEqual([]);
    expect(r.orphans["videos/clip.mp4"]).toBeDefined();
  });
});

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

// The grace period only works if the RECORD survives between passes — and a paths-scoped run classifies
// only the paths it was handed. Writing its map wholesale wiped every other file's `first_seen_at`, and
// since each decision click fires a targeted pin, the 24h clock was restarted for the whole repo several
// times a day: the file deleted here was never staled back to Undecided.
describe("mergeOrphans — a scoped pass must not erase what it never looked at", () => {
  const prior: Record<string, OrphanRecord> = {
    "old.mp4": { first_seen_at: "2026-08-04T12:00:00.000Z", cid: "bafyOld" },
    "other.mp4": { first_seen_at: "2026-08-04T13:00:00.000Z", cid: "bafyOther" },
  };

  it("a WHOLE-REPO pass writes its own answer — it looked at everything", () => {
    const fresh = { "old.mp4": { first_seen_at: "2026-08-05T12:00:00.000Z", cid: "bafyOld" } };
    expect(mergeOrphans(prior, fresh)).toEqual(fresh); // "other.mp4" came back — dropping it is correct
  });

  it("a SCOPED pass keeps the records of files outside its scope, clock untouched", () => {
    const scope = new Set(["old.mp4"]);
    const fresh = { "old.mp4": { first_seen_at: "2026-08-04T12:00:00.000Z", cid: "bafyOld" } };
    const merged = mergeOrphans(prior, fresh, scope);
    expect(merged["other.mp4"]).toEqual(prior["other.mp4"]);
    expect(merged["old.mp4"]!.first_seen_at).toBe("2026-08-04T12:00:00.000Z");
  });

  it("inside the scope the fresh verdict wins — a file whose bytes came back loses its record", () => {
    const merged = mergeOrphans(prior, {}, new Set(["old.mp4"]));
    expect(merged).toEqual({ "other.mp4": prior["other.mp4"] });
  });

  it("a scoped pass over a file with no prior record still records it", () => {
    const fresh = { "new.mp4": { first_seen_at: "2026-08-05T12:00:00.000Z", cid: "bafyNew" } };
    expect(mergeOrphans(prior, fresh, new Set(["new.mp4"]))).toEqual({ ...prior, ...fresh });
  });
});
