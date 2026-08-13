// A WRAPPER-DIRECTORY CID IS NOT A SECOND SPELLING OF THE FILE, AND FILING IT AS ONE IS PERMANENT.
//
// Two records can disagree about a file's CID for two completely different reasons, and the repairs are
// opposites: a second ADD PROFILE is remembered locally and the shared manifest is left alone, while a
// wrapper DIRECTORY is corrected in the shared manifest and written to `superseded_cids.yaml`. Only the
// reconciler ever told them apart. The pull's local-bytes fast path and `runUnitPin`'s adopt path recorded
// an equivalence unconditionally — and an equivalence for a directory CID is a trap door, because
// `pinsetHasContent` answers TRUE through the map from then on, so the probe that would have noticed is
// never run again on that entry.
//
// MEASURED, on the live fleet, 2026-08-13. pc-10 held such a pair for `IPFS/videos/chain_of_evil.mp4`. It
// kept publishing the wrapper CID; pc-4 (which had proved it a directory) kept rewriting it to the file
// CID; the merge tie-break — a total order on the CID VALUE, which cannot know one of them is a folder —
// handed the wrapper back every time. charlie-kirk's manifest carried 4 distinct versions across 30
// consecutive commits, 16 entries flipping every 5-10 minutes, for days.
//
// Three tests for "never write down the wrong correction", one for "correct the ones already written down".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

const FOLDER = "wrapper-poison-fixture";
const REL = "videos/chain_of_evil.mp4";
const RECORDED = "bafybeiazdwqqs7cv6mxr5vkqzb772355nhadpsyent32bfdn6c3vuq7ofa"; // the wrapper, in the manifest
const LOCAL = "bafybeigm2judyoxm3yzrfz5x7v6zmsxbhajxdnn7zcmalywiwqhvwykp5y"; // the file, pinned here
const SIZE = 5;

let tmp: string;
let repoRoot: string;

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return {
    ...actual,
    listPins: vi.fn(async () => []),
    health: vi.fn(async () => "ok" as const),
    enforceCompliance: vi.fn(async () => undefined),
    addFile: vi.fn(async () => LOCAL),
    contentPinnedCid: vi.fn(async () => null),
    contentPinnedCidDetailed: vi.fn(async () => null),
    dagNodeType: vi.fn(async () => "file" as const),
    resolveFileCid: vi.fn(async (cid: string) => cid),
    hasProvider: vi.fn(async () => true),
    pinAdd: vi.fn(async () => undefined),
    catToFile: vi.fn(async () => undefined),
  };
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-wrapper-poison-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  process.env.LFB_LOG_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "charlie-kirk");
  fs.mkdirSync(path.join(repoRoot, path.dirname(REL)), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true }); // `runUnitPin` preflights a working tree
  fs.writeFileSync(path.join(repoRoot, REL), "bytes"); // the bytes ARE here — that is what starts all of this
  // The factory's `vi.fn`s outlive `resetModules`, so re-establish the whole default node per test.
  const ipfs = await import("../ipfs/ipfs.service.js");
  vi.mocked(ipfs.listPins).mockResolvedValue([]);
  vi.mocked(ipfs.addFile).mockResolvedValue(LOCAL);
  vi.mocked(ipfs.contentPinnedCid).mockResolvedValue(null);
  vi.mocked(ipfs.contentPinnedCidDetailed).mockResolvedValue(null);
  vi.mocked(ipfs.dagNodeType).mockResolvedValue("file");
  vi.mocked(ipfs.resolveFileCid).mockImplementation(async (cid: string) => cid);
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_LOG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A registered repo whose manifest records `RECORDED` for a file that is on this disk but not pinned. */
async function seed(opts: { pinned?: boolean } = {}): Promise<void> {
  const units = await import("../store-model/units.service.js");
  await units.updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
    pinned: opts.pinned ?? true,
    decisions: { [REL]: "sync" },
  }));
  const doc = {
    schema_version: 1,
    unit: "repo",
    files: [{ path: REL, cid: RECORDED, size: SIZE, sha256: null, pinned_by: ["bryan-mac-pro"] }],
  };
  units.writeRepoManifest(FOLDER, doc as never);
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoTrackingManifest(repoRoot, doc as never);
}

