// THE UNIT DATA-ACCESS LAYER — `lfb.unit`, `unit_setting`, `unit_scan`, `unit_rollup`, plus the two
// dimensions a unit points at, `device` and `person` (database.mdx §3, migration 0003).
//
// EVERY function here is Postgres-only and every one of them is safe to call with no database: they go
// through `shared/persistence/db.ts`, whose `q`/`exec`/`copyRows` return empty answers when there is no
// pool. NONE of them is a fallback — deciding what to do when Postgres is absent belongs to the CALLER,
// which is the only layer that knows what the YAML answer would have been (R2 / database.mdx §7).
//
// THE NAMING LAW (0003's header) is why this file has so few concepts for so many columns: `unit_id` is the
// ONLY FK target in the schema, and the five spellings the rest of the code already uses — `abs_path`,
// `repo_key`, `repo_id`, `storage_sid`, `pin_folder` — are COLUMNS on that one row. So no caller has to
// change its vocabulary to use this, and nothing in here translates between them.
//
// HASHES ARE INSERTED AS LITERALS, NEVER RECOMPUTED IN SQL. `repo_key` / `repo_id` / `storage_sid` are the
// same sha1 at three lengths and `repo_uid` is a sha1 of a normalized remote; all four are computed by the
// existing TypeScript functions (`tracking-root.service.ts repoKeyFor`, `units.service.ts repoIdFromPath`,
// `storage.service.ts storageSid`, `repo-identity.ts repoUidFor`). Postgres has no way to reproduce them and
// must never be in a position to disagree with one.
import { copyRows, exec, q, q1 } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";

// ── device ──────────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceUpsert {
  /** The `pinned_by` spelling — the canonical one, after both spellings have been resolved. */
  label: string;
  /** The `history/<device>.txt` spelling (`repoFolderKey(label)`). */
  folderKey: string | null;
  ipfsPeerId: string | null;
  isSelf: boolean;
}

/**
 * Upsert the device registry.
 *
 * THE `is_self` DANCE, and why it is a transaction of two statements rather than one upsert:
 * `device_one_self` is a PARTIAL UNIQUE INDEX (0002) — at most one row may have `is_self`. Setting the new
 * self before clearing the old one violates it, and the violation would abort the whole backfill. So the
 * old self is stood down first, in the same transaction, and the window where neither row claims self never
 * becomes visible to a reader.
 *
 * `ipfs_peer_id` is COALESCEd rather than overwritten: the peer id comes from the SDL device registry, and a
 * label we only ever saw in a `pinned_by` list has none. Writing NULL over a known peer id would lose the
 * one field that makes the row useful.
 */
export async function upsertDevices(rows: DeviceUpsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const self = rows.find((r) => r.isSelf)?.label ?? null;
  if (self !== null) {
    await exec(`UPDATE ${S}.device SET is_self = false WHERE is_self AND label <> $1`, [self]);
  }
  return copyRows(
    `${S}.device`,
    ["label", "folder_key", "ipfs_peer_id", "is_self", "last_seen_at"],
    rows.map((r) => [r.label, r.folderKey, r.ipfsPeerId, r.isSelf, new Date()]),
    {
      onConflict:
        "ON CONFLICT (label) DO UPDATE SET " +
        "folder_key = COALESCE(EXCLUDED.folder_key, " +
        `${S}.device.folder_key), ` +
        `ipfs_peer_id = COALESCE(EXCLUDED.ipfs_peer_id, ${S}.device.ipfs_peer_id), ` +
        "is_self = EXCLUDED.is_self, last_seen_at = EXCLUDED.last_seen_at",
    },
  );
}

/** `label` → `device_id`, for every device we know. The join key every later area needs. */
export async function deviceIdsByLabel(): Promise<Map<string, number>> {
  const rows = await q<{ device_id: number; label: string }>(`SELECT device_id, label FROM ${S}.device`);
  return new Map(rows.map((r) => [r.label, r.device_id]));
}

