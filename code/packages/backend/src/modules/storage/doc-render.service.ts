// THE SYNC FENCE — the ONE module allowed to hold both a Postgres handle and a designated serializer.
//
// database.mdx §2.2 states the fence as a rule about causality, not about layering:
//
//     A byte that will be read by another of the user's computers must be produced by a DESIGNATED
//     SERIALIZER writing a file under a Syncable Data Location, and Postgres must appear nowhere in that
//     write's causal chain EXCEPT as the source of the values the serializer is handed.
//
// A rule phrased that way needs a place where the two halves legally meet, or every caller invents its own
// meeting point and the rule becomes folklore. This file is that place, and it is the only one: the import
// guard (`doc-render.import-guard.spec.ts`) fails the build if any other production module imports both
// `shared/persistence/*` and one of the six serializers below.
//
// ── THE SIX SERIALIZERS ARE FIXED, AND THIS WORK ADDS NONE ──────────────────────────────────────────────
//
//   decisions.yaml          serializeLedger              modules/storage/ledger-merge.ts
//   manifest.yaml           serializeManifest            modules/storage/manifest-merge.ts
//   repo_storage.yaml       YAML.stringify {sortMapEntries:true}   modules/storage/repo-storage.service.ts
//   files/<rel>.yaml        YAML.stringify {sortMapEntries:true}   modules/storage/file-sidecar.service.ts
//   history/<device>.txt    appendHistory                modules/storage/history-log.service.ts
//   decisions_policy.yaml   writeDecisionPolicy          modules/storage/decisions.service.ts
//
// Every renderer below reconstructs the serializer's ARGUMENT — a `Manifest`, a `DecisionEvent[]`, a
// `FileSidecar` — from rows, and then calls the serializer. Nothing here emits YAML that a serializer did
// not emit. That is what keeps the wire-format rules (the `pinned_by` self-strip, `serializeLedger`'s
// compaction, the plain-`<` CID tie-break, `MACHINE_LOCAL_REPO_STORAGE`'s scrub) unrepeated in SQL: they
// live in exactly one implementation and this file feeds it.
//
// ── THE RENDER EQUALITY GATE (database.mdx §2.3) ────────────────────────────────────────────────────────
//
// For every (unit, doc): render from Postgres through the designated serializer and compare sha256 against
// the bytes on disk. ZERO DIFFS, OR THE CUTOVER DOES NOT HAPPEN — `renderWritesArmed()` below is the
// cutover, and it is OFF unless `LFB_DOC_RENDER_WRITE=1` is deliberately set.
//
// It is the right test because `tracking-sync.service.ts` records that 58 of the last 60 device commits were
// a lone `updated_at` line. A renderer that is ONE BYTE off turns every mirror pass into a commit and two
// computers into a re-render loop — the same shape as the `last_scan` ping-pong the `counts:` scrub exists
// to stop, except originating inside the database where no `git diff` would explain it.
//
// Run it: `just db-render-gate` (or `pnpm -C code/packages/backend db-render-gate`).
//
// ── WHAT `doc_render` MEANS, EXACTLY (migration 0012) ───────────────────────────────────────────────────
//
//   rendered_sha256 — what we last WROTE to this path. Written by whichever designated serializer produced
//                     it; this module records the hash whether the bytes came from Postgres (armed) or from
//                     the ordinary write path (disarmed, which is today). Either way the statement is true,
//                     which is what lets the same column serve both.
//   ingested_sha256 — what we last PARSED IN from the SDL copy, recorded by the reconcile leg.
//
// `doc_render_dirty` (`WHERE rendered_sha256 IS DISTINCT FROM ingested_sha256`) is therefore the pre-mirror
// work list in both postures: "documents where what we hold and what last arrived are not the same bytes".
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  DecisionPolicyDocSchema,
  FileSidecarSchema,
  RepoStorageDocSchema,
  type DecisionEvent,
  type DecisionPolicyDoc,
  type FileEvent,
  type FileSidecar,
  type Manifest,
  type ManifestFile,
  type PerceptualFingerprint,
  type RepoStorageDoc,
} from "@lfb/shared";
import { dbEnabled, exec, q, q1, tryDb } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";
import { parseLedgerBestEffort, serializeLedger } from "./ledger-merge.js";
import { serializeManifest } from "./manifest-merge.js";
import { repoStateDir } from "./tracking-root.service.js";
import { healWindowsPath, joinRel } from "../../shared/rel-path.js";
import { log } from "../../shared/logging.js";

// ── the document taxonomy ───────────────────────────────────────────────────────────────────────────────

/** `lfb.doc_kind` (migration 0002), verbatim. */
export type DocKind =
  | "manifest"
  | "decisions"
  | "decisions_policy"
  | "repo_storage"
  | "sidecar"
  | "history"
  | "compression"
  | "files_index";

/** One document that crosses the boundary: a `doc_render` row and the file it describes. */
export interface RenderTarget {
  unitId: number;
  doc: DocKind;
  /** `''` for a whole-unit document; `rel_posix` for a sidecar; the device folder key for a history log. */
  docKey: string;
  /** Absolute path of the LOCAL Category-B copy — the one the mirror copies FROM (database.mdx §6.2). */
  file: string;
}

/**
 * A render either produced bytes or explained why it could not.
 *
 * `unsourced` is NOT a failure and NOT a diff. It means "no table in the schema carries this document's
 * values yet" — which for `history` is structural and for `compression` / `decisions_policy` simply means
 * their backfill area has not shipped. Counting those as diffs would make the gate's headline number a
 * measure of how many slices remain, which is exactly the kind of dishonest metric §2.3 exists to avoid.
 */
export type RenderOutcome =
  | { status: "rendered"; text: string; sha256: string }
  | { status: "unsourced"; reason: string };

const sha256Of = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The in-memory key for a `doc_render` row: the table's PK minus the unit, spelled ONCE.
 *
 * The separator is NUL, written as its ESCAPE — the same choice `ledger-merge.ts eventIdentity` makes, and
 * for the same two reasons. It cannot appear in a `doc_key` (which is a `rel_posix` or a device label), so
 * two different rows can never collide on it; and writing the raw byte into a source file makes git treat
 * the whole module as BINARY — no diff, no review, no blame. This function exists at all because the
 * writer and the reader of that key sat six hundred lines apart and disagreed by one character, which made
 * `syncFenceBeforeMirror` re-render every document on every pass while reporting `unchanged: 0`.
 */
const docRenderKey = (doc: string, docKey: string): string => `${doc}\u0000${docKey}`;

/**
 * THE ONE SPELLING OF AN ISO TIMESTAMP ON THE WAY OUT, in SQL rather than in the driver.
 *
 * Borrowed verbatim from `decision.repo.ts` (`decidedAtIso`) and for the same reason, which matters far
 * more here: every one of these documents TRAVELS. `timestamptz` has no spelling of its own, so letting the
 * pg driver hand back a `Date` would make the rendered bytes depend on the driver's parser and on this
 * process's `TZ` — i.e. two of the user's computers would render the same row differently and each would
 * "fix" the other's file forever. Pinned to what `Date.prototype.toISOString()` produces: UTC, three
 * fractional digits, `Z`.
 */
const isoCol = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ── the cutover latch ───────────────────────────────────────────────────────────────────────────────────

