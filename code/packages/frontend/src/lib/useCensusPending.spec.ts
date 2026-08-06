// "THIS NUMBER IS NOT FINAL YET" (performance.mdx P-38).
//
// The failure being pinned: a repo screen showed `Pull down 0` in the light-green ALL-CLEAR tile, and some
// minutes later the same tile read 6. Nothing was broken — `Pull down` counts files a peer computer has
// and this one does not, and that answer only exists once the git backbone has pulled and the mirrored
// manifests are folded in, which the pin pass does in its own time. But the tile did not say "still
// counting". It said zero, in the colour reserved for "there is nothing to do".
//
// The rule these tests hold to is asymmetric ON PURPOSE. A false "still counting" costs a moment's
// patience. A false "all clear" costs a file that was never backed up here. So the last test is the
// important one: EVERY census-moving kind must light the cue, and adding a kind to the catalog without
// deciding about it must fail here rather than ship a silent all-clear.
import { describe, it, expect } from "vitest";
import type { ProgressKind } from "@lfb/shared";
import { censusPendingFrom } from "./useCensusPending.js";

const idle = { jobs: [], queued: 0, scanRunning: false };

describe("nothing running", () => {
  it("is not pending, and offers no sentence to show", () => {
    expect(censusPendingFrom(idle)).toEqual({ active: false, label: null });
  });
});

describe("a running pass", () => {
  it("names the pass, so the cue says WHAT is moving the numbers", () => {
    const out = censusPendingFrom({ ...idle, jobs: [{ kind: "pin", target: "charlie-kirk" }] });
    expect(out.active).toBe(true);
    expect(out.label).toBe("Pinning charlie-kirk");
  });

  it("beats the coarser signals when several are true at once", () => {
    const out = censusPendingFrom({
      jobs: [{ kind: "scan", target: "all" }],
      queued: 12,
      scanRunning: true,
    });
    expect(out.label).toBe("Scanning all"); // the specific sentence, not "12 jobs waiting to start"
  });

  it("ignores a job whose kind cannot move a repo census", () => {
    // A download of the IPFS binary, an install, a hash — real work, but not work that changes what the
    // tiles count. Marking those pending would make the cue permanent background noise, and a cue that is
    // always on is a cue nobody reads.
    expect(censusPendingFrom({ ...idle, jobs: [{ kind: "download", target: "kubo" }] }).active).toBe(false);
    expect(censusPendingFrom({ ...idle, jobs: [{ kind: "install", target: "ffmpeg" }] }).active).toBe(false);
  });
});

describe("a scan with no dock job yet", () => {
  it("still counts — discovery runs BEFORE the per-unit jobs exist", () => {
    const out = censusPendingFrom({ ...idle, scanRunning: true });
    expect(out).toEqual({ active: true, label: "Scanning this computer" });
  });
});

describe("work that is queued but not started", () => {
  it("counts, because the numbers are about to move", () => {
    expect(censusPendingFrom({ ...idle, queued: 3 })).toEqual({
      active: true,
      label: "3 jobs waiting to start",
    });
  });

  it("says 'job' for one and 'jobs' for more", () => {
    expect(censusPendingFrom({ ...idle, queued: 1 }).label).toBe("1 job waiting to start");
  });
});

describe("the census-moving kinds", () => {
  // THE ONE THAT MUST NOT ROT. `pin` is the kind the reported failure hung on: `Pull down` is fed by the
  // backbone pull and the peer-manifest fold, both of which live inside the pin pass.
  const MUST_BE_PENDING: ProgressKind[] = ["scan", "pin", "import", "compress", "transcribe", "describe", "ocr", "mixed"];
  for (const kind of MUST_BE_PENDING) {
    it(`treats a running "${kind}" as census-moving`, () => {
      expect(censusPendingFrom({ ...idle, jobs: [{ kind, target: "x" }] }).active).toBe(true);
    });
  }
});