export async function countDevices(): Promise<number> {
  const r = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.device`);
  return Number(r?.n ?? 0);
}

/** How many rows claim to be this computer. `device_one_self` makes >1 impossible; 0 means we never found us. */
export async function countSelfDevices(): Promise<number> {
  const r = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.device WHERE is_self`);
  return Number(r?.n ?? 0);
}

// ── person ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PersonUpsert {
  email: string | null;
  handle: string | null;
  /** `'not-lfbridge'` | `'policy:<email>'` | `'anonymous'` — an identity that is not a person's address. */
  sentinel: string | null;
}

/**
 * Upsert people, split by which of the three UNIQUE columns identifies each row.
 *
 * Two statements rather than one, because `ON CONFLICT` needs a NAMED constraint to do an UPDATE and these
 * rows arrive keyed differently: an allow-listed user is keyed by `email` (and may gain a handle later),
 * while `not-lfbridge` / `anonymous` are keyed by `sentinel` and never change. A single untargeted
 * `ON CONFLICT DO NOTHING` would work but would silently drop a handle that appeared after the email row
 * was first written — which is exactly what happens the first time a repo switches to handle attribution.
 */
export async function upsertPeople(rows: PersonUpsert[]): Promise<number> {
  const byEmail = rows.filter((r) => r.email);
  const bySentinel = rows.filter((r) => !r.email && r.sentinel);
  let n = 0;
  if (byEmail.length) {
    n += await copyRows(
      `${S}.person`,
      ["email", "handle"],
      byEmail.map((r) => [r.email, r.handle]),
      { onConflict: `ON CONFLICT (email) DO UPDATE SET handle = COALESCE(EXCLUDED.handle, ${S}.person.handle)` },
    );
  }
  if (bySentinel.length) {
    n += await copyRows(
      `${S}.person`,
      ["sentinel"],
      bySentinel.map((r) => [r.sentinel]),
      { onConflict: "ON CONFLICT (sentinel) DO NOTHING" },
    );
  }
  return n;
}

/** `email` (lower-cased by the citext column) → `person_id`. */
export async function personIdsByEmail(): Promise<Map<string, number>> {
  const rows = await q<{ person_id: number; email: string | null }>(
    `SELECT person_id, email::text AS email FROM ${S}.person WHERE email IS NOT NULL`,
  );
  return new Map(rows.filter((r) => r.email).map((r) => [r.email!.toLowerCase(), r.person_id]));
}

export async function countPeople(): Promise<number> {
  const r = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.person`);
  return Number(r?.n ?? 0);
}

// ── sync_repo (the SDL a unit mirrors into) ─────────────────────────────────────────────────────────────

export interface SyncRepoUpsert {
  absPath: string;
  storageSid: string;
  name: string;
}

export async function upsertSyncRepos(rows: SyncRepoUpsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.sync_repo`,
    ["abs_path", "storage_sid", "name"],
    rows.map((r) => [r.absPath, r.storageSid, r.name]),
    { onConflict: "ON CONFLICT (abs_path) DO UPDATE SET storage_sid = EXCLUDED.storage_sid, name = EXCLUDED.name" },
  );
}

export async function syncRepoIdsByPath(): Promise<Map<string, number>> {
  const rows = await q<{ sync_repo_id: number; abs_path: string }>(
    `SELECT sync_repo_id, abs_path FROM ${S}.sync_repo`,
  );
  return new Map(rows.map((r) => [r.abs_path, r.sync_repo_id]));
}

// ── unit ────────────────────────────────────────────────────────────────────────────────────────────────

export interface UnitUpsert {
  kind: "repo" | "personal" | "company" | "community" | "computer" | "storage";
  absPath: string;
  repoKey: string | null;
  repoId: string | null;
  storageSid: string;
  pinFolder: string | null;
  repoUid: string | null;
  slugLocal: string;
  slugShared: string | null;
  name: string;
  remote: string | null;
  syncRepoId: number | null;
  /** TRI-STATE. `null` = the default (mirror ON). See `mirrorOptoutFor` in unit-backfill.ts. */
  mirrorOptout: boolean | null;
  enlistedAt: Date | null;
  enlistedBy: number | null;
  enlistedOnDevice: number | null;
}