/**
 * IS THE POSTGRES-FED WRITE ARMED? Default NO, and deliberately an env var rather than a setting.
 *
 * database.mdx §2.3: "ZERO DIFFS, OR THE CUTOVER DOES NOT HAPPEN." The gate is not yet zero on this machine
 * (see the slice report), so nothing may write a rendered document into a Syncable Data Location's source.
 * A user-facing setting would make arming a click; an env var makes it a deliberate act by whoever ran the
 * gate and read its output, which is the correct bar for a switch whose failure mode is corrupted bytes
 * travelling to the user's other computers over git.
 */
export function renderWritesArmed(): boolean {
  return process.env.LFB_DOC_RENDER_WRITE === "1";
}

// ── unit resolution ─────────────────────────────────────────────────────────────────────────────────────

export interface UnitRef {
  unitId: number;
  absPath: string;
  /** The Local-Storage Category-B directory, `~/T/_large_files_bridge/repos/<slug>-<repoKey>/`. */
  stateDir: string;
}

/** Every repo unit that has a Local-Storage tracking directory — the gate's scope. */
export async function repoUnits(): Promise<UnitRef[]> {
  const rows = await q<{ unit_id: string; abs_path: string }>(
    `SELECT unit_id::text AS unit_id, abs_path FROM ${S}.unit WHERE kind = 'repo' ORDER BY abs_path`,
  );
  return rows.map((r) => ({
    unitId: Number(r.unit_id),
    absPath: r.abs_path,
    stateDir: repoStateDir(r.abs_path),
  }));
}

/** `abs_path` → `unit_id`, or null when this root is not (yet) a unit row. */
export async function unitIdForAbsPath(absPath: string): Promise<number | null> {
  const row = await q1<{ unit_id: string }>(`SELECT unit_id::text AS unit_id FROM ${S}.unit WHERE abs_path = $1`, [
    path.resolve(absPath),
  ]);
  return row ? Number(row.unit_id) : null;
}

// ── renderer: decisions.yaml → serializeLedger ──────────────────────────────────────────────────────────

interface EventRow {
  sid: string;
  path: string;
  fingerprint: string | null;
  asked: boolean;
  ipfs: boolean;
  gitignore: boolean;
  decided_by: string | null;
  decided_at: string;
}

/**
 * Rebuild the ledger's `DecisionEvent[]` and hand it to `serializeLedger`.
 *
 * NO ORDER BY, and that is not an omission. `serializeLedger` runs `compactLedger` and then
 * `unionLedgerEvents`, whose sort is the document's total order (`decided_at`, `sid`, `path`, `decided_by`)
 * — so the rows may arrive in any order and the bytes are identical. Adding an ORDER BY here would be a
 * second, silently divergent, statement of that order.
 *
 * `rel_path` and NOT `rel_posix`: `ledger-merge.ts` keys event identity on the RAW path, so rendering the
 * healed spelling would be a different event and the union would grow instead of converging.
 */
export async function renderDecisions(unitId: number): Promise<RenderOutcome> {
  const rows = await q<EventRow>(
    `SELECT sid, rel_path AS path, fingerprint, asked, ipfs, gitignore, decided_by,
            ${isoCol("decided_at")} AS decided_at
       FROM ${S}.decision_event WHERE unit_id = $1`,
    [unitId],
  );
  const events: DecisionEvent[] = rows.map((r) => ({
    sid: r.sid,
    path: r.path,
    fingerprint: r.fingerprint,
    asked: r.asked,
    ipfs: r.ipfs,
    gitignore: r.gitignore,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
  }));
  const text = serializeLedger(events);
  return { status: "rendered", text, sha256: sha256Of(text) };
}

// ── renderer: manifest.yaml → serializeManifest ─────────────────────────────────────────────────────────

export type ManifestStage = "unit" | "tracking";

interface ManifestRow {
  rel_path: string;
  cid_text: string | null;
  size_bytes: string;
  sha256: string | null;
  modified_at: string | null;
  pinned_by: string[];
}

/**
 * Rebuild a `Manifest` for one STAGE and hand it to `serializeManifest`.
 *
 * `stage` IS A PARAMETER, never a default — `pin/r/<folder>/manifest.yaml` (unit) and
 * `repos/<key>/manifest.yaml` (tracking) are two stages of a pipeline, and the tracking write is gated
 * behind `publish_manifest` (pin.service.ts). Rendering one under the other's name would publish a manifest
 * for a repo the user opted out of (manifest.repo.ts's header states the same rule for the write side).
 *
 * `pinned_by` is the DEVICE LABEL, not the folder key: `manifest-merge.ts` compares claims against
 * `computerLabel()` with a plain string equality, so the label spelling is the one the wire uses.
 *
 * `modified_at` is `iso.optional()` in the schema — a NULL column must render as an ABSENT key, not as
 * `modified_at: null`. `undefined` is what `YAML.stringify` drops, so the `?? undefined` below is
 * load-bearing rather than decorative.
 */
export async function renderManifest(unitId: number, stage: ManifestStage): Promise<RenderOutcome> {
  const rows = await q<ManifestRow>(
    `SELECT e.rel_path,
            e.cid_text,
            e.size_bytes::text AS size_bytes,
            e.sha256,
            ${isoCol("e.modified_at")} AS modified_at,
            COALESCE(
              ARRAY(SELECT d.label
                      FROM ${S}.pin_claim c
                      JOIN ${S}.device d ON d.device_id = c.device_id
                     WHERE c.unit_id = e.unit_id AND c.stage = e.stage AND c.rel_posix = e.rel_posix),
              '{}'::text[]) AS pinned_by
       FROM ${S}.manifest_entry e
      WHERE e.unit_id = $1 AND e.stage = $2`,
    [unitId, stage],
  );
  const files: ManifestFile[] = rows.map((r) => ({
    path: r.rel_path,
    cid: r.cid_text,
    size: Number(r.size_bytes),
    sha256: r.sha256,
    modified_at: r.modified_at ?? undefined,
    pinned_by: r.pinned_by,
  }));
  // `unit: 'repo'` is not a guess: both manifests this schema stores belong to a repo unit, and
  // `serializeManifest` uses `unit` only to decide whether to heal `\` separators (a `computer` manifest
  // keys on absolute paths, where `\` is legitimate). A repo manifest heals, which is what the file on disk
  // already went through on its way in.
  const manifest: Manifest = { schema_version: 1, unit: "repo", files };
  const text = serializeManifest(manifest);
  return { status: "rendered", text, sha256: sha256Of(text) };
}

// ── renderer: repo_storage.yaml → YAML.stringify {sortMapEntries:true} ──────────────────────────────────

interface RepoStorageRow {
  name: string;
  enlisted_at: string | null;
  enlisted_by: string | null;
  enlisted_on_device: string | null;
  recommend_ipfs_pin: boolean;
  recommend_compress: boolean;
  recommend_transcribe: boolean;
  last_scan_at: string | null;
  last_scan_device: string | null;
  last_scan_headless: boolean;
}

