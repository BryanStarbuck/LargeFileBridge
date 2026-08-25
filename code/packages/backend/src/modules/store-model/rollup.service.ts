// THE MAINTAINED ROLLUP — `lfb.unit_rollup` (migration 0003) and the charter's category rollup table
// (migration 0011). Slice 11 of database.mdx §9.
//
// ── WHY THIS TABLE EXISTS AT ALL ────────────────────────────────────────────────────────────────────────
// `computeRepoRow` composes one Repos-table row by parsing that repo's `config.yaml`, `status.yaml` and
// `manifest.yaml`, building a foreign-pin path set, and walking every scan candidate to tally five numbers
// (units.service.ts `repoRowStats`). That is the cheap path — it already avoids composing `FileRow`s — and
// the Repos list still runs it 105 times per walk. `unit_rollup` is those five numbers already added up.
// MEASURED CONTRAST recorded with the table (0003): computing them live is a HashAggregate over 30,758
// candidate rows at 27.9 ms; reading the row is sub-millisecond.
//
// ── THE ONE RULE THIS MODULE IS ORGANISED AROUND ────────────────────────────────────────────────────────
//
//     A ROLLUP PUBLISHED MID-SCAN AS IF IT WERE FINAL IS HOW A COUNT THAT IS MERELY INCOMPLETE GETS READ
//     AS A COUNT THAT WENT DOWN.
//
// The scan re-states a unit's whole census. Halfway through, "how many files does this repo have" has a
// true answer and a *published* answer, and they differ by however much of the walk is left. A reader that
// cannot tell the two apart shows the user a repo that appears to be losing files. So:
//
//   * `markUnitRollupPartial()` sets `partial = true` the moment anything that feeds a rollup number
//     changes, and
//   * `publishUnitRollup()` is the ONLY writer that clears it, and it is called at the END of a pass with
//     the completed numbers in hand.
//
// `partial` is performance.mdx P-38's honesty flag, and `unit_rollup_dirty` (0003) is the partial index
// that answers "which rollups are still provisional" without ever holding all 105 rows.
//
// ── HOW FRESHNESS IS ESTABLISHED (two independent mechanisms, on purpose) ───────────────────────────────
//
//   1. WRITER-SIDE INVALIDATION. Every mutation that can move a rollup number funnels through one of three
//      writers in units.service.ts — `writeRepoStatus` (the scan and the pin pass), `writeRepoManifest`
//      (the pin pass's claims) and `updateRepoConfig` (every decision, via decisions.service.ts:546). Those
//      three already bump the repo's live-refresh topics because, in that file's own words, "a change here
//      is exactly the moment an open page has gone stale". The rollup is stale at exactly the same moment,
//      so it is invalidated at exactly the same seam.
//
//   2. A TIMESTAMP GUARD, as the backstop. `readFreshRollupForPinFolder` refuses a row whose `computed_at`
//      predates `unit_scan.last_scan_at`, `unit_scan.last_pin_at` or `unit_setting.updated_at`. If a future
//      write path is added and somebody forgets mechanism 1, the guard still catches everything those three
//      timestamps cover. Belt and braces, because the failure mode of a missed invalidation is a WRONG
//      NUMBER shown confidently, which is worse than a slow one.
//
// A rollup that fails either test is not an error: the caller composes from YAML exactly as it did before
// this module existed, and publishes the result on the way past (R2, and the reason the cutover is safe).
//
// ── R5 INSIDE ONE TABLE: TWO WRITERS, DISJOINT COLUMNS ──────────────────────────────────────────────────
// `unit_rollup` has two writers in this file and they must not overwrite each other:
//
//   `publishUnitRollup`          owns file_count, bytes_total, bytes_pinned, n_pinned, n_pending,
//                                n_undecided, n_ignored, n_pinned_foreign, n_not_backed_up, n_missing_here,
//                                peer_count — the DECISION/BYTE/PEER plane, composed in TypeScript by
//                                `repoRowStats`, which is the one implementation of that arithmetic.
//   `refreshRollupCategoryCounts` owns n_big_not_ignored, n_big_ignored_untracked, n_compressible_videos,
//                                n_compressible_images, n_already_compressed and the six analysis counts —
//                                the CATEGORY plane, computed by one SQL aggregate over `lfb.file`.
//
// `computed_at` / `partial` belong to the first writer alone. The category refresh deliberately does not
// touch them: it must never clear the `partial` flag of a scan that is still running.
//
// WHY THE DECISION PLANE IS COMPOSED IN TYPESCRIPT AND NOT AGGREGATED IN SQL. `lfb.file.decision`,
// `.transfer`, `.peer_count` and `.pinned_foreign` are columns that NO writer populates yet — area 4
// deliberately does not project the decision onto `lfb.file` (decision-backfill.ts states why: four writers
// share that table and area 3 owns those rows), and areas 5/7 write `pin_claim` rather than `file.transfer`.
// A SQL aggregate over those columns today would return `n_pinned = 0` for every repo on this machine. The
// numbers `repoRowStats` computes are the correct ones, and copying them into the table is both honest and
// exactly the "one implementation of the rule" discipline this codebase keeps everywhere else.
import { exec, q, q1 } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";

