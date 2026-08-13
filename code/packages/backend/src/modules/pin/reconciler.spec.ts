// THE RECONCILER'S RULES, pinned one at a time.
//
// Every case below is a state the product actually reached and then reported as fact: a claim on bytes this
// computer did not hold, a file sitting on disk that the node had never pinned, a manifest CID that is a
// directory and can therefore never be `cat`-ed by anyone. The pass exists to close those, and the two
// rules it must NOT break — a peer's claim is not ours to edit, and a delete must still mean something —
// get a test each, because both are the kind of thing a later "make it more thorough" change quietly eats.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest } from "@lfb/shared";

const FOLDER = "reconcile-fixture";
const SELF = "test-computer";
const PEER = "bryan-laptop";
const REL = "videos/a.mp4";
const LOCAL_CID = "bafkreilocaladd0000000000000000000000000000000000000000000000";

let tmp: string;
let repoRoot: string;
let absFile: string;

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return {
    ...actual,
    listPins: vi.fn(async () => []),
    health: vi.fn(async () => "ok" as const),
    addFile: vi.fn(async () => "bafkreilocaladd0000000000000000000000000000000000000000000000"),
    catToFile: vi.fn(async () => undefined),
    contentPinnedCidDetailed: vi.fn(async () => null),
    dagNodeType: vi.fn(async () => "file" as const),
    resolveFileCid: vi.fn(async (cid: string) => cid),
  };
});

beforeEach(async () => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-reconcile-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  process.env.LFB_LOG_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "repo");
  absFile = path.join(repoRoot, REL);
  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  const cfg = await import("../store-model/config.service.js");
  await cfg.updateAppConfig((c) => ((c.computer.label = SELF), c));
  // `vi.resetModules()` clears the MODULE registry, not the MOCK registry: the factory's `vi.fn()`s are the
  // same objects every test, so both call history and any `mockResolvedValue` a test sets would leak into
  // the next one. Re-establish the whole default node here so each test starts from a known daemon.
  const ipfs = await import("../ipfs/ipfs.service.js");
  vi.clearAllMocks();
  vi.mocked(ipfs.listPins).mockResolvedValue([]);
  vi.mocked(ipfs.addFile).mockResolvedValue(LOCAL_CID);
  vi.mocked(ipfs.catToFile).mockImplementation(async (cid: string) => cid);
  vi.mocked(ipfs.contentPinnedCidDetailed).mockResolvedValue(null);
  vi.mocked(ipfs.dagNodeType).mockResolvedValue("file");
  vi.mocked(ipfs.resolveFileCid).mockImplementation(async (cid: string) => cid);
});

afterEach(async () => {
  const { stopReconciler } = await import("./reconciler.service.js");
  stopReconciler();
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_LOG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Register the repo unit and seed ONE manifest entry into both records. */
async function seed(entry: { cid: string | null; pinned_by: string[] }): Promise<void> {
  const units = await import("../store-model/units.service.js");
  await units.updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
    pinned: true,
    decisions: { [REL]: "sync" },
  }));
  const doc = {
    schema_version: 1,
    unit: "repo",
    files: [{ path: REL, cid: entry.cid, size: 10, sha256: null, pinned_by: entry.pinned_by }],
  } as unknown as Manifest;
  units.writeRepoManifest(FOLDER, doc);
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoTrackingManifest(repoRoot, doc);
}

/** What both records say about our one path after the pass. */
async function readBack(): Promise<{ unit?: { cid: string | null; pinned_by: string[] }; tracking?: unknown }> {
  const units = await import("../store-model/units.service.js");
  const { readRepoTrackingManifest } = await import("./manifest.service.js");
  const u = units.getRepoManifest(FOLDER).files.find((f) => f.path === REL);
  const t = readRepoTrackingManifest(repoRoot).files.find((f) => f.path === REL);
  return { unit: u ? { cid: u.cid, pinned_by: u.pinned_by } : undefined, tracking: t };
}

const pins = (...cids: string[]) => cids.map((cid) => ({ cid, type: "recursive" }));