/**
 * Rebuild `RepoStorageDoc`. THE `counts:` BLOCK HAS NO SOURCE IN THIS SCHEMA, and saying so is the point.
 *
 * `RepoStorageCountsSchema` is nine fields — special / large / ipfs_pinned / videos / images / audio /
 * compressible / transcribable / transcribed — and `lfb.unit_rollup` (0003) carries none of them under those
 * names. Its vocabulary is the UI's (`n_compressible_videos`, `n_pinned`, `n_transcribed`, …), which
 * overlaps this document's in exactly one field. So a local `repo_storage.yaml` is NOT renderable today.
 *
 * The MIRROR copy is a different matter and is renderable, because `projectRepoStorageToMirror` resets both
 * machine-local blocks to their schema defaults on the way out (`MACHINE_LOCAL_REPO_STORAGE`,
 * tracking-sync.service.ts). `scrub: true` renders exactly that projection — every value in it is a column
 * we hold, and the two blocks Postgres cannot source are the two the wire does not carry.
 */
export async function renderRepoStorage(unitId: number, opts: { scrub: boolean }): Promise<RenderOutcome> {
  const row = await q1<RepoStorageRow>(
    `SELECT u.name,
            ${isoCol("u.enlisted_at")} AS enlisted_at,
            COALESCE(p.email::text, p.sentinel) AS enlisted_by,
            ed.label      AS enlisted_on_device,
            COALESCE(s.recommend_ipfs_pin,   true)  AS recommend_ipfs_pin,
            COALESCE(s.recommend_compress,   true)  AS recommend_compress,
            COALESCE(s.recommend_transcribe, false) AS recommend_transcribe,
            ${isoCol("sc.last_scan_at")} AS last_scan_at,
            sd.label AS last_scan_device,
            COALESCE(sc.last_scan_headless, false) AS last_scan_headless
       FROM ${S}.unit u
       LEFT JOIN ${S}.unit_setting s ON s.unit_id = u.unit_id
       LEFT JOIN ${S}.unit_scan    sc ON sc.unit_id = u.unit_id
       LEFT JOIN ${S}.person       p  ON p.person_id  = u.enlisted_by
       LEFT JOIN ${S}.device       ed ON ed.device_id = u.enlisted_on_device
       LEFT JOIN ${S}.device       sd ON sd.device_id = sc.last_scan_device
      WHERE u.unit_id = $1`,
    [unitId],
  );
  if (!row) return { status: "unsourced", reason: "no lfb.unit row" };
  if (!opts.scrub) {
    return {
      status: "unsourced",
      reason:
        "repo_storage.counts has no column in lfb.unit_rollup (0003 names the UI's nine counters, not this " +
        "document's nine) — only the SCRUBBED mirror projection is renderable",
    };
  }
  const defaults = RepoStorageDocSchema.parse({ repo_storage: {} }).repo_storage;
  const doc: RepoStorageDoc = RepoStorageDocSchema.parse({
    repo_storage: {
      schema_version: 1,
      name: row.name,
      enlisted: {
        at: row.enlisted_at ?? undefined,
        by: row.enlisted_by,
        on_device: row.enlisted_on_device ?? "",
      },
      // The two MACHINE-LOCAL blocks, at their schema defaults — byte-for-byte what the scrub produces.
      counts: defaults.counts,
      last_scan: defaults.last_scan,
      policy: {
        recommend_ipfs_pin: row.recommend_ipfs_pin,
        recommend_compress: row.recommend_compress,
        recommend_transcribe: row.recommend_transcribe,
      },
    },
  });
  const text = YAML.stringify(doc, { sortMapEntries: true });
  return { status: "rendered", text, sha256: sha256Of(text) };
}

// ── renderer: files/<rel>.yaml → YAML.stringify {sortMapEntries:true} ───────────────────────────────────

interface SidecarFileRow {
  rel_path: string;
  /** SIDECAR-OWNED (migration 0017). NULL is a legitimate document value, not "unknown". */
  sidecar_size_bytes: string | null;
  created_at: string | null;
  /** SIDECAR-OWNED (migration 0017) — the mtime AS OF the last time we touched the file. */
  sidecar_modified_at: string | null;
  categories: string[];
  first_seen_at: string | null;
  first_seen_device: string | null;
}

interface SidecarEventRow {
  at: string;
  kind: FileEvent["kind"];
  on_device: string | null;
  by: string | null;
  detail: Record<string, unknown>;
}

/**
 * The content hash and the perceptual fingerprint.
 *
 * TWO TABLES AND TWO DIFFERENT KEYS, which is why this is its own query rather than a join on the file row.
 * `file_variant` is keyed `(unit_id, rel_posix, variant)` and the sidecar's `hash:` is its `uncompressed`
 * row; `file_fingerprint` is keyed by CONTENT HASH so it survives a rename (0009), so it is reached THROUGH
 * that hash and never through the path.
 *
 * `bits` is `bit(256)` — 0009 stores the perceptual value as bits, not as the 64-hex text the sidecar
 * carries. `bits::text` hands back the 256-character binary string and the hex is re-derived in TypeScript,
 * inverting `file-detail.repo.ts fingerprintBits`. A round trip through two representations is exactly the
 * kind of thing that is right in principle and wrong in practice, so the gate measures it.
 */
interface SidecarSideRow {
  content_hash: string | null;
  algo: string | null;
  bits: string | null;
  quality: string | null;
}

