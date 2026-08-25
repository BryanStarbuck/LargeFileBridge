// THE FILE-PLANE DATA-ACCESS LAYER — `lfb.file`, plus the two `unit`-scoped tables the scan census owns
// (`unit_scan`'s scan scalars and `unit_orphan`). Migrations 0004 / 0005 / 0014.
//
// The same contract `unit.repo.ts` states and for the same reason: EVERY function here is Postgres-only,
// every one is safe to call with no database (`q`/`exec`/`copyRows` answer `[]` / `0` / `0` when there is no
// pool), and NONE of them is a fallback. Deciding what to do when Postgres is absent belongs to the caller —
// it is the only layer that knows what the YAML answer would have been (R2 / database.mdx §7).
//
// ── WHO OWNS WHICH COLUMN OF `lfb.file` (R5, database_migration.mdx §4.1(b)) ────────────────────────────
// `lfb.file` has FOUR writers — the scan census (this file), decisions, manifests/pins, and sidecars/
// artifacts/git-ignore. A whole-row upsert from any one of them silently resets the other three. So this
// file's `ON CONFLICT` clause names EXACTLY the census's own columns and nothing else:
//
//   OWNED, written on insert AND update — the census re-states these on every scan:
//     rel_path, base_name, dir_posix, file_ext, media,
//     size_bytes, modified_at, changed_at, present_local, is_candidate, analysis_only, candidate_gen
//
//   OWNED, written on INSERT ONLY — compress / transcribe / describe / ocr.
//     These are the NAME-ONLY FLOOR of the four task verdicts, and they are insert-only for a reason that
//     is worth stating plainly: the name-only verdict is a PURE FUNCTION of `rel_posix`, which is half the
//     primary key, so it can never go stale for a row that already exists — while the ARTIFACT-AWARE
//     upgrade ("a `.transcription` exists beside it, so this is `done`") belongs to area 7 and would be
//     clobbered back to `could` by every subsequent scan if the census re-stated it. Insert-only is what
//     lets both be true: a brand-new row is immediately correct enough for the four tab indexes in 0005,
//     and area 7's better answer is never overwritten.
//     The verdict itself is NOT re-derived here — it comes from the SAME `compressInfo` / `mediaKindForName`
//     / `isPdfName` helpers the read path uses (units.service.ts:861-905), so there is one spelling of the
//     rule and not two.
//
//   NOT OWNED, never named: decision / decided_by / decided_at (area 4), cid_canon / pinned_here /
//     pinned_foreign / peer_count / transfer (area 5), first_seen_at / first_seen_device (area 6),
//     never_ipfs / no_compress (git-ignore + flags), looks_compressed (area 11's learned baseline).
//
// `nudgeOnly` IS DELIBERATELY ABSENT from every shape in this file. `scanner.service.ts:52-55` says it is
// in-memory on purpose — "its only job is to keep the auto-decide policy off these rows in the SAME scan
// pass" — it is recomputed inline by every walk, and zero of the 105 status.yaml documents on this machine
// carry it. A stored copy would go stale the instant a threshold moved, which is the exact failure the
// design warns about elsewhere (database_migration.mdx §4.1, AREA 3).
import { fileExt, isPdfName, mediaKindForName, type MediaKind } from "@lfb/shared";
import { compressInfo } from "../fs/badges.js";
import { copyRows, exec, q, q1, type CopyRowsOptions } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";

// ── the derived path facets (0004: base_name / dir_posix / file_ext / media) ────────────────────────────

/** `media_kind` is an ENUM of four values, and `mediaKindForName` only knows three of them. */
type FileMediaKind = MediaKind | "pdf";

export interface FileFacets {
  /** `replace(rel_path,'\','/')` — the value Postgres GENERATES for the primary key. Computed here too so
   *  a caller can dedupe a batch BEFORE the statement, which is what makes `ON CONFLICT` legal (below). */
  relPosix: string;
  baseName: string;
  /** `''` at the unit root. The prefix key every directory rollup groups on (0011). */
  dirPosix: string;
  fileExt: string;
  media: FileMediaKind | null;
  compress: "could" | "done" | "na";
  transcribe: "could" | "done" | "na";
  describe: "could" | "done" | "na";
  ocr: "could" | "done" | "na";
}

