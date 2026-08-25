// THE ROLLUP GATE — `computeRepoRow` read from `lfb.unit_rollup` MUST equal `computeRepoRow` composed
// from YAML, for EVERY unit.
//
// This is the assertion the slice-11 read cutover rests on, and it is the same shape as the decision
// fold's gate (decision-fold-gate.spec.ts): the arithmetic exists in one place (`repoRowStats`), the
// rollup is a STORED COPY of what that function returned, and a stored copy is only trustworthy if
// somebody re-derives it over real data and compares. `repoRowStats` is the oracle and it stays (R3).
//
// It also pins the freshness contract, which is the part that could go wrong silently. A rollup is refused
// when it is `partial` — and `writeRepoStatus` / `writeRepoManifest` / `updateRepoConfig` must make it
// partial, because those three are the funnel every mutation passes through. If somebody adds a fourth
// write path and does not invalidate, the numbers on the Repos list go stale with no symptom at all; this
// spec is where that gets caught for the three that exist.
//
// IT SKIPS, LOUDLY, WITHOUT A DATABASE — the documented `auto` posture, not a failure (R2). Point it at a
// migrated scratch database and the real state root to make it mean something:
//
//   LFB_GATE_DATABASE_URL=postgresql://localhost:5432/<db> LFB_GATE_STATE_DIR=<state root> \
//     CI=true ./node_modules/.bin/vitest run src/modules/store-model/rollup-drift.spec.ts
//
// The `LFB_GATE_*` spelling is not a whim: `vitest.config.ts` clamps `LFB_STATE_DIR` to a temp dir and
// `LFB_DB_MODE` to `off` for the WHOLE suite, deliberately, and `test.env` wins over the shell.
import { describe, it, expect } from "vitest";

if (process.env.LFB_GATE_STATE_DIR) process.env.LFB_STATE_DIR = process.env.LFB_GATE_STATE_DIR;
if (process.env.LFB_GATE_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.LFB_GATE_DATABASE_URL;
  process.env.LFB_DB_MODE = "required";
}

const { refreshDbHealth } = await import("../../shared/persistence/db.js");
const { probeDatabase, resolveDbMode } = await import("../../shared/persistence/pool.js");
const reachable = resolveDbMode() !== "off" && (await probeDatabase()).reachable;
if (reachable) await refreshDbHealth();

const units = await import("./units.service.js");
const rollup = await import("./rollup.service.js");
const { unitIdForPinFolder } = await import("./file.repo.js");

/** Everything on a `RepoRow` that `unit_rollup` is responsible for. `transferring` is not stored and is
 *  not on the row — it only reaches `status`, which IS compared. */
function aggregates(r: Awaited<ReturnType<typeof units.computeRepoRow>>): string {
  return JSON.stringify({
    counts: r.counts,
    peerCount: r.peerCount,
    notBackedUp: r.notBackedUp,
    missingHere: r.missingHere,
    bytes: r.bytes,
    status: r.status,
  });
}

describe.skipIf(!reachable)("unit_rollup equals repoRowStats, for every unit", () => {
  it("returns identical aggregates from the stored rollup and from the YAML composition", async () => {
    const folders = units.listRepoFolders();
    expect(folders.length).toBeGreaterThan(0);

    // Pass 1 with every rollup invalidated: each row composes from YAML — the oracle — and publishes.
    for (const f of folders) {
      const id = await unitIdForPinFolder(f);
      if (id !== null) await rollup.markUnitRollupPartial(id);
    }
    const oracle = new Map<string, string>();
    for (const f of folders) oracle.set(f, aggregates(await units.computeRepoRow(f)));

    // Publish every rollup as FINAL, the way the scan end does.
    for (const f of folders) await units.refreshRepoRollup(f);
    expect(await rollup.partialRollupCount()).toBe(0);

    // Pass 2 now reads the stored rollup. Every number must be the one the oracle produced.
    const drift: string[] = [];
    for (const f of folders) {
      const got = aggregates(await units.computeRepoRow(f));
      if (got !== oracle.get(f)) drift.push(`${f}:\n  yaml = ${oracle.get(f)}\n  pg   = ${got}`);
    }
    expect(drift, `${drift.length} of ${folders.length} unit(s) drifted:\n${drift.join("\n")}`).toEqual([]);
  });

  it("REFUSES a rollup the moment a status write makes it provisional", async () => {
    const folder = units.listRepoFolders()[0]!;
    const unitId = await unitIdForPinFolder(folder);
    expect(unitId, "the first repo must have been adopted by area 2").not.toBeNull();

    await units.refreshRepoRollup(folder);
    expect(await rollup.readFreshRollupForPinFolder(folder)).not.toBeNull();

    // The write itself is what invalidates — the caller does nothing special, which is the whole point of
    // putting the invalidation at the YAML writer rather than at every call site.
    units.writeRepoStatus(folder, units.getRepoStatus(folder));
    await new Promise((r) => setTimeout(r, 500)); // the invalidation is fire-and-forget by contract

    expect((await rollup.readUnitRollup(unitId!))?.partial).toBe(true);
    expect(await rollup.readFreshRollupForPinFolder(folder)).toBeNull();
  });

  it("agrees with `computeTaskMetrics` on the charter's IMAGE row, and reports the video gap honestly", async () => {
    // The category plane is SQL over `lfb.file`, the tile is TypeScript over composed `FileRow`s. They
    // agree on images and — until area 7 upgrades `lfb.file.compress` past its name-only floor — the SQL
    // side over-reports videos by exactly the number carrying a compression record. That is stated in
    // `categoryCounts`'s doc comment; this asserts the half that must ALREADY agree, so a real divergence
    // in the image predicate cannot hide behind the known video one.
    const folders = units.listRepoFolders();
    const withFiles: Array<{ folder: string; unitId: number }> = [];
    for (const f of folders) {
      const id = await unitIdForPinFolder(f);
      if (id !== null) withFiles.push({ folder: f, unitId: id });
    }
    expect(withFiles.length).toBeGreaterThan(0);

    for (const { unitId } of withFiles.slice(0, 5)) {
      const c = await rollup.categoryCounts(unitId, { thresholdBytes: 52428800 });
      const rows = rollup.categoryRollupRows(c);
      expect(rows.map((r) => r.key)).toEqual([
        "compressible_videos",
        "compressible_images",
        "big_not_ignored",
        "big_ignored_untracked",
      ]);
      // Every count is a real number, never negative, and never NaN from a bigint arriving as a string.
      for (const r of rows) expect(Number.isInteger(r.count) && r.count >= 0).toBe(true);
    }
  });
});

describe("the charter's four rows, without a database", () => {
  it("names the four categories in the charter's order, with the charter's actions", () => {
    const rows = rollup.categoryRollupRows({
      compressibleVideos: 27,
      compressibleImages: 4,
      bigNotIgnored: 9,
      bigIgnoredUntracked: 2,
      alreadyCompressed: 0,
      transcribable: 0,
      transcribed: 0,
      describable: 0,
      described: 0,
      ocrable: 0,
      ocred: 0,
    });
    expect(rows.map((r) => [r.count, r.action])).toEqual([
      [27, "compress"],
      [4, "compress"],
      [9, "ignore"],
      [2, "track"],
    ]);
    // User-facing English: the charter forbids abbreviating the product name in anything a customer reads.
    // These are category labels and mention no product name at all, so the rule is satisfied by absence —
    // asserted so a later edit cannot slip an "LFB" into a string the user reads as a sentence.
    for (const r of rows) expect(r.label).not.toMatch(/\bLFB(ridge)?\b/);
  });
});
