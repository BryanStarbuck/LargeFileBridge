// ONE FILE, ONE TRANSFER — NO MATTER HOW MANY PASSES ASK FOR IT.
//
// `pullMissing` has four entry points (the repo page's Pull down, the To Do apply, the hourly auto-sync-in,
// the 3-hourly pull-retry) and, unlike a pin pass, none of them takes the repo unit lock. Two landing on one
// repo is ordinary: seen on charlie-kirk as two dock cards pulling the same 3.0 GB video, one reading
// ≈2.3 GB and the other ≈2.2 GB — a separate DAG walk and a separate full write to disk for bytes that only
// have to arrive once, holding two of the eight global transfer slots between them.
//
// The fix is NOT a whole-pass lock: that would park the user's click behind a three-hour sweep. The second
// caller for a file joins the first one's transfer and reports its outcome as its own.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FOLDER = "pull-single-flight-fixture";
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
  vi.resetModules(); // clears the MODULE registry — not the MOCK one, so the call counts need their own reset
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-pull-single-flight-"));
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

/** A registered repo unit whose manifest holds `paths`, each pinned by a peer and absent from this disk.
 *  The mock defaults are re-applied here because the factory's `vi.fn`s survive `resetModules`. */
async function seedRepo(paths: string[]): Promise<void> {
  const units = await import("../store-model/units.service.js");
  await units.updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
    pinned: true,
  }));
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoTrackingManifest(repoRoot, {
    schema_version: 1,
    files: paths.map((p, i) => ({ path: p, cid: `bafyPeer${i}`, size: 10, pinned_by: ["bryan-laptop"] })),
  } as never);
  const ipfs = await import("../ipfs/ipfs.service.js");
  vi.mocked(ipfs.listPins).mockResolvedValue([]);
  vi.mocked(ipfs.hasProvider).mockResolvedValue(true);
  vi.mocked(ipfs.pinAdd).mockResolvedValue(undefined);
  vi.mocked(ipfs.catToFile).mockResolvedValue(undefined);
  vi.mocked(ipfs.resolveFileCid).mockImplementation(async (cid: string) => cid);
}

/** A transfer this test can hold open: `arrived` settles once the pull is inside it, `release` lets it end. */
function gate(): { arrived: Promise<void>; release: () => void; enter: () => Promise<void> } {
  let reached!: () => void;
  let open!: () => void;
  const arrived = new Promise<void>((r) => (reached = r));
  const held = new Promise<void>((r) => (open = r));
  return { arrived, release: () => open(), enter: async () => { reached(); await held; } };
}

/** Let every already-scheduled microtask/timer turn run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("pullMissing — two passes over one file move the bytes once", () => {
  it("makes the SECOND caller join the first transfer instead of repeating it", async () => {
    await seedRepo(["videos/a.mp4"]);
    const ipfs = await import("../ipfs/ipfs.service.js");
    const g = gate();
    vi.mocked(ipfs.pinAdd).mockImplementation(g.enter);

    const { pullMissing } = await import("./pin.service.js");
    const first = pullMissing(repoRoot, ["videos/a.mp4"], { label: "click" });
    await g.arrived; // the first pull is now mid-transfer
    const second = pullMissing(repoRoot, ["videos/a.mp4"], { label: "pull-retry" });
    await settle();
    g.release();
    const [a, b] = await Promise.all([first, second]);

    expect(ipfs.pinAdd).toHaveBeenCalledTimes(1); // was 2 — the whole point
    expect(ipfs.catToFile).toHaveBeenCalledTimes(1);
    // The joiner still answers for the file it was asked about: its card must reach its total.
    expect(a.pulled).toBe(1);
    expect(b.pulled).toBe(1);
  });

  it("gives the joiner the real REASON when the shared transfer fails", async () => {
    await seedRepo(["videos/a.mp4"]);
    const ipfs = await import("../ipfs/ipfs.service.js");
    const g = gate();
    vi.mocked(ipfs.pinAdd).mockImplementation(async () => {
      await g.enter();
      throw new Error("peer hung up");
    });

    const { pullMissing } = await import("./pin.service.js");
    const first = pullMissing(repoRoot, ["videos/a.mp4"]);
    await g.arrived;
    const second = pullMissing(repoRoot, ["videos/a.mp4"]);
    await settle();
    g.release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.failed).toBe(1);
    expect(b.failed).toBe(1); // NOT silently counted as pulled
    expect(b.errors[0]).toContain("peer hung up");
  });

  it("does NOT serialize different files — a busy repo still pulls the rest", async () => {
    await seedRepo(["videos/a.mp4", "videos/b.mp4"]);
    const ipfs = await import("../ipfs/ipfs.service.js");
    const g = gate();
    vi.mocked(ipfs.pinAdd).mockImplementation(async (cid: string) => {
      if (cid === "bafyPeer0") await g.enter();
    });

    const { pullMissing } = await import("./pin.service.js");
    const held = pullMissing(repoRoot, ["videos/a.mp4"]);
    await g.arrived;
    // Resolves while the other file is still mid-transfer. A whole-pass lock would deadlock this test.
    expect((await pullMissing(repoRoot, ["videos/b.mp4"])).pulled).toBe(1);
    g.release();
    expect((await held).pulled).toBe(1);
  });

  it("tells the background sweeps a pull is in progress, and stops saying so when it ends", async () => {
    await seedRepo(["videos/a.mp4"]);
    const ipfs = await import("../ipfs/ipfs.service.js");
    const g = gate();
    vi.mocked(ipfs.pinAdd).mockImplementation(g.enter);

    const { pullMissing, repoPullInFlight } = await import("./pin.service.js");
    expect(repoPullInFlight(repoRoot)).toBe(false);
    const running = pullMissing(repoRoot, ["videos/a.mp4"]);
    await g.arrived;
    expect(repoPullInFlight(repoRoot)).toBe(true);
    g.release();
    await running;
    expect(repoPullInFlight(repoRoot)).toBe(false);
  });

  it("saves a healed CID WITHOUT dropping what another pass wrote meanwhile", async () => {
    // A pull can run for hours. Writing back the manifest snapshot it opened with throws away every entry a
    // pin pass, the reconciler or a second pull added in between — the lost update the unit lock stops for
    // pin passes, which a pull cannot hold.
    await seedRepo(["videos/a.mp4"]);
    const ipfs = await import("../ipfs/ipfs.service.js");
    const { writeRepoTrackingManifest, readRepoTrackingManifest } = await import("./manifest.service.js");
    vi.mocked(ipfs.resolveFileCid).mockImplementation(async (cid: string) =>
      cid === "bafyPeer0" ? "bafyHealed" : cid,
    );
    vi.mocked(ipfs.catToFile).mockImplementation(async () => {
      const m = readRepoTrackingManifest(repoRoot);
      m.files.push({ path: "videos/z.mp4", cid: "bafyLater", size: 7, pinned_by: ["bryan-laptop"] } as never);
      writeRepoTrackingManifest(repoRoot, m);
      return undefined as never;
    });

    const { pullMissing } = await import("./pin.service.js");
    expect((await pullMissing(repoRoot, ["videos/a.mp4"])).pulled).toBe(1);

    const after = readRepoTrackingManifest(repoRoot);
    expect(after.files.find((f) => f.path === "videos/a.mp4")?.cid).toBe("bafyHealed");
    expect(after.files.find((f) => f.path === "videos/z.mp4")?.cid).toBe("bafyLater"); // was gone
  });
});
