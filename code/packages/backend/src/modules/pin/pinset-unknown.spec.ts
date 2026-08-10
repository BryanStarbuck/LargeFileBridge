// A FAILED `pin ls` IS NOT AN EMPTY PINSET.
//
// `pinnedCidSet` used to answer `new Set()` when the IPFS node could not be reached, reasoned in its own
// docstring as "so nothing is silently hidden from the pull prompt". That is not the conservative
// direction — it is a false alarm. With an empty pinset every file in the manifest reads as "not pinned
// here", so the whole repo lands in Pull down and the user is invited to re-fetch bytes they already hold.
//
// And it bites at exactly the wrong moment. The backend serves requests the instant it is up, while the
// IPFS daemon it auto-starts is still coming up — so the window right AFTER A RESTART is when `listPins`
// is most likely to fail, and a user who has just restarted the app is a user staring at this number. They
// watch the count they thought they had cleared come back, which is indistinguishable from losing the work.
//
// The pin pass already refuses to make this mistake ("A failed/timed-out `pin ls` must NEVER be read as
// 'nothing is pinned'") — it aborts the pass. The read path cannot abort, so it reports nothing and lets
// the next computation, seconds later against a healthy daemon, tell the truth.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let repoRoot: string;

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return { ...actual, listPins: vi.fn(), health: vi.fn(async () => "ok" as const) };
});

beforeEach(() => {
  // Fresh module registry per test: `resolveStateDir()` is resolved at module load, so a cached
  // pin.service would keep reading the PREVIOUS test's state dir and every fixture would read as empty.
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-pinset-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "charlie-kirk");
  fs.mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A tracking manifest holding one peer-pinned file whose bytes are NOT on this disk. */
async function seedManifest(): Promise<void> {
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoTrackingManifest(repoRoot, {
    schema_version: 1,
    files: [{ path: "videos/a.mp4", cid: "bafyPeerPinned", size: 10, pinned_by: ["bryan-laptop"] }],
  } as never);
}

describe("missingPinnedFromPeers — an unreachable IPFS node must not invent a pull-down list", () => {
  it("offers nothing when `pin ls` fails, instead of offering the entire manifest", async () => {
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5001"));
    await seedManifest();

    const { missingPinnedFromPeers } = await import("./pin.service.js");
    // The bytes really are absent here, so the ONLY reason to answer [] is the honest one: we cannot know
    // what is pinned, and guessing "nothing" is what made the count spring back after every restart.
    expect(await missingPinnedFromPeers(repoRoot)).toEqual([]);
  });

  it("offers the file once the node answers and the CID genuinely is not pinned", async () => {
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([]);
    await seedManifest();

    const { missingPinnedFromPeers } = await import("./pin.service.js");
    const offers = await missingPinnedFromPeers(repoRoot);
    expect(offers.map((o) => o.path)).toEqual(["videos/a.mp4"]);
  });
});
