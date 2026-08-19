// THE DIFFERENTIAL GUARD for the Repos-table aggregates (repos.mdx §4.1/§4.1a/§4.3).
//
// repo-row-stats.spec pins the numbers on ONE hand-built repo. That fixture is readable precisely because
// it is small, which is also its limit: it exercises each branch once, in one combination. The counting
// bugs this file exists to catch were never single-branch mistakes — they were a rule applied in one path
// and not the other (self counted as a peer here but not there), or a bucket that only goes wrong when
// two conditions coincide (undecided AND foreign-pinned, decided AND single-copy).
//
// So this generates repos instead: random candidates, decisions, peer claims, analysis-only flags,
// foreign-pin discoveries and manifest-only entries, then asserts the CHEAP path (`computeRepoRow`, which
// reads raw config/status/manifest fields) computes exactly what the EXPENSIVE path (`computeRepoDetail`,
// which composes full FileRows) computes, for every aggregate the table shows — plus the invariants that
// must hold whatever the inputs were.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ManifestSchema, UnitStatusSchema, type FileRow, type RepoCounts, type RepoUnitConfig } from "@lfb/shared";
import { updateRepoConfig, writeRepoStatus, writeRepoManifest, computeRepoRow, computeRepoDetail } from "./units.service.js";
import { computerLabel } from "./config.service.js";
import { recordForeignPin } from "../ipfs/foreign-pin.service.js";

const SELF = computerLabel();
const PEERS = ["the-tower", "the-laptop", "the-server"];

/** Seeded so a failure is reproducible — a differential test that cannot be re-run on the input that
 *  broke it only tells you something is wrong, never what. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every aggregate the Repos row shows, recomputed from fully-composed FileRows. */
function fromDetailFiles(files: FileRow[]) {
  const counts: RepoCounts = { pinned: 0, pending: 0, undecided: 0, ignored: 0, pinnedForeign: 0 };
  const peers = new Set<string>();
  const bytes = { total: 0, pinned: 0 };
  let notBackedUp = 0;
  let missingHere = 0;
  for (const f of files) {
    for (const p of f.peers) if (p !== SELF) peers.add(p);
    if (f.analysisOnly) continue;
    bytes.total += f.sizeBytes;
    if (f.presence === "remote-only") missingHere++;
    if (f.decision === "ignore") counts.ignored++;
    else if (f.decision === "undecided") {
      if (f.pinnedForeign) counts.pinnedForeign++;
      else counts.undecided++;
    } else if (f.decision === "sync") {
      if (f.transfer === "pinned") {
        counts.pinned++;
        bytes.pinned += f.sizeBytes;
      } else counts.pending++;
      if (f.transfer === "pinned" && !f.peers.some((p) => p !== SELF)) notBackedUp++;
    }
    // A foreign pin nobody else claims is ALSO a single copy on this disk: the bytes are pinned here by
    // some other tool, the file has no manifest entry, and no other computer can see or fetch it
    // (foreign_pin_discovery.mdx §5/§6). Outside the decision branches because it is not a decision state,
    // and excluded for remote-only rows, which have no bytes here to be a single copy of. Mirrors
    // isUnpublishedForeignPin() in units.service.ts — this oracle exists to catch the two drifting apart.
    if (
      f.presence !== "remote-only" &&
      f.decision === "undecided" &&
      f.pinnedForeign &&
      !f.peers.some((p) => p !== SELF)
    )
      notBackedUp++;
  }
  return { counts, peerCount: peers.size, notBackedUp, missingHere, bytes };
}