// ── the shape `repoRowStats` produces and this table stores ─────────────────────────────────────────────

/** The decision/byte/peer plane of one unit's rollup — every field composed by `repoRowStats`. */
export interface RollupStats {
  fileCount: number;
  counts: { pinned: number; pending: number; undecided: number; ignored: number; pinnedForeign: number };
  /** OTHER computers only, never this one (ipfs.mdx §1.1). */
  peerCount: number;
  notBackedUp: number;
  missingHere: number;
  bytes: { total: number; pinned: number };
}

/** One `unit_rollup` row as a reader wants it. `partial` is carried so a caller can log WHY it was refused. */
export interface UnitRollupRow extends RollupStats {
  unitId: number;
  partial: boolean;
  computedAt: Date;
  categories: CategoryCounts;
}

/** The charter's four category-rollup rows, as counts. */
export interface CategoryCounts {
  compressibleVideos: number;
  compressibleImages: number;
  bigNotIgnored: number;
  bigIgnoredUntracked: number;
  alreadyCompressed: number;
  transcribable: number;
  transcribed: number;
  describable: number;
  described: number;
  ocrable: number;
  ocred: number;
}

const PUBLISH_COLUMNS = [
  "file_count",
  "bytes_total",
  "bytes_pinned",
  "n_pinned",
  "n_pending",
  "n_undecided",
  "n_ignored",
  "n_pinned_foreign",
  "n_not_backed_up",
  "n_missing_here",
  "peer_count",
] as const;

const CATEGORY_COLUMNS = [
  "n_big_not_ignored",
  "n_big_ignored_untracked",
  "n_compressible_videos",
  "n_compressible_images",
  "n_already_compressed",
  "n_transcribable",
  "n_transcribed",
  "n_describable",
  "n_described",
  "n_ocrable",
  "n_ocred",
] as const;

// ── writer 1: the decision/byte/peer plane ──────────────────────────────────────────────────────────────

/**
 * Mark this unit's rollup PROVISIONAL. Cheap — a single-row upsert, no aggregate, no read.
 *
 * Called at the START of anything that will change the numbers, and from the three YAML writers that every
 * mutation path funnels through. An INSERT here creates a row of zeroes, which would be a lie if anybody
 * read it — which is precisely why it is created with `partial = true`, and why every reader in this file
 * refuses a partial row.
 */
export async function markUnitRollupPartial(unitId: number): Promise<number> {
  return exec(
    `INSERT INTO ${S}.unit_rollup (unit_id, partial, computed_at) VALUES ($1, true, now())
     ON CONFLICT (unit_id) DO UPDATE SET partial = true`,
    [unitId],
  );
}

/**
 * Publish the completed decision/byte/peer plane, and clear `partial` unless the caller says otherwise.
 *
 * `partial: true` is for a caller that has real numbers but knows they are not final — a scan that
 * published a census and has not yet run the pin pass, say. The DEFAULT is `false`, because the normal
 * caller is one that has just finished.
 */
