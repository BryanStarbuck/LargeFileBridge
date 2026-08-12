// THE PULL-DOWN COUNT MUST ASK "DO I HAVE THESE BYTES", NOT "DO I HAVE THIS STRING".
//
// Two computers pin identical content under DIFFERENT CIDs — a legacy `ipfs add` yields a CIDv0 `Qm…`,
// a raw-leaves build yields a `bafk…` — and `canonicalCid` cannot bridge them: it re-encodes a multihash,
// it does not re-hash bytes. That is exactly what `cid_equivalence.yaml` is for, and the pin pass has
// always consulted it (`pinsetHasContent`). The Pull-down metric did not.
//
// So a file pulled from a peer with a legacy CID was pinned, recorded as equivalent, reported as pulled —
// and then offered again, forever. Every retry re-added the same bytes, re-wrote the same pair, and the
// count did not move by one. The user's read of that is the correct one: "I pulled them and nothing
// happened."
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RECORDED = "bafybeirecordedbyapeerwithalegacyaddprofile00000000000000000";
const LOCAL = "bafkreiwhatthiscomputeractuallypinnedforthesamebytes0000000000";

let tmp: string;
let repoRoot: string;

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return { ...actual, listPins: vi.fn(), health: vi.fn(async () => "ok" as const) };
});

beforeEach(() => {
  vi.resetModules(); // the equivalence map is cached in-module; a stale cache would leak across tests
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-pd-equiv-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "charlie-kirk");
  fs.mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** One manifest entry, pinned by a peer, whose CID is what the FLEET recorded — not what we pinned. The
 *  file itself is on disk: these tests are about the CID axis, and a pull that finished leaves BOTH the pin
 *  and the copy (an entry with a pin but no copy is its own offer — pull-down-materialized.spec.ts). */
async function seedManifest(): Promise<void> {
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoTrackingManifest(repoRoot, {
    schema_version: 1,
    files: [{ path: "images/a.jpg", cid: RECORDED, size: 10, pinned_by: ["bryan-laptop"] }],
  } as never);
  fs.mkdirSync(path.join(repoRoot, "images"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "images/a.jpg"), "bytes");
}

describe("missingPinnedFromPeers — a file held under an equivalent CID is not still 'missing'", () => {
  it("does NOT offer a file whose bytes are pinned here under a recorded equivalent CID", async () => {
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: LOCAL, type: "recursive" }] as never);
    await seedManifest();
    const { noteCidEquivalence } = await import("./cid-equivalence.service.js");
    noteCidEquivalence(RECORDED, LOCAL); // what the pull that fetched it already wrote

    const { missingPinnedFromPeers } = await import("./pin.service.js");
    expect(await missingPinnedFromPeers(repoRoot)).toEqual([]);
  });

  it("still offers a file when NOTHING here holds those bytes", async () => {
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([]);
    await seedManifest();

    const { missingPinnedFromPeers } = await import("./pin.service.js");
    expect((await missingPinnedFromPeers(repoRoot)).map((o) => o.path)).toEqual(["images/a.jpg"]);
  });

  it("does not trust the map blindly — a pair whose local CID is no longer pinned is still a pull-down", async () => {
    // The equivalence map is a record of a past add, not proof of a present pin. Unpin the local copy and
    // the file is genuinely gone again; believing the map here would hide a lost second copy.
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([]);
    await seedManifest();
    const { noteCidEquivalence } = await import("./cid-equivalence.service.js");
    noteCidEquivalence(RECORDED, LOCAL);

    const { missingPinnedFromPeers } = await import("./pin.service.js");
    expect((await missingPinnedFromPeers(repoRoot)).map((o) => o.path)).toEqual(["images/a.jpg"]);
  });
});
