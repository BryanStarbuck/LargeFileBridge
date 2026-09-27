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

// ONE FAILED `pin ls`, ONE WARN (error catalog #17). `listPins` is single-flight, so every reader waiting on
// an enumeration receives the SAME rejection — and each used to restate it at WARN (pinnedCidSet, then
// missingPinnedFromPeers per repo, the reconciler, each pin pass): six WARNs for one abort. The ipfs layer
// reports the failure once; the readers record their consequence at INFO. A failure no one has reported yet
// (anything that is not the ipfs layer's PinsetUnavailableError) keeps its WARN.
describe("pinnedCidSet — the already-reported pin-ls failure is not re-announced", () => {
  it("logs the consequence at INFO, not WARN, when the ipfs layer already reported the failure", async () => {
    const ipfs = await import("../ipfs/ipfs.service.js");
    const { PinsetUnavailableError } = await import("../ipfs/pinset-unavailable.js");
    vi.mocked(ipfs.listPins).mockRejectedValue(new PinsetUnavailableError("ipfs pin ls (recursive) failed: aborted"));
    await seedManifest();
    const { log } = await import("../../shared/logging.js");
    const warn = vi.spyOn(log, "warn");

    const { missingPinnedFromPeers } = await import("./pin.service.js");
    expect(await missingPinnedFromPeers(repoRoot)).toEqual([]);
    expect(warn.mock.calls.filter(([ctx]) => ctx === "pin")).toEqual([]);
  });

  it("still WARNs for a failure nobody has reported yet", async () => {
    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockRejectedValue(new Error("something unexpected"));
    const { log } = await import("../../shared/logging.js");
    const warn = vi.spyOn(log, "warn");

    const { pinnedCidSet } = await import("./pin.service.js");
    expect(await pinnedCidSet()).toBeNull();
    expect(warn.mock.calls.some(([ctx, m]) => ctx === "pin" && /listPins failed/.test(m))).toBe(true);
  });
});

// ONE PUSH GIVE-UP, ONE WARN (error catalog #16). git.service already WARNs its own push give-up; pin's
// report of the same result (and backbone-freshness after it) must not restate it at WARN.
describe("gitProblemAlreadyWarned", () => {
  it("a push-phase remote/auth problem was already WARNed by the git layer", async () => {
    const { gitProblemAlreadyWarned } = await import("./pin.service.js");
    const why = "Git remote error — Large File Bridge keeps pinning over IPFS. ( ! [rejected] main -> main (fetch first))";
    expect(gitProblemAlreadyWarned(undefined, { ran: true, fetched: true, problem: why })).toBe(true);
  });
  it("the pull's problem, unchanged by the push, was already reported by the pull report", async () => {
    const { gitProblemAlreadyWarned } = await import("./pin.service.js");
    expect(gitProblemAlreadyWarned("Git pull failed: x", { ran: true, problem: "Git pull failed: x" })).toBe(true);
  });
  it("a failed commit, a thrown push, or a re-pull conflict is NOT logged by git — it keeps its WARN", async () => {
    const { gitProblemAlreadyWarned } = await import("./pin.service.js");
    expect(gitProblemAlreadyWarned(undefined, { ran: true, problem: "Git commit failed: index.lock" })).toBe(false);
    expect(gitProblemAlreadyWarned(undefined, { ran: true, problem: "Git push failed: boom" })).toBe(false);
    expect(
      gitProblemAlreadyWarned(undefined, { ran: true, problem: "Git merge conflict on 1 file(s)", conflicts: ["a"] }),
    ).toBe(false);
  });
  it("no problem, nothing to dedupe", async () => {
    const { gitProblemAlreadyWarned } = await import("./pin.service.js");
    expect(gitProblemAlreadyWarned(undefined, { ran: true, pushed: true })).toBe(false);
  });
});