export async function publishUnitRollup(
  unitId: number,
  stats: RollupStats,
  opts: { partial?: boolean } = {},
): Promise<number> {
  const values = [
    unitId,
    Math.max(0, Math.trunc(stats.fileCount)),
    Math.max(0, Math.trunc(stats.bytes.total)),
    Math.max(0, Math.trunc(stats.bytes.pinned)),
    Math.max(0, Math.trunc(stats.counts.pinned)),
    Math.max(0, Math.trunc(stats.counts.pending)),
    Math.max(0, Math.trunc(stats.counts.undecided)),
    Math.max(0, Math.trunc(stats.counts.ignored)),
    Math.max(0, Math.trunc(stats.counts.pinnedForeign)),
    Math.max(0, Math.trunc(stats.notBackedUp)),
    Math.max(0, Math.trunc(stats.missingHere)),
    Math.max(0, Math.trunc(stats.peerCount)),
    opts.partial === true,
  ];
  const marks = values.map((_, i) => `$${i + 1}`).join(",");
  return exec(
    `INSERT INTO ${S}.unit_rollup (unit_id, ${PUBLISH_COLUMNS.join(", ")}, partial, computed_at)
     VALUES (${marks}, now())
     ON CONFLICT (unit_id) DO UPDATE SET
       ${PUBLISH_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(", ")},
       partial = EXCLUDED.partial, computed_at = now()`,
    values,
  );
}

// ── writer 2: the charter's category plane ──────────────────────────────────────────────────────────────

/**
 * THE CHARTER'S CATEGORY ROLLUP, EXACT — one SQL aggregate over `lfb.file`, no cap and no truncation.
 *
 * CLAUDE.md "Category rollup table" asks for a count-plus-action table at directory, repo and computer
 * level. Four rows:
 *
 *   1. Videos that can be compressed — `compress='could' AND media='video'`. The charter's PRIMARY target.
 *   2. Images that can be compressed — the same with `media='image'`. Secondary.
 *   3. Big files that aren't a good idea to check in — big, present, and git's own answer is "not ignored".
 *   4. Big files that ARE git-ignored, therefore untracked by us and unsynced — the nudge to start tracking.
 *
 * THREE THINGS ABOUT THIS QUERY THAT ARE EASY TO GET WRONG, each of which costs a wrong number:
 *
 * (a) ROW 3 USES THE CHECKED-IN THRESHOLD, NOT `is_big`. `lfb.file.is_big` is a GENERATED column at the
 *     100 MB payload threshold, but the shipped metric this row has to agree with counts at the CHECKED-IN
 *     threshold (`big_file.checked_in_threshold_bytes`, 50 MB by default) — units.service.ts
 *     `computeTaskMetrics` says so in its own comment, and it is right: a file admitted to the census by
 *     scan.mdx §4.1 rule 4 must be counted by the metric that offers to fix it. So the threshold is a
 *     PARAMETER here. The consequence is stated plainly in the slice report: 0011's `file_rollup_big_open`
 *     partial index is predicated on `is_big`, so it does NOT serve row 3 as the product currently defines
 *     it. That is a real gap, and inventing an index is not this slice's call.
 *
 * (b) ROW 3'S GIT-IGNORE TEST IS `IS FALSE`, NEVER `IS NOT TRUE`. `file_gitignore.ignored` is
 *     THREE-VALUED: true, false, and "git could not answer for this path" (git_ignore.mdx §5.4). An
 *     UNDETERMINED row must not be counted as a nudge — counting it nags the user about a file git has not
 *     been asked about yet (performance.mdx P-37 fix 4). A missing `file_gitignore` row is the same
 *     undetermined state, which is why the LEFT JOIN's NULL falls out of `IS FALSE` for free.
 *
 * (c) THE DECISION AXIS COMES FROM `file_decision.ipfs`, NOT FROM `lfb.file.decision`. Row 4 is "not
 *     tracked by us", i.e. we are not syncing it, and TWO things about that are easy to get wrong. First,
 *     `lfb.file.decision` is one of the columns area 4 deliberately leaves unwritten (decision-backfill.ts
 *     states why) — reading it would report every git-ignored big file as untracked, including the ones the
 *     user has already told us to sync. Second, `file_decision` does not carry the `Decision` enum at all:
 *     the maintained fold stores the two INDEPENDENT AXES the ledger actually records (`ipfs`, `gitignore`,
 *     plus `asked`), and "we are syncing this" is `ipfs = true`. A row that does not exist is a file nobody
 *     has decided, which is not synced — hence `COALESCE(d.ipfs, false)`.
 *
 * ROWS 1 AND 2 ARE ONLY AS GOOD AS WHOEVER LAST WROTE `lfb.file.compress`, AND TODAY THAT IS THE
 * NAME-ONLY FLOOR. MEASURED on charlie-kirk (2,741 census rows): this query counts 123 compressible
 * videos where the shipped One-Repo tile (`computeTaskMetrics`) counts 104. The difference is EXACTLY 19,
 * and 19 is exactly the number of that repo's video candidates carrying a compression record — because
 * slice 5 writes `compress` insert-only from `compressInfo(name)`, which cannot know a file has already
 * been compressed, and the artifact-aware upgrade to `done` belongs to area 7 (file.repo.ts states this
 * explicitly). Images agree exactly (7 vs 7) only because `.jpg`/`.webp` already read `done` from the name.
 * The predicate here deliberately MATCHES 0011's index predicate rather than compensating — a query that
 * diverges from the partial index stops being served by it, and the fix belongs in the column, not in
 * every reader of it. Until area 7 has run on a machine, row 1 over-reports by the compression-record count.
 *
 * `dirPosix` scopes the whole thing to a directory subtree, which is what `ViewOneDirectoryPage` asks for.
 * The predicate is `dir_posix = $d OR dir_posix LIKE $d || '/%'` — a LIKE-prefix, which is exactly why
 * 0011 declares those indexes `text_pattern_ops`: a default en_US.UTF-8 btree cannot serve one.
 */