/** The inverse of `file-detail.repo.ts fingerprintBits`: 256 binary characters → 64 lowercase hex. */
function hexFromBits(bits: string): string | null {
  if (!/^[01]{256}$/.test(bits)) return null;
  let hex = "";
  for (let i = 0; i < 256; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/**
 * Rebuild ONE sidecar `FileSidecar` and hand it to the sidecar's serializer.
 *
 * THE EVENT ORDER IS `event_id`, WHICH IS INSERTION ORDER. `YAML.stringify` does not sort arrays, so the
 * sidecar's `events:` list keeps whatever order the document had — and the only record of that order in
 * Postgres is the identity column, because `file_event` deliberately has no sequence field (0009). The
 * backfill inserts in document order and the union is `DO NOTHING`, so first-seen order survives; an event
 * that arrived out of order through `appendFileEvent` on a running app would not. This is exactly the kind
 * of fidelity claim that must be MEASURED rather than asserted, which is what the gate does.
 */
export async function renderSidecar(unitId: number, relPosix: string): Promise<RenderOutcome> {
  const file = await q1<SidecarFileRow>(
    `SELECT f.rel_path,
            f.sidecar_size_bytes::text AS sidecar_size_bytes,
            ${isoCol("f.created_at")}  AS created_at,
            ${isoCol("f.sidecar_modified_at")} AS sidecar_modified_at,
            f.categories,
            ${isoCol("f.first_seen_at")} AS first_seen_at,
            d.label AS first_seen_device
       FROM ${S}.file f
       LEFT JOIN ${S}.device d ON d.device_id = f.first_seen_device
      WHERE f.unit_id = $1 AND f.rel_posix = $2`,
    [unitId, relPosix],
  );
  if (!file) return { status: "unsourced", reason: "no lfb.file row" };

  const [events, side] = await Promise.all([
    q<SidecarEventRow>(
      `SELECT ${isoCol("e.at")} AS at, e.kind::text AS kind, d.label AS on_device,
              COALESCE(p.email::text, p.sentinel) AS by, e.detail
         FROM ${S}.file_event e
         LEFT JOIN ${S}.device d ON d.device_id = e.device_id
         LEFT JOIN ${S}.person p ON p.person_id = e.actor_id
        WHERE e.unit_id = $1 AND e.rel_posix = $2
        ORDER BY e.event_id`,
      [unitId, relPosix],
    ),
    q1<SidecarSideRow>(
      `SELECT v.hash AS content_hash, fp.algo, fp.bits::text AS bits, fp.quality::text AS quality
         FROM ${S}.file_variant v
         LEFT JOIN ${S}.file_fingerprint fp ON fp.content_hash = v.hash
        WHERE v.unit_id = $1 AND v.rel_posix = $2 AND v.variant = 'uncompressed'
        LIMIT 1`,
      [unitId, relPosix],
    ),
  ]);

  // `frames_ref` HAS NO COLUMN in 0009 — a vPDQ sidecar that carries one cannot round-trip, and the gate
  // will say so rather than this renderer inventing a value. Measured on this machine: 2 of 29,138 sidecars
  // carry any fingerprint at all, and neither carries `frames_ref`.
  const fpHex = side?.bits ? hexFromBits(side.bits) : null;
  const fingerprint: PerceptualFingerprint | null =
    side?.algo && fpHex
      ? { algo: side.algo, value: fpHex, quality: side.quality === null ? null : Number(side.quality) }
      : null;

  const doc: FileSidecar = FileSidecarSchema.parse({
    file: {
      path: file.rel_path,
      name: path.posix.basename(healWindowsPath(file.rel_path)),
      categories: file.categories ?? [],
      // THE SIDECAR-OWNED PAIR, NOT THE LIVE ONE (migration 0017). `f.size_bytes` and `f.modified_at` are
      // the SCAN CENSUS's live measurement and are deliberately re-measured on every pass; rendering from
      // them made 15,868 of 29,447 documents differ, because the document states what was true when Large
      // File Bridge last touched the file, which is a different fact from what is true now.
      // `size` is `z.number().nullable()`, so a NULL column is a real `size: null`, never `0`.
      size: file.sidecar_size_bytes === null ? null : Number(file.sidecar_size_bytes),
      // `created` / `modified` are `iso.optional()` — a NULL must be an ABSENT key, never `null`.
      created: file.created_at ?? undefined,
      modified: file.sidecar_modified_at ?? undefined,
      hash: side?.content_hash ?? null,
      fingerprint,
      first_seen: { at: file.first_seen_at ?? undefined, on_device: file.first_seen_device ?? "" },
      // `detail` LAST is wrong and `detail` FIRST is right: 0009 normalizes kind/at/on_device/by OUT of
      // `detail` (file-sidecar.service.ts `detailOf`), so nothing in it can collide — but if a legacy row
      // ever carried one of the four, the column is the truth and must win.
      events: events.map((e) => ({ ...e.detail, kind: e.kind, at: e.at, on_device: e.on_device ?? "", by: e.by })),
    },
  });
  const text = YAML.stringify(doc, { sortMapEntries: true });
  return { status: "rendered", text, sha256: sha256Of(text) };
}

// ── renderer: decisions_policy.yaml → writeDecisionPolicy's serialization ───────────────────────────────

/**
 * Rebuild the SHARED default-decision policy.
 *
 * TWO SPELLINGS OF ONE TRAVELLING DOCUMENT EXIST TODAY, and this renderer cannot be correct for both:
 * `writeDecisionPolicy` (decisions.service.ts) uses a plain `YAML.stringify(doc)` while `mergePolicyInto`
 * (tracking-sync.service.ts) uses `YAML.stringify(winner, { sortMapEntries: true })`. §2.2 names the former
 * as the designated serializer, so that is what this renders. The discrepancy is latent — there are ZERO
 * `decisions_policy.yaml` files on this machine — but it is the exact churn shape §6 describes ("two
 * spellings of one document make each writer re-dirty what the other just wrote") and it is reported rather
 * than quietly reconciled here, because changing a designated serializer is not this module's to do.
 */
export async function renderDecisionPolicy(unitId: number): Promise<RenderOutcome> {
  const row = await q1<{
    media_mode: string;
    media_ipfs: boolean | null;
    media_gitignore: boolean | null;
    other_mode: string;
    other_ipfs: boolean | null;
    other_gitignore: boolean | null;
    attribution: string;
    set_at: string | null;
    set_by: string | null;
  }>(
    `SELECT media_mode, media_ipfs, media_gitignore,
            other_mode, other_ipfs, other_gitignore,
            attribution, ${isoCol("set_at")} AS set_at, set_by
       FROM ${S}.unit_decision_policy WHERE unit_id = $1`,
    [unitId],
  );
  if (!row) return { status: "unsourced", reason: "no lfb.unit_decision_policy row (area 12 has not shipped)" };
  const doc: DecisionPolicyDoc = DecisionPolicyDocSchema.parse({
    media: { mode: row.media_mode, ipfs: row.media_ipfs, gitignore: row.media_gitignore },
    other: { mode: row.other_mode, ipfs: row.other_ipfs, gitignore: row.other_gitignore },
    attribution: row.attribution,
    set_at: row.set_at ?? undefined,
    set_by: row.set_by,
  });
  const text = YAML.stringify(doc);
  return { status: "rendered", text, sha256: sha256Of(text) };
}

// ── the dispatcher ──────────────────────────────────────────────────────────────────────────────────────

/**
 * WHY `history` AND `compression` ARE REFUSED HERE RATHER THAN ATTEMPTED.
 *
 * `history/<device>.txt`'s designated serializer is `appendHistory`, which is APPEND-ONLY and stamps
 * `new Date().toISOString()` at call time. There is no argument you can hand it that reproduces a file — the
 * function's contract is "add one line NOW". Re-rendering a history log would require a second, different
 * writer, and §2.2's "one serializer per travelling document, and it does not change" forbids exactly that.
 * So history is out of the render gate by construction, not by omission, and `history_entry` (0010) stays a
 * READ index over a file this module never writes.
 *
 * `analysis/**​/compression.yaml`'s serializer is `writeLedger` in modules/compress/compress-ledger.ts, which
 * is slice 11's; `lfb.compression_record` has no writer yet.
 */
export async function renderDoc(target: RenderTarget): Promise<RenderOutcome> {
  switch (target.doc) {
    case "decisions":
      return renderDecisions(target.unitId);
    case "manifest":
      return renderManifest(target.unitId, target.docKey === "unit" ? "unit" : "tracking");
    case "repo_storage":
      return renderRepoStorage(target.unitId, { scrub: target.docKey === "mirror" });
    case "sidecar":
      return renderSidecar(target.unitId, target.docKey);
    case "decisions_policy":
      return renderDecisionPolicy(target.unitId);
    case "history":
      return {
        status: "unsourced",
        reason: "appendHistory is append-only and stamps now() — a whole-document render has no serializer",
      };
    case "compression":
      return { status: "unsourced", reason: "lfb.compression_record has no writer (slice 11, area 11)" };
    case "files_index":
      return { status: "unsourced", reason: "files.yaml is LOCAL_ONLY and does not travel (database.mdx §2.1)" };
  }
}

// ── the doc_render ledger ───────────────────────────────────────────────────────────────────────────────

export interface DocRenderRow {
  doc: DocKind;
  docKey: string;
  renderedSha256: string | null;
  renderedBytes: number | null;
  ingestedSha256: string | null;
}

/** Every `doc_render` row for one unit, keyed `<doc> <docKey>`. */
export async function readDocRender(unitId: number): Promise<Map<string, DocRenderRow>> {
  const rows = await q<{
    doc: DocKind;
    doc_key: string;
    rendered_sha256: string | null;
    rendered_bytes: string | null;
    ingested_sha256: string | null;
  }>(
    `SELECT doc::text AS doc, doc_key, rendered_sha256, rendered_bytes::text AS rendered_bytes, ingested_sha256
       FROM ${S}.doc_render WHERE unit_id = $1`,
    [unitId],
  );
  const out = new Map<string, DocRenderRow>();
  for (const r of rows) {
    out.set(docRenderKey(r.doc, r.doc_key), {
      doc: r.doc,
      docKey: r.doc_key,
      renderedSha256: r.rendered_sha256,
      renderedBytes: r.rendered_bytes === null ? null : Number(r.rendered_bytes),
      ingestedSha256: r.ingested_sha256,
    });
  }
  return out;
}

/**
 * Record what we last WROTE to a document's path.
 *
 * R5 IN MINIATURE: this statement names only the `rendered_*` columns, and `recordIngest` names only the
 * `ingested_*` ones. They are two writers of one row — the mirror leg and the reconcile leg — and a
 * whole-row upsert from either would blank the other's half, which would make `doc_render_dirty` (whose
 * predicate is precisely `rendered IS DISTINCT FROM ingested`) report every document as dirty forever.
 */
export async function recordRendered(
  unitId: number,
  doc: DocKind,
  docKey: string,
  sha256: string,
  bytes: number,
): Promise<number> {
  return exec(
    `INSERT INTO ${S}.doc_render (unit_id, doc, doc_key, rendered_sha256, rendered_at, rendered_bytes)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (unit_id, doc, doc_key) DO UPDATE
        SET rendered_sha256 = EXCLUDED.rendered_sha256,
            rendered_at     = EXCLUDED.rendered_at,
            rendered_bytes  = EXCLUDED.rendered_bytes`,
    [unitId, doc, docKey, sha256, bytes],
  );
}

/** Record what we last PARSED IN from an SDL copy. Only the `ingested_*` columns — see `recordRendered`. */
export async function recordIngested(
  unitId: number,
  doc: DocKind,
  docKey: string,
  sha256: string,
  from: string,
): Promise<number> {
  return exec(
    `INSERT INTO ${S}.doc_render (unit_id, doc, doc_key, ingested_sha256, ingested_at, ingested_from)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (unit_id, doc, doc_key) DO UPDATE
        SET ingested_sha256 = EXCLUDED.ingested_sha256,
            ingested_at     = EXCLUDED.ingested_at,
            ingested_from   = EXCLUDED.ingested_from`,
    [unitId, doc, docKey, sha256, from],
  );
}

/** The per-(SDL, unit) reconcile watermark. `events_in` / `claims_in` ACCUMULATE — a pass adds to the tally. */
export async function recordSdlIngest(
  syncRepoId: number,
  unitId: number,
  counts: { eventsIn?: number; claimsIn?: number } = {},
): Promise<number> {
  return exec(
    `INSERT INTO ${S}.sdl_ingest (sync_repo_id, unit_id, last_ingest_at, events_in, claims_in)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (sync_repo_id, unit_id) DO UPDATE
        SET last_ingest_at = EXCLUDED.last_ingest_at,
            events_in = ${S}.sdl_ingest.events_in + EXCLUDED.events_in,
            claims_in = ${S}.sdl_ingest.claims_in + EXCLUDED.claims_in`,
    [syncRepoId, unitId, Math.max(0, counts.eventsIn ?? 0), Math.max(0, counts.claimsIn ?? 0)],
  );
}

/** An SDL working-tree root → `sync_repo_id`, or null when this SDL has no row. */
export async function syncRepoIdForPath(absPath: string): Promise<number | null> {
  const row = await q1<{ sync_repo_id: string }>(
    `SELECT sync_repo_id::text AS sync_repo_id FROM ${S}.sync_repo WHERE abs_path = $1`,
    [path.resolve(absPath)],
  );
  return row ? Number(row.sync_repo_id) : null;
}

// ── the on-disk half: hash a file at most once per (ino, size, mtimeNs) ─────────────────────────────────
//
// The fence runs on EVERY mirror pass, for all 105 units. Hashing `charlie-kirk`'s 3.1 MB ledger and 0.9 MB
// manifest on each of those passes would cost ~400 MB of SHA-256 per pass across the fleet — which would make
// the fence more expensive than the walk it exists to shorten. So the hash is memoized against the same
// nanosecond identity triple `mirror-memo.json` already trusts (tracking-sync.service.ts `fileId`): any edit
// by anyone moves an mtime, the identity stops matching, and the file is re-hashed.
//
// In-process only, and deliberately so — this is a cache of a pure function of bytes we can re-read at any
// time, and persisting it would create a second thing that can be wrong across a restart for no benefit.

interface DiskDigest {
  sha256: string;
  bytes: number;
}
const diskDigests = new Map<string, { id: string; digest: DiskDigest }>();

/** Nanosecond identity, or null when the file is absent. `bigint: true` allocates no `Date` and is faster. */
function fileIdentity(file: string): string | null {
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}`;
  } catch {
    return null;
  }
}

/** sha256 + byte length of a file's CURRENT contents, or null when it is absent/unreadable. */
export function digestOnDisk(file: string): DiskDigest | null {
  const id = fileIdentity(file);
  if (id === null) {
    diskDigests.delete(file);
    return null;
  }
  const hit = diskDigests.get(file);
  if (hit && hit.id === id) return hit.digest;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const digest: DiskDigest = { sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  diskDigests.set(file, { id, digest });
  return digest;
}

/** TEST-ONLY: forget every memoized on-disk digest. */
export function resetDiskDigestMemo(): void {
  diskDigests.clear();
}

// ── the pre-mirror fence ────────────────────────────────────────────────────────────────────────────────

/**
 * The whole-unit Category-B documents, the only ones the pre-mirror fence looks at.
 *
 * SIDECARS ARE DELIBERATELY ABSENT. One repo here holds 20,062 of the 29,138 sidecars; stat-ing them per
 * mirror pass would re-introduce the per-entry walk this slice exists to shorten, and the mirror's own
 * `copyTrackedFile` already short-circuits on identical bytes. The sidecar plane's `doc_render` rows are
 * seeded by the gate (a once-per-migration pass), not by the mirror.
 */
export function unitDocTargets(unitId: number, stateDir: string): RenderTarget[] {
  return [
    { unitId, doc: "manifest", docKey: "tracking", file: path.join(stateDir, "manifest.yaml") },
    { unitId, doc: "decisions", docKey: "", file: path.join(stateDir, "decisions.yaml") },
    { unitId, doc: "decisions_policy", docKey: "", file: path.join(stateDir, "decisions_policy.yaml") },
    { unitId, doc: "repo_storage", docKey: "", file: path.join(stateDir, "repo_storage.yaml") },
  ];
}

/** The sidecar path for a repo-relative POSIX key, without importing `file-sidecar.service.ts`.
 *  `resolveTrackingRoot` is unconditionally `repoStateDir` (tracking-root.service.ts), so this is the same
 *  answer `sidecarPath()` gives — reached through the leaf module so the fence keeps no cycle. */
export function sidecarFileFor(stateDir: string, relPosix: string): string {
  return `${joinRel(path.join(stateDir, "files"), healWindowsPath(relPosix))}.yaml`;
}

export interface FenceOutcome {
  /** Documents whose `doc_render` row was refreshed from the bytes now on disk. */
  recorded: number;
  /** Documents Postgres rewrote because the render differed from disk (0 unless `renderWritesArmed()`). */
  written: number;
  /** Documents whose render differed from disk while DISARMED — the gate's live counter. */
  diffs: number;
  /** Documents whose bytes have not moved since `doc_render` last saw them — the whole point (0012). */
  unchanged: number;
  skipped: string | null;
}

/**
 * THE GATE, CALLED BEFORE `mirrorToSyncRepo`'s tree walk (tracking-sync.service.ts `mirrorGen`).
 *
 * ── THE SKIP IS THE FEATURE, NOT AN OPTIMISATION ────────────────────────────────────────────────────────
 *
 * A document whose on-disk sha256 already equals `doc_render.rendered_sha256` is one this fence has already
 * accounted for, byte for byte. It is not re-rendered, not re-compared and not re-recorded — which is
 * exactly what 0012's header asks for ("the renderer SKIPS a document whose bytes have not changed"), and it
 * is what makes the fence affordable at all. `storage.mirror` runs ~101 times a minute on this machine, and
 * `serializeLedger` on `charlie-kirk`'s 11,423 events is ~460 ms; rendering unconditionally would put a
 * minute of CPU into every minute of wall clock and make the mirror slower than the thing it precedes. The
 * on-disk hash itself is memoized against `(ino, size, mtimeNs)` (`digestOnDisk`), so the steady-state cost
 * per unit is one SELECT plus four `statSync`.
 *
 * DISARMED (today, and until the render equality gate reads zero): a document whose bytes DID move is
 * rendered and compared, and the result recorded. `rendered_sha256` is stamped from the bytes on disk — true
 * in either posture, because the designated serializer is what wrote them. A disagreement is WARNed, which
 * makes a drifted dual-write visible on a real machine at the moment it drifts rather than at the next
 * migration.
 *
 * ARMED: a document whose render differs from disk is rewritten THROUGH ITS DESIGNATED SERIALIZER (the
 * renderers above are the only callers of those functions here), so the mirror that follows copies bytes
 * that are already current. A document whose render matches is not written at all — no `fsync`, no moved
 * mtime, and therefore no commit.
 *
 * IT IS FIRE-AND-FORGET, because `mirrorToSyncRepo` is synchronous top to bottom (`drainSync`, and
 * `worktree-gate.ts`'s header explains why that call chain cannot await). `tryDb` swallows and throttles
 * every failure, so a machine with no Postgres — the default, and every machine today — pays one
 * `dbEnabled()` call and nothing else (R2).
 */
export async function syncFenceBeforeMirror(repoRoot: string): Promise<FenceOutcome> {
  const idle: FenceOutcome = { recorded: 0, written: 0, diffs: 0, unchanged: 0, skipped: null };
  if (!dbEnabled()) return { ...idle, skipped: "no-database" };
  return tryDb(
    async () => {
      const unitId = await unitIdForAbsPath(repoRoot);
      // No unit row yet (never enlisted, or enlisted since the last `adopt_units` pass). Not an error: the
      // YAML was written by its own writer and the backfill adopts the row on its next pass.
      if (unitId === null) return { ...idle, skipped: "no-unit" };
      const stateDir = repoStateDir(repoRoot);
      const armed = renderWritesArmed();
      const known = await readDocRender(unitId);
      const out: FenceOutcome = { recorded: 0, written: 0, diffs: 0, unchanged: 0, skipped: null };
      for (const target of unitDocTargets(unitId, stateDir)) {
        const disk = digestOnDisk(target.file);
        // A whole-unit document this repo does not have (there are zero `decisions_policy.yaml` on this
        // machine) is not a subject. Recording an absence would put a permanently-dirty row in the work list.
        if (!disk) continue;
        if (known.get(docRenderKey(target.doc, target.docKey))?.renderedSha256 === disk.sha256) {
          out.unchanged += 1;
          continue;
        }
        const rendered = await renderDoc(target);
        if (rendered.status === "unsourced") {
          // Nothing to compare and nothing to claim. Still record the on-disk bytes — `doc_render_dirty` is
          // the mirror work list, and a document we cannot render still has to appear in it, or the list
          // silently under-reports exactly the documents nobody is watching.
          await recordRendered(unitId, target.doc, target.docKey, disk.sha256, disk.bytes);
          out.recorded += 1;
          continue;
        }
        if (disk.sha256 === rendered.sha256) {
          await recordRendered(unitId, target.doc, target.docKey, disk.sha256, disk.bytes);
          out.recorded += 1;
          continue;
        }
        out.diffs += 1;
        if (!armed) {
          await recordRendered(unitId, target.doc, target.docKey, disk.sha256, disk.bytes);
          out.recorded += 1;
          continue;
        }
        // ARMED: the serializer's own bytes, written through the ordinary atomic discipline.
        writeRenderedDoc(target.file, rendered.text);
        await recordRendered(unitId, target.doc, target.docKey, rendered.sha256, Buffer.byteLength(rendered.text));
        out.written += 1;
        out.recorded += 1;
      }
      if (out.diffs > 0 && !armed) {
        log.warn(
          "storage",
          `sync fence: ${out.diffs} document(s) in ${repoRoot} render differently from the bytes on disk — ` +
            `the Postgres-fed write stays OFF (database.mdx §2.3). Run \`just db-render-gate\` for the detail.`,
        );
      }
      return out;
    },
    idle,
    "storage.syncFence",
  );
}