/**
 * Everything about a file that is derivable from its path alone.
 *
 * The four task verdicts are the NAME-ONLY floor described in the header: `compressInfo` already answers
 * "compressible, and does the name say it is already compressed" (badges.ts:242), and the media kind
 * already answers which analysis tasks apply at all. What this cannot see — and deliberately does not
 * guess — is whether an artifact has since been produced; that is `analysisOutputs()`'s answer and area 7's
 * column to write.
 */
export function fileFacets(relPath: string): FileFacets {
  const relPosix = relPath.replace(/\\/g, "/");
  const slash = relPosix.lastIndexOf("/");
  const baseName = slash >= 0 ? relPosix.slice(slash + 1) : relPosix;
  const dirPosix = slash > 0 ? relPosix.slice(0, slash) : "";
  const kind = mediaKindForName(baseName);
  const pdf = isPdfName(baseName);
  const ci = compressInfo(baseName);
  return {
    relPosix,
    baseName,
    dirPosix,
    fileExt: fileExt(baseName),
    media: kind ?? (pdf ? "pdf" : null),
    // compressStatusFor (units.service.ts:861) minus its artifact leg: `na` when the name is not a
    // compressible kind, `done` when the name itself says so (`…_compressed.mp4`), else `could`.
    compress: ci.compressible === null ? "na" : ci.compressState === "done" ? "done" : "could",
    // transcribeStatusFor / describeStatusFor / ocrStatusFor (units.service.ts:878/887/899), same split.
    transcribe: kind === "video" || kind === "audio" ? "could" : "na",
    describe: kind === "image" || kind === "video" ? "could" : "na",
    ocr: kind === "image" || kind === "video" || pdf ? "could" : "na",
  };
}

// ── the census writer ───────────────────────────────────────────────────────────────────────────────────

/** One scan candidate, in the shape both the live scan and the backfill already hold it. */
export interface CensusRow {
  /** BYTE-EXACT as the walk saw it (0004: `rel_path` is what re-renders the YAML the SDL carries). */
  relPath: string;
  sizeBytes: number;
  modifiedAt: Date | null;
  /** scan.mdx §4.1 rule 5 — small analysis media, admitted only so the analysis tabs can see it. */
  analysisOnly: boolean;
}

const CENSUS_COLUMNS = [
  "unit_id",
  "rel_path",
  "base_name",
  "dir_posix",
  "file_ext",
  "media",
  "size_bytes",
  "modified_at",
  "changed_at",
  "present_local",
  "is_candidate",
  "analysis_only",
  "candidate_gen",
  "compress",
  "transcribe",
  "describe",
  "ocr",
];

/**
 * The census's own columns, re-stated on every scan. See this file's header for why the four task verdicts
 * are NOT in this list and why the ten below are.
 *
 * `present_local` is here because a scan candidate is a file the walk just STAT'ED — that is direct
 * evidence the bytes are on this computer, and it is the one thing that can promote a remote-only row
 * (area 5, `present_local = false`) back to local when the file finally arrives. The sweep does not clear
 * it: "no longer a candidate" is not "no longer present" (a file that dropped under the threshold is still
 * here), and claiming otherwise would put rows in the "Pull down" tile that need no pulling.
 */
const CENSUS_UPDATE = [
  "rel_path",
  "base_name",
  "dir_posix",
  "file_ext",
  "media",
  "size_bytes",
  "modified_at",
  "changed_at",
  "present_local",
  "is_candidate",
  "analysis_only",
  "candidate_gen",
];

/**
 * ON CONFLICT ... DO UPDATE, NEVER DO NOTHING — and this is the one place it is load-bearing rather than
 * habitual (database_migration.mdx §4.1 AREA 3).
 *
 * The primary key is `(unit_id, rel_posix)` where `rel_posix` is the STORED GENERATED column
 * `replace(rel_path,'\','/')`. That collapses `a\b.mp4` and `a/b.mp4` into ONE row BY DESIGN — it
 * reproduces `foldLedger`'s `healWindowsPath` key exactly (0004's header), which is what makes the
 * stray-path fork structurally impossible instead of healed by hand. But a design that collapses two
 * inputs into one row has to decide which one wins, and `DO NOTHING` decides "whichever we happened to see
 * first, forever" — so the byte-exact spelling on the row would be frozen at whatever the very first scan
 * happened to produce. `DO UPDATE` makes it the LAST spelling seen on disk, which is what 0004 says
 * `rel_path` means.
 */