export async function categoryCounts(
  unitId: number,
  opts: { thresholdBytes: number; dirPosix?: string | null },
): Promise<CategoryCounts> {
  const dir = opts.dirPosix ?? null;
  const rows = await q<Record<keyof CategoryCounts, string>>(
    `SELECT
       count(*) FILTER (WHERE f.compress = 'could' AND f.media = 'video'
                          AND NOT f.analysis_only AND NOT f.no_compress)::text AS "compressibleVideos",
       count(*) FILTER (WHERE f.compress = 'could' AND f.media = 'image'
                          AND NOT f.analysis_only AND NOT f.no_compress)::text AS "compressibleImages",
       count(*) FILTER (WHERE f.size_bytes >= $2 AND NOT f.analysis_only AND f.present_local
                          AND g.ignored IS FALSE)::text                        AS "bigNotIgnored",
       count(*) FILTER (WHERE f.size_bytes >= $2 AND NOT f.analysis_only
                          AND g.ignored IS TRUE
                          AND COALESCE(d.ipfs, false) = false)::text                    AS "bigIgnoredUntracked",
       count(*) FILTER (WHERE f.compress   = 'done'  AND NOT f.analysis_only)::text AS "alreadyCompressed",
       count(*) FILTER (WHERE f.transcribe = 'could')::text AS "transcribable",
       count(*) FILTER (WHERE f.transcribe = 'done')::text  AS "transcribed",
       count(*) FILTER (WHERE f.describe   = 'could')::text AS "describable",
       count(*) FILTER (WHERE f.describe   = 'done')::text  AS "described",
       count(*) FILTER (WHERE f.ocr        = 'could')::text AS "ocrable",
       count(*) FILTER (WHERE f.ocr        = 'done')::text  AS "ocred"
     FROM ${S}.file f
     LEFT JOIN ${S}.file_gitignore g ON g.unit_id = f.unit_id AND g.rel_posix = f.rel_posix
     LEFT JOIN ${S}.file_decision  d ON d.unit_id = f.unit_id AND d.rel_posix = f.rel_posix
     WHERE f.unit_id = $1
       AND f.is_candidate
       AND ($3::text IS NULL OR f.dir_posix = $3 OR f.dir_posix LIKE $3 || '/%')`,
    [unitId, Math.max(0, Math.trunc(opts.thresholdBytes)), dir],
  );
  return toCategoryCounts(rows[0] ?? null);
}

