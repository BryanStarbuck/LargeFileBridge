// THE FOREIGN-PIN DATA-ACCESS LAYER — `lfb.foreign_pin` and `lfb.fingerprint_probe` (migration 0008).
//
// Same contract as `store-model/unit.repo.ts`: every function here is Postgres-only, every one is safe to
// call with no database (they go through `shared/persistence/db.ts`, whose `q`/`exec`/`copyRows` answer
// honestly with `[]` / `0` when there is no pool), and NONE of them is a fallback. Deciding what to do when
// Postgres is absent belongs to `foreign-pin.service.ts`, which is the only layer that knows what the JSON
// stores would have said (R2 / database.mdx §7).
//
// WHAT THESE TWO TABLES REPLACE, and why the byte count is the headline. `foreign-pins.json` is 1,284,193 B
// / 2,825 records and `foreign-pin-cache.json` is 7,198,446 B / 36,103 entries, of which 33,157 (91.8%) are
// NEGATIVE — "I hashed this file and it is not pinned". Both were held RESIDENT for the life of the process
// by the write-back stores in `foreign-pin.service.ts`, and before those stores existed both were
// read-modify-REWRITTEN in full once per scanned file, which is the 4 GB RSS incident of 2026-07-20
// (memory.mdx; database.mdx §1.1).
//
// THE NEGATIVES ARE THE POINT AND MUST SURVIVE THE MOVE. `cid_text IS NULL` is a negative probe, and it is
// the only thing standing between the scan and re-hashing 33,157 files every 15 minutes. A "cleanup" that
// deletes NULL-cid rows would look like it freed space and would cost hours of CPU on the next pass.
import { copyRows, exec, q, q1 } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";

// ── lfb.cid (the FK target `foreign_pin.cid_canon` points at) ───────────────────────────────────────────

/**
 * Make sure every canonical CID we are about to reference EXISTS in `lfb.cid`.
 *
 * `foreign_pin.cid_canon REFERENCES lfb.cid(cid_canon) ON DELETE CASCADE` (0008), so this has to run before
 * any foreign-pin insert or the whole batch aborts on a FK violation. `ON CONFLICT DO NOTHING` is mandated
 * for this table (R5): `lfb.cid` is written by several slices and `cid_text` is documented as the "verbatim
 * FIRST-SEEN spelling" (0002) — an upsert here would let a later sighting rewrite an earlier one's
 * spelling, which is the one guarantee that column makes.
 */
export async function ensureCids(rows: ReadonlyArray<{ canon: string; text: string }>): Promise<number> {
  if (rows.length === 0) return 0;
  // De-duplicate in memory first: 2,825 foreign pins share far fewer distinct CIDs, and Postgres refuses a
  // multi-VALUES upsert that hits the same conflict target twice in one statement
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time" — DO NOTHING tolerates it, but sending
  // the duplicates is pointless traffic either way).
  const seen = new Map<string, string>();
  for (const r of rows) if (r.canon && !seen.has(r.canon)) seen.set(r.canon, r.text || r.canon);
  return copyRows(
    `${S}.cid`,
    ["cid_canon", "cid_text"],
    [...seen].map(([canon, text]) => [canon, text]),
    { onConflict: "ON CONFLICT (cid_canon) DO NOTHING" },
  );
}

// ── lfb.foreign_pin ─────────────────────────────────────────────────────────────────────────────────────

export interface ForeignPinRow {
  abs_path: string;
  cid_text: string;
  cid_canon: string;
  profile: string;
  size_bytes: string; // bigint — pg returns it as text so a >2^53 size cannot silently lose precision
  unit_id: number | null;
  observed_at: Date;
  /**
   * The owning unit's root, joined from `lfb.unit`.
   *
   * The JSON index carried `repoRoot` on every record and the IPFS page still renders it — a row's unit
   * name and repo id (ipfs-page.service.ts §4 reverse resolution). 0008 stores `unit_id` instead of a
   * second copy of the path, so every read here joins it back. NULL where the pin is outside every unit,
   * which is exactly what `repoRoot: null` meant.
   */
  unit_abs_path: string | null;
}

/** The SELECT list every read below shares — one place to change when a column is added. */
const FOREIGN_PIN_SELECT =
  `SELECT f.abs_path, f.cid_text, f.cid_canon, f.profile, f.size_bytes::text AS size_bytes,
          f.unit_id::int AS unit_id, f.observed_at, u.abs_path AS unit_abs_path
     FROM ${S}.foreign_pin f
     LEFT JOIN ${S}.unit u ON u.unit_id = f.unit_id`;

