// A RUNNING PULL MUST TELL THE OPEN PAGE THAT ITS NUMBERS MOVED.
//
// `Pull down` is composed at fetch time (`missingPinnedFromPeers`) and the One-Repo page only re-reads when
// something bumps `repo:<folder>`. The pull path bumped NOTHING — the sole repo bump in the pin module is
// `writeRepoManifest` at the END of a pin pass, and `pullMissing` never writes a manifest. So a pull could
// run for an hour with files landing one by one under a tile frozen at the number it had when the page
// loaded, PULSING as if it were recounting (useCensusPending marks it provisional while a pin job runs).
//
// The bump is deliberately throttled far wider than the 1s default: it re-composes the whole repo detail —
// every file row plus a full `pin ls` — and that must not compete with the transfer it is reporting on.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FOLDER = "pull-refresh-fixture";
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-pull-refresh-"));
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

/** A tracking manifest at `root` holding `paths`, each pinned by a peer and absent from this disk. */
async function seedManifest(root: string, paths: string[]): Promise<void> {
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoTrackingManifest(root, {
    schema_version: 1,
    files: paths.map((p, i) => ({ path: p, cid: `bafyPeer${i}`, size: 10, pinned_by: ["bryan-laptop"] })),
  } as never);
}

/** A registered repo unit at `repoRoot`, plus a healthy node that hands over every file asked of it. The
 *  mock defaults are re-applied here because the factory's `vi.fn`s survive `resetModules`. */
async function seedRepo(paths: string[]): Promise<void> {
  const units = await import("../store-model/units.service.js");
  await units.updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
    pinned: true,
  }));
  await seedManifest(repoRoot, paths);
  const ipfs = await import("../ipfs/ipfs.service.js");
  vi.mocked(ipfs.listPins).mockResolvedValue([]);
  vi.mocked(ipfs.hasProvider).mockResolvedValue(true);
  vi.mocked(ipfs.pinAdd).mockResolvedValue(undefined);
  vi.mocked(ipfs.catToFile).mockImplementation(async (cid: string) => cid);
  vi.mocked(ipfs.resolveFileCid).mockImplementation(async (cid: string) => cid);
}

/** Count bumps of THIS repo's topic. Per-topic, because `repoBumpTopics` publishes several. */
async function watchRepoTopic(): Promise<() => number> {
  const events = await import("../events/state-events.service.js");
  let n = 0;
  events.subscribe((b) => {
    if (b.topic === events.repoTopic(FOLDER)) n++;
  });
  return () => n;
}

describe("pullMissing — the Pull-down count refreshes while the pull runs, not only after it", () => {
  it("tells open pages to re-read when a file LANDS", async () => {
    await seedRepo(["videos/a.mp4"]);
    const bumps = await watchRepoTopic();

    const { pullMissing } = await import("./pin.service.js");
    const counts = await pullMissing(repoRoot, ["videos/a.mp4"]);

    expect(counts.pulled).toBe(1);
    expect(bumps()).toBe(1); // was 0 — nothing in the pull path bumped at all
  });

  it("says nothing when the pull FAILS — a file that never arrived changes no count", async () => {
    await seedRepo(["videos/a.mp4"]);
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.hasProvider).mockResolvedValue(false); // the holder is offline
    const bumps = await watchRepoTopic();

    const { pullMissing } = await import("./pin.service.js");
    const counts = await pullMissing(repoRoot, ["videos/a.mp4"]);

    expect(counts.failed).toBe(1);
    expect(bumps()).toBe(0);
  });

  it("RATE-LIMITS the re-read: a burst of landings costs ONE detail rebuild, not one per file", async () => {
    // The reason the throttle window is wide. Ten files landing together must not queue ten walks of every
    // row plus ten `pin ls` calls on a machine already saturated moving the bytes.
    const paths = Array.from({ length: 10 }, (_, i) => `videos/f${i}.mp4`);
    await seedRepo(paths);
    const bumps = await watchRepoTopic();

    const { pullMissing } = await import("./pin.service.js");
    const counts = await pullMissing(repoRoot, paths);

    expect(counts.pulled).toBe(10);
    expect(bumps()).toBe(1);
  });

  it("does not bump some OTHER repo's topic — a pull that lands elsewhere is not this page's news", async () => {
    await seedRepo(["videos/a.mp4"]);
    const stray = path.join(tmp, "not-a-unit");
    fs.mkdirSync(stray, { recursive: true });
    await seedManifest(stray, ["videos/a.mp4"]);
    const bumps = await watchRepoTopic();

    const { pullMissing } = await import("./pin.service.js");
    const counts = await pullMissing(stray, ["videos/a.mp4"]);

    expect(counts.pulled).toBe(1); // it really did land — it just isn't this unit
    expect(bumps()).toBe(0);
  });
});