function toCategoryCounts(row: Partial<Record<keyof CategoryCounts, string>> | null): CategoryCounts {
  const n = (v: string | undefined): number => Number(v ?? 0);
  return {
    compressibleVideos: n(row?.compressibleVideos),
    compressibleImages: n(row?.compressibleImages),
    bigNotIgnored: n(row?.bigNotIgnored),
    bigIgnoredUntracked: n(row?.bigIgnoredUntracked),
    alreadyCompressed: n(row?.alreadyCompressed),
    transcribable: n(row?.transcribable),
    transcribed: n(row?.transcribed),
    describable: n(row?.describable),
    described: n(row?.described),
    ocrable: n(row?.ocrable),
    ocred: n(row?.ocred),
  };
}

/**
 * Recompute and store this unit's category plane. Does NOT touch `partial` — see the R5 note in the header:
 * clearing another writer's in-flight flag is exactly the mid-scan lie this module exists to prevent.
 */
export async function refreshRollupCategoryCounts(unitId: number, thresholdBytes: number): Promise<CategoryCounts> {
  const c = await categoryCounts(unitId, { thresholdBytes });
  const values = [
    unitId,
    c.bigNotIgnored,
    c.bigIgnoredUntracked,
    c.compressibleVideos,
    c.compressibleImages,
    c.alreadyCompressed,
    c.transcribable,
    c.transcribed,
    c.describable,
    c.described,
    c.ocrable,
    c.ocred,
  ];
  const marks = values.map((_, i) => `$${i + 1}`).join(",");
  await exec(
    // A row created HERE is created `partial`: the category plane is real but the decision plane is still
    // all zeroes, and a reader must not believe those zeroes. `publishUnitRollup` is what clears it.
    `INSERT INTO ${S}.unit_rollup (unit_id, ${CATEGORY_COLUMNS.join(", ")}, partial)
     VALUES (${marks}, true)
     ON CONFLICT (unit_id) DO UPDATE SET
       ${CATEGORY_COLUMNS.map((col) => `${col} = EXCLUDED.${col}`).join(", ")}`,
    values,
  );
  return c;
}

// ── the read side ───────────────────────────────────────────────────────────────────────────────────────

interface RollupRowRaw {
  unit_id: string;
  file_count: number;
  bytes_total: string;
  bytes_pinned: string;
  n_pinned: number;
  n_pending: number;
  n_undecided: number;
  n_ignored: number;
  n_pinned_foreign: number;
  n_not_backed_up: number;
  n_missing_here: number;
  peer_count: number;
  n_big_not_ignored: number;
  n_big_ignored_untracked: number;
  n_compressible_videos: number;
  n_compressible_images: number;
  n_already_compressed: number;
  n_transcribable: number;
  n_transcribed: number;
  n_describable: number;
  n_described: number;
  n_ocrable: number;
  n_ocred: number;
  partial: boolean;
  computed_at: Date;
}

function toRollupRow(r: RollupRowRaw): UnitRollupRow {
  return {
    unitId: Number(r.unit_id),
    fileCount: r.file_count,
    counts: {
      pinned: r.n_pinned,
      pending: r.n_pending,
      undecided: r.n_undecided,
      ignored: r.n_ignored,
      pinnedForeign: r.n_pinned_foreign,
    },
    peerCount: r.peer_count,
    notBackedUp: r.n_not_backed_up,
    missingHere: r.n_missing_here,
    // bigint columns arrive as strings from the pg driver — Number() them at the boundary, exactly once,
    // rather than letting a string escape into arithmetic that would silently concatenate.
    bytes: { total: Number(r.bytes_total), pinned: Number(r.bytes_pinned) },
    partial: r.partial,
    computedAt: r.computed_at,
    categories: {
      compressibleVideos: r.n_compressible_videos,
      compressibleImages: r.n_compressible_images,
      bigNotIgnored: r.n_big_not_ignored,
      bigIgnoredUntracked: r.n_big_ignored_untracked,
      alreadyCompressed: r.n_already_compressed,
      transcribable: r.n_transcribable,
      transcribed: r.n_transcribed,
      describable: r.n_describable,
      described: r.n_described,
      ocrable: r.n_ocrable,
      ocred: r.n_ocred,
    },
  };
}