const CENSUS_ON_CONFLICT =
  `ON CONFLICT ON CONSTRAINT file_pkey DO UPDATE SET ` +
  CENSUS_UPDATE.map((c) => `${c} = EXCLUDED.${c}`).join(", ");

/**
 * Insert/refresh one unit's scan candidates at generation `gen`.
 *
 * `fallbackChangedAt` is what `changed_at` takes when the walk recorded no mtime. It is the SAME fallback
 * the read path already uses — `cand.modified_at ?? status.last_scan_at ?? epoch` (units.service.ts
 * composeFileRows) — so the column the "Changed" header sorts on is the value that column has always shown.
 *
 * WITHIN-BATCH DEDUPE IS MANDATORY, not tidiness: Postgres refuses `ON CONFLICT DO UPDATE` when one
 * statement presents the same conflict key twice ("cannot affect row a second time"). Two candidates whose
 * paths differ only by separator are exactly that case, and while no such pair exists on this machine
 * today (measured: 0 of 30,732 candidate paths contain a backslash), the PK exists precisely because they
 * have existed. Later duplicates win, matching the DO UPDATE rule above.
 */
export async function upsertCensusRows(
  unitId: number,
  gen: number,
  rows: readonly CensusRow[],
  fallbackChangedAt: Date,
  opts: Pick<CopyRowsOptions, "client" | "batchRows"> = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const byKey = new Map<string, unknown[]>();
  for (const r of rows) {
    const f = fileFacets(r.relPath);
    byKey.set(f.relPosix, [
      unitId,
      r.relPath,
      f.baseName,
      f.dirPosix,
      f.fileExt,
      f.media,
      Math.max(0, Math.trunc(r.sizeBytes)), // size_bytes CHECK (>= 0); a negative stat is a bug, not a row
      r.modifiedAt,
      r.modifiedAt ?? fallbackChangedAt,
      true,
      true,
      r.analysisOnly,
      gen,
      f.compress,
      f.transcribe,
      f.describe,
      f.ocr,
    ]);
  }
  return copyRows(`${S}.file`, CENSUS_COLUMNS, [...byKey.values()], {
    ...opts,
    onConflict: CENSUS_ON_CONFLICT,
  });
}

/**
 * THE GENERATION SWEEP — how a file that stopped qualifying leaves the census without a delete pass.
 *
 * Every scan bumps `unit_scan.candidate_gen`, stamps that generation on every row it re-states, and then
 * retires whatever still carries an older one. A file that was deleted, renamed, shrank under the
 * threshold or became git-ignored simply is not re-stated, so it falls out here.
 *
 * WHY NOT A DELETE. The row is not only a census entry: it carries the file's decision, its CID, its pin
 * claims and its first-seen provenance. Deleting it would throw away the decision the user made about a
 * file that is merely under the threshold today. `is_candidate = false` is the honest statement — the row
 * is still true, it just is not in the current census.
 *
 * WHY NOT status.yaml's WHOLE-DOCUMENT REWRITE. That is what this replaces: the largest single status.yaml
 * on this machine is 820,891 bytes, rewritten in full on every scan of that unit. `file_candidate_sweep`
 * (0004) makes this a bounded UPDATE over exactly the rows that went stale.
 */
export async function sweepStaleCandidates(unitId: number, gen: number): Promise<number> {
  return exec(
    `UPDATE ${S}.file SET is_candidate = false
      WHERE unit_id = $1 AND is_candidate AND candidate_gen < $2`,
    [unitId, gen],
  );
}

// ── unit_scan: the scan scalars (the OTHER half of R5's two writers) ────────────────────────────────────

/**
 * `unit_scan.candidate_gen + 1`, atomically, returning the new value.
 *
 * The row may not exist yet (a unit whose `repo_storage.yaml` had no `last_scan` block never got one from
 * slice 4), so this is an upsert rather than an UPDATE — but note the DO UPDATE names `candidate_gen`
 * ALONE. `unit_scan` has two writers and slice 4's owns `last_scan_at` / `last_scan_device` /
 * `last_scan_headless`; resetting those here would erase which computer last scanned this repo.
 *
 * ATOMIC ON PURPOSE. Two scans of the same unit racing on a read-then-write would both compute the same
 * next generation, and the second one's sweep would then retire the first one's rows. `+ 1` inside the
 * statement makes the two generations distinct whatever the interleaving.
 */
