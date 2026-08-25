// THE PER-FILE DETAIL DATA-ACCESS LAYER — everything migration 0009 hangs off one `lfb.file` row:
// `file_event`, `file_artifact`, `file_gitignore`, `file_variant`, `file_fingerprint` (database.mdx §9,
// slice 9).
//
// It is the sibling of `unit.repo.ts` and follows exactly its rules, so read that file's header first. The
// two that bite hardest here:
//
//   R5 — ON CONFLICT DO UPDATE SET <ONLY YOUR OWN COLUMNS>. `lfb.file` has FOUR writers (candidates,
//        sidecars, artifacts, git-ignore) and a whole-row upsert from any one of them silently resets
//        another's work. Every helper below that touches `lfb.file` names the columns it owns and no
//        others, and each one says WHICH columns those are and why.
//   R2 — nothing here decides what to do without a database. `q`/`exec`/`copyRows` answer honestly with
//        nothing (`[]` / `0`), and the CALLER — which is the only layer that knows what the YAML answer
//        would have been — picks the fallback.
//
// WHY A NEW FILE RATHER THAN MORE OF `unit.repo.ts`: `unit.repo.ts` is the UNIT plane (one row per tracked
// directory, ~106 rows on this machine). This is the FILE plane, which is three orders of magnitude larger
// (29,138 sidecars, 12,921 artifact bodies, 56,946 events measured on disk 2026-08-24). They have different
// batching characteristics and different owners, and keeping them apart is what lets the unit helpers stay
// single-row-and-obvious while these are all batch-shaped.
import path from "node:path";
import { copyRows, exec, q, q1 } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";
import { healWindowsPath } from "../../shared/rel-path.js";
// The ONE implementation of "what can be derived from a file's name" (file.repo.ts `fileFacets`). Imported
// rather than re-spelled: `file.repo.ts` is SQL + these pure helpers and imports nothing from this file, so
// there is no cycle, and a second copy of the classification is exactly how two writers of the same
// pure-function columns start disagreeing.
import { fileFacets } from "./file.repo.js";

// ── derived-from-the-key columns ────────────────────────────────────────────────────────────────────────

/**
 * `base_name` / `dir_posix` / `file_ext` / `media` for a POSIX key.
 *
 * These four are PURE FUNCTIONS OF THE PRIMARY KEY, which is the only reason more than one writer of
 * `lfb.file` is allowed to set them without breaking R5: two writers computing them from the same
 * `rel_posix` cannot disagree, so there is no column for one to clobber. Every other column on that table
 * carries per-writer meaning and is therefore claimed by exactly one area.
 *
 * A THIN PROJECTION OF `fileFacets`, not a second derivation. It used to be its own copy of the same four
 * rules; the two agreed by inspection but nothing made them agree, and the integration pass that landed
 * areas 3, 6 and 7 together is precisely when "agree by inspection" stops being good enough.
 */
export function derivedFileColumns(relPosix: string): {
  baseName: string;
  dirPosix: string;
  fileExt: string;
  media: string | null;
} {
  const f = fileFacets(relPosix);
  return { baseName: f.baseName, dirPosix: f.dirPosix, fileExt: f.fileExt, media: f.media };
}

/**
 * THE NAME-ONLY TASK FLOOR, for the two writers on this side of `lfb.file` (R5).
 *
 * MEASURED DEFECT THIS CLOSES (2026-08-24, over the full 44,868-row corpus): `file.repo.ts` writes
 * `compress` / `transcribe` / `describe` / `ocr` on INSERT ONLY — correctly, because the verdict is a pure
 * function of `rel_posix` (half the primary key) while the ARTIFACT-AWARE upgrade belongs to area 7 and
 * must never be re-stated back down to `could` by a later scan. That reasoning holds only if EVERY writer
 * that can create the row seeds the floor. The two writers below could not, so 14,136 rows — 13,164 of them
 * real media — were created by a sidecar or an artifact claim with all four columns NULL. Migration 0005's
 * four tab indexes are PARTIAL (`WHERE compress = ANY('could','done')`), so a NULL is not merely a blank
 * cell: the row is absent from the index the Compress / Transcribe / AI-descriptions / OCR tabs are built
 * to read. Nothing reads them yet, which is the only reason this was invisible.
 *
 * INSERT ONLY here too, for area 7's sake, and safe from R5 by the same argument as `derivedFileColumns`:
 * the value comes from the same `fileFacets` the census uses, off the same key, so no two writers can put
 * different verdicts in these columns.
 */
