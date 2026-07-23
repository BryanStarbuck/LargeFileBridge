// THE REGRESSION GUARD for the Repos table's cheap counting path (repos.mdx §4.1/§4.2).
//
// `computeRepoRow` deliberately does NOT compose FileRows. A FileRow carries the git-ignore axis (a
// `git check-ignore` spawn per repo) and the four task axes (an artifact probe per file), and none of
// that reaches the Repos table — so the row's counts, peer count and rolled-up status are derived
// straight from the config + scan status + manifest instead. That is what took `GET /api/repos` from an
// ~11-second synchronous handler (which pinned the event loop, so clicking a repo row appeared to do
// nothing) down to well under two seconds on a 179-repo machine.
//
// The risk that buys is DRIFT: two ways to count the same repo can quietly disagree, and then the Repos
// table shows one number while the One-repo page it links to shows another. These tests pin the two
// together — every assertion below compares the row's aggregates against the SAME aggregates recomputed
// from `computeRepoDetail`'s fully-composed rows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { ManifestSchema, UnitStatusSchema, type RepoCounts, type FileRow } from "@lfb/shared";
import {
  updateRepoConfig,
  writeRepoStatus,
  writeRepoManifest,
  computeRepoRow,
  computeRepoDetail,
} from "./units.service.js";
import { computerLabel } from "./config.service.js";

const FOLDER = "row-stats-fixture";
// "Pinned" means claimed by THIS computer (ipfs.mdx §1.1), so the fixture must use the label this
// process actually resolves to — a hand-written string would silently make every `sync` row read
// `pending` and the test would pass while proving nothing about the pinned state.
const SELF = computerLabel();
const PEER = "the-tower";

// A repo root that EXISTS but holds none of the manifest's files — so the peer-claimed entries below
// become remote-only rows, which both counting paths have to agree about.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-row-stats-"));

const candidate = (p: string, analysisOnly = false) => ({
  path: p,
  size: 1024,
  modified_at: "2026-07-01T00:00:00Z",
  analysisOnly,
});

const manifestEntry = (p: string, cid: string | null, pinnedBy: string[]) => ({
  path: p,
  cid,
  size: 1024,
  sha256: null,
  modified_at: "2026-07-01T00:00:00Z",
  pinned_by: pinnedBy,
});

/** The row aggregates recomputed the EXPENSIVE way, from fully-composed FileRows. */
function aggregatesFromDetail(): { counts: RepoCounts; peerCount: number } {
  const detail = computeRepoDetail(FOLDER, "unreachable");
  const files: FileRow[] = detail.files;
  const counts: RepoCounts = { pinned: 0, pending: 0, undecided: 0, ignored: 0, pinnedForeign: 0 };
  const peers = new Set<string>();
  for (const f of files) {
    for (const p of f.peers) peers.add(p);
    if (f.analysisOnly) continue;
    if (f.decision === "ignore") counts.ignored++;
    else if (f.decision === "undecided") {
      if (f.pinnedForeign) counts.pinnedForeign++;
      else counts.undecided++;
    } else if (f.decision === "sync") {
      if (f.transfer === "pinned") counts.pinned++;
      else counts.pending++;
    }
  }
  return { counts, peerCount: peers.size };
}

beforeAll(async () => {
  await updateRepoConfig(FOLDER, (c) => ({
    ...c,
    repo: { ...c.repo, name: "fixture", path: root, remote: null },
    pinned: true,
    decisions: {
      // One of each decision the counts distinguish.
      "videos/pinned-here.mp4": "sync",
      "videos/wanted-not-here.mp4": "sync",
      "videos/ignored.mp4": "ignore",
      // "videos/undecided.mp4" is deliberately absent → undecided.
      // The peer's file is undecided here too, and becomes a remote-only row.
    },
  }));

  writeRepoStatus(
    FOLDER,
    UnitStatusSchema.parse({
      last_scan_at: "2026-07-01T00:00:00Z",
      last_pin_at: "2026-07-01T00:00:00Z",
      candidates: [
        candidate("videos/pinned-here.mp4"),
        candidate("videos/wanted-not-here.mp4"),
        candidate("videos/ignored.mp4"),
        candidate("videos/undecided.mp4"),
        // Small analysis-only media (scan.mdx §4.1 rule 5) — present as a row, excluded from the counts.
        candidate("images/thumb.jpg", true),
      ],
    }),
  );

  writeRepoManifest(
    FOLDER,
    ManifestSchema.parse({
      generated_at: "2026-07-01T00:00:00Z",
      files: [
        // Decided + claimed by US → "pinned".
        manifestEntry("videos/pinned-here.mp4", "bafypinnedhere", [SELF, PEER]),
        // Decided, has a CID, but only a PEER claims it → still "pending" here.
        manifestEntry("videos/wanted-not-here.mp4", "bafywanted", [PEER]),
        // Only the peer has it and it was never scanned here → a remote-only row.
        manifestEntry("videos/only-on-the-tower.mp4", "bafyremote", [PEER]),
      ],
    }),
  );
});

describe("computeRepoRow — the cheap Repos-table path", () => {
  it("counts exactly what the fully-composed One-repo rows count", () => {
    expect(computeRepoRow(FOLDER).counts).toEqual(aggregatesFromDetail().counts);
  });

  it("reports the same distinct peer count as the composed rows", () => {
    expect(computeRepoRow(FOLDER).peerCount).toEqual(aggregatesFromDetail().peerCount);
  });

  it("gets the counts themselves right, not merely self-consistent", () => {
    // A row that agrees with a broken composer is worthless — pin the actual numbers too.
    expect(computeRepoRow(FOLDER).counts).toEqual({
      pinned: 1, // pinned-here.mp4 — decided AND claimed by this computer
      pending: 1, // wanted-not-here.mp4 — decided, but only a peer claims it
      undecided: 2, // undecided.mp4 + the peer's only-on-the-tower.mp4 remote-only row
      ignored: 1, // ignored.mp4
      pinnedForeign: 0,
    });
  });

  it("excludes small analysis-only media from the decision counts (scan.mdx §4.1 rule 5)", () => {
    const counts = computeRepoRow(FOLDER).counts;
    const total = counts.pinned + counts.pending + counts.undecided + counts.ignored + counts.pinnedForeign;
    // Five scanned candidates + one remote-only row = six rows, but the thumbnail owes no decision.
    expect(total).toBe(5);
  });

  it("counts a peer's file this computer lacks — the remote-only row reaches the table", () => {
    // The Repos table must not under-report a repo just because the bytes live on another computer:
    // the peer's entry is exactly the file the user needs to pull down.
    expect(computeRepoRow(FOLDER).peerCount).toBeGreaterThan(0);
    expect(computeRepoDetail(FOLDER, "unreachable").files.some((f) => f.presence === "remote-only")).toBe(true);
  });

  it("rolls up the SAME status the composed path would (repos.mdx §4.2)", () => {
    // pending > 0 outranks undecided, so this repo reads "behind" on both paths.
    expect(computeRepoRow(FOLDER).status).toBe("behind");
    expect(computeRepoDetail(FOLDER, "unreachable").status).toBe(computeRepoRow(FOLDER).status);
  });
});
