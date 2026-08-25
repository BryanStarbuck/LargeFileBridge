// BACKFILL AREA 3 — the scan census, `pin/r/<folder>/status.yaml` → `lfb.file` + `unit_scan` + `unit_orphan`
// (database_migration.mdx §4.1, AREA 3; state-file key `backfill_candidates`).
//
// MEASURED SOURCE on this machine: 105 × `pin/r/<folder>/status.yaml`, 5.17 MB in total, 30,732 candidate
// rows, largest single document 820,891 bytes. 101 units read `repo_state: present`, 4 read `missing`, and
// no unit currently carries an `orphans:` entry.
//
// WHY THIS AREA IS THE ONE THAT PAYS. `status.candidates` is the row set the One-Repo table is built from,
// and today every read of it parses the whole document — including, for the largest repo, 820 KB of YAML to
// answer "which files are in this repo's census". Worse, every SCAN REWRITES that document in full. This
// area is what lets the generation sweep (`file.repo.ts sweepStaleCandidates`) replace the rewrite with a
// bounded UPDATE, and what lets the "All" tab's row set come from an index instead of a parse.
//
// The three harness mechanics are NOT re-implemented here — they are `shared/persistence/backfill.ts`'s
// (watermark + cursor, caller-supplied ON CONFLICT, reject-and-continue). What this file owns is the
// TRANSFORM, and the transform's three rules:
//
//   1. R6 — read through `readRawYaml`, never `readYaml()`. 5.17 MB of documents through yaml-store's
//      4,096-entry FIFO `rawCache` would evict the hot unit configs the running app is serving from.
//   2. R5 — write only this area's own columns. `unit_scan` has two writers (slice 4 owns the `last_scan`
//      trio from `repo_storage.yaml`; this area owns the scan scalars), and `lfb.file` has four.
//   3. `nudgeOnly` IS NOT PERSISTED. `scanner.service.ts:52-55` states it is in-memory on purpose, every
//      walk recomputes it inline, and zero of the 105 documents on disk contain it. A stored copy would be
//      wrong the moment a threshold moved.
import fs from "node:fs";
import path from "node:path";
import { UnitStatusSchema, type UnitStatus } from "@lfb/shared";
import {
  registerBackfill,
  type BackfillArea,
  type BackfillContext,
  type BackfillScope,
} from "../../shared/persistence/backfill.js";
import { readRawYaml } from "../../shared/persistence/raw-yaml.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { canonicalCid } from "../ipfs/ipfs.service.js";
import {
  bumpCandidateGen,
  candidateCountsByPinFolder,
  countAllCandidates,
  currentCandidateGen,
  replaceUnitOrphans,
  setUnitPresent,
  sweepStaleCandidates,
  unitIdForPinFolder,
  upsertCensusRows,
  upsertUnitScanScalars,
  type CensusRow,
  type OrphanRow,
} from "./file.repo.js";

const pinReposRoot = (): string => path.join(resolveStateDir(), "pin", "r");

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return []; // a state root with no pin units yet is normal, not an error
  }
}

interface CandidateScopeData {
  folder: string;
  statusFile: string;
}

function candidateScopes(): BackfillScope[] {
  const scopes: BackfillScope[] = [];
  for (const folder of listDirs(pinReposRoot())) {
    const statusFile = path.join(pinReposRoot(), folder, "status.yaml");
    if (!fs.existsSync(statusFile)) continue; // a unit registered but never scanned has no census to migrate
    scopes.push({
      key: `r/${folder}`,
      sources: [statusFile],
      data: { folder, statusFile } satisfies CandidateScopeData,
    });
  }
  return scopes;
}

/**
 * ROWS PER STATEMENT BATCH, and per checkpoint.
 *
 * The harness flushes its ledger at 2,000 rows or 5 s, whichever comes first, so a checkpoint call is
 * cheap and this number only has to be small enough that a crash loses a bounded amount of work. 1,000
 * rows × 17 columns = 17,000 bind parameters, comfortably inside `copyRows`'s 65,535 cap (which would
 * otherwise silently re-split the batch — correct, but it would make the cursor lag the rows actually
 * written).
 */
const BATCH_ROWS = 1_000;