export async function bumpCandidateGen(unitId: number): Promise<number> {
  const row = await q1<{ candidate_gen: string }>(
    `INSERT INTO ${S}.unit_scan (unit_id, candidate_gen) VALUES ($1, 1)
     ON CONFLICT (unit_id) DO UPDATE SET candidate_gen = ${S}.unit_scan.candidate_gen + 1
     RETURNING candidate_gen::text AS candidate_gen`,
    [unitId],
  );
  return row ? Number(row.candidate_gen) : 0;
}

/** The generation in force right now. A RESUMING backfill reuses it rather than bumping — see file-backfill.ts. */
export async function currentCandidateGen(unitId: number): Promise<number> {
  const row = await q1<{ candidate_gen: string }>(
    `SELECT candidate_gen::text AS candidate_gen FROM ${S}.unit_scan WHERE unit_id = $1`,
    [unitId],
  );
  return row ? Number(row.candidate_gen) : 0;
}

/**
 * status.yaml's scan scalars.
 *
 * R5, stated as a column list: this writer owns `scan_source`, `last_pin_at`,
 * `effective_threshold_bytes`, `big_file_count`, `big_file_bytes`, `scan_dropped_candidates` and
 * `last_error`. It does NOT write `last_scan_at` / `last_scan_device` / `last_scan_headless`, even though
 * status.yaml carries `last_scan_at`: slice 4 already writes all three from `repo_storage.yaml`'s
 * `last_scan` block, which is strictly more informative (it names the device and whether the scan was
 * headless). Two writers on one column is the thing R5 forbids, and here the other writer knows more.
 * It does not write `candidate_gen` either — `bumpCandidateGen` owns that one.
 */
export interface UnitScanScalars {
  unitId: number;
  scanSource: "scheduled" | "manual";
  lastPinAt: Date | null;
  effectiveThresholdBytes: number;
  bigFileCount: number;
  bigFileBytes: number;
  scanDroppedCandidates: number;
  lastError: string | null;
}

const SCAN_SCALAR_COLUMNS = [
  "unit_id",
  "scan_source",
  "last_pin_at",
  "effective_threshold_bytes",
  "big_file_count",
  "big_file_bytes",
  "scan_dropped_candidates",
  "last_error",
];