function taskFloor(relPosix: string): [string, string, string, string] {
  const f = fileFacets(relPosix);
  return [f.compress, f.transcribe, f.describe, f.ocr];
}

/** The POSIX spelling of a relative key — what every `rel_posix` column in 0009 stores. */
export function relPosixKey(relPath: string): string {
  return healWindowsPath(relPath);
}

// ── the unit-id latch (how a SYNCHRONOUS writer finds its unit) ─────────────────────────────────────────

/**
 * `abs_path` → `unit_id`, remembered rather than queried.
 *
 * `file-sidecar.service.ts` is synchronous from top to bottom — `writeSidecar` and `appendFileEvent` are
 * called from inside scan walks that have no `await` to give — and a dual-write behind them still needs a
 * `unit_id`. So the mapping is a LATCH in the same shape `db.ts` uses for health: a synchronous read of a
 * remembered fact, with a background refresh kicked off when the fact is stale or missing.
 *
 * A MISS IS NOT AN ERROR. It means "this directory has no unit row yet" — a repo enlisted since the last
 * refresh, or a machine whose backfill has not run. The caller skips the Postgres mirror; the YAML sidecar
 * was already written by its designated serializer (R1), and the backfill will adopt the row on its next
 * pass. Nothing is lost by missing, and inventing a unit row from a hot path would put a second writer on
 * `lfb.unit` that area 2 owns.
 */
const UNIT_CACHE_TTL_MS = 60_000;
let unitIds = new Map<string, number>();
let unitIdsAt = 0;
let unitRefreshInFlight: Promise<void> | null = null;

/** Re-read the unit table. Never throws — a failure leaves the previous map in place and re-arms the TTL. */
export async function refreshUnitIdCache(): Promise<void> {
  if (unitRefreshInFlight) return unitRefreshInFlight;
  unitRefreshInFlight = (async () => {
    try {
      const rows = await q<{ unit_id: string; abs_path: string }>(
        `SELECT unit_id::text AS unit_id, abs_path FROM ${S}.unit WHERE abs_path <> ''`,
      );
      // Only replace the map when the query actually answered. `q()` returns [] when there is no pool at
      // all, and overwriting a good map with an empty one there would turn a transient outage into a
      // permanent stream of misses until the next enlistment.
      if (rows.length > 0) unitIds = new Map(rows.map((r) => [r.abs_path, Number(r.unit_id)]));
    } catch {
      /* leave the previous map; the timestamp below re-arms the next attempt */
    } finally {
      unitIdsAt = Date.now();
      unitRefreshInFlight = null;
    }
  })();
  return unitRefreshInFlight;
}

/** The remembered `unit_id` for a root, or null. Kicks a background refresh when stale; never awaits. */
export function unitIdForRootSync(absPath: string): number | null {
  const key = path.resolve(absPath);
  const hit = unitIds.get(key) ?? null;
  if (hit === null || Date.now() - unitIdsAt > UNIT_CACHE_TTL_MS) void refreshUnitIdCache();
  return hit;
}

/** The `unit_id` for a root, refreshing first when we have never looked. For async callers. */
export async function unitIdForRoot(absPath: string): Promise<number | null> {
  if (unitIdsAt === 0) await refreshUnitIdCache();
  return unitIds.get(path.resolve(absPath)) ?? null;
}

/** Tests only — the latch is module state. */
export function resetUnitIdCache(): void {
  unitIds = new Map();
  unitIdsAt = 0;
  unitRefreshInFlight = null;
}

// ── lfb.file: the two narrow claims this slice makes ────────────────────────────────────────────────────

export interface SidecarFileRow {
  unitId: number;
  /** BYTE-EXACT as the sidecar recorded it; `rel_posix` is generated from it by the column (0004). */
  relPath: string;
  /** Coerced to a non-negative number for the LIVE `size_bytes` column, which is NOT NULL. */
  sizeBytes: number;
  /**
   * VERBATIM as the document states it, `null` included — `FileSidecarSchema` declares
   * `size: z.number().nullable()`, and `renderSidecar` has to reproduce a `size: null` as `size: null`
   * rather than as the `0` its live twin would coerce it to (migration 0017).
   */
  sidecarSizeBytes: number | null;
  createdAt: Date | null;
  modifiedAt: Date | null;
  categories: string[];
  firstSeenAt: Date | null;
  firstSeenDevice: number | null;
}

