// A COMPUTER MUST NEVER ADVERTISE A PIN IT DOES NOT HOLD.
//
// `pinned_by` is the signal the whole pull-down feature reads: a peer's label on an entry means "a computer
// of yours has these bytes, you can fetch them from it". Pin truth is therefore self-claim-only and derived
// from the local pinset (ipfs.mdx §1.1) — and `runUnitPin` re-derives it every pass, which is exactly why
// `mergeManifests` felt safe unioning a claim about US straight off the wire.
//
// It is not safe on a unit whose pin pass does not run. A repo with `pinned: false` runs the RECEIVE half of
// the mirror on every pass (marker + reconcile) and `runUnitPin` NEVER, so a self-claim that arrived back
// over the mirror had no writer that could ever correct it — and the scan-path mirror published it onward.
// Measured on charlie-kirk (`pinned: false`, `last_pin_at: null`) on 2026-08-11: 173 entries in both the
// unit and the tracking manifest named `xenx-xenx-pc` while `ipfs pin ls` held none of those CIDs.
//
// Two rules close it, and they only work as a pair — the merge-side strip (cross-computer-sync.spec.ts) stops
// new ones arriving, and the heal below removes the ones already on disk. Without the strip the heal is
// undone by the next union with the mirror; without the heal the strip never repairs what is published.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

let tmp: string;
let repoRoot: string;
const FOLDER = "charlie-kirk";
/**
 * A peer label that cannot be this computer's own, whichever machine runs the suite. This suite's entire
 * subject is "a claim of OURS vs a claim of a PEER's", so a hard-coded real device name breaks it on the one
 * machine it names: `PEER = "bryan-mac-pro"` IS `computerLabel()` on Bryan's Mac Pro, which collapsed
 * `pinned_by: [PEER, label]` to a single claim and made "drops ours, keeps the peer's" unsatisfiable there
 * while passing in every other checkout. Deriving from the local label keeps it foreign by construction.
 */
const peerOf = (label: string): string => `peer-${label}-elsewhere`;
const HELD = "bafyReallyPinnedHere";
const UNHELD = "bafyNotPinnedHere";
const STAMP = "2026-07-08T00:01:51.501Z";

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return { ...actual, listPins: vi.fn(), health: vi.fn(async () => "ok" as const) };
});

beforeEach(() => {
  // Fresh registry per test — `resolveStateDir()` is read at module load (see pinset-unknown.spec.ts).
  vi.resetModules();
  // The mock factory's `vi.fn()` outlives `resetModules`, so its call log carries over between tests and
  // the "never reads the pin list" assertion below would count the EARLIER tests' calls.
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-self-claim-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, FOLDER);
  fs.mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A repo unit the user has NOT opted into pinning — the shape the pin pass skips. */
function seedConfig(): void {
  const dir = path.join(process.env.LFB_STATE_DIR!, "pin", "r", FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    YAML.stringify({ schema_version: 1, repo: { name: FOLDER, path: repoRoot }, pinned: false }),
  );
}

/**
 * Seed BOTH manifests with the same two entries: one this computer really holds, one it does not.
 * `claims` is the exact `pinned_by` list both entries carry, so a caller that means "a peer's claim and
 * ours" and one that means "a peer's claim ONLY" say so explicitly instead of encoding it in one argument.
 */
async function seedManifests(claims: string[]): Promise<void> {
  const files = [
    { path: "images/held.jpg", cid: HELD, size: 10, sha256: null, modified_at: STAMP, pinned_by: [...claims] },
    { path: "images/unheld.jpg", cid: UNHELD, size: 20, sha256: null, modified_at: STAMP, pinned_by: [...claims] },
  ];
  const { writeRepoManifest } = await import("../store-model/units.service.js");
  const { writeRepoTrackingManifest } = await import("./manifest.service.js");
  writeRepoManifest(FOLDER, { schema_version: 1, unit: "repo", files } as never);
  writeRepoTrackingManifest(repoRoot, { schema_version: 1, unit: "repo", files } as never);
}

async function readBoth(): Promise<Record<string, string[]>[]> {
  const { getRepoManifest } = await import("../store-model/units.service.js");
  const { readRepoTrackingManifest } = await import("./manifest.service.js");
  return [getRepoManifest(FOLDER), readRepoTrackingManifest(repoRoot)].map((m) =>
    Object.fromEntries(m.files.map((f) => [f.path, f.pinned_by])),
  );
}

describe("a `pinned: false` repo must not publish pin claims it cannot back", () => {
  it("drops this computer's unbacked claims from BOTH manifests and keeps the peer's", async () => {
    const { computerLabel } = await import("../store-model/config.service.js");
    const label = computerLabel();
    const peer = peerOf(label);
    seedConfig();
    await seedManifests([peer, label]);
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([{ cid: HELD }] as never);

    const { pinRepoFolder } = await import("./pin.service.js");
    const counts = await pinRepoFolder(FOLDER);

    // The opt-in still holds: no bytes moved, an honest all-zero tally.
    expect(counts.added + counts.fetched + counts.pinned).toBe(0);
    for (const claims of await readBoth()) {
      // The claim we can back survives; the one we cannot is gone. A peer's claim is never ours to touch —
      // we can only verify our own pinset, so removing theirs would delete the pull-down signal itself.
      expect(claims["images/held.jpg"]).toContain(label);
      expect(claims["images/held.jpg"]).toContain(peer);
      expect(claims["images/unheld.jpg"]).not.toContain(label);
      expect(claims["images/unheld.jpg"]).toContain(peer);
    }
  });

  it("leaves every claim alone when `pin ls` FAILS — a dead daemon is not an empty pinset", async () => {
    // The same rule `runUnitPin` states. Dropping every claim because the daemon was still coming up would
    // tell the user's other computers this machine had lost the bytes — a false alarm at the exact moment
    // (right after a restart) when the daemon is most likely to be unreachable.
    const { computerLabel } = await import("../store-model/config.service.js");
    const label = computerLabel();
    seedConfig();
    await seedManifests([peerOf(label), label]);
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5001"));

    const { pinRepoFolder } = await import("./pin.service.js");
    await pinRepoFolder(FOLDER);

    for (const claims of await readBoth()) {
      expect(claims["images/held.jpg"]).toContain(label);
      expect(claims["images/unheld.jpg"]).toContain(label);
    }
  });

  it("never reads the pin list when there is no claim of ours to verify", async () => {
    // The pass visits every non-opted-in repo every 15 minutes and `pin ls` is the slowest call the app
    // makes. Paying it per repo per pass would trade one defect for a much more visible one, so the whole
    // check is conditional — a healed repo costs nothing ever again.
    const { computerLabel } = await import("../store-model/config.service.js");
    seedConfig();
    await seedManifests([peerOf(computerLabel())]); // peer claims ONLY — nothing of ours to verify
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([] as never);

    const { pinRepoFolder } = await import("./pin.service.js");
    await pinRepoFolder(FOLDER);

    expect(ipfs.listPins).not.toHaveBeenCalled();
  });
});