/** ISO string → Date, or null. A status document written by an older build can carry an unparseable value. */
function isoDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * status.yaml's `orphans:` map → `unit_orphan` rows.
 *
 * The key is already a unit-relative path, but it is healed to POSIX here for the same reason `file`'s
 * primary key is a generated POSIX column: an orphan recorded under `a\b.mp4` and a file row keyed
 * `a/b.mp4` are the same file, and a join that misses is a decided-and-vanished file the UI never warns
 * about. `cid` goes through `canonicalCid` because `lfb.cid` is keyed canonically (ipfs.mdx §5.1) and a raw
 * `Qm…` spelling would never match the `bafy…` row that holds the same block.
 */
function orphanRows(status: UnitStatus): OrphanRow[] {
  const out: OrphanRow[] = [];
  for (const [rel, o] of Object.entries(status.orphans ?? {})) {
    const at = isoDate(o.first_seen_at);
    if (!at) continue; // `first_seen_at` is NOT NULL and it is the grace period's clock — no date, no record
    let cid: string | null = null;
    try {
      cid = o.cid ? canonicalCid(o.cid) : null;
    } catch {
      cid = null; // an uninterpretable CID makes the orphan CID-less, never makes the orphan disappear
    }
    out.push({ relPosix: rel.replace(/\\/g, "/"), firstSeenAt: at, cidCanon: cid });
  }
  return out;
}

/**
 * The candidates of one status document, in CURSOR ORDER.
 *
 * Sorted by the POSIX-healed path, not left in walk order: the resume cursor is "the last path inserted",
 * and that only means anything if the same document always yields the same sequence. The walk's own order
 * is directory-iteration order, which is neither sorted nor promised to be stable across runs.
 */