/**
 * AREA 6's claim on `lfb.file` (R5).
 *
 * ON INSERT the sidecar seeds the whole row, because when no other writer has produced it the sidecar's
 * identity block is the only description of the file we have.
 *
 * ON CONFLICT it updates FOUR columns outright: `created_at`, `categories`, `first_seen_at`,
 * `first_seen_device`. Those are the ones NO other area writes — the scan census (area 3) has no creation
 * date and no first-seen provenance at all.
 *
 * `size_bytes` and `modified_at` ARE FILLED ONLY WHEN NOBODY HAS MEASURED THEM. Area 3 writes both from the
 * live scan and runs first, and a sidecar's copy is by construction as old as the last time the file was
 * touched THROUGH us — so overwriting would replace a fresh measurement with a stale one, and `size_bytes`
 * drives `is_big`, the compression rollups and every "large files only" tab. But leaving them alone
 * unconditionally was WRONG in a way that took a live probe to find (2026-08-24): `ensureFileRows` is a
 * presence-only claim that creates the row at the column DEFAULT of 0, and it wins the race with this upsert
 * whenever `appendFileEvent` fires first — after which the sidecar's real size could never land, and the row
 * read as a zero-byte file forever. So the `CASE` fills the default and only the default: a real value from
 * any writer is never touched.
 */
export async function upsertSidecarFiles(rows: SidecarFileRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.file`,
    [
      "unit_id",
      "rel_path",
      "base_name",
      "dir_posix",
      "file_ext",
      "size_bytes",
      "created_at",
      "modified_at",
      // SIDECAR-OWNED (migration 0017). The two columns above are the LIVE measurement and are shared with
      // the scan census, which is why they are only ever filled here and never overwritten. These two are
      // what the DOCUMENT says, they have exactly one writer — this function — and one reader,
      // `renderSidecar`. Without them the sidecar cannot be re-serialized byte-for-byte, which is what the
      // render equality gate measured as 15,868 differing documents (database.mdx §2.3).
      "sidecar_size_bytes",
      "sidecar_modified_at",
      "categories",
      "media",
      "first_seen_at",
      "first_seen_device",
      // INSERT-ONLY, and deliberately absent from the ON CONFLICT below — see {@link taskFloor}.
      "compress",
      "transcribe",
      "describe",
      "ocr",
    ],
    rows.map((r) => {
      const key = relPosixKey(r.relPath);
      const d = derivedFileColumns(key);
      return [
        r.unitId,
        r.relPath,
        d.baseName,
        d.dirPosix,
        d.fileExt,
        Math.max(0, Math.round(r.sizeBytes)), // the CHECK is >= 0; a negative size is a corrupt sidecar
        r.createdAt,
        r.modifiedAt,
        // VERBATIM, including null — this pair must reproduce what the document SAYS, so it is deliberately
        // not clamped, defaulted or rounded up to 0 the way the live `size_bytes` above is. A sidecar that
        // says `size: null` has to render as `size: null`.
        r.sidecarSizeBytes ?? null,
        r.modifiedAt,
        r.categories,
        d.media,
        r.firstSeenAt,
        r.firstSeenDevice,
        ...taskFloor(key),
      ];
    }),
    {
      onConflict:
        "ON CONFLICT (unit_id, rel_posix) DO UPDATE SET " +
        `created_at = COALESCE(EXCLUDED.created_at, ${S}.file.created_at), ` +
        "categories = EXCLUDED.categories, " +
        `first_seen_at = COALESCE(EXCLUDED.first_seen_at, ${S}.file.first_seen_at), ` +
        `first_seen_device = COALESCE(EXCLUDED.first_seen_device, ${S}.file.first_seen_device), ` +
        // Fill the DEFAULT, never a measurement — see the header. `0` is the column default and the only
        // value that means "no writer has said anything about this file's size".
        `size_bytes = CASE WHEN ${S}.file.size_bytes = 0 THEN EXCLUDED.size_bytes ELSE ${S}.file.size_bytes END, ` +
        `modified_at = COALESCE(${S}.file.modified_at, EXCLUDED.modified_at), ` +
        // THE SIDECAR-OWNED PAIR IS ASSIGNED OUTRIGHT, and that is the difference between them and the two
        // shared columns above. Those two are guarded because another writer's live measurement must win;
        // these two have exactly ONE writer — this function — so "preserve what is there" would mean
        // preserving a value only this function could have written, i.e. never updating a re-written
        // sidecar. Omitting them from this clause entirely was measured as WORSE than the original defect:
        // every row already existed, so the DO UPDATE fired, left both NULL, and the gate went from 15,868
        // to 28,451 differing documents (2026-08-24). No COALESCE: NULL is a legitimate document value.
        "sidecar_size_bytes = EXCLUDED.sidecar_size_bytes, " +
        "sidecar_modified_at = EXCLUDED.sidecar_modified_at",
    },
  );
}

/**
 * PRESENCE ONLY — "there is a file at this key", claiming no column at all.
 *
 * `file_event`, `file_artifact`, `file_gitignore` and `file_variant` all carry
 * `FOREIGN KEY (unit_id, rel_posix) REFERENCES lfb.file` (0009), so a child row cannot be written for a path
 * the file plane has never heard of — and an FK violation aborts the whole statement, not just the offending
 * row. Areas 7 and the git-ignore writer therefore call this first.
 *
 * `DO NOTHING`, never `DO UPDATE`: these callers know a PATH and nothing else. An artifact body tells us
 * a transcript exists; it does not tell us the media's size, and writing a zero there would read as an empty
 * file to `is_big` and to every rollup.
 */
export async function ensureFileRows(rows: Array<{ unitId: number; relPath: string }>): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.file`,
    // The four verdicts ride along on the INSERT for the reason {@link taskFloor} gives: this function is
    // often the FIRST thing to create the row (an artifact claim arrives before any scan has run), and a row
    // created here with NULL verdicts is a row the four partial tab indexes in 0005 cannot see. It is still
    // "presence only" in the sense that mattered — it claims no MEASUREMENT, only what the name already says.
    ["unit_id", "rel_path", "base_name", "dir_posix", "file_ext", "media", "compress", "transcribe", "describe", "ocr"],
    rows.map((r) => {
      const key = relPosixKey(r.relPath);
      const d = derivedFileColumns(key);
      return [r.unitId, r.relPath, d.baseName, d.dirPosix, d.fileExt, d.media, ...taskFloor(key)];
    }),
    { onConflict: "ON CONFLICT (unit_id, rel_posix) DO NOTHING" },
  );
}

