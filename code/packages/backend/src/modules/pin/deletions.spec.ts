// FLEET-WIDE DELETION — the acceptance simulation from pm/deletion.mdx §13.
//
// This is written as the REAL case that failed (§1): ten images of a private individual, deleted from a
// repo, re-downloaded by the pin pass every hour for a day on a computer that had never pinned them. Every
// assertion below is one the old code would have failed, or one that stops a plausible way of un-fixing it.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  emptyDeletions,
  mergeDeletions,
  buildTombstoneIndex,
  matchTombstone,
  reap,
  readDeletions,
  writeDeletions,
  serializeDeletions,
  isLive,
} from "./deletions.service.js";
import type { Deletions, DeletionRecord, ManifestFile } from "@lfb/shared";

// The real values from the incident, so the fixtures are the thing itself rather than a paraphrase.
const REL = "site/internals/static/img/evidence/476892283dfc6df142915c67a61d7f59e3602e9202735606fdd277a5945e691d.jpg";
const SHA = "476892283dfc6df142915c67a61d7f59e3602e9202735606fdd277a5945e691d";
const CID = "bafkreichncjcqpp4nxyufek4m6tb272z4nqc5eqconlan7oso6szixtjdu";
const THIS_DEVICE = "bryan-mac-pro"; // NOT in pinned_by — the configuration the old delete could not express
const PEERS = ["bryan-mac-studio", "lenovo-laptop-ug0k96ca", "pc-4-pc-4"];

/** Identity re-encode stands in for ipfs.canonicalCid — these tests are about the RULES, not base32. */
const canon = (c: string): string => c;

function tombstone(over: Partial<DeletionRecord> = {}): DeletionRecord {
  return {
    path: REL,
    cid: CID,
    cid_alternates: [],
    sha256: SHA,
    size: 224366,
    scope: "fleet",
    reason: "Private individual; must not appear on the site or in the repo.",
    removed_at: "2026-09-20T14:02:11.004Z",
    removed_by: "bryan@thestarbucks.com",
    removed_on_device: THIS_DEVICE,
    actions: { delete_bytes: true, unpin: true },
    enforced_by: [],
    undeleted_at: null,
    undeleted_by: null,
    undelete_reason: null,
    ...over,
  };
}

function ledger(...records: DeletionRecord[]): Deletions {
  return { ...emptyDeletions(), deletions: records };
}

function entry(over: Partial<ManifestFile> = {}): ManifestFile {
  return { path: REL, cid: CID, size: 224366, sha256: SHA, pinned_by: [...PEERS], ...over };
}

describe("§13.3 — THE DEFECT: the fetch gate, on a computer that never held the file", () => {
  it("gates a tombstoned entry even though this device is NOT in pinned_by", () => {
    // This single assertion is the whole bug. `pinned_by` has three peers and not us, so the orphan
    // classifier reads the absence as the healthy "never here" and fetch-missing pulls it down. Forever.
    const e = entry();
    expect(e.pinned_by).not.toContain(THIS_DEVICE);
    const idx = buildTombstoneIndex(ledger(tombstone()), THIS_DEVICE, canon);
    expect(matchTombstone(idx, e, canon)).not.toBeNull();
  });

  it("does not gate an untombstoned file — the pull-down offer still works", () => {
    // The rule this feature must never break. If a deletion could make ordinary files stop syncing, the
    // cure would be worse than the disease.
    const idx = buildTombstoneIndex(ledger(tombstone()), THIS_DEVICE, canon);
    expect(matchTombstone(idx, entry({ path: "videos/other.mp4", cid: "bafOTHER", sha256: "ffff" }), canon)).toBeNull();
  });

  it("an empty ledger gates nothing and costs nothing", () => {
    const idx = buildTombstoneIndex(emptyDeletions(), THIS_DEVICE, canon);
    expect(idx.size).toBe(0);
    expect(matchTombstone(idx, entry(), canon)).toBeNull();
  });
});

describe("§5 — identity: ANY of CID / sha256 / path, not all three", () => {
  it("§13.7 catches the SAME BYTES AT A DIFFERENT PATH (the _Mirror original)", () => {
    // The served copy and the `~/_Mirror/.../1Robbie_Parker_.jpg` original are two paths, one set of bytes.
    // A path-only tombstone deletes the second and lets the first re-seed it.
    const idx = buildTombstoneIndex(ledger(tombstone()), THIS_DEVICE, canon);
    const elsewhere = entry({ path: "_Mirror/Politics/Charlie_Kirk_Mi/Other/Skyler_Baird/1Robbie_Parker_.jpg" });
    expect(matchTombstone(idx, elsewhere, canon)).not.toBeNull();
  });

  it("catches a RE-ADD under a different CID, by sha256", () => {
    const idx = buildTombstoneIndex(ledger(tombstone()), THIS_DEVICE, canon);
    expect(matchTombstone(idx, entry({ cid: "bafkreiSOMETHINGELSE" }), canon)).not.toBeNull();
  });

  it("catches a path match when neither CID nor sha256 is known", () => {
    const idx = buildTombstoneIndex(ledger(tombstone({ cid: null, sha256: null })), THIS_DEVICE, canon);
    expect(matchTombstone(idx, entry({ cid: null, sha256: null }), canon)).not.toBeNull();
  });

  it("honours cid_alternates — CID equivalence across add profiles", () => {
    const idx = buildTombstoneIndex(
      ledger(tombstone({ cid: "bafPRIMARY", sha256: null, cid_alternates: ["QmLEGACY"] })),
      THIS_DEVICE,
      canon,
    );
    expect(matchTombstone(idx, entry({ cid: "QmLEGACY", sha256: null }), canon)).not.toBeNull();
  });

  it("scope:here is enforced only on the device that recorded it", () => {
    const l = ledger(tombstone({ scope: "here", removed_on_device: "some-other-mac" }));
    expect(buildTombstoneIndex(l, THIS_DEVICE, canon).size).toBe(0);
    expect(buildTombstoneIndex(l, "some-other-mac", canon).size).toBe(1);
  });
});