/** What the SHARED record says about our path now. */
async function recordedCid(): Promise<string | null | undefined> {
  const { readRepoTrackingManifest } = await import("./manifest.service.js");
  return readRepoTrackingManifest(repoRoot).files.find((f) => f.path === REL)?.cid;
}

async function maps(): Promise<{ equivalent: string | null; superseded: string | null }> {
  const { equivalentCid } = await import("./cid-equivalence.service.js");
  const { supersededCid } = await import("./superseded-cids.service.js");
  return { equivalent: equivalentCid(RECORDED), superseded: supersededCid(RECORDED) };
}

describe("the pull's local-bytes fast path — classify the difference, never assume it", () => {
  it("CORRECTS a wrapper-directory CID instead of filing it as an add profile", async () => {
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.dagNodeType).mockResolvedValue("directory");
    await seed();

    const { pullMissing } = await import("./pin.service.js");
    expect((await pullMissing(repoRoot, [REL])).pulled).toBe(1);

    const m = await maps();
    expect(m.equivalent).toBeNull(); // the pair that used to blind this machine forever
    expect(m.superseded).toBe(LOCAL); // proved, so the wire merge can never hand the folder back
    expect(await recordedCid()).toBe(LOCAL); // and the correction is PUBLISHED, not just held
  });

  it("still records the equivalence when the recorded CID really is another add profile", async () => {
    await seed(); // dagNodeType defaults to "file"

    const { pullMissing } = await import("./pin.service.js");
    expect((await pullMissing(repoRoot, [REL])).pulled).toBe(1);

    const m = await maps();
    expect(m.equivalent).toBe(LOCAL);
    expect(m.superseded).toBeNull();
    expect(await recordedCid()).toBe(RECORDED); // neither spelling is more true — the fleet's record stands
  });

  it("writes down NOTHING when the node cannot say what the recorded CID is", async () => {
    // `dagNodeType` returns null when the blocks are not here and no peer served them in time. Guessing
    // "file" is how the bad pair got written; guessing "directory" would rewrite a CID on no evidence.
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.dagNodeType).mockResolvedValue(null);
    await seed();

    const { pullMissing } = await import("./pin.service.js");
    expect((await pullMissing(repoRoot, [REL])).pulled).toBe(1); // the pin still happened — bytes are held

    const m = await maps();
    expect(m.equivalent).toBeNull();
    expect(m.superseded).toBeNull();
    expect(await recordedCid()).toBe(RECORDED);
  });
});

describe("the pin pass's foreign-profile adopt — the same rule, on the other path", () => {
  it("replaces the recorded CID when the adopt proves it was a wrapper directory", async () => {
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.contentPinnedCid).mockResolvedValue(LOCAL); // these exact bytes are already pinned here
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: LOCAL }] as never);
    vi.mocked(ipfs.dagNodeType).mockResolvedValue("directory");
    await seed();

    const { pinRepoFolder } = await import("./pin.service.js");
    await pinRepoFolder(FOLDER);

    const m = await maps();
    expect(m.equivalent).toBeNull();
    expect(m.superseded).toBe(LOCAL);
    expect(await recordedCid()).toBe(LOCAL);
    expect(vi.mocked(ipfs.addFile)).not.toHaveBeenCalled(); // adopting still means no duplicate add
  });
});