// ── file_event ──────────────────────────────────────────────────────────────────────────────────────────

export interface FileEventRow {
  unitId: number;
  relPosix: string;
  at: Date;
  kind: string;
  deviceId: number | null;
  actorId: number | null;
  /** The event MINUS the four normalized columns — `FileEventSchema` is `.passthrough()`, so this varies. */
  detail: Record<string, unknown>;
  origin?: "local" | "wire";
}

/**
 * Insert events. THE UNIQUE IS THE MERGE — `DO NOTHING`, never `DO UPDATE`.
 *
 * `file_event_union` is `UNIQUE NULLS NOT DISTINCT (unit_id, rel_posix, at, kind, device_id, actor_id,
 * detail)` and the NULLS clause is load-bearing: 18 of the 29,138 sidecars on this machine carry an event
 * with `by: null` (measured 2026-08-24), and under the SQL default of NULLS DISTINCT every one of them would
 * re-insert on every single pass — the sidecar mirror runs on every reconcile, so "idempotent" would be
 * false for exactly those files, forever.
 *
 * The events array is APPEND-ONLY by the sidecar's own rule (repo_tracking_scheme.mdx §3.2), so there is
 * never anything to update: an event either is already recorded or is new.
 */
export async function insertFileEvents(rows: FileEventRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.file_event`,
    ["unit_id", "rel_posix", "at", "kind", "device_id", "actor_id", "detail", "origin"],
    rows.map((r) => [
      r.unitId,
      r.relPosix,
      r.at,
      r.kind,
      r.deviceId,
      r.actorId,
      JSON.stringify(r.detail ?? {}),
      r.origin ?? "local",
    ]),
    { onConflict: "ON CONFLICT ON CONSTRAINT file_event_union DO NOTHING" },
  );
}

export async function countFileEvents(unitId?: number): Promise<number> {
  const r = unitId
    ? await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.file_event WHERE unit_id = $1`, [unitId])
    : await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.file_event`);
  return Number(r?.n ?? 0);
}

// ── file_variant / file_fingerprint ─────────────────────────────────────────────────────────────────────

export interface FileVariantRow {
  unitId: number;
  relPosix: string;
  variant: "uncompressed" | "compressed";
  algo?: string;
  hash: string;
  sizeBytes: number | null;
}

/**
 * The charter's two-hashes-per-compressible-file rule as rows.
 *
 * MEASURED YIELD ON THIS MACHINE: 2 of 29,138 sidecars carry a non-null `hash` (2026-08-24). That is the
 * honest state of the product, not a bug in this writer — nothing populates `file.hash` on the sidecar path
 * today, and it is the same emptiness that makes the charter's perceptual-match feature impossible right now.
 */
export async function upsertFileVariants(rows: FileVariantRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.file_variant`,
    ["unit_id", "rel_posix", "variant", "algo", "hash", "size_bytes", "observed_at"],
    rows.map((r) => [r.unitId, r.relPosix, r.variant, r.algo ?? "sha256", r.hash, r.sizeBytes, new Date()]),
    {
      onConflict:
        "ON CONFLICT (unit_id, rel_posix, variant) DO UPDATE SET " +
        "algo = EXCLUDED.algo, hash = EXCLUDED.hash, size_bytes = EXCLUDED.size_bytes, " +
        "observed_at = EXCLUDED.observed_at",
    },
  );
}