export function candidateRows(status: UnitStatus, reject: (reason: string) => void): CensusRow[] {
  const rows: CensusRow[] = [];
  for (const c of status.candidates) {
    const rel = typeof c.path === "string" ? c.path : "";
    if (!rel.trim()) {
      // `file_rel_path_nonblank` is a CHECK, and a CHECK failure aborts the WHOLE multi-row INSERT rather
      // than the offending tuple — one blank path would take 999 good rows with it. Mechanic (c): record
      // it and keep going. Exported so the branch can be exercised without a database; the real corpus
      // cannot produce it (measured: 0 of 30,732 candidate paths are blank).
      reject("candidate with an empty path");
      continue;
    }
    rows.push({
      relPath: rel,
      sizeBytes: typeof c.size === "number" ? c.size : 0,
      modifiedAt: isoDate(c.modified_at),
      analysisOnly: c.analysisOnly === true,
    });
  }
  rows.sort((a, b) => {
    const x = a.relPath.replace(/\\/g, "/");
    const y = b.relPath.replace(/\\/g, "/");
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return rows;
}

async function runCandidateScope(data: CandidateScopeData, ctx: BackfillContext): Promise<number> {
  const unitId = await unitIdForPinFolder(data.folder);
  if (unitId === null) {
    // NOT a failure of this area. `adopt_units` (area 2) is what creates the row, and it is registered
    // ahead of this one for exactly this reason — but a unit registered since the last adopt pass has no
    // row yet, and recording that is more useful than throwing.
    ctx.reject(data.statusFile, `no lfb.unit row for pin folder '${data.folder}' — run adopt_units first`);
    return 0;
  }

  let status: UnitStatus;
  try {
    status = readRawYaml(data.statusFile, UnitStatusSchema);
  } catch (e) {
    ctx.reject(data.statusFile, `status.yaml unreadable: ${(e as Error).message}`);
    return 0;
  }

  // ── the scalars, first: they are one row each and they are what makes a partially-migrated unit still
  // readable. A scope that dies halfway through 11,000 candidates has at least published this unit's
  // threshold, counts and repo_state.
  await upsertUnitScanScalars([
    {
      unitId,
      scanSource: status.scan_source,
      lastPinAt: isoDate(status.last_pin_at),
      effectiveThresholdBytes: status.effective_threshold_bytes,
      bigFileCount: status.big_file_count,
      bigFileBytes: status.big_file_bytes,
      scanDroppedCandidates: status.scan_dropped_candidates ?? 0,
      lastError: status.last_error,
    },
  ]);
  // `unit.present` — the one column of `lfb.unit` this area owns. Slice 4 left it unwritten rather than
  // parse 5.17 MB of status documents for a single enum (unit.repo.ts `upsertUnit`).
  await setUnitPresent(unitId, status.repo_state === "present");
  await replaceUnitOrphans(unitId, orphanRows(status));

  /**
   * THE GENERATION, and the one subtlety in this whole area.
   *
   * A fresh pass BUMPS: it is a new census, and the sweep at the end must retire everything the previous
   * one left behind. A RESUMING pass must NOT bump — it has to keep stamping the generation the
   * interrupted run already wrote, because the rows that run managed to insert carry it. Bumping on resume
   * would make its own earlier rows look stale, and the sweep would then retire the first half of the very
   * census it just finished writing.
   *
   * `currentCandidateGen` returning 0 means the `unit_scan` row vanished under us (a dropped database, a
   * cleared schema) — in which case there is nothing to be consistent with and a fresh generation is right.
   */
  let gen = ctx.resumeFrom === null ? await bumpCandidateGen(unitId) : await currentCandidateGen(unitId);
  if (gen === 0) gen = await bumpCandidateGen(unitId);

  // The fallback for `changed_at` when a candidate has no mtime — the SAME one the read path uses
  // (units.service.ts composeFileRows: `cand.modified_at ?? status.last_scan_at ?? epoch`), so the column
  // the "Changed" header sorts on holds the value that column has always shown.
  const fallbackChangedAt = isoDate(status.last_scan_at) ?? new Date(0);

  const all = candidateRows(status, (reason) => ctx.reject(data.statusFile, reason));
  const resumeFrom = ctx.resumeFrom;
  const pending = resumeFrom === null ? all : all.filter((r) => r.relPath.replace(/\\/g, "/") > resumeFrom);

  let rows = ctx.rowsBefore;
  for (let i = 0; i < pending.length; i += BATCH_ROWS) {
    const batch = pending.slice(i, i + BATCH_ROWS);
    await upsertCensusRows(unitId, gen, batch, fallbackChangedAt);
    rows += batch.length;
    ctx.checkpoint(batch[batch.length - 1]!.relPath.replace(/\\/g, "/"), rows);
  }

  // THE SWEEP, only now that every candidate carries this generation. Running it earlier — or on a scope
  // that failed partway — would retire rows this pass is still about to re-state.
  await sweepStaleCandidates(unitId, gen);
  ctx.checkpoint(null, rows);
  return rows;
}

export const BACKFILL_CANDIDATES: BackfillArea = {
  name: "backfill_candidates",
  version: 1,
  kind: "backfill",
  sources: () => candidateScopes().flatMap((s) => s.sources),
  scopes: () => candidateScopes(),

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    return { rows: await runCandidateScope(scope.data as CandidateScopeData, ctx) };
  },

  /**
   * §4.5's named assertion for this area: "sum over units of `file WHERE is_candidate` = 30,732 ± the
   * reject count; per unit, count matches `len(status.candidates)`".
   *
   * The per-unit expectation is DISTINCT POSIX PATHS, not `candidates.length`, and the difference is not a
   * fudge: the primary key deliberately collapses `a\b.mp4` and `a/b.mp4` into one row (0004), so a
   * document containing both legitimately produces one row for two entries. Asserting against the raw
   * length would report that correct behaviour as a mismatch and — per §4.5 — block the read cutover over
   * it. Measured on this machine the two numbers are equal (30,732 = 30,732; no candidate path contains a
   * backslash), so the distinction costs nothing today and is correct the day it stops costing nothing.
   */
  async verify() {
    const mismatches: string[] = [];
    const scopes = candidateScopes();
    const counts = await candidateCountsByPinFolder();
    let yamlRows = 0;

    for (const scope of scopes) {
      const data = scope.data as CandidateScopeData;
      let status: UnitStatus;
      try {
        status = readRawYaml(data.statusFile, UnitStatusSchema);
      } catch {
        continue; // already in the reject table with the parser's own message
      }
      const distinct = new Set(
        status.candidates
          .map((c) => (typeof c.path === "string" ? c.path.replace(/\\/g, "/") : ""))
          .filter((p) => p.trim().length > 0),
      );
      yamlRows += distinct.size;
      const got = counts.get(data.folder) ?? 0;
      if (got !== distinct.size) {
        mismatches.push(`${scope.key}: ${got} candidate row(s) in Postgres, ${distinct.size} in status.yaml`);
      }
    }

    const pgRows = await countAllCandidates();
    return { yamlRows, pgRows, mismatches };
  },
};

/**
 * Register area 3.
 *
 * Explicit, like `registerUnitBackfills()`, so importing this file for one exported helper does not mutate
 * the global registry as a side effect. It MUST be registered after areas 1 and 2: every scope here starts
 * by resolving a `unit_id`, and a unit that `adopt_units` has not produced yet is a reject, not a row.
 */
export function registerFileBackfills(): void {
  registerBackfill(BACKFILL_CANDIDATES);
}