export interface ForeignPinUpsert {
  absPath: string;
  cidText: string;
  cidCanon: string;
  profile: string;
  sizeBytes: number;
  unitId: number | null;
  observedAt: Date;
}

const FOREIGN_PIN_COLUMNS = ["abs_path", "cid_text", "cid_canon", "profile", "size_bytes", "unit_id", "observed_at"];

/**
 * Upsert discovered foreign pins, keyed on `abs_path` — one live record per file, exactly as the JSON index
 * was (`recordForeignPin`'s `findIndex` + replace).
 *
 * `unit_id` is COALESCEd rather than overwritten. A pin can be discovered for a file outside every unit
 * (0008's header), so the runtime path frequently has no unit to attach; letting that NULL overwrite the
 * unit id the backfill worked out would quietly empty the column that `foreign_pin_unit` indexes, and
 * `foreignPinPathSetFor` would stop finding anything for that repo. A NULL here means "I don't know",
 * never "no unit".
 *
 * The caller MUST have called {@link ensureCids} for these CIDs first.
 */
export async function upsertForeignPins(rows: ReadonlyArray<ForeignPinUpsert>): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.foreign_pin`,
    FOREIGN_PIN_COLUMNS,
    rows.map((r) => [r.absPath, r.cidText, r.cidCanon, r.profile, r.sizeBytes, r.unitId, r.observedAt]),
    {
      onConflict:
        "ON CONFLICT (abs_path) DO UPDATE SET " +
        "cid_text = EXCLUDED.cid_text, cid_canon = EXCLUDED.cid_canon, profile = EXCLUDED.profile, " +
        `size_bytes = EXCLUDED.size_bytes, unit_id = COALESCE(EXCLUDED.unit_id, ${S}.foreign_pin.unit_id), ` +
        "observed_at = EXCLUDED.observed_at",
    },
  );
}

/** One file's discovered pin — the repo-row / entity-view surfacing read (foreign_pin_discovery.mdx §6). */
export async function foreignPinByPath(absPath: string): Promise<ForeignPinRow | null> {
  return q1<ForeignPinRow>(`${FOREIGN_PIN_SELECT} WHERE f.abs_path = $1`, [absPath]);
}

/**
 * The discovered paths under one unit root, as rows — replaces the whole-index `Set` rebuild that
 * `foreignPinPathSet()` did once per unit (105 rebuilds of a 2,825-record array per Repos-list composition).
 *
 * MATCHED BY PATH PREFIX, NOT BY `unit_id`, AND DELIBERATELY SO. `unit_id` is populated by area 9's backfill
 * from `lfb.unit`, so it is NULL for any pin discovered before that unit was adopted — and a repo whose unit
 * row does not exist yet would answer "no foreign pins at all". That is precisely the regression MEMORY.md's
 * "foreign pin: recorded must render" note is about: a recorded pin that stops rendering reads to the user
 * as "not pinned", and the pin-nag counts follow it. The prefix predicate cannot go blind that way.
 *
 * `starts_with()` rather than `LIKE`: a real file path contains `_` and `%` constantly, and both are LIKE
 * wildcards — `/Users/x/My_Movies/` would match `/Users/x/MyAMovies/`. `starts_with` has no metacharacters.
 * At 2,825 rows the scan is sub-millisecond; `foreign_pin_unit` is there for when the table is large enough
 * for it to matter and for SQL that joins on units.
 */
export async function foreignPinPathsUnder(rootPrefix: string): Promise<string[]> {
  const rows = await q<{ abs_path: string }>(
    `SELECT abs_path FROM ${S}.foreign_pin WHERE starts_with(abs_path, $1)`,
    [rootPrefix],
  );
  return rows.map((r) => r.abs_path);
}

/**
 * The discovered pins under one unit root, as FULL rows — the pin pass's identity-publication source
 * (foreign_pin_discovery.mdx §6.1). {@link foreignPinPathsUnder} answers "which paths"; publishing needs the
 * CID and the recorded size too, and asking {@link foreignPinByPath} once per path would be one round trip
 * per discovered file on every pass. Same `starts_with` prefix match, for the same reasons.
 */
export async function foreignPinsUnder(rootPrefix: string): Promise<ForeignPinRow[]> {
  return q<ForeignPinRow>(`${FOREIGN_PIN_SELECT} WHERE starts_with(f.abs_path, $1)`, [rootPrefix]);
}

/**
 * Reverse resolution by CANONICAL cid (foreign_pin_discovery.mdx §4) — `foreign_pin_canon`.
 *
 * BATCHED, because the caller (`ipfs-page.service.ts computeIpfsPage`) asks once per untracked pin inside a
 * synchronous `pins.map()`. One `= ANY($1)` for the whole page is one round trip; per-pin queries would be
 * one round trip each AND would force that map async.
 */
export async function foreignPinsByCanon(canons: readonly string[]): Promise<ForeignPinRow[]> {
  if (canons.length === 0) return [];
  return q<ForeignPinRow>(`${FOREIGN_PIN_SELECT} WHERE f.cid_canon = ANY($1::text[])`, [[...canons]]);
}

/** Every discovered pin. The debug export and the verification pass; never a request path. */
export async function readAllForeignPins(): Promise<ForeignPinRow[]> {
  return q<ForeignPinRow>(FOREIGN_PIN_SELECT);
}

/**
 * THE COMPATIBILITY PRUNE (foreign_pin_discovery.mdx §5.1), as one DELETE.
 *
 * Another tool `pin rm`'d the bytes ⇒ we must stop claiming the file is pinned. The JSON form read all 2,825
 * records, filtered them in JS and rewrote the whole file; this is `cid_canon <> ALL(kept)`.
 *
 * An EMPTY kept-set deletes everything, and that is the pre-existing behaviour preserved on purpose: `x <>
 * ALL('{}')` is TRUE, exactly as `new Set().has(x)` was false. The guard against "the daemon was down so we
 * wiped every discovery" lives where it always has — in the caller, which only verifies when the node
 * actually answered (scanner.service.ts, `if (pinset.size > 0)`).
 */
export async function deleteForeignPinsNotKept(keptCanon: readonly string[]): Promise<number> {
  return exec(`DELETE FROM ${S}.foreign_pin WHERE cid_canon <> ALL($1::text[])`, [[...keptCanon]]);
}

export async function countForeignPins(): Promise<number> {
  const r = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.foreign_pin`);
  return Number(r?.n ?? 0);
}