describe("the equivalence audit — the pairs already on disk are the ones keeping the loop alive", () => {
  it("drops a pair whose recorded CID is a directory, so the entry can be corrected again", async () => {
    // Exactly pc-10's state: the pair is already written, so nothing re-examines the entry. Stopping new
    // ones being written does not clear this — the audit has to go and look.
    const { noteCidEquivalence, equivalentCid } = await import("./cid-equivalence.service.js");
    noteCidEquivalence(RECORDED, LOCAL);
    expect(equivalentCid(RECORDED)).toBe(LOCAL);

    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.dagNodeType).mockResolvedValue("directory");
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: LOCAL }] as never);
    vi.mocked(ipfs.contentPinnedCidDetailed).mockResolvedValue({ cid: LOCAL, profile: "v1" });
    await seed();

    const { runReconcile } = await import("./reconciler.service.js");
    const counts = await runReconcile({ folders: [FOLDER] });

    expect(equivalentCid(RECORDED)).toBeNull();
    // …and the same pass then repairs what the pair had been hiding.
    expect(counts.cidsHealed).toBe(1);
    expect(await recordedCid()).toBe(LOCAL);
    const { supersededCid } = await import("./superseded-cids.service.js");
    expect(supersededCid(RECORDED)).toBe(LOCAL);
  });

  it("leaves a genuine add-profile pair alone", async () => {
    const { noteCidEquivalence, equivalentCid } = await import("./cid-equivalence.service.js");
    noteCidEquivalence(RECORDED, LOCAL);
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.dagNodeType).mockResolvedValue("file");
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: LOCAL }] as never);
    await seed();

    const { runReconcile } = await import("./reconciler.service.js");
    await runReconcile({ folders: [FOLDER] });

    expect(equivalentCid(RECORDED)).toBe(LOCAL);
    expect(await recordedCid()).toBe(RECORDED);
  });

  it("keeps a pair the node could not describe — an unreachable daemon is not evidence", async () => {
    const { noteCidEquivalence, equivalentCid } = await import("./cid-equivalence.service.js");
    noteCidEquivalence(RECORDED, LOCAL);
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.dagNodeType).mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5001"));
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: LOCAL }] as never);
    await seed();

    const { runReconcile } = await import("./reconciler.service.js");
    await runReconcile({ folders: [FOLDER] });

    expect(equivalentCid(RECORDED)).toBe(LOCAL);
  });
});

describe("a disproved CID must not come back through a LOCAL fold", () => {
  it("does not let the unit manifest's wrapper CID beat the tracking manifest's file CID", async () => {
    // THE DAY-TWO FAILURE, and the one the first fix missed. The corrections that arrive over the wire are
    // applied to the TRACKING manifest; the UNIT manifest is never on the wire, so it keeps the wrapper CID
    // — and `pinRepoFolderInner` folds the two LOCAL documents with a tie-break that is a total order on the
    // CID value. `bafybeiazdwq…` sorts before `bafybeigm2ju…`, so the folder beat the file it contains, was
    // written back into both records, mirrored, and published. Measured on pc-10 an hour after deploying.
    const { noteSupersededCid } = await import("./superseded-cids.service.js");
    noteSupersededCid(RECORDED, LOCAL); // this computer has already PROVED it
    const units = await import("../store-model/units.service.js");
    await units.updateRepoConfig(FOLDER, (c) => ({
      ...c,
      repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
      pinned: true,
      decisions: { [REL]: "sync" },
    }));
    const entry = (cid: string) => ({
      schema_version: 1,
      unit: "repo",
      files: [{ path: REL, cid, size: SIZE, sha256: null, pinned_by: ["bryan-mac-pro"] }],
    });
    units.writeRepoManifest(FOLDER, entry(RECORDED) as never); // the stale local copy
    const { writeRepoTrackingManifest } = await import("./manifest.service.js");
    writeRepoTrackingManifest(repoRoot, entry(LOCAL) as never); // already corrected
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: LOCAL }] as never);
    // The fold is what this test is about, so close the pass's OTHER repair routes: a re-add here would
    // heal the entry no matter what the fold did, and the test would pass with the bug in place.
    vi.mocked(ipfs.addFile).mockResolvedValue(RECORDED);

    const { pinRepoFolder } = await import("./pin.service.js");
    await pinRepoFolder(FOLDER);

    expect(await recordedCid()).toBe(LOCAL); // …and not republished as the wrapper
    expect(units.getRepoManifest(FOLDER).files.find((f) => f.path === REL)?.cid).toBe(LOCAL);
  });
});

describe("the state root keeps the two maps apart", () => {
  it("writes the correction to superseded_cids.yaml and nothing to cid_equivalence.yaml", async () => {
    // A regression here is invisible in behaviour until a merge runs, so assert the files themselves.
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.dagNodeType).mockResolvedValue("directory");
    await seed();
    const { pullMissing } = await import("./pin.service.js");
    await pullMissing(repoRoot, [REL]);

    const root = process.env.LFB_STATE_DIR as string;
    const superseded = YAML.parse(fs.readFileSync(path.join(root, "superseded_cids.yaml"), "utf8"));
    expect(superseded.pairs[RECORDED]).toBe(LOCAL);
    expect(fs.existsSync(path.join(root, "cid_equivalence.yaml"))).toBe(false);
  });
});