// ── the reconcile half: what last came IN from the SDL ──────────────────────────────────────────────────

export interface IngestOutcome {
  /** Documents whose `ingested_sha256` was refreshed. */
  recorded: number;
  eventsIn: number;
  claimsIn: number;
  skipped: string | null;
}

/**
 * Record what a reconcile pass just parsed IN, called from `reconcileFromSyncRepo` (tracking-sync.service.ts
 * `reconcileGen`) after the merge legs have run.
 *
 * TWO ROWS, TWO MEANINGS, AND THEY ARE NOT REDUNDANT:
 *   * `doc_render.ingested_sha256` — the exact bytes of each arriving document. Paired with
 *     `rendered_sha256` it is `doc_render_dirty`, the mirror's pre-pass work list: "this document differs
 *     between what we hold and what last arrived".
 *   * `sdl_ingest` — a per-(SDL, unit) watermark with the ACCUMULATED count of events and pin claims that
 *     have come in. It answers "is this peer's push actually reaching us", which no per-document hash can.
 *
 * THE COUNTS ARE ONLY COMPUTED WHEN THE BYTES MOVED. Parsing an arriving ledger to count its events would
 * otherwise be a second multi-megabyte `YAML.parse` on the leg `loop-watch` already names as the
 * multi-second stall (performance.mdx P-47) — and would run on every pass for every repo, on a fleet where
 * nothing usually arrives. When the sha is unchanged, nothing arrived, and the tally is unchanged too.
 */