describe("§6 — the merge rule: a tombstone cannot be lost", () => {
  it("§13.6 an EMPTY incoming ledger does not lift the tombstone", () => {
    // The manifest's "absence is never a delete", pointed the other way. A truncated, mid-transfer, or
    // older-build ledger arriving on the backbone must remove nothing.
    const merged = mergeDeletions(ledger(tombstone()), emptyDeletions());
    expect(merged.deletions).toHaveLength(1);
    expect(isLive(merged.deletions[0], THIS_DEVICE)).toBe(true);
  });

  it("§13.6 adopts a tombstone we did not have", () => {
    const merged = mergeDeletions(emptyDeletions(), ledger(tombstone()));
    expect(merged.deletions).toHaveLength(1);
  });

  it("the MORE DESTRUCTIVE record wins, and the WIDEST scope wins", () => {
    // The one place in this product where conflict resolution deliberately does not preserve data. The cost
    // of over-deleting is an undelete; the cost of under-deleting is the photograph back on the website.
    const timid = tombstone({ scope: "here", actions: { delete_bytes: false, unpin: false } });
    const merged = mergeDeletions(ledger(timid), ledger(tombstone()));
    expect(merged.deletions).toHaveLength(1);
    expect(merged.deletions[0].scope).toBe("fleet");
    expect(merged.deletions[0].actions).toEqual({ delete_bytes: true, unpin: true });
  });

  it("receipts UNION across devices, newest per device", () => {
    const a = tombstone({ enforced_by: [{ device: "pc-4-pc-4", at: "2026-09-20T15:00:00.000Z", bytes: "deleted", pin: "unpinned", sidecars: 0, note: null }] });
    const b = tombstone({ enforced_by: [{ device: "lenovo-laptop-ug0k96ca", at: "2026-09-20T16:00:00.000Z", bytes: "deleted", pin: "not-held", sidecars: 1, note: null }] });
    const merged = mergeDeletions(ledger(a), ledger(b));
    expect(merged.deletions[0].enforced_by.map((e) => e.device).sort()).toEqual(["lenovo-laptop-ug0k96ca", "pc-4-pc-4"]);
  });

  it("an OLDER undelete does not resurrect a file deleted again afterwards", () => {
    const lifted = tombstone({ removed_at: "2026-09-01T00:00:00.000Z", undeleted_at: "2026-09-02T00:00:00.000Z" });
    const reDeleted = tombstone({ removed_at: "2026-09-20T00:00:00.000Z" });
    const merged = mergeDeletions(ledger(lifted), ledger(reDeleted));
    expect(merged.deletions[0].undeleted_at).toBeNull();
    expect(isLive(merged.deletions[0], THIS_DEVICE)).toBe(true);
  });

  it("§13.8 an undelete DEACTIVATES without erasing, and the gate opens", () => {
    const l = ledger(tombstone({ undeleted_at: "2026-09-21T00:00:00.000Z", undeleted_by: "bryan@thestarbucks.com" }));
    expect(l.deletions).toHaveLength(1); // the record survives — the audit trail is the point
    expect(buildTombstoneIndex(l, THIS_DEVICE, canon).size).toBe(0);
  });
});

// ── the reaper, against a real temp filesystem ──────────────────────────────

function tmpUnit(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lfb-del-"));
}

async function runReap(
  l: Deletions,
  opts: { root: string; byPath: Map<string, ManifestFile>; pinned?: Set<string>; label?: string },
): Promise<{ result: Awaited<ReturnType<typeof reap>>; unpinCalls: string[] }> {
  const unpinCalls: string[] = [];
  const pinned = opts.pinned ?? new Set<string>();
  const result = await reap(
    l,
    {
      resolveAbs: (rel) => path.join(opts.root, rel),
      pinsetHasContent: (cid) => pinned.has(cid),
      pinRm: async (cid) => void unpinCalls.push(cid),
      canonicalCid: canon,
      label: opts.label ?? THIS_DEVICE,
      byPath: opts.byPath,
      sidecarPathsFor: (rel) => [path.join(opts.root, rel) + ".transcription", path.join(opts.root, rel) + ".ocr"],
    },
    "2026-09-20T14:02:11.180Z",
  );
  return { result, unpinCalls };
}