const UNIT_COLUMNS = [
  "kind",
  "abs_path",
  "repo_key",
  "repo_id",
  "storage_sid",
  "pin_folder",
  "repo_uid",
  "slug_local",
  "slug_shared",
  "name",
  "remote",
  "sync_repo_id",
  "mirror_optout",
  "enlisted_at",
  "enlisted_by",
  "enlisted_on_device",
];

function unitValues(u: UnitUpsert): unknown[] {
  return [
    u.kind,
    u.absPath,
    u.repoKey,
    u.repoId,
    u.storageSid,
    u.pinFolder,
    u.repoUid,
    u.slugLocal,
    u.slugShared,
    u.name,
    u.remote,
    u.syncRepoId,
    u.mirrorOptout,
    u.enlistedAt,
    u.enlistedBy,
    u.enlistedOnDevice,
  ];
}

/**
 * Upsert repo/computer units keyed on `abs_path`.
 *
 * `present` is DELIBERATELY NOT WRITTEN HERE. It projects `status.yaml`'s `repo_state`, and `status.yaml` is
 * area 3's source — a 5.17 MB file set whose largest single document is 820 KB. Parsing all 105 of them to
 * read one enum would make this area pay area 3's cost for one column, and would put two areas in the write
 * path of the same column (R5). Area 3 owns it; until then the schema default `true` stands.
 */
export async function upsertUnit(u: UnitUpsert): Promise<number | null> {
  const marks = UNIT_COLUMNS.map((_, i) => `$${i + 1}`).join(",");
  const set = UNIT_COLUMNS.filter((c) => c !== "abs_path")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  // RETURNING rather than a follow-up SELECT: a backfill scope is exactly one unit, and its `unit_id` is the
  // FK every row it then writes (unit_setting, unit_scan) needs. One statement instead of two, and no window
  // in which a concurrent writer could change which row we are about to attach settings to.
  const row = await q1<{ unit_id: string }>(
    `INSERT INTO ${S}.unit (${UNIT_COLUMNS.join(", ")}) VALUES (${marks})
     ON CONFLICT (abs_path) DO UPDATE SET ${set}
     RETURNING unit_id::text AS unit_id`,
    unitValues(u),
  );
  return row ? Number(row.unit_id) : null;
}

/**
 * Upsert a STORAGE unit (`pin/s/<id>`) onto whatever row already owns its directory.
 *
 * ONE DIRECTORY IS ONE `unit` ROW — `unit_abs_path_unique`. On this machine two of the 105 tracked repos ARE
 * the two registered storages (`personal_large_files_bridge` and `act3_large_files_bridge` are both git repos
 * the user tracks AND the roots the Storages tab lists), so those two directories have two identities and one
 * row. The row carries both: `kind` takes the STORAGE classification, because it is the more specific one and
 * it is what `GET /api/storages` filters on (`unit_kind_name`, 0003), while `repo_key` / `repo_id` /
 * `pin_folder` stay untouched so every repo-keyed lookup — including `folderForRepoId`, the read this slice
 * cuts over — still resolves.
 *
 * Hence the narrow DO UPDATE list: this writer owns `kind`, `storage_sid` and `name`, and nothing else. It is
 * the same discipline R5 imposes on the four writers of `lfb.file`, applied one table up.
 */