export async function recordSdlIngestForRepo(
  repoRoot: string,
  sdlRoot: string,
  sdlSubtree: string,
): Promise<IngestOutcome> {
  const idle: IngestOutcome = { recorded: 0, eventsIn: 0, claimsIn: 0, skipped: null };
  if (!dbEnabled()) return { ...idle, skipped: "no-database" };
  return tryDb(
    async () => {
      const [unitId, syncRepoId] = await Promise.all([unitIdForAbsPath(repoRoot), syncRepoIdForPath(sdlRoot)]);
      if (unitId === null) return { ...idle, skipped: "no-unit" };
      const known = await readDocRender(unitId);
      const out: IngestOutcome = { recorded: 0, eventsIn: 0, claimsIn: 0, skipped: null };
      for (const target of unitDocTargets(unitId, sdlSubtree)) {
        const disk = digestOnDisk(target.file);
        if (!disk) continue;
        if (known.get(docRenderKey(target.doc, target.docKey))?.ingestedSha256 === disk.sha256) continue;
        await recordIngested(unitId, target.doc, target.docKey, disk.sha256, target.file);
        out.recorded += 1;
        if (target.doc === "decisions") out.eventsIn += countArrivingEvents(target.file);
        else if (target.doc === "manifest") out.claimsIn += countArrivingClaims(target.file);
      }
      // `sync_repo_id` is NOT NULL in 0012, so an SDL with no row (never adopted by area 2) gets the
      // per-document hashes and no watermark. That is the honest half-answer rather than a fabricated id.
      if (syncRepoId !== null && out.recorded > 0) {
        await recordSdlIngest(syncRepoId, unitId, { eventsIn: out.eventsIn, claimsIn: out.claimsIn });
      } else if (syncRepoId === null) {
        out.skipped = "no-sync-repo-row";
      }
      return out;
    },
    idle,
    "storage.sdlIngest",
  );
}