export async function upsertUnitScanScalars(rows: UnitScanScalars[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.unit_scan`,
    SCAN_SCALAR_COLUMNS,
    rows.map((r) => [
      r.unitId,
      r.scanSource,
      r.lastPinAt,
      // effective_threshold_bytes CHECK (> 0). A status document with 0 is one that predates the field;
      // the schema default (100 MB) is the honest reading, not a constraint violation that fails the scope.
      r.effectiveThresholdBytes > 0 ? r.effectiveThresholdBytes : 104857600,
      Math.max(0, r.bigFileCount),
      Math.max(0, r.bigFileBytes),
      Math.max(0, r.scanDroppedCandidates),
      r.lastError,
    ]),
    {
      onConflict:
        "ON CONFLICT (unit_id) DO UPDATE SET " +
        SCAN_SCALAR_COLUMNS.filter((c) => c !== "unit_id")
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(", "),
    },
  );
}

/**
 * `unit.present` from status.yaml's `repo_state` — the ONE column of `lfb.unit` this area owns.
 *
 * Slice 4 left it deliberately unwritten and said why (unit.repo.ts `upsertUnit`): reading it would have
 * made area 2 parse area 3's 5.17 MB source for a single enum. Area 3 is already holding the document, so
 * it costs nothing here. Measured on this machine: 101 of 105 units are `present`, 4 are `missing`.
 */
export async function setUnitPresent(unitId: number, present: boolean): Promise<number> {
  return exec(`UPDATE ${S}.unit SET present = $2 WHERE unit_id = $1`, [unitId, present]);
}

// ── unit_orphan (status.yaml `orphans:`) ────────────────────────────────────────────────────────────────

export interface OrphanRow {
  relPosix: string;
  firstSeenAt: Date;
  cidCanon: string | null;
}

/**
 * Replace one unit's orphan set.
 *
 * DELETE-then-insert rather than upsert, because an orphan record is CLEARED the moment the bytes come back
 * (schemas.ts:889-893) — the meaning of the set is "these paths are missing RIGHT NOW", so a path that
 * dropped out of status.yaml has to drop out here too. It is a handful of rows per unit (measured: 0 across
 * all 105 units on this machine today), so the whole-set replace costs nothing and cannot drift.
 *
 * `cid_canon` REFERENCES `lfb.cid`, which area 5 populates. Until it has run, a CID we have not inserted
 * would fail the FK and take the scope down with it — so the value is passed through a guard that keeps it
 * only when the row already exists. An orphan without its CID is still a correct orphan; a failed scope is
 * not.
 */
export async function replaceUnitOrphans(unitId: number, rows: readonly OrphanRow[]): Promise<number> {
  await exec(`DELETE FROM ${S}.unit_orphan WHERE unit_id = $1`, [unitId]);
  if (rows.length === 0) return 0;
  const known = await knownCids(rows.map((r) => r.cidCanon).filter((c): c is string => c !== null));
  const byKey = new Map<string, unknown[]>();
  for (const r of rows) {
    byKey.set(r.relPosix, [unitId, r.relPosix, r.firstSeenAt, r.cidCanon && known.has(r.cidCanon) ? r.cidCanon : null]);
  }
  return copyRows(`${S}.unit_orphan`, ["unit_id", "rel_posix", "first_seen_at", "cid_canon"], [...byKey.values()], {
    onConflict:
      "ON CONFLICT (unit_id, rel_posix) DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at, cid_canon = EXCLUDED.cid_canon",
  });
}

/** Which of these canonical CIDs `lfb.cid` already holds. See `replaceUnitOrphans` for why we ask. */
async function knownCids(cids: string[]): Promise<Set<string>> {
  if (cids.length === 0) return new Set();
  const rows = await q<{ cid_canon: string }>(`SELECT cid_canon FROM ${S}.cid WHERE cid_canon = ANY($1)`, [cids]);
  return new Set(rows.map((r) => r.cid_canon));
}

// ── lookups ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `pin/r/<folder>` → `unit_id`, one lookup on `unit_pin_folder_uq` (0003).
 *
 * The scan and the backfill both hold the pin folder name and nothing else, so this is the join every write
 * in this file starts from. Null means area 2 has not adopted this unit yet, which is a perfectly ordinary
 * state (a repo registered since the last backfill) and never an error.
 */
export async function unitIdForPinFolder(folder: string): Promise<number | null> {
  const row = await q1<{ unit_id: string }>(`SELECT unit_id::text AS unit_id FROM ${S}.unit WHERE pin_folder = $1`, [
    folder,
  ]);
  return row ? Number(row.unit_id) : null;
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

export interface CensusReadRow {
  rel_path: string;
  size_bytes: string;
  modified_at: Date | null;
  changed_at: Date;
  analysis_only: boolean;
}

/**
 * THE CENSUS SOURCE the "All" tab cuts over to (R3 / database.mdx §9).
 *
 * It answers exactly the question `status.candidates` answers and no more: which paths are in this unit's
 * current census, how big, when changed, and whether the row is small analysis-only media. Everything else
 * on a `FileRow` — the decision, the CID, the pin reality, the four task verdicts, the git-ignore axis — is
 * still composed in TypeScript exactly as it was, from exactly the same sources. That narrowness is the
 * point: cutting over the SOURCE OF THE ROW SET is a change one comparison can verify, where cutting over
 * the rows themselves would be six independent projections to get right at once.
 *
 * `changed_at DESC` is the "All" tab's default sort (taskTabs.config.ts `all.defaultSort`), so the rows
 * arrive in the order the tab wants and `file_tab_all` serves the scan.
 */
export async function readCandidateCensus(unitId: number): Promise<CensusReadRow[]> {
  return q<CensusReadRow>(
    `SELECT rel_path, size_bytes::text AS size_bytes, modified_at, changed_at, analysis_only
       FROM ${S}.file
      WHERE unit_id = $1 AND is_candidate
      ORDER BY changed_at DESC`,
    [unitId],
  );
}

export interface AllTabPageRow {
  rel_path: string;
  base_name: string;
  size_bytes: string;
  changed_at: Date;
  analysis_only: boolean;
  media: FileMediaKind | null;
  decision: string;
  transfer: string;
  peer_count: number;
  cid_canon: string | null;
  compress: string | null;
  transcribe: string | null;
  describe: string | null;
  ocr: string | null;
  pinned_here: boolean | null;
  pinned_foreign: boolean;
  present_local: boolean;
  never_ipfs: boolean;
}

/**
 * THE "All" TAB, PAGE 1 — the query `file_tab_all` (0004) was built for, spelled the way the index expects.
 *
 * `unit_id` equality, then `size_bytes` as a RANGE BOUND (the promoted "Large files only" rail toggle,
 * tables.mdx §2.9, which the tab seeds ON), then `changed_at DESC` as the sort, then the charter's
 * 500-row page. Every projected column is in the index's INCLUDE list, so the whole page is an index-only
 * scan and the pin pass's bulk rewrite of `transfer` / `peer_count` does not force heap fetches on the next
 * read.
 *
 * `modified_at` IS DELIBERATELY NOT PROJECTED, and it is the whole difference between an index-only scan
 * and a heap fetch per row. `file_tab_all`'s INCLUDE list (0004) carries sixteen columns; `modified_at` is
 * not one of them, and adding it to the SELECT is enough to demote the plan from `Index Only Scan …
 * Heap Fetches: 0` to a plain `Index Scan` — MEASURED on the real census, both plans in this slice's
 * verification. The tab does not need it: `changed_at` is the column the "Changed" header sorts on and
 * renders, and it is a KEY column of the index. Anything that genuinely needs the raw mtime is asking a
 * per-file question and should read the row, not the page.
 *
 * `thresholdBytes: 0` is the toggle OFF. Be aware that this is the case the index does NOT win: with no
 * selective bound the planner prefers the narrower `file_candidate_sweep` and a bitmap heap scan —
 * MEASURED 6.17 ms for the largest unit's 5,365 rows, against 0.51 ms at the 100 MB default. Six of the
 * seven tabs ship `largeOnlyDefault: true` (taskTabs.config.ts), so the default path is the fast one.
 */
export async function readAllTabPage(
  unitId: number,
  opts: { thresholdBytes?: number; limit?: number } = {},
): Promise<AllTabPageRow[]> {
  return q<AllTabPageRow>(
    `SELECT rel_path, base_name, size_bytes::text AS size_bytes, changed_at, analysis_only,
            media::text AS media, decision::text AS decision, transfer, peer_count, cid_canon,
            compress::text AS compress, transcribe::text AS transcribe, describe::text AS describe,
            ocr::text AS ocr, pinned_here, pinned_foreign, present_local, never_ipfs
       FROM ${S}.file
      WHERE unit_id = $1 AND is_candidate AND size_bytes >= $2
      ORDER BY changed_at DESC
      LIMIT $3`,
    [unitId, Math.max(0, Math.trunc(opts.thresholdBytes ?? 0)), Math.max(1, opts.limit ?? 500)],
  );
}

/** How many candidates this unit currently has. The verification pass's left-hand side. */
export async function countCandidates(unitId: number): Promise<number> {
  const row = await q1<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${S}.file WHERE unit_id = $1 AND is_candidate`,
    [unitId],
  );
  return Number(row?.n ?? 0);
}

/** `pin_folder` → candidate count, for every unit at once. One statement instead of 105. */
export async function candidateCountsByPinFolder(): Promise<Map<string, number>> {
  const rows = await q<{ pin_folder: string | null; n: string }>(
    `SELECT u.pin_folder, count(*)::text AS n
       FROM ${S}.file f JOIN ${S}.unit u USING (unit_id)
      WHERE f.is_candidate
      GROUP BY u.pin_folder`,
  );
  return new Map(rows.filter((r) => r.pin_folder).map((r) => [r.pin_folder!, Number(r.n)]));
}

/** Total candidates across every unit — the §4.5 headline number (30,732 measured on this machine). */
export async function countAllCandidates(): Promise<number> {
  const row = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.file WHERE is_candidate`);
  return Number(row?.n ?? 0);
}
