// "WE DID NOT CHECK" IS NOT "WE DO NOT HAVE IT".
//
// The reconciler drops this computer's `pinned_by` claim when the pinset does not back it — right, and the
// rule the whole pull-down feature depends on. But the pinset is only half the test while the file is
// sitting on disk: identical bytes can be pinned under a CID no string comparison reaches, which is why the
// content probe (`add --only-hash`) exists. That probe is BUDGETED per repo per pass, and it can throw.
// Both of those used to land in the same branch as a genuine "not pinned here" and DROP the claim — a write
// to the shared manifest, published to every other computer.
//
// The pin pass then re-adopts the same bytes (its own adopt path has no budget) and re-adds the claim.
// Measured on the live `all` repo, 2026-08-12: three entries alternating `pinned_by: []` / `[bryan-mac-pro]`
// across consecutive backbone commits all day, the manifest carrying two versions of itself and nothing
// else. A claim left exactly as we found it costs nothing; a claim written on no evidence costs a commit
// each way, forever.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest } from "@lfb/shared";

const FOLDER = "claim-verification-fixture";
const SELF = "test-computer";
const PEER = "bryan-mac-pro";
const A = "images/a.jpg";
const B = "images/b.jpg";

let tmp: string;
let repoRoot: string;

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return {
    ...actual,
    listPins: vi.fn(async () => []),
    health: vi.fn(async () => "ok" as const),
    addFile: vi.fn(async () => "bafkreiunused000000000000000000000000000000000000000000000000"),
    contentPinnedCidDetailed: vi.fn(async () => null),
    dagNodeType: vi.fn(async () => "file" as const),
    resolveFileCid: vi.fn(async (cid: string) => cid),
  };
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-claim-verify-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  process.env.LFB_LOG_DIR = path.join(tmp, "state");
  // ONE probe for the whole repo, so the second file is a file we never looked at — the budget case,
  // reached the way the product reaches it rather than by reaching into the module.
  process.env.LFB_RECONCILE_CID_PROBES = "1";
  repoRoot = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repoRoot, "images"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, A), "x");
  fs.writeFileSync(path.join(repoRoot, B), "y");
  const cfg = await import("../store-model/config.service.js");
  await cfg.updateAppConfig((c) => ((c.computer.label = SELF), c));
  const ipfs = await import("../ipfs/ipfs.service.js");
  vi.mocked(ipfs.listPins).mockResolvedValue([]);
  vi.mocked(ipfs.contentPinnedCidDetailed).mockResolvedValue(null);
  vi.mocked(ipfs.dagNodeType).mockResolvedValue("file");
});

afterEach(async () => {
  const { stopReconciler } = await import("./reconciler.service.js");
  stopReconciler();
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_LOG_DIR;
  delete process.env.LFB_RECONCILE_CID_PROBES;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Both records carry the same two on-disk entries, each claimed by this computer and a peer. */
async function seed(): Promise<void> {
  const units = await import("../store-model/units.service.js");
  await units.updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
    pinned: true,
    decisions: { [A]: "sync", [B]: "sync" },
  }));
  const doc = {
    schema_version: 1,
    unit: "repo",
    files: [A, B].map((p) => ({ path: p, cid: `bafyRecorded-${p}`, size: 1, sha256: null, pinned_by: [SELF, PEER] })),
  } as unknown as Manifest;
  units.writeRepoManifest(FOLDER, doc);
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoTrackingManifest(repoRoot, doc);
}

async function claims(): Promise<Record<string, string[]>> {
  const units = await import("../store-model/units.service.js");
  return Object.fromEntries(units.getRepoManifest(FOLDER).files.map((f) => [f.path, f.pinned_by]));
}

describe("reconciler — a claim is only edited on a settled answer", () => {
  it("keeps our claim on a file the probe budget never reached", async () => {
    await seed();
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    // The first file got the one probe: nothing is pinned here, so that claim is disproved and dropped.
    // The second never got one, and "on disk, unexamined" is not evidence of anything.
    expect(counts.claimsDropped).toBe(1);
    expect(counts.claimsUnverified).toBe(1);
    const back = await claims();
    expect(back[A]).toEqual([PEER]);
    expect(back[B]).toEqual([PEER, SELF].sort());
  });

  it("keeps our claim when the probe THREW — an error is not a disproof", async () => {
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.contentPinnedCidDetailed).mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5001"));
    await seed();
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.claimsDropped).toBe(0);
    expect(counts.claimsUnverified).toBe(2);
    expect((await claims())[A]).toContain(SELF);
  });

  it("writes NOTHING AT ALL when every claim it saw was unverified", async () => {
    // The other half of the loop: an unverified claim must not count as a change, or both manifests are
    // rewritten (and committed) every pass on any repo big enough to exhaust the budget.
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.contentPinnedCidDetailed).mockRejectedValue(new Error("node busy"));
    await seed();
    const { repoTrackingManifestPath } = await import("./manifest.service.js");
    const file = repoTrackingManifestPath(repoRoot);
    const before = fs.readFileSync(file, "utf8");
    const { reconcileRepo } = await import("./reconciler.service.js");

    await reconcileRepo(FOLDER);

    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("still drops a claim on a file that is not here at all — no probe is owed for that", async () => {
    // The rule it must not soften: nothing on disk and nothing in the pinset is a settled answer, budget
    // or no budget, and that is the case the whole claim rule was written for.
    fs.rmSync(path.join(repoRoot, A));
    fs.rmSync(path.join(repoRoot, B));
    await seed();
    const { reconcileRepo } = await import("./reconciler.service.js");

    const counts = await reconcileRepo(FOLDER);

    expect(counts.claimsDropped).toBe(2);
    expect(counts.claimsUnverified).toBe(0);
    const back = await claims();
    expect(back[A]).toEqual([PEER]);
    expect(back[B]).toEqual([PEER]);
  });
});