export interface FileFingerprintRow {
  contentHash: string;
  algo: string;
  /** 64 hex characters = 256 bits. The column is `bit(256)`; anything else is refused before the insert. */
  hex: string;
  quality: number | null;
}

/** 64 hex chars → the 256-bit string literal `bit(256)` accepts. Null when the value cannot be one. */
export function fingerprintBits(hex: string): string | null {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) return null;
  let bits = "";
  for (const ch of clean) bits += parseInt(ch, 16).toString(2).padStart(4, "0");
  return bits;
}

/**
 * The perceptual index, keyed by CONTENT hash rather than by path so it survives a rename (0009).
 *
 * LOCAL-ONLY BY CHARTER: whatever fills this must run entirely on this computer and must never phone home.
 * This writer only ever moves a value that is already sitting in a sidecar on this disk.
 */
export async function upsertFileFingerprints(rows: FileFingerprintRow[]): Promise<number> {
  const usable = rows.flatMap((r) => {
    const bits = fingerprintBits(r.hex);
    return bits ? [[r.contentHash, r.algo, bits, r.quality, new Date()]] : [];
  });
  if (usable.length === 0) return 0;
  return copyRows(`${S}.file_fingerprint`, ["content_hash", "algo", "bits", "quality", "computed_at"], usable, {
    onConflict:
      "ON CONFLICT (content_hash) DO UPDATE SET algo = EXCLUDED.algo, bits = EXCLUDED.bits, " +
      "quality = EXCLUDED.quality, computed_at = EXCLUDED.computed_at",
  });
}

// ── file_artifact ───────────────────────────────────────────────────────────────────────────────────────

export interface FileArtifactRow {
  unitId: number;
  relPosix: string;
  kind: "transcript" | "description" | "ocr" | "visuals_by_time" | "compression";
  bodyPath: string;
  placement: "tracking_base" | "beside" | "legacy_lfbridge" | "sync_repo" | "local_state";
  bodySize: number;
  bodyMtimeMs: number;
  /** MANDATORY for kind='compression' — see the CHECK on the table and the note below. */
  mediaSizeAtRecord: number | null;
  engine: string | null;
  provider: string | null;
  language: string | null;
  generatedAt: Date | null;
}

const ARTIFACT_COLUMNS = [
  "unit_id",
  "rel_posix",
  "kind",
  "body_path",
  "placement",
  "body_size",
  "body_mtime_ms",
  "media_size_at_record",
  "engine",
  "provider",
  "language",
  "generated_at",
  "indexed_at",
];

/**
 * THE ARTIFACT INDEX. One row per (file, kind) — the PK is exactly the point question `analysisOutputs()`
 * answers with ~12 `statSync` probes per row today (tracking.service.ts).
 *
 * `media_size_at_record` is NOT NULL-checked for `kind='compression'` by the table itself, and the reason is
 * worth restating where the writer lives: `compressionRecordFresh()` compares the record's compressed size
 * against a LIVE `stat` of the media. The compression verdict is therefore NOT a static fact — replacing the
 * media with new bytes of a different size invalidates it — and a row that claims "compressed: done" without
 * carrying the size to re-check is a FALSE DONE that silently never re-offers a re-edited file to the user.
 */