/** Events in an arriving ledger, through the same best-effort parse the reconcile itself uses. */
function countArrivingEvents(file: string): number {
  try {
    return parseLedgerBestEffort(fs.readFileSync(file, "utf8")).length;
  } catch {
    return 0;
  }
}

/** `pinned_by` claims in an arriving manifest. Best-effort: an unparseable copy contributes nothing. */
function countArrivingClaims(file: string): number {
  try {
    const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as { files?: Array<{ pinned_by?: string[] }> } | null;
    if (!parsed || !Array.isArray(parsed.files)) return 0;
    let n = 0;
    for (const f of parsed.files) n += f.pinned_by?.length ?? 0;
    return n;
  } catch {
    return 0;
  }
}

/** Atomic write — temp → fsync → rename, the same discipline every designated serializer's writer uses. */
function writeRenderedDoc(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw e;
  }
}

// ── the render equality gate ────────────────────────────────────────────────────────────────────────────

export interface GateDiff {
  doc: DocKind;
  docKey: string;
  file: string;
  /** 'diff' — rendered and on-disk bytes differ. 'missing-on-disk' — Postgres has it, the file does not. */
  reason: "diff" | "missing-on-disk";
  diskSha: string | null;
  renderSha: string;
  diskBytes: number | null;
  renderBytes: number;
  /** The first line that differs, for a human — never the whole document. */
  firstDelta: string | null;
}

export interface GateUnitReport {
  unitId: number;
  absPath: string;
  matched: number;
  /**
   * Documents whose ONLY difference is the stray-path normalization the schema performs ON PURPOSE
   * (database.mdx §3). Counted apart from `diffs` so a KNOWN, INTENDED divergence cannot sit in the failure
   * bucket forever and train everyone to ignore a red gate — the same reason 0015's "DO NOT APPLY" comment
   * was replaced by a real mechanism.
   */
  healed: GateDiff[];
  diffs: GateDiff[];
  unsourced: Map<string, number>;
  /** Documents on disk with no `lfb` row to render them from — a backfill gap, not a renderer bug. */
  absentInPg: number;
}

/**
 * Is this diff ONLY the stray-path normalization the schema performs deliberately?
 *
 * THE CASE, measured on this machine (2026-08-24): three sidecars sit at a HEALED location on disk —
 * `files/_mix/rotten/27k_data.csv.yaml` — while their own `path:` field still carries the pre-heal Windows
 * spelling `_mix\rotten\27k_data.csv`. `sidecar-heal.ts` fixed where the file lives and did not rewrite what
 * it says. Postgres files the row under the filename-derived POSIX spelling, because `rel_posix` is a STORED
 * GENERATED column and the PRIMARY KEY, which is precisely what makes the stray-path fork "structurally
 * impossible instead of healed by hand" (database.mdx §3).
 *
 * So Postgres is RIGHT and the document is stale, and no change to the renderer can or should reproduce it.
 * Counting it as a failure would leave the gate permanently red for a reason nobody intends to fix, which is
 * how a gate stops being read. Counting it as a match would hide it. It gets its own bucket.
 *
 * DELIBERATELY NARROW: the delta must be a `path:` line whose two sides are equal once backslashes become
 * forward slashes. Anything else — a different path, a different key, a second delta — is a real diff.
 */
export function isStrayPathHeal(d: GateDiff): boolean {
  const delta = d.firstDelta;
  if (d.doc !== "sidecar" || d.reason !== "diff" || !delta) return false;
  // `firstDeltaOf` renders both sides with JSON.stringify, so what sits in the string is the ESCAPED form —
  // a single backslash in the document arrives here as the two characters `\\`. Parse them back rather than
  // un-escaping by hand; a hand-rolled unescape is exactly the sort of thing that silently mis-handles the
  // one path containing a quote. The capture is a JSON string literal, quotes included.
  const m = /disk=("(?:[^"\\]|\\.)*") pg=("(?:[^"\\]|\\.)*")$/.exec(delta);
  if (!m) return false;
  let disk: string;
  let pg: string;
  try {
    disk = JSON.parse(m[1]) as string;
    pg = JSON.parse(m[2]) as string;
  } catch {
    return false; // unparseable → treat as a real diff, never as healed
  }
  // Both sides must be the `path:` key, and the delta must be a CLIPPED-free full line (a truncated line
  // ends in the ellipsis `firstDeltaOf` appends, and comparing those could call two different paths equal).
  if (!/^\s*path:/.test(disk) || !/^\s*path:/.test(pg)) return false;
  if (disk.endsWith("\u2026") || pg.endsWith("\u2026")) return false;
  // The heal is ONE-DIRECTIONAL: the DISK side is the one carrying backslashes, and normalizing them must
  // reproduce the Postgres side exactly. A pg side with backslashes would mean we had stored the stray
  // spelling, which is the bug the generated `rel_posix` PK exists to prevent — that is a real diff.
  return disk.includes("\\") && !pg.includes("\\") && disk.replace(/\\/g, "/") === pg;
}

export interface GateReport {
  units: GateUnitReport[];
  matched: number;
  /** See {@link GateUnitReport.healed}. Reported, never counted as a failure. */
  healed: GateDiff[];
  diffs: GateDiff[];
  /** reason → count. */
  unsourced: Map<string, number>;
  absentInPg: number;
  scanned: number;
  ms: number;
}