export async function upsertStorageUnit(u: UnitUpsert): Promise<number | null> {
  const marks = UNIT_COLUMNS.map((_, i) => `$${i + 1}`).join(",");
  const row = await q1<{ unit_id: string }>(
    `INSERT INTO ${S}.unit (${UNIT_COLUMNS.join(", ")}) VALUES (${marks})
     ON CONFLICT (abs_path) DO UPDATE SET
       kind = EXCLUDED.kind,
       storage_sid = EXCLUDED.storage_sid,
       name = CASE WHEN EXCLUDED.name = '' THEN ${S}.unit.name ELSE EXCLUDED.name END
     RETURNING unit_id::text AS unit_id`,
    unitValues(u),
  );
  return row ? Number(row.unit_id) : null;
}

export async function unitIdsByAbsPath(): Promise<Map<string, number>> {
  const rows = await q<{ unit_id: string; abs_path: string }>(`SELECT unit_id::text, abs_path FROM ${S}.unit`);
  return new Map(rows.map((r) => [r.abs_path, Number(r.unit_id)]));
}

export async function countUnits(kind?: string): Promise<number> {
  const r = kind
    ? await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.unit WHERE kind = $1`, [kind])
    : await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.unit`);
  return Number(r?.n ?? 0);
}

export interface UnitVerifyRow {
  unit_id: number;
  kind: string;
  abs_path: string;
  repo_key: string | null;
  repo_id: string | null;
  storage_sid: string;
  pin_folder: string | null;
  repo_uid: string | null;
  slug_shared: string | null;
  sync_repo_id: number | null;
  mirror_optout: boolean | null;
}

/** Every unit, for the verification pass that compares Postgres against the YAML it was composed from. */
export async function readUnitsForVerify(): Promise<UnitVerifyRow[]> {
  return q<UnitVerifyRow>(
    `SELECT unit_id::int AS unit_id, kind::text AS kind, abs_path, repo_key, repo_id, storage_sid,
            pin_folder, repo_uid, slug_shared, sync_repo_id, mirror_optout
       FROM ${S}.unit`,
  );
}

/**
 * THE READ THIS SLICE CUTS OVER (database.mdx §3, migration 0003's `unit_repo_id_uq`).
 *
 * `units.service.ts folderForRepoId` walks all 105 `pin/r/<folder>/config.yaml` on EVERY `/api/repos/:repoId*`
 * request — 16 call sites in `repos.router.ts` alone — parsing 413 KB of YAML to answer one question that a
 * unique index answers with one row. This is that index lookup.
 *
 * Returns null when there is no database, no matching row, or the row has no `pin_folder`. The caller falls
 * back to the linear scan in every one of those cases, and the scan stays the verification oracle (R3).
 */
export async function pinFolderForRepoId(repoId: string): Promise<string | null> {
  const row = await q1<{ pin_folder: string | null }>(
    `SELECT pin_folder FROM ${S}.unit WHERE repo_id = $1`,
    [repoId],
  );
  return row?.pin_folder ?? null;
}

// ── unit_setting ────────────────────────────────────────────────────────────────────────────────────────

export interface UnitSettingUpsert {
  unitId: number;
  pinned: boolean;
  bookmarked: boolean;
  bigFileOverrideOn: boolean;
  bigFileOverrideBytes: number | null;
  followGitignore: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
  pinLocally: boolean;
  fetchMissing: boolean;
  publishManifest: boolean;
  accessShared: boolean;
  accessParticipants: string[];
  transcriptionPlacement: string;
  descriptionPlacement: string;
  ocrPlacement: string;
  ownerOverrideKind: string | null;
  ownerOverrideCompany: string | null;
  recommendIpfsPin: boolean;
  recommendCompress: boolean;
  recommendTranscribe: boolean;
}

const SETTING_COLUMNS = [
  "unit_id",
  "pinned",
  "bookmarked",
  "big_file_override_on",
  "big_file_override_bytes",
  "follow_gitignore",
  "include_globs",
  "exclude_globs",
  "pin_locally",
  "fetch_missing",
  "publish_manifest",
  "access_shared",
  "access_participants",
  "transcription_placement",
  "description_placement",
  "ocr_placement",
  "owner_override_kind",
  "owner_override_company",
  "recommend_ipfs_pin",
  "recommend_compress",
  "recommend_transcribe",
  "updated_at",
];