describe("§7 — the reaper", () => {
  it("§13.5 THE SECOND COMPUTER: bytes present and pinned → deleted, unpinned, claim retracted", async () => {
    const root = tmpUnit();
    const abs = path.join(root, REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "the bytes");
    fs.writeFileSync(abs + ".transcription", "a full text extraction of the deleted image");
    const peer = "bryan-mac-studio";
    const e = entry({ pinned_by: [peer, "pc-4-pc-4"] });
    const byPath = new Map([[REL, e]]);
    const l = ledger(tombstone());

    const { result, unpinCalls } = await runReap(l, { root, byPath, pinned: new Set([CID]), label: peer });

    expect(fs.existsSync(abs)).toBe(false);
    expect(fs.existsSync(abs + ".transcription")).toBe(false); // §7.2 step 6
    expect(unpinCalls).toEqual([CID]);
    expect(result.bytesDeleted).toBe(1);
    expect(e.pinned_by).not.toContain(peer); // stop advertising bytes we no longer hold
    expect(e.pinned_by).toContain("pc-4-pc-4"); // a PEER's claim is not ours to withdraw
    expect(e.state).toBe("removed");
    expect(l.deletions[0].enforced_by.find((r) => r.device === peer)).toMatchObject({ bytes: "deleted", pin: "unpinned" });
  });

  it("records a receipt even when there was NOTHING here — a silent device has not RUN", async () => {
    const root = tmpUnit();
    const e = entry();
    const l = ledger(tombstone());
    await runReap(l, { root, byPath: new Map([[REL, e]]) });
    expect(l.deletions[0].enforced_by).toHaveLength(1);
    expect(l.deletions[0].enforced_by[0]).toMatchObject({ device: THIS_DEVICE, bytes: "already-absent", pin: "not-held" });
  });

  it("§13.4 is IDEMPOTENT — a second pass changes nothing and writes nothing", async () => {
    const root = tmpUnit();
    const abs = path.join(root, REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "the bytes");
    const e = entry();
    const l = ledger(tombstone());
    await runReap(l, { root, byPath: new Map([[REL, e]]), pinned: new Set([CID]) });
    const after = serializeDeletions(l);
    const second = await runReap(l, { root, byPath: new Map([[REL, e]]), pinned: new Set() });
    expect(second.result.bytesDeleted).toBe(0);
    expect(second.result.touched).toEqual([]);
    expect(serializeDeletions(l)).toBe(after); // byte-identical → no noise commit on the backbone
  });

  it("§7.3 BACKFILLS the sha256 from the bytes it is about to delete", async () => {
    const root = tmpUnit();
    const abs = path.join(root, REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "known content");
    const l = ledger(tombstone({ sha256: null }));
    await runReap(l, { root, byPath: new Map([[REL, entry({ sha256: null })]]) });
    const expected = crypto.createHash("sha256").update("known content").digest("hex");
    expect(l.deletions[0].sha256).toBe(expected);
  });

  it("--keep-bytes / --keep-pin are honoured", async () => {
    const root = tmpUnit();
    const abs = path.join(root, REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "the bytes");
    const l = ledger(tombstone({ actions: { delete_bytes: false, unpin: false } }));
    const { unpinCalls } = await runReap(l, { root, byPath: new Map([[REL, entry()]]), pinned: new Set([CID]) });
    expect(fs.existsSync(abs)).toBe(true);
    expect(unpinCalls).toEqual([]);
    expect(l.deletions[0].enforced_by[0]).toMatchObject({ bytes: "kept", pin: "kept" });
  });

  it("deletes bytes that are on disk but NOT in the manifest", async () => {
    // The untracked-leftover case: `git status` showed these ten files as untracked. A reaper that only
    // walked manifest entries would leave exactly the files the user is looking at.
    const root = tmpUnit();
    const abs = path.join(root, REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "the bytes");
    const l = ledger(tombstone());
    const { result } = await runReap(l, { root, byPath: new Map() });
    expect(fs.existsSync(abs)).toBe(false);
    expect(result.bytesDeleted).toBe(1);
  });
});

describe("§4/§6 — the ledger on disk", () => {
  it("a MISSING file is an empty ledger, and round-trips byte-for-byte", () => {
    const dir = tmpUnit();
    const file = path.join(dir, "deletions.yaml");
    expect(readDeletions(file).deletions).toEqual([]);
    const l = ledger(tombstone());
    writeDeletions(file, l);
    const back = readDeletions(file);
    expect(back.deletions).toHaveLength(1);
    expect(serializeDeletions(back)).toBe(serializeDeletions(l));
  });

  it("REFUSES a half-merged ledger rather than parsing it", () => {
    // Silently dropping records here puts deleted files back on every computer, so this throws where the
    // rest of the product would warn and continue.
    const dir = tmpUnit();
    const file = path.join(dir, "deletions.yaml");
    fs.writeFileSync(file, "schema_version: 1\n<<<<<<< HEAD\ndeletions: []\n=======\ndeletions: []\n>>>>>>> peer\n");
    expect(() => readDeletions(file)).toThrow(/half-merged/);
  });
});