export async function upsertFileArtifacts(rows: FileArtifactRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.file_artifact`,
    ARTIFACT_COLUMNS,
    rows.map((r) => [
      r.unitId,
      r.relPosix,
      r.kind,
      r.bodyPath,
      r.placement,
      Math.max(0, Math.round(r.bodySize)),
      Math.round(r.bodyMtimeMs),
      r.mediaSizeAtRecord,
      r.engine,
      r.provider,
      r.language,
      r.generatedAt,
      new Date(),
    ]),
    {
      onConflict:
        "ON CONFLICT (unit_id, rel_posix, kind) DO UPDATE SET " +
        ARTIFACT_COLUMNS.filter((c) => c !== "unit_id" && c !== "rel_posix" && c !== "kind")
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(", "),
    },
  );
}

export interface ArtifactIndexRow {
  rel_posix: string;
  kind: string;
  body_path: string;
  body_size: string;
  body_mtime_ms: string;
  media_size_at_record: string | null;
}

/**
 * THE BATCHED READ (`analysisOutputs`, one page at a time).
 *
 * `WHERE unit_id = $1 AND rel_posix = ANY($2)` is the form the PK serves — the whole page in ONE round trip
 * instead of a query per row. Batching is not an optimisation here, it is the entire point: a per-row query
 * would replace a ~2 µs cached `statSync` with a ~150-300 µs socket round trip and make the page SLOWER,
 * which is the same trap the foreign-pin slice had to avoid in the scanner.
 */
export async function readArtifactsForFiles(unitId: number, relPosix: string[]): Promise<ArtifactIndexRow[]> {
  if (relPosix.length === 0) return [];
  return q<ArtifactIndexRow>(
    `SELECT rel_posix, kind::text AS kind, body_path, body_size::text AS body_size,
            body_mtime_ms::text AS body_mtime_ms, media_size_at_record::text AS media_size_at_record
       FROM ${S}.file_artifact
      WHERE unit_id = $1 AND rel_posix = ANY($2)`,
    [unitId, relPosix],
  );
}

export async function countFileArtifacts(kind?: string): Promise<number> {
  const r = kind
    ? await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.file_artifact WHERE kind = $1`, [kind])
    : await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.file_artifact`);
  return Number(r?.n ?? 0);
}

// ── file_gitignore ──────────────────────────────────────────────────────────────────────────────────────

export interface FileGitignoreRow {
  unitId: number;
  relPosix: string;
  ignored: boolean;
  locked: boolean;
  ruleSource: string | null;
  ruleLine: number | null;
  rulePattern: string | null;
}

/**
 * The git-ignore axis, cached WITH its own freshness stamp.
 *
 * THREE-VALUED, and the third value is the ABSENCE of a row: no row means UNDETERMINED, which is NOT "not
 * ignored" (performance.mdx P-37 fix 4, and `gitIgnoreAxis` in units.service.ts returns `{}` for exactly
 * that case). So a path git could not answer for is never written here — writing `ignored = false` for it
 * would mis-file the file into the big-files-to-ignore nudge on nothing but a spawn failure.
 *
 * `checked_at` is a first-class column rather than an implicit "we wrote it, so it is true" because the
 * source is a SUBPROCESS, not a file: `git check-ignore` is measured at 2.3 s for 1,875 paths, and that is
 * git's own evaluation — the cost survives the migration in full and has to be schedulable (database.mdx
 * §8.3), which needs a staleness key.
 */
export async function upsertFileGitignore(rows: FileGitignoreRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.file_gitignore`,
    ["unit_id", "rel_posix", "ignored", "locked", "rule_source", "rule_line", "rule_pattern", "checked_at"],
    rows.map((r) => [
      r.unitId,
      r.relPosix,
      r.ignored,
      r.locked,
      r.ruleSource,
      // The CHECK is `NULL OR > 0`; git's verbose output is 1-based, but a 0 from a malformed parse must
      // not abort the batch it is in.
      r.ruleLine && r.ruleLine > 0 ? r.ruleLine : null,
      r.rulePattern,
      new Date(),
    ]),
    {
      onConflict:
        "ON CONFLICT (unit_id, rel_posix) DO UPDATE SET ignored = EXCLUDED.ignored, " +
        "locked = EXCLUDED.locked, rule_source = EXCLUDED.rule_source, rule_line = EXCLUDED.rule_line, " +
        "rule_pattern = EXCLUDED.rule_pattern, checked_at = EXCLUDED.checked_at",
    },
  );
}

