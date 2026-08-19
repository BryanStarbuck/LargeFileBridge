// A REPO WHOSE FOLDER IS NOT ON THIS COMPUTER MUST NOT BE PULLED INTO EXISTENCE.
//
// `pullMissing` has four entry points and three of them SWEEP EVERY CONFIGURED UNIT on a timer. A unit's
// path stops existing for ordinary reasons — an external drive unmounted, a clone deleted, a folder
// renamed — and every one of those repos used to get the full treatment on every sweep: provider probes,
// a `pin/add` per file, and then a write into a directory tree that is gone, which materialize would
// simply RE-CREATE under a path the user deliberately removed. On this machine the same shape showed up
// as ~60 registered units pointing at reaped temp dirs, re-attempted every cycle for weeks.
//
// The guard sits in `pullMissing` — one choke point, so no caller can forget it — and reports NOTHING
// ATTEMPTED (`failed: 0`), not "still pending": pull-retry re-arms its timer on pending work, and a repo
// that is not here will never stop being pending.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FOLDER = "pull-absent-root-fixture";
let tmp: string;
let repoRoot: string;

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return {
    ...actual,
    listPins: vi.fn(async () => []),
    health: vi.fn(async () => "ok" as const),
    resolveFileCid: vi.fn(async (cid: string) => cid),
    hasProvider: vi.fn(async () => true),
    pinAdd: vi.fn(async () => undefined),
    catToFile: vi.fn(async () => undefined),
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-pull-absent-root-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  process.env.LFB_LOG_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_LOG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A registered unit whose manifest holds one file, pinned by a peer and absent from this disk. */
async function seedRepo(): Promise<void> {
  const units = await import("../store-model/units.service.js");
  await units.updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
    pinned: true,
  }));
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoTrackingManifest(repoRoot, {
    schema_version: 1,
    files: [{ path: "videos/a.mp4", cid: "bafyPeer0", size: 10, pinned_by: ["bryan-laptop"] }],
  } as never);
  const ipfs = await import("../ipfs/ipfs.service.js");
  vi.mocked(ipfs.hasProvider).mockResolvedValue(true);
  vi.mocked(ipfs.pinAdd).mockResolvedValue(undefined);
  vi.mocked(ipfs.catToFile).mockImplementation(async (cid: string) => cid);
  vi.mocked(ipfs.resolveFileCid).mockImplementation(async (cid: string) => cid);
}

describe("pullMissing — the repo folder is gone", () => {
  it("spends no IPFS work and does not re-create the folder", async () => {
    await seedRepo();
    const ipfs = await import("../ipfs/ipfs.service.js");
    fs.rmSync(repoRoot, { recursive: true, force: true }); // the drive unmounts / the clone is deleted

    const { pullMissing } = await import("./pin.service.js");
    const r = await pullMissing(repoRoot, ["videos/a.mp4"], { label: "pull-retry" });

    expect(ipfs.pinAdd).not.toHaveBeenCalled();
    expect(ipfs.catToFile).not.toHaveBeenCalled();
    expect(r.pulled).toBe(0);
    expect(r.failed).toBe(0); // nothing ATTEMPTED — never "still pending", which would re-arm forever
    expect(r.errors[0]).toContain("not on this computer");
    expect(fs.existsSync(repoRoot)).toBe(false);
  });

  it("still pulls normally when the folder IS here", async () => {
    await seedRepo();
    const ipfs = await import("../ipfs/ipfs.service.js");
    const { pullMissing } = await import("./pin.service.js");
    const r = await pullMissing(repoRoot, ["videos/a.mp4"], { label: "click" });
    expect(r.pulled).toBe(1);
    expect(ipfs.pinAdd).toHaveBeenCalledTimes(1);
  });
});