/** The first differing LINE, abbreviated. Enough to name the field; never enough to dump a 3 MB ledger. */
function firstDeltaOf(a: string, b: string): string {
  const la = a.split("\n");
  const lb = b.split("\n");
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      const clip = (s: string | undefined): string => (s === undefined ? "<eof>" : s.length > 110 ? `${s.slice(0, 110)}…` : s);
      return `line ${i + 1}: disk=${JSON.stringify(clip(la[i]))} pg=${JSON.stringify(clip(lb[i]))}`;
    }
  }
  return `identical lines, ${a.length} vs ${b.length} bytes (trailing newline?)`;
}

function bump(m: Map<string, number>, k: string, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

/**
 * RUN THE GATE. For every (unit, doc) currently on this machine: render from Postgres through the designated
 * serializer, sha256 it, and compare against the bytes on disk.
 *
 * `sidecars: false` covers the four whole-unit documents only (a few hundred files, a second or two).
 * `sidecars: true` adds the 29,138-document sidecar plane, which is the scope §2.3 actually specifies and
 * takes minutes. `record: true` additionally stamps `doc_render` as it goes, so a passing gate leaves the
 * mirror work list seeded.
 */
export async function runRenderGate(
  opts: { sidecars?: boolean; record?: boolean; onUnit?: (r: GateUnitReport) => void } = {},
): Promise<GateReport> {
  const began = Date.now();
  const report: GateReport = {
    units: [],
    matched: 0,
    healed: [],
    diffs: [],
    unsourced: new Map(),
    absentInPg: 0,
    scanned: 0,
    ms: 0,
  };

  for (const unit of await repoUnits()) {
    const u: GateUnitReport = {
      unitId: unit.unitId,
      absPath: unit.absPath,
      matched: 0,
      healed: [],
      diffs: [],
      unsourced: new Map(),
      absentInPg: 0,
    };
    const targets = unitDocTargets(unit.unitId, unit.stateDir);
    if (opts.sidecars) {
      // DRIVE THE SIDECAR SCOPE FROM DISK, not from `lfb.file`. `lfb.file` holds 44,868 rows against 29,138
      // sidecars — the scan census (area 3) writes a row for every candidate whether or not a sidecar was
      // ever created — so iterating rows would report ~15,000 phantom "missing on disk" documents that are
      // not documents at all. The gate's question is about FILES THAT EXIST, and the answer for a sidecar
      // Postgres has never heard of is `absentInPg`, which is counted below.
      //
      // THE KEY IS THE DOCUMENT'S OWN `file.path`, NEVER THE FILENAME IT IS STORED UNDER — the same rule
      // `sidecar-backfill.ts` states at its `const rel = doc.file.path?.trim() || …`, and getting it wrong
      // here cost a full gate run: on a CASE-INSENSITIVE filesystem `sidecarPath()` reuses whatever spelling
      // of a directory already exists, so `files/internal/feed/feed_ranking/x.jpg.yaml` legitimately holds
      // `path: internal/feed/Feed_Ranking/x.jpg`. Deriving the key from the filename looked up a DIFFERENT
      // file's row (both exist), and 4,427 documents reported as "all events lost" when nothing was lost at
      // all. A gate that is wrong in that direction is worse than no gate: it blames the schema for its own
      // key derivation.
      for (const file of sidecarFiles(unit.stateDir)) {
        const relKey = sidecarKeyFor(file, unit.stateDir);
        if (relKey === null) {
          report.scanned += 1;
          bump(u.unsourced, "sidecar unreadable (YAML syntax or schema) — see backfill_reject");
          continue;
        }
        targets.push({ unitId: unit.unitId, doc: "sidecar", docKey: relKey, file });
      }
    }

    for (const target of targets) {
      const disk = digestOnDisk(target.file);
      // A whole-unit document that does not exist locally is simply a document this repo has never had
      // (there are zero `decisions_policy.yaml` on this machine). Not a gate subject.
      if (!disk && target.doc !== "sidecar") continue;
      report.scanned += 1;
      const rendered = await renderDoc(target);
      if (rendered.status === "unsourced") {
        if (rendered.reason === "no lfb.file row") u.absentInPg += 1;
        else bump(u.unsourced, rendered.reason);
        continue;
      }
      if (!disk) {
        u.diffs.push({
          doc: target.doc,
          docKey: target.docKey,
          file: target.file,
          reason: "missing-on-disk",
          diskSha: null,
          renderSha: rendered.sha256,
          diskBytes: null,
          renderBytes: Buffer.byteLength(rendered.text),
          firstDelta: null,
        });
        continue;
      }
      if (disk.sha256 === rendered.sha256) {
        u.matched += 1;
        if (opts.record) await recordRendered(unit.unitId, target.doc, target.docKey, disk.sha256, disk.bytes);
        continue;
      }
      const thisDiff: GateDiff = {
        doc: target.doc,
        docKey: target.docKey,
        file: target.file,
        reason: "diff",
        diskSha: disk.sha256,
        renderSha: rendered.sha256,
        diskBytes: disk.bytes,
        renderBytes: Buffer.byteLength(rendered.text),
        firstDelta: firstDeltaOf(fs.readFileSync(target.file, "utf8"), rendered.text),
      };
      // A stray-path heal is an INTENDED divergence, not a failure — see {@link isStrayPathHeal}.
      if (isStrayPathHeal(thisDiff)) u.healed.push(thisDiff);
      else u.diffs.push(thisDiff);
    }

    report.units.push(u);
    report.matched += u.matched;
    report.healed.push(...u.healed);
    report.diffs.push(...u.diffs);
    report.absentInPg += u.absentInPg;
    for (const [k, v] of u.unsourced) bump(report.unsourced, k, v);
    opts.onUnit?.(u);
  }

  report.ms = Date.now() - began;
  return report;
}

/** Every `*.yaml` under `<stateDir>/files/`, as an absolute path. */
export function sidecarFiles(stateDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.isFile() && e.name.endsWith(".yaml")) out.push(path.join(dir, e.name));
    }
  };
  walk(path.join(stateDir, "files"));
  return out;
}

/**
 * The `rel_posix` a sidecar's rows are filed under: its OWN `file.path`, healed, falling back to the path it
 * is stored at. Null when the document does not parse — which is a `backfill_reject`, not a gate diff.
 *
 * This mirrors `sidecar-backfill.ts` exactly, including the fallback, because the gate's whole value is
 * asking the database the same question the writer answered. Two of the 29,138 sidecars here have never
 * parsed (a Windows-separator `path:` raising BLOCK_AS_IMPLICIT_KEY) and this is where they surface.
 */
export function sidecarKeyFor(file: string, stateDir: string): string | null {
  let doc: FileSidecar;
  try {
    doc = FileSidecarSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")) ?? {});
  } catch {
    return null;
  }
  const recorded = doc.file.path?.trim();
  if (recorded) return healWindowsPath(recorded);
  const rel = path.relative(path.join(stateDir, "files"), file).split(path.sep).join("/");
  return rel.endsWith(".yaml") ? healWindowsPath(rel.slice(0, -".yaml".length)) : null;
}