/**
 * The rollup for a pin folder, ONLY IF IT IS SAFE TO BELIEVE — mechanism 2 of the freshness contract.
 *
 * Returns null for every ordinary state of this app rather than throwing or guessing: no unit row yet (a
 * repo registered since the backfill), no rollup row yet, a `partial` row, or a row whose `computed_at`
 * predates the last scan, the last pin pass or the last settings change. The caller composes from YAML and
 * publishes the answer, so the very next read is cheap — which is what makes the cutover pay for itself
 * without ever showing a stale number.
 *
 * The three timestamps are the ones the schema already maintains; they are not a substitute for the
 * writer-side invalidation in units.service.ts, they are the backstop under it.
 */
export async function readFreshRollupForPinFolder(folder: string): Promise<UnitRollupRow | null> {
  const row = await q1<RollupRowRaw>(
    `SELECT r.*, r.unit_id::text AS unit_id, r.bytes_total::text AS bytes_total,
            r.bytes_pinned::text AS bytes_pinned
       FROM ${S}.unit_rollup r
       JOIN ${S}.unit u        ON u.unit_id = r.unit_id
       LEFT JOIN ${S}.unit_scan    s ON s.unit_id = r.unit_id
       LEFT JOIN ${S}.unit_setting t ON t.unit_id = r.unit_id
      WHERE u.pin_folder = $1
        AND NOT r.partial
        AND r.computed_at >= COALESCE(s.last_scan_at, '-infinity'::timestamptz)
        AND r.computed_at >= COALESCE(s.last_pin_at,  '-infinity'::timestamptz)
        AND r.computed_at >= COALESCE(t.updated_at,   '-infinity'::timestamptz)`,
    [folder],
  );
  return row ? toRollupRow(row) : null;
}

/** The rollup row for a unit whatever its state — for tests, drift checks and `/api/health`. Never a gate. */
export async function readUnitRollup(unitId: number): Promise<UnitRollupRow | null> {
  const row = await q1<RollupRowRaw>(
    `SELECT r.*, r.unit_id::text AS unit_id, r.bytes_total::text AS bytes_total,
            r.bytes_pinned::text AS bytes_pinned
       FROM ${S}.unit_rollup r WHERE r.unit_id = $1`,
    [unitId],
  );
  return row ? toRollupRow(row) : null;
}

/** How many rollups are still provisional — the `unit_rollup_dirty` probe (P-38 honesty). */
export async function partialRollupCount(): Promise<number> {
  const row = await q1<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${S}.unit_rollup WHERE partial`,
  );
  return Number(row?.n ?? 0);
}

// ── the charter's table, rendered ───────────────────────────────────────────────────────────────────────

/** One row of the charter's category-rollup table: a count and the action the click performs. */
export interface CategoryRollupRow {
  key: "compressible_videos" | "compressible_images" | "big_not_ignored" | "big_ignored_untracked";
  /** User-facing English. The charter is absolute that the product name is spelled out in full; these are
   *  category labels rather than product references, so they carry no abbreviation at all. */
  label: string;
  count: number;
  action: "compress" | "ignore" | "track";
}

/**
 * The charter's four rows, in the charter's order, with the charter's actions.
 *
 * Note what the four actions are NOT: none of them acts. "We detect, surface, and offer. We do not act on
 * files on our own" (CLAUDE.md, Compression) and "Never add a `.gitignore` entry automatically for anyone"
 * (Big-file / git-ignore nudging). The `action` field names the button, not a thing this function did.
 */
export function categoryRollupRows(c: CategoryCounts): CategoryRollupRow[] {
  return [
    {
      key: "compressible_videos",
      label: "Videos that can be compressed",
      count: c.compressibleVideos,
      action: "compress",
    },
    {
      key: "compressible_images",
      label: "Images that can be compressed",
      count: c.compressibleImages,
      action: "compress",
    },
    {
      key: "big_not_ignored",
      label: "Big files that aren't a good idea to check in",
      count: c.bigNotIgnored,
      action: "ignore",
    },
    {
      key: "big_ignored_untracked",
      label: "Big files being git-ignored, and not tracked or synced",
      count: c.bigIgnoredUntracked,
      action: "track",
    },
  ];
}