describe("reconciler — a claim this computer cannot back is not a claim", () => {
  it("drops OUR claim when neither the disk nor the pinset has the bytes", async () => {
    await seed({ cid: "bafyGone", pinned_by: [SELF, PEER] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.claimsDropped).toBe(1);
    expect(counts.entriesRemoved).toBe(0); // the peer still says it has them — the row stays
    const { unit } = await readBack();
    expect(unit?.pinned_by).toEqual([PEER]);
  });

  it("removes the ENTRY when our disproved claim was the last one on it", async () => {
    await seed({ cid: "bafyGone", pinned_by: [SELF] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.entriesRemoved).toBe(1);
    const { unit, tracking } = await readBack();
    expect(unit).toBeUndefined();
    expect(tracking).toBeUndefined(); // BOTH records, or the next fold puts it straight back
  });

  it("NEVER edits a peer's claim, even when we can prove nothing about it", async () => {
    // We can verify exactly one computer's bytes. A peer's claim is evidence from a machine we cannot see,
    // and deleting it here is how the pull-down list empties itself of real, fetchable files.
    await seed({ cid: "bafyGone", pinned_by: [PEER] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.claimsDropped).toBe(0);
    expect(counts.entriesRemoved).toBe(0);
    expect((await readBack()).unit?.pinned_by).toEqual([PEER]);
  });
});

describe("reconciler — it validates records, it does not move bytes", () => {
  beforeEach(() => fs.writeFileSync(absFile, "x"));

  it("drops our claim on a file that is ON DISK but was never pinned — and does NOT pin it", async () => {
    // `pinned_by` means "these bytes are pinned on this computer", not "the file is here". Adding it is the
    // pin pass's job; this pass only stops the record claiming something that is not true yet.
    await seed({ cid: "bafyNeverPinned", pinned_by: [SELF, PEER] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    const ipfs = await import("../ipfs/ipfs.service.js");
    expect(counts.claimsDropped).toBe(1);
    expect(vi.mocked(ipfs.addFile)).not.toHaveBeenCalled();
    expect(vi.mocked(ipfs.catToFile)).not.toHaveBeenCalled();
    expect((await readBack()).unit?.pinned_by).toEqual([PEER]);
  });

  it("keeps the entry even with no claim left, while the bytes are still on disk", async () => {
    // A row is only inert when nobody claims it AND no copy is here. The file is right there.
    await seed({ cid: "bafyNeverPinned", pinned_by: [SELF] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.claimsDropped).toBe(1);
    expect(counts.entriesRemoved).toBe(0);
    expect((await readBack()).unit?.pinned_by).toEqual([]);
  });

  it("recognises bytes pinned under a FOREIGN ADD PROFILE and records the pair instead of reporting a gap", async () => {
    // Different add flags are a different multihash, so no string comparison can bridge them (§5.1 Layer 2).
    // `add --only-hash` re-derives the CID without storing a block or creating a pin — a read, not an add.
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue(pins(LOCAL_CID) as never);
    vi.mocked(ipfs.contentPinnedCidDetailed).mockResolvedValue({ cid: LOCAL_CID, profile: "v0" });
    await seed({ cid: "bafyRecordedByAPeer", pinned_by: [] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.equivalences).toBe(1);
    expect(counts.claimsAdded).toBe(1); // we DO hold these bytes — say so
    expect(vi.mocked(ipfs.addFile)).not.toHaveBeenCalled();
    const back = await readBack();
    expect(back.unit?.cid).toBe("bafyRecordedByAPeer"); // the fleet's record stays as the fleet wrote it
    const { equivalentCid } = await import("./cid-equivalence.service.js");
    expect(equivalentCid("bafyRecordedByAPeer")).toBe(LOCAL_CID);
  });
});

describe("reconciler — a recorded CID that is not a file", () => {
  it("REPLACES it on the computer that holds the bytes — the one repair that reaches the peers", async () => {
    // This is the case that actually unsticks a wrapper-CID file for the fleet. Recording an equivalence
    // here instead would fix only this machine and leave every peer holding a CID it can never `cat`.
    const ipfs = await import("../ipfs/ipfs.service.js");
    fs.writeFileSync(absFile, "x");
    vi.mocked(ipfs.listPins).mockResolvedValue(pins(LOCAL_CID) as never);
    vi.mocked(ipfs.contentPinnedCidDetailed).mockResolvedValue({ cid: LOCAL_CID, profile: "v1" });
    vi.mocked(ipfs.dagNodeType).mockResolvedValue("directory");
    await seed({ cid: "bafyWrapperDirectory", pinned_by: [PEER] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.cidsHealed).toBe(1);
    expect(counts.equivalences).toBe(0); // NOT a local-only note — the shared record is the broken one
    expect(counts.claimsAdded).toBe(1);
    const { unit, tracking } = await readBack();
    expect(unit?.cid).toBe(LOCAL_CID);
    expect((tracking as { cid: string }).cid).toBe(LOCAL_CID); // both records, or the next fold undoes it
  });

  it("REPLACES it with the file inside when the wrapper can still be unwrapped", async () => {
    // The wrapper defect (§5.1 Layer 0): an absolute path was passed as the add filename, so the recorded
    // CID is a directory tree. No computer in the fleet can `cat` it, so the entry is unusable for everyone
    // until it is corrected — and unwrapping corrects the RECORD without moving a byte.
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.dagNodeType).mockResolvedValue("directory");
    vi.mocked(ipfs.resolveFileCid).mockResolvedValue(LOCAL_CID);
    await seed({ cid: "bafyWrapperDirectory", pinned_by: [PEER] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.cidsHealed).toBe(1);
    expect((await readBack()).unit?.cid).toBe(LOCAL_CID);
  });

  it("REPORTS it, and guesses nothing, when the wrapper's interior is gone too", async () => {
    // A CID written here that nobody has is a worse record than the broken one. The honest outcome is that
    // the file needs re-adding on a computer that holds the bytes, and this pass says so.
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.dagNodeType).mockResolvedValue("directory");
    vi.mocked(ipfs.resolveFileCid).mockRejectedValue(new Error("context canceled"));
    await seed({ cid: "bafyWrapperDirectory", pinned_by: [PEER] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.unresolvableCids).toBe(1);
    expect(counts.cidsHealed).toBe(0);
    expect((await readBack()).unit?.cid).toBe("bafyWrapperDirectory"); // left exactly as recorded
  });
});

describe("reconciler — the other YAML on a repo", () => {
  it("re-projects the frozen `decisions:` enum when it has drifted from the shared ledger", async () => {
    // The enum is a PROJECTION every read path trusts instead of re-folding (the pull-retry's `pendingFor`,
    // the file rows, the tiles). An enum that disagrees with the ledger is the same class of defect as a pin
    // claim with no pin behind it: a record asserting something the evidence does not support.
    const units = await import("../store-model/units.service.js");
    const { recordDecision } = await import("../storage/decisions.service.js");
    await seed({ cid: "bafyGone", pinned_by: [PEER] });
    await recordDecision(FOLDER, [REL], { ipfs: false }, "test"); // the ledger says: do NOT sync this
    await units.updateRepoConfig(FOLDER, (c) => ({ ...c, decisions: { ...c.decisions, [REL]: "sync" } })); // drift

    const { reconcileRepo } = await import("./reconciler.service.js");
    const counts = await reconcileRepo(FOLDER);

    expect(counts.decisionsFixed).toBeGreaterThan(0);
    expect(units.getRepoConfig(FOLDER).decisions[REL]).toBe("ignore");
  });
});

describe("reconciler — what it does when it cannot see", () => {
  it("does NOTHING AT ALL when the node cannot list its pins", async () => {
    // An unreachable node answers "unknown", not "nothing is pinned". Read as empty, every rule fires the
    // wrong way at once: every claim reads false, every file reads unpinned, and one pass could strip a
    // repo's whole manifest. So the pass declines to run rather than guess.
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5001"));
    await seed({ cid: "bafyGone", pinned_by: [SELF] });
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts).toMatchObject({ checked: 0, claimsDropped: 0, entriesRemoved: 0 });
    expect((await readBack()).unit?.pinned_by).toEqual([SELF]); // untouched
  });

  it("leaves a repo whose working tree is not mounted completely alone", async () => {
    await seed({ cid: "bafyGone", pinned_by: [SELF] });
    fs.rmSync(repoRoot, { recursive: true, force: true }); // the external drive is unplugged
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.checked).toBe(0);
    expect((await readBack()).unit?.pinned_by).toEqual([SELF]);
  });
});

describe("reconciler — the schedule survives a restart", () => {
  it("waits only the REMAINDER of the interval, not the whole thing again", async () => {
    process.env.LFB_RECONCILE_MS = String(6 * 60 * 60 * 1000);
    process.env.LFB_RECONCILE_BOOT_MS = String(60_000);
    const { nextReconcileDelayMs } = await import("./reconciler.service.js");
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

    // ~1 hour left, not 6 — restarting is what a person does when they want work to happen, and a reset
    // schedule means a long pass never runs at all (the defect pull-retry already had to fix).
    const ms = nextReconcileDelayMs(Date.now(), fiveHoursAgo);
    expect(ms).toBeGreaterThan(55 * 60_000);
    expect(ms).toBeLessThanOrEqual(60 * 60_000);
    delete process.env.LFB_RECONCILE_MS;
    delete process.env.LFB_RECONCILE_BOOT_MS;
  });

  it("never returns a zero delay, so a restart loop cannot become a hot loop", async () => {
    const { nextReconcileDelayMs } = await import("./reconciler.service.js");
    expect(nextReconcileDelayMs(Date.now(), new Date(Date.now() - 99 * 60 * 60 * 1000).toISOString())).toBeGreaterThan(0);
    expect(nextReconcileDelayMs(Date.now(), null)).toBeGreaterThan(0);
  });
});
