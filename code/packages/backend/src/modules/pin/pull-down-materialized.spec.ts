// A PIN IS NOT A COPY. HOLDING A FILE MEANS BOTH.
//
// `pullMissing` pins the CID and THEN writes the bytes into the working tree. An interrupted run leaves the
// first half done — the blockstore holds the file, its path holds nothing — and `Pull down` skipped that
// file for being pinned. So the row rendered RED (it has no file, so it composes as remote-only) while the
// tile above it read `Pull down 0`, and the two disagreed about the same file. Seen on charlie-kirk: one
// entry of 2091 in exactly that state, and the CLI's `pull_down` — which counts `pinnedHere === false` —
// already said 1.
//
// The repair is cheap and needs no network: the bytes are in the local blockstore, so the pull materializes
// them straight to disk. What it must NOT do is offer a file the user DELETED here — that one is pinned and
// absent too, and re-offering it is the surprise re-pinning decisions.mdx §12 forbids.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FOLDER = "pull-down-materialized-fixture";
const CID = "bafybeipinnedhereinthenodeblockstorebutnevermateriali000000";
const REL = "videos/clip.mp4";

let tmp: string;
let repoRoot: string;

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return { ...actual, listPins: vi.fn(), health: vi.fn(async () => "ok" as const) };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-pd-material-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  process.env.LFB_LOG_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "charlie-kirk");
  fs.mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_LOG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A registered repo unit whose manifest carries one peer-pinned entry, with that CID pinned on this node. */
async function seed(): Promise<void> {
  const units = await import("../store-model/units.service.js");
  await units.updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
    pinned: true,
  }));
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoTrackingManifest(repoRoot, {
    schema_version: 1,
    files: [{ path: REL, cid: CID, size: 22593106, pinned_by: ["bryan-laptop"] }],
  } as never);
  const ipfs = await import("../ipfs/ipfs.service.js");
  vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: CID, type: "recursive" }] as never);
}

/** Put the real file where the manifest says it is. */
function materialize(): void {
  fs.mkdirSync(path.join(repoRoot, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, REL), "bytes");
}

describe("missingPinnedFromPeers — pinned is not the same as here", () => {
  it("offers a file whose CID is pinned here but whose path holds nothing", async () => {
    await seed();
    const { missingPinnedFromPeers } = await import("./pin.service.js");
    expect((await missingPinnedFromPeers(repoRoot)).map((o) => o.path)).toEqual([REL]);
  });

  it("stops offering it once both records agree — pinned AND in the tree", async () => {
    await seed();
    materialize();
    const { missingPinnedFromPeers } = await import("./pin.service.js");
    expect(await missingPinnedFromPeers(repoRoot)).toEqual([]);
  });

  it("does NOT offer a path the pin pass recorded as deleted here", async () => {
    // Same two facts — pinned, no file — but this absence is the user's doing. It belongs to the
    // "Deleted here" tile, and an offer here would have the hourly auto-sync-in put the file straight back.
    await seed();
    const units = await import("../store-model/units.service.js");
    units.writeRepoStatus(FOLDER, {
      ...units.getRepoStatus(FOLDER),
      orphans: { [REL]: { first_seen_at: new Date().toISOString(), cid: CID } },
    } as never);
    const { missingPinnedFromPeers } = await import("./pin.service.js");
    expect(await missingPinnedFromPeers(repoRoot)).toEqual([]);
  });
});