/** One randomly-shaped repo written into the state root, returned as its folder name. */
async function generateRepo(rng: () => number, i: number): Promise<string> {
  const folder = `drift-fixture-${i}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-drift-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), "*.mp4\n*.jpg\n");

  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const candidates: { path: string; size: number; modified_at: string; analysisOnly: boolean }[] = [];
  const manifest: { path: string; cid: string | null; size: number; sha256: null; modified_at: string; pinned_by: string[] }[] = [];
  const decisions: Record<string, "sync" | "ignore" | "undecided"> = {};

  const n = 1 + Math.floor(rng() * 25);
  for (let k = 0; k < n; k++) {
    const rel = `videos/f${k}.mp4`;
    const size = 1 + Math.floor(rng() * 10_000);
    const analysisOnly = rng() < 0.25;
    candidates.push({ path: rel, size, modified_at: "2026-07-01T00:00:00Z", analysisOnly });

    const d = pick(["sync", "ignore", "undecided"] as const);
    if (rng() < 0.85) decisions[rel] = d; // else: absent → undecided

    // A manifest entry, sometimes with no CID, claimed by any mix of devices (possibly none).
    if (rng() < 0.8) {
      const claims: string[] = [];
      if (rng() < 0.6) claims.push(SELF);
      for (const p of PEERS) if (rng() < 0.35) claims.push(p);
      manifest.push({
        path: rel,
        cid: rng() < 0.85 ? `bafy${i}-${k}` : null,
        size,
        sha256: null,
        modified_at: "2026-07-01T00:00:00Z",
        pinned_by: claims,
      });
    }
    // The bytes may or may not actually be on disk — remoteOnlyRows tests existsSync, and a manifest
    // entry whose file IS here must never become a remote-only row.
    if (rng() < 0.5) {
      fs.mkdirSync(path.join(root, "videos"), { recursive: true });
      fs.writeFileSync(path.join(root, rel), "x");
    }
    // A discovered foreign pin on an undecided file is the `pinnedForeign` bucket.
    if (rng() < 0.3) {
      recordForeignPin({ cid: `bafyforeign${i}-${k}`, profile: "v1-raw-leaves", absPath: path.join(root, rel), size, repoRoot: root });
    }
  }

  // Manifest-only entries the scan never saw: the remote-only rows, when a peer claims them and the
  // bytes are absent here. Deliberately includes self-only and CID-less ones, which must NOT qualify.
  const m = Math.floor(rng() * 6);
  for (let k = 0; k < m; k++) {
    const rel = `remote/r${k}.mp4`;
    const claims: string[] = [];
    if (rng() < 0.3) claims.push(SELF);
    for (const p of PEERS) if (rng() < 0.5) claims.push(p);
    manifest.push({
      path: rel,
      cid: rng() < 0.9 ? `bafyr${i}-${k}` : null,
      size: 1 + Math.floor(rng() * 10_000),
      sha256: null,
      modified_at: "2026-07-01T00:00:00Z",
      pinned_by: claims,
    });
    if (rng() < 0.85) decisions[rel] = pick(["sync", "ignore", "undecided"] as const);
    if (rng() < 0.2) {
      fs.mkdirSync(path.join(root, "remote"), { recursive: true });
      fs.writeFileSync(path.join(root, rel), "x");
    }
  }

  await updateRepoConfig(folder, (c) => ({
    ...c,
    repo: { ...c.repo, name: folder, path: root, remote: null },
    pinned: rng() < 0.5,
    decisions: decisions as RepoUnitConfig["decisions"],
  }));
  writeRepoStatus(
    folder,
    UnitStatusSchema.parse({
      last_scan_at: "2026-07-01T00:00:00Z",
      last_pin_at: rng() < 0.5 ? "2026-07-02T00:00:00Z" : null,
      candidates,
    }),
  );
  writeRepoManifest(folder, ManifestSchema.parse({ generated_at: "2026-07-01T00:00:00Z", files: manifest }));
  return folder;
}

describe("Repos-table aggregates — the cheap path and the composed path agree on ANY repo", () => {
  it("agrees on 60 randomly-shaped repos, and the row invariants hold on every one", async () => {
    const rng = mulberry32(20260813);
    let sawForeign = 0;
    let sawNotBackedUp = 0;
    let sawRemoteOnly = 0;

    for (let i = 0; i < 60; i++) {
      const folder = await generateRepo(rng, i);
      const row = await computeRepoRow(folder);
      const detail = await computeRepoDetail(folder, "unreachable");
      const expected = fromDetailFiles(detail.files);

      // ── Drift: every number the table shows, computed both ways ──────────────────────────────────
      expect(row.counts, `counts for ${folder}`).toEqual(expected.counts);
      expect(row.peerCount, `peerCount for ${folder}`).toBe(expected.peerCount);
      expect(row.notBackedUp, `notBackedUp for ${folder}`).toBe(expected.notBackedUp);
      expect(row.missingHere, `missingHere for ${folder}`).toBe(expected.missingHere);
      expect(row.bytes, `bytes for ${folder}`).toEqual(expected.bytes);
      expect(row.status, `status for ${folder}`).toBe(detail.status);
      expect(row.peerCount, `row vs detail peerCount for ${folder}`).toBe(detail.peerCount);

      // ── Invariants that must hold whatever the inputs were ───────────────────────────────────────
      const c = row.counts;
      const files = c.pinned + c.pending + c.undecided + c.ignored + c.pinnedForeign;
      // §4.1a — the Files column IS the number of rows the One-repo page shows.
      expect(files, `Files invariant for ${folder}`).toBe(detail.files.filter((f) => !f.analysisOnly).length);
      // §4.3 — this computer is never one of its own peers.
      expect(detail.files.flatMap((f) => f.peers).includes(SELF) ? row.peerCount : 0).toBeLessThanOrEqual(PEERS.length);
      expect(row.peerCount).toBeLessThanOrEqual(PEERS.length);
      // The two out-of-sum columns are subsets, never extra rows.
      expect(row.missingHere).toBeLessThanOrEqual(files);
      // `notBackedUp` counts rows whose bytes are on THIS disk and nowhere else. Two count buckets hold
      // rows with local bytes: `pinned` (decided + pinned by us) and `pinnedForeign` (pinned here by
      // another tool, never published — foreign_pin_discovery.mdx §5/§6). The bound was `c.pinned` alone
      // while the second bucket was silently treated as backed up; it is a subset of both, never extra rows.
      expect(row.notBackedUp).toBeLessThanOrEqual(c.pinned + c.pinnedForeign);
      expect(row.bytes.pinned).toBeLessThanOrEqual(row.bytes.total);

      if (c.pinnedForeign > 0) sawForeign++;
      if (row.notBackedUp > 0) sawNotBackedUp++;
      if (row.missingHere > 0) sawRemoteOnly++;
    }

    // A differential test that never reached the interesting branches proves nothing — assert the
    // generator actually produced the three states real data on a healthy machine does not contain.
    expect(sawForeign, "generator never produced a foreign-pinned file").toBeGreaterThan(0);
    expect(sawNotBackedUp, "generator never produced a single-copy file").toBeGreaterThan(0);
    expect(sawRemoteOnly, "generator never produced a remote-only row").toBeGreaterThan(0);
  });
});