export async function upsertUnitSettings(rows: UnitSettingUpsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.unit_setting`,
    SETTING_COLUMNS,
    rows.map((r) => [
      r.unitId,
      r.pinned,
      r.bookmarked,
      r.bigFileOverrideOn,
      r.bigFileOverrideBytes,
      r.followGitignore,
      r.includeGlobs,
      r.excludeGlobs,
      r.pinLocally,
      r.fetchMissing,
      r.publishManifest,
      r.accessShared,
      r.accessParticipants,
      r.transcriptionPlacement,
      r.descriptionPlacement,
      r.ocrPlacement,
      r.ownerOverrideKind,
      r.ownerOverrideCompany,
      r.recommendIpfsPin,
      r.recommendCompress,
      r.recommendTranscribe,
      new Date(),
    ]),
    {
      onConflict:
        "ON CONFLICT (unit_id) DO UPDATE SET " +
        SETTING_COLUMNS.filter((c) => c !== "unit_id")
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(", "),
    },
  );
}

// ── unit_scan ───────────────────────────────────────────────────────────────────────────────────────────

export interface UnitScanLastScan {
  unitId: number;
  lastScanAt: Date | null;
  lastScanDevice: number | null;
  lastScanHeadless: boolean;
}

/**
 * Write ONLY the three `last_scan` columns — the ones `repo_storage.yaml` owns.
 *
 * R5 IN MINIATURE. `unit_scan` has two writers: this area (from `repo_storage.yaml`'s `last_scan` block) and
 * area 3 (from `pin/r/<f>/status.yaml`'s scan scalars — `effective_threshold_bytes`, `big_file_count`,
 * `candidate_gen`, …). A whole-row upsert from either one would reset the other's columns to their defaults,
 * and `candidate_gen` resetting to 0 would make every candidate row in the repo read as stale. So each writer
 * names its own columns and nothing else.
 */
export async function upsertUnitScanLastScan(rows: UnitScanLastScan[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.unit_scan`,
    ["unit_id", "last_scan_at", "last_scan_device", "last_scan_headless"],
    rows.map((r) => [r.unitId, r.lastScanAt, r.lastScanDevice, r.lastScanHeadless]),
    {
      onConflict:
        "ON CONFLICT (unit_id) DO UPDATE SET last_scan_at = EXCLUDED.last_scan_at, " +
        "last_scan_device = EXCLUDED.last_scan_device, last_scan_headless = EXCLUDED.last_scan_headless",
    },
  );
}

// ── unit_rollup ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The maintained rollup (0003). Read by the Repos list and every metric tile, NEVER computed live: the live
 * equivalent is a GROUP BY over 30,758 candidate rows at 27.9 ms, and this table answers in under a
 * millisecond.
 *
 * Slice 4 deliberately does NOT seed rows here. A row of zeroes would not be "no data yet" to any reader —
 * it would be "this repo has no files", which is a lie the UI would render as a number. The areas that
 * actually count files (3, 5, 6) populate it, and `partial` is how a provisional row says so
 * (performance.mdx P-38).
 */
export interface UnitRollupPatch {
  unitId: number;
  columns: Record<string, number | boolean>;
  partial?: boolean;
}

export async function upsertUnitRollup(patch: UnitRollupPatch): Promise<number> {
  const cols = Object.keys(patch.columns);
  const names = ["unit_id", ...cols, "computed_at", "partial"];
  const values = [patch.unitId, ...cols.map((c) => patch.columns[c]), new Date(), patch.partial === true];
  return copyRows(`${S}.unit_rollup`, names, [values], {
    onConflict:
      "ON CONFLICT (unit_id) DO UPDATE SET " +
      [...cols, "computed_at", "partial"].map((c) => `${c} = EXCLUDED.${c}`).join(", "),
  });
}