// ── the two dimensions this plane joins to ──────────────────────────────────────────────────────────────

/**
 * Make sure every `on_device` label a sidecar mentions has a `device` row, WITHOUT touching `is_self`.
 *
 * This is deliberately NOT `unit.repo.ts upsertDevices`. That one sets `is_self = EXCLUDED.is_self`, which is
 * right for area 1 (it knows which computer this is) and catastrophic here: the sidecar tree names nine
 * distinct devices and knows nothing about which of them is us, so passing `false` for all nine would stand
 * down the self row that area 1 established and break `pinned_here` — the one bit that separates "pinned on
 * THIS computer" from "a peer claims it" (ipfs.mdx §1.1).
 *
 * Measured: all nine `on_device` spellings in the sidecar tree are already rows area 1 produced, so this
 * normally inserts nothing. It exists for the label that appears between two backfill passes.
 */
export async function ensureDeviceLabels(labels: string[]): Promise<number> {
  const clean = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
  if (clean.length === 0) return 0;
  return copyRows(
    `${S}.device`,
    ["label", "last_seen_at"],
    clean.map((l) => [l, new Date()]),
    { onConflict: "ON CONFLICT (label) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at" },
  );
}

export async function deviceIdsByLabel(): Promise<Map<string, number>> {
  const rows = await q<{ device_id: number; label: string }>(`SELECT device_id, label FROM ${S}.device`);
  return new Map(rows.map((r) => [r.label, r.device_id]));
}

/**
 * True when a sidecar's `by:` token is an EMAIL and not a sentinel.
 *
 * Measured on this machine's 56,946 events: `not-lfbridge` (31,806), `pull-retry` (12,336) and
 * `cli@localhost` (64) sit alongside eight real allow-listed addresses. `person` has three UNIQUE identity
 * columns and `not-lfbridge` / `pull-retry` belong in `sentinel`, not in `email` — putting a non-address in
 * the citext email column would make it collide with a future real user of the same string and would break
 * the "who decided this" attribution the decision ledger reads from the same table.
 *
 * `cli@localhost` IS shaped like an address and is stored as one; it is what the CLI stamps, and treating it
 * as a person is exactly right — it is an actor with an address, just not a Google one.
 */
export function isEmailToken(token: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(token.trim());
}

/** Make sure every `by:` token has a `person` row, split by which UNIQUE column identifies it. */
export async function ensurePeopleForTokens(tokens: string[]): Promise<number> {
  const clean = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))];
  const emails = clean.filter(isEmailToken);
  const sentinels = clean.filter((t) => !isEmailToken(t));
  let n = 0;
  if (emails.length) {
    n += await copyRows(`${S}.person`, ["email"], emails.map((e) => [e]), {
      onConflict: "ON CONFLICT (email) DO NOTHING",
    });
  }
  if (sentinels.length) {
    n += await copyRows(`${S}.person`, ["sentinel"], sentinels.map((s) => [s]), {
      onConflict: "ON CONFLICT (sentinel) DO NOTHING",
    });
  }
  return n;
}

/**
 * Every `by:` token → `person_id`, over BOTH identity columns in one map.
 *
 * The sidecar's `by:` field is one string that may be either an address or a sentinel, so the join it needs
 * is one lookup, not two. Emails are lower-cased on the way in because the column is `citext` and the caller
 * holds a raw string.
 */
export async function personIdsByToken(): Promise<Map<string, number>> {
  const rows = await q<{ person_id: number; email: string | null; sentinel: string | null }>(
    `SELECT person_id, email::text AS email, sentinel FROM ${S}.person`,
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.email) out.set(r.email.toLowerCase(), r.person_id);
    if (r.sentinel) out.set(r.sentinel, r.person_id);
  }
  return out;
}

/** Drop every 0009 row for one unit. Used by the specs; the backfill itself is idempotent and never needs it. */
export async function deleteFileDetailForUnit(unitId: number): Promise<number> {
  return exec(`DELETE FROM ${S}.file WHERE unit_id = $1`, [unitId]);
}