/** Rows whose `cid_canon` has no `lfb.cid` row. The FK makes this impossible; area 9 asserts it anyway. */
export async function countForeignPinsWithoutCid(): Promise<number> {
  const r = await q1<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${S}.foreign_pin f
       LEFT JOIN ${S}.cid c ON c.cid_canon = f.cid_canon
      WHERE c.cid_canon IS NULL`,
  );
  return Number(r?.n ?? 0);
}

/**
 * `unit.abs_path` → `unit_id` for a handful of known roots — the join that gives a discovered pin its
 * `unit_id`.
 *
 * A READ of a table `store-model/unit.repo.ts` owns, which is deliberate: `unitIdsByAbsPath()` there fetches
 * the WHOLE table because a backfill wants it whole, while the scan already knows exactly which repo root it
 * is in and wants one row. Writing `lfb.unit` from here would be the thing to refuse; reading two columns of
 * it is not.
 */
export async function unitIdsForRoots(roots: readonly string[]): Promise<Map<string, number>> {
  if (roots.length === 0) return new Map();
  const rows = await q<{ unit_id: string; abs_path: string }>(
    `SELECT unit_id::text, abs_path FROM ${S}.unit WHERE abs_path = ANY($1::text[])`,
    [[...roots]],
  );
  return new Map(rows.map((r) => [r.abs_path, Number(r.unit_id)]));
}

// ── lfb.fingerprint_probe (the fingerprint cache, negatives included) ───────────────────────────────────

export interface ProbeRow {
  abs_path: string;
  size_bytes: string;
  mtime_ms: string;
  cid_text: string | null;
  profile: string | null;
}

export interface ProbeUpsert {
  absPath: string;
  sizeBytes: number;
  mtimeMs: number;
  /** NULL = hashed and NOT pinned. The negative cache — 91.8% of the rows and the whole reason it exists. */
  cidText: string | null;
  profile: string | null;
  probedAt: Date;
}

/**
 * Preload every probe row for a set of files — ONE round trip for a whole unit.
 *
 * WHY BY PATH AND NOT BY THE FULL KEY. The PK is `(abs_path, size_bytes, mtime_ms)`, and the scan knows all
 * three for every candidate, so an exact `IN ((p,s,m), …)` is possible. It is not worth it: it triples the
 * bind parameters (2,188 candidates × 3 = 6,564, which also puts the 65,535 cap within sight of a big
 * enough repo) to avoid fetching the handful of stale-fingerprint rows a path accumulates as it is edited.
 * `= ANY($1::text[])` is one parameter of any size, and the caller filters by the exact key in memory.
 */
export async function probesForPaths(absPaths: readonly string[]): Promise<ProbeRow[]> {
  if (absPaths.length === 0) return [];
  return q<ProbeRow>(
    `SELECT abs_path, size_bytes::text AS size_bytes, mtime_ms::text AS mtime_ms, cid_text, profile
       FROM ${S}.fingerprint_probe WHERE abs_path = ANY($1::text[])`,
    [[...absPaths]],
  );
}

/** One file's probe verdict, for callers with no batch open (a CLI, a test, a one-off). */
export async function probeForKey(absPath: string, sizeBytes: number, mtimeMs: number): Promise<ProbeRow | null> {
  return q1<ProbeRow>(
    `SELECT abs_path, size_bytes::text AS size_bytes, mtime_ms::text AS mtime_ms, cid_text, profile
       FROM ${S}.fingerprint_probe WHERE abs_path = $1 AND size_bytes = $2 AND mtime_ms = $3`,
    [absPath, sizeBytes, mtimeMs],
  );
}

/**
 * Write probe verdicts, positive and negative alike.
 *
 * This table has exactly ONE writer (this module), so a DO UPDATE over its own columns is safe — the R5
 * hazard is a table written by several backfills, which `fingerprint_probe` is not. Re-probing a file whose
 * (size, mtime) is unchanged refreshes `probed_at`, which is what keeps it out of the eviction window.
 */
export async function upsertProbes(rows: ReadonlyArray<ProbeUpsert>): Promise<number> {
  if (rows.length === 0) return 0;
  // The same (path,size,mtime) twice in one statement would trip "ON CONFLICT DO UPDATE command cannot
  // affect row a second time". A scan can legitimately see one path twice (a repo unit and the computer
  // unit overlapping); last write wins, as it did in the JSON object.
  const byKey = new Map<string, ProbeUpsert>();
  for (const r of rows) byKey.set(`${r.absPath} ${r.sizeBytes} ${r.mtimeMs}`, r);
  return copyRows(
    `${S}.fingerprint_probe`,
    ["abs_path", "size_bytes", "mtime_ms", "cid_text", "profile", "probed_at"],
    [...byKey.values()].map((r) => [r.absPath, r.sizeBytes, r.mtimeMs, r.cidText, r.profile, r.probedAt]),
    {
      onConflict:
        "ON CONFLICT (abs_path, size_bytes, mtime_ms) DO UPDATE SET " +
        "cid_text = EXCLUDED.cid_text, profile = EXCLUDED.profile, probed_at = EXCLUDED.probed_at",
    },
  );
}

/**
 * EVICTION — what replaces `CACHE_MAX_ENTRIES = 40,000` plus an O(n log n) sort of every key on every flush.
 *
 * The old cap existed for ONE reason: the whole file had to be resident in the heap, so its size was the
 * process's problem. It is not any more, which is why the default here is 200,000 rather than 40,000 (0008's
 * header) — a bigger cache is strictly better, since every evicted row costs one re-hash of a large file.
 *
 * `probed_at DESC OFFSET $cap LIMIT 1` finds the cut-off timestamp in one index scan of
 * `fingerprint_probe_age`; rows older than it go. Returns 0 when the table is under the cap.
 */
export async function pruneProbes(maxRows: number): Promise<number> {
  return exec(
    `DELETE FROM ${S}.fingerprint_probe
      WHERE probed_at < (SELECT probed_at FROM ${S}.fingerprint_probe
                          ORDER BY probed_at DESC OFFSET $1 LIMIT 1)`,
    [Math.max(1000, Math.floor(maxRows))],
  );
}

export async function countProbes(): Promise<number> {
  const r = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.fingerprint_probe`);
  return Number(r?.n ?? 0);
}

/** How many probe rows are NEGATIVE. Surfaced by area 9's verification because losing them is the failure. */
export async function countNegativeProbes(): Promise<number> {
  const r = await q1<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${S}.fingerprint_probe WHERE cid_text IS NULL`,
  );
  return Number(r?.n ?? 0);
}
