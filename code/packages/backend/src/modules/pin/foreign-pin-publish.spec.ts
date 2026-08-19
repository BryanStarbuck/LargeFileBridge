// A FILE ALREADY PINNED ON THIS NODE MUST BE PUBLISHED, NEVER RE-ADDED.
//
// foreign_pin_discovery.mdx acceptance criterion 6 is unambiguous: a pin another tool created is
// "discovered and shown but NEVER re-pinned". The pin pass honored that for files ALREADY in the manifest
// (the foreign-profile adoption branch, gated on `existing?.cid`) and broke it for the case the whole
// subsystem exists for — a discovered file the user has NOW decided to sync. With no manifest entry there
// was nothing for that branch to compare, so the pass fell through to `addFile()` and re-uploaded bytes
// this node already holds, publishing OUR CID instead of the real one the IPFS page already names.
//
// Measured on charlie-kirk on 2026-08-19: 49 videos, 2.0 GB, every one of them in exactly this state —
// pinned here under a legacy CIDv0, absent from the manifest, and therefore invisible to the user's other
// computer, which reported "0 missing" because it had never been told they exist.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let repoRoot: string;
const FOLDER = "charlie-kirk";
const REL = "videos/1965869689755812061.mp4";
const BYTES = "the exact bytes another tool already pinned";
// A real CIDv0 shape, so `canonicalCid()` does its base58 -> CIDv1 conversion rather than passing a
// placeholder straight through — the encoding axis (foreign_pin_discovery.mdx §1.1) is half the bug.
const FOREIGN_CID = "Qmdupxi4TifTuoMz25qHPMUxP3DVz7btycwvJ1rfZZKBpq";
const OUR_CID = "bafyOurOwnAddProfileWouldProduceThis";

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return {
    ...actual,
    listPins: vi.fn(),
    health: vi.fn(async () => "ok" as const),
    addFile: vi.fn(async () => OUR_CID),
    enforceCompliance: vi.fn(async () => undefined),
    contentPinnedCidDetailed: vi.fn(async () => null),
    dagNodeType: vi.fn(async () => "file" as const),
    // The EXPENSIVE probe. The new branch must not reach for it — it reads the RECORDED discovery, which
    // is the only thing §3's honest boundary allows on a per-file path.
    contentPinnedCid: vi.fn(async () => null),
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-foreign-publish-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  process.env.LFB_LOG_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, FOLDER);
  fs.mkdirSync(path.join(repoRoot, "videos"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true }); // `runUnitPin` preflights a working tree
  fs.writeFileSync(path.join(repoRoot, REL), BYTES);
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_LOG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A pinning repo unit with the file DECIDED to sync and NO manifest entry for it — the exact shape the
 *  user creates by clicking the green pin on a foreign-pinned row (one_repo.mdx §4.9). */
async function seedDecidedButUnpublished(): Promise<void> {
  const units = await import("../store-model/units.service.js");
  await units.updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
    pinned: true,
    decisions: { [REL]: "sync" },
  }));
}

/** Record the discovery the background pass would have written (foreign_pin_discovery.mdx §5 tier 1). */
function seedDiscovery(size = BYTES.length): void {
  const state = process.env.LFB_STATE_DIR!;
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, "foreign-pins.json"),
    JSON.stringify([
      {
        cid: FOREIGN_CID,
        canonicalCid: FOREIGN_CID, // recomputed on read; the value here is not the lookup key we use
        profile: "v0-dag-pb",
        absPath: path.join(repoRoot, REL),
        size,
        repoRoot,
        at: "2026-08-19T11:55:51.264Z",
      },
    ]),
  );
}

async function manifestEntry(): Promise<{ cid: string; pinned_by: string[] } | undefined> {
  const { getRepoManifest } = await import("../store-model/units.service.js");
  return getRepoManifest(FOLDER).files.find((f) => f.path === REL) as never;
}

describe("publishing a file whose bytes another tool already pinned here", () => {
  it("records the DISCOVERED CID in the manifest and never re-adds the bytes", async () => {
    await seedDecidedButUnpublished();
    seedDiscovery();
    const ipfs = await import("../ipfs/ipfs.service.js");
    // The pinset really holds it — canonicalized, exactly as `runUnitPin` reads it.
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: FOREIGN_CID }] as never);

    const { pinRepoFolder } = await import("./pin.service.js");
    const counts = await pinRepoFolder(FOLDER);

    const entry = await manifestEntry();
    expect(entry, "the file must reach the manifest — that is what publishes it to the other computer")
      .toBeDefined();
    // The REAL CID, not ours. Publishing our CID would advertise a block this node has never pinned.
    expect(entry!.cid).toBe(FOREIGN_CID);
    expect(ipfs.addFile, "2.0 GB of already-pinned bytes must not be re-uploaded").not.toHaveBeenCalled();
    // `added` (the manifest gained an entry) but NOT `pinned` (no new pin was taken) — the pass may not
    // claim work it did not do.
    expect(counts.added).toBe(1);
    expect(counts.pinned).toBe(0);
  });

  it("claims the pin under this computer's label, so the other computer can fetch it", async () => {
    await seedDecidedButUnpublished();
    seedDiscovery();
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: FOREIGN_CID }] as never);

    const { pinRepoFolder } = await import("./pin.service.js");
    await pinRepoFolder(FOLDER);

    const { computerLabel } = await import("../store-model/config.service.js");
    // Without this claim the entry is a path and a CID that no machine says it holds — the pull-down
    // signal on the other computer reads `pinned_by` and would offer nothing.
    expect((await manifestEntry())!.pinned_by).toContain(computerLabel());
  });

  it("adds normally when another tool has since REMOVED the pin — a stale record is not a pin", async () => {
    // §5.1: we stay compatible with software that unpins. The recorded discovery is a claim about the
    // past; the live pinset is the authority, and trusting the record alone would publish a CID whose
    // blocks are gone — the other computer would fetch forever and never resolve.
    await seedDecidedButUnpublished();
    seedDiscovery();
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([] as never); // the foreign pin is gone

    const { pinRepoFolder } = await import("./pin.service.js");
    await pinRepoFolder(FOLDER);

    expect(ipfs.addFile).toHaveBeenCalledOnce();
    expect((await manifestEntry())!.cid).toBe(OUR_CID);
  });

  it("adds normally when the recorded size no longer matches — the file changed under the pin", async () => {
    await seedDecidedButUnpublished();
    seedDiscovery(BYTES.length + 5000); // record describes different bytes than the file now holds
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: FOREIGN_CID }] as never);

    const { pinRepoFolder } = await import("./pin.service.js");
    await pinRepoFolder(FOLDER);

    expect(ipfs.addFile).toHaveBeenCalledOnce();
    expect((await manifestEntry())!.cid).toBe(OUR_CID);
  });

  it("does not pay the expensive re-hash probe on this path", async () => {
    // The honest boundary (§3): hashing happens in the background discovery pass, size-pruned and cached.
    // A brand-new add that probed every ADD_PROFILE would re-read the whole file for every genuinely-new
    // file in the repo — the cost regression this branch is deliberately shaped to avoid.
    await seedDecidedButUnpublished();
    seedDiscovery();
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: FOREIGN_CID }] as never);

    const { pinRepoFolder } = await import("./pin.service.js");
    await pinRepoFolder(FOLDER);

    expect(ipfs.contentPinnedCid).not.toHaveBeenCalled();
  });
});
