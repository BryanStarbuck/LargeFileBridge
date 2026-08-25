// THE BATCH-MANIFEST INDEX — a READ-ONLY projection of `_batches/*.yaml` into `lfb.batch_manifest` /
// `lfb.batch_item` (migration 0013; database.mdx §6.12, slice 12).
//
// THE FILES STAY AUTHORITATIVE, AND THAT IS NOT A STYLISTIC PREFERENCE.
//
// `batch-manifest.service.ts:12-18` chose an O(1) `appendFileSync` document on purpose: rewriting the whole
// manifest per outcome would be O(n²) on the exact 1,440-file batch the file was built to explain, and a
// manifest that became a performance incident would be a poor monument to one. Nothing in this file writes a
// manifest, and nothing in this file may ever become the thing a manifest is written FROM (R1/R4). The
// projection is a query surface and only that: if it disagrees with the disk, the disk is right and the
// answer is "re-read", never "believe the row".
//
// WHY A PROJECTION AT ALL. `listManifests()` is an uncached `readdir` + `YAML.parse` of up to 200 documents
// on every call, and `readManifest()` re-parses the whole 486,861 B document to work out which files a batch
// never finished. Manifests live forever, so both costs grow without bound while the questions they answer
// ("what ran last night, and did it finish?", "retry the 36 that failed") are one indexed row each.
//
// THREE THINGS THIS GETS RIGHT OR GETS WRONG:
//
//   1. A MANIFEST WITH NO TERMINAL RECORD IS `terminal_state='crashed'`. The ABSENCE is the signal
//      (batch-manifest.service.ts:20-21). Projecting it as NULL — "unfinished, maybe still running" — would
//      destroy the one durable fact the manifest format was designed to carry.
//
//   2. FRESHNESS IS (size, mtime_ms) OF THE FILE, STAMPED FROM THE STAT TAKEN *BEFORE* THE READ. A manifest
//      that is being appended to right now is the normal case, not an edge case — an in-flight batch writes
//      one line per settled file. Stamping the PRE-read stat means that if the file grew while we were
//      parsing it, the token we stored is older than the content we stored, so the next pass sees a mismatch
//      and re-ingests. Stamping the POST-read stat would claim freshness for bytes we never saw.
//
//   3. IDENTITY IS `(batch_id, rel_path)`. The plan (backfillPlan.txt, area 12) asks for deterministic item
//      ids — `uuid_v5(batch_id, rel_path)` — because manifest outcome records carry no task id and a
//      re-ingest must not duplicate. 0013 went one better and made that pair the PRIMARY KEY itself, so the
//      determinism is structural and there is no synthetic uuid to keep in step. Re-runnable by
//      construction, which is the property the plan actually wanted.
//
// `rel_path` is the column's name in 0013; the value stored is the path EXACTLY as the manifest records it,
// which is absolute. A batch's scope routinely spans repos (`scope: "1779 checked path(s)"`), so there is no
// single root it could be made relative to, and rewriting user paths on the way into a projection would make
// the projection disagree with the file it is projecting.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { resolveBatchesDir } from "../../config/state-dir.js";
import { copyRows, dbEnabled, exec, q, q1, tryDb } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";
import { log } from "../../shared/logging.js";
import type { BatchTerminalState } from "./batch-manifest.service.js";

// ── the document, parsed the migration's way ────────────────────────────────────────────────────────────
//
// Raw `fs.readFileSync` + `YAML.parse` + a zod schema, NEVER `readYaml()` (R6 / database_migration.mdx §4.2):
// `yaml-store`'s `rawCache` is 4,096 entries with FIFO eviction, and pushing migration traffic through it
// evicts the hot unit configs that the request this work exists to speed up depends on. `raw-yaml.ts` is the
// shared helper for exactly this, but it takes a file that is fully written; a manifest may be mid-append,
// so the parse and its failure are handled here where the caller can turn them into a reject.

/**
 * `.default(x)` FILLS IN FOR `undefined` ONLY, AND AN OPEN YAML KEY PARSES AS `null`.
 *
 * This is not a theoretical trap here, it is THE crashed-batch case. `writeManifest` ends its one-shot header
 * write with a bare `outcomes:\n` and leaves the key open for appends (batch-manifest.service.ts). A batch
 * that died before its FIRST file settled therefore leaves a document whose `outcomes` is an open key with
 * nothing indented under it — which `YAML.parse` renders as `null`, which `z.array(...).default([])` REJECTS
 * ("expected array, received null"). Verified against a hand-built manifest of exactly that shape: the
 * document was pushed to the reject table instead of projecting as `terminal_state='crashed'`, so the one
 * batch whose crash record matters most would have been the one the projection dropped.
 *
 * `yaml-store.ts:103` records the same lesson for the config stores. These helpers are the fix applied
 * consistently: absent OR null both collapse to the empty value, and only a WRONG type is a parse failure.
 */
const orEmptyString = z.string().nullish().transform((v) => v ?? "");
const orNullString = z.string().nullish().transform((v) => v ?? null);
const orEmptyList = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item)
    .nullish()
    .transform((v) => v ?? []);

/**
 * Deliberately permissive beyond that. A manifest is a durable forensic record written across many app
 * versions, and the projection's job is to index what is there — not to refuse a document because a field it
 * does not read has changed shape. Every field this file actually uses is validated; everything else is
 * passed over.
 */
const ManifestDoc = z.object({
  batch_id: orEmptyString,
  op: orEmptyString,
  label: orEmptyString,
  started: orEmptyString,
  scope: orEmptyString,
  finished: orNullString,
  terminal_state: z
    .enum(["completed", "halted", "crashed"])
    .nullish()
    .transform((v) => v ?? null),
  environment: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? {}),
  files: orEmptyList(z.object({ path: orEmptyString, size_bytes: z.number().nullish().transform((v) => v ?? null) })),
  outcomes: orEmptyList(z.object({ path: orEmptyString, outcome: orNullString, reason: orNullString })),
});
type ManifestDoc = z.infer<typeof ManifestDoc>;

/** A UUID, or null. `batch_manifest.batch_id` is `uuid` — a malformed id must be rejected, never coerced. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a timestamp the manifest wrote with `toISOString()`. Returns null for absent/garbage. */
function isoOrNull(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ManifestSourceStat {
  sizeBytes: number;
  mtimeMs: number;
}

export interface ParsedManifest {
  batchId: string;
  op: string;
  label: string;
  scope: string;
  fileCount: number;
  startedAt: Date;
  finishedAt: Date | null;
  terminalState: BatchTerminalState;
  environment: Record<string, unknown>;
  items: BatchItemRow[];
}

export interface BatchItemRow {
  relPath: string;
  sizeBytes: number | null;
  outcome: string | null;
  reason: string | null;
}

/** Thrown by `parseManifest` when the document cannot become rows. The message goes in the reject table. */
export class ManifestUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestUnusableError";
  }
}

/**
 * Read and project one manifest file. THROWS `ManifestUnusableError` on anything that cannot become rows —
 * which is the point, not an accident: the backfill's mechanic (c) needs a message to put in
 * `lfb.backfill_reject`, and swallowing a parse failure is how an unreadable forensic record sits unnoticed.
 *
 * A YAML syntax error is the expected failure here, and its most likely cause is benign: a manifest whose
 * last `appendFileSync` was cut in half by a crash — i.e. exactly the batch whose crash the manifest exists
 * to record. That file is worth a reject row naming it, and worth NOT aborting the other four.
 */
export function parseManifest(file: string): ParsedManifest {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new ManifestUnusableError(`cannot read manifest: ${(e as Error).message}`);
  }
  let doc: ManifestDoc;
  try {
    doc = ManifestDoc.parse(YAML.parse(text) ?? {});
  } catch (e) {
    throw new ManifestUnusableError(`manifest does not parse: ${(e as Error).message}`);
  }
  if (!UUID_RE.test(doc.batch_id)) {
    throw new ManifestUnusableError(`batch_id ${JSON.stringify(doc.batch_id)} is not a uuid`);
  }
  const startedAt = isoOrNull(doc.started);
  if (!startedAt) {
    // `started_at` is NOT NULL in 0013 and is the sort key of `batch_manifest_recent`. Inventing `now()` for
    // a manifest written weeks ago would put it at the top of "what ran last night", which is worse than
    // leaving the record on disk and saying why it did not project.
    throw new ManifestUnusableError(`manifest has no usable 'started' timestamp (${JSON.stringify(doc.started)})`);
  }

  // THE ABSENCE IS THE SIGNAL (§4.2). No terminal record ⇒ the process died mid-batch ⇒ 'crashed'. A
  // `finished` key with no `terminal_state` is treated the same way: the pair is written by one append in
  // `finalizeManifest`, so half of it means the write itself was interrupted.
  const terminalState: BatchTerminalState = doc.terminal_state ?? "crashed";
  const finishedAt = doc.terminal_state ? isoOrNull(doc.finished) : null;

  // Merge the file list with the outcome list, IN THAT ORDER. The file list is the batch's INTENT (written
  // once, before anything was enqueued) and the outcomes are what happened to it; an outcome for a path not
  // in the list is still kept, because a real record of work done is not something a projection may discard.
  const byPath = new Map<string, BatchItemRow>();
  for (const f of doc.files) {
    if (!f.path) continue;
    // Last write wins WITHIN the document. Postgres refuses two rows with the same conflict key in ONE
    // statement, so a manifest that lists a path twice (a caller that enqueued a duplicate) must be deduped
    // here or the whole INSERT aborts — the same lesson slice 5 recorded for `lfb.file`.
    byPath.set(f.path, { relPath: f.path, sizeBytes: f.size_bytes, outcome: null, reason: null });
  }
  for (const o of doc.outcomes) {
    if (!o.path) continue;
    const prior = byPath.get(o.path);
    // A retried file appends a second outcome; the LAST one is the verdict that stands, which is also what
    // `readManifest`'s `settled` set concludes when it folds the list.
    byPath.set(o.path, {
      relPath: o.path,
      sizeBytes: prior?.sizeBytes ?? null,
      outcome: o.outcome,
      reason: o.reason ? o.reason.slice(0, 300) : null,
    });
  }

  return {
    batchId: doc.batch_id,
    op: doc.op || "?",
    label: doc.label,
    scope: doc.scope,
    // `file_count` is the batch's INTENT — how many files it set out to process — so it comes from the file
    // list, not from the merged map, which can be larger if an outcome named a path the list did not.
    fileCount: doc.files.length,
    startedAt,
    finishedAt,
    terminalState,
    environment: doc.environment,
    items: [...byPath.values()],
  };
}

/** The (size, mtime_ms) freshness token for a manifest file, or null when it cannot be stat'ed. */
export function manifestStat(file: string): ManifestSourceStat | null {
  try {
    const st = fs.statSync(file);
    return { sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null; // vanished between readdir and stat — a normal race, not a fault
  }
}

/** Every manifest on disk, oldest name first (the names sort chronologically). */
export function manifestFiles(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(resolveBatchesDir()).filter((n) => n.endsWith(".yaml"));
  } catch {
    return []; // no `_batches` directory yet — a machine that has never run a batch
  }
  return names.sort().map((n) => path.join(resolveBatchesDir(), n));
}

// ── the write side (Postgres only; the YAML is never touched) ───────────────────────────────────────────

const MANIFEST_COLUMNS = [
  "batch_id",
  "manifest_path",
  "op",
  "label",
  "scope",
  "file_count",
  "started_at",
  "finished_at",
  "terminal_state",
  "environment",
  "src_size",
  "src_mtime_ms",
];

/**
 * R5, stated for this table: THIS AREA IS THE ONLY WRITER of `batch_manifest` and `batch_item`, so a
 * whole-row `DO UPDATE` is correct here and would not be anywhere else. It is still written out column by
 * column rather than as a blanket, so that the day a second writer appears the diff is where it needs to be.
 *
 * `manifest_path` is UNIQUE as well as `batch_id` being the PK. The conflict is taken on `batch_id`, because
 * that is the identity the document carries; a manifest RENAMED on disk (a backup, a hand-copy) must update
 * the existing row's path rather than fail the unique index.
 */
const MANIFEST_ON_CONFLICT =
  "ON CONFLICT (batch_id) DO UPDATE SET " +
  "manifest_path = EXCLUDED.manifest_path, op = EXCLUDED.op, label = EXCLUDED.label, " +
  "scope = EXCLUDED.scope, file_count = EXCLUDED.file_count, started_at = EXCLUDED.started_at, " +
  "finished_at = EXCLUDED.finished_at, terminal_state = EXCLUDED.terminal_state, " +
  "environment = EXCLUDED.environment, src_size = EXCLUDED.src_size, src_mtime_ms = EXCLUDED.src_mtime_ms";

const ITEM_ON_CONFLICT =
  "ON CONFLICT (batch_id, rel_path) DO UPDATE SET " +
  "size_bytes = EXCLUDED.size_bytes, outcome = EXCLUDED.outcome, reason = EXCLUDED.reason";

export interface IngestOptions {
  /** Rows per INSERT statement. Defaults to `copyRows`'s own 500. */
  batchRows?: number;
  /** Called after each item batch lands, so a backfill scope can checkpoint its cursor. */
  onItems?: (lastRelPath: string, itemsSoFar: number) => void;
}

/**
 * Write one parsed manifest and its items. Returns the number of ITEM rows presented.
 *
 * The header row goes in FIRST and on its own: `batch_item.batch_id` REFERENCES `batch_manifest` ON DELETE
 * CASCADE (0013), so items written before their header would abort the whole statement on the FK.
 */
export async function writeManifestRows(
  file: string,
  m: ParsedManifest,
  st: ManifestSourceStat,
  opts: IngestOptions = {},
): Promise<number> {
  await copyRows(
    `${S}.batch_manifest`,
    MANIFEST_COLUMNS,
    [
      [
        m.batchId,
        file,
        m.op,
        m.label,
        m.scope,
        m.fileCount,
        m.startedAt,
        m.finishedAt,
        m.terminalState,
        JSON.stringify(m.environment),
        st.sizeBytes,
        st.mtimeMs,
      ],
    ],
    { onConflict: MANIFEST_ON_CONFLICT },
  );

  const perStatement = opts.batchRows ?? 500;
  let written = 0;
  for (let i = 0; i < m.items.length; i += perStatement) {
    const slice = m.items.slice(i, i + perStatement);
    await copyRows(
      `${S}.batch_item`,
      ["batch_id", "rel_path", "size_bytes", "outcome", "reason"],
      slice.map((it) => [m.batchId, it.relPath, it.sizeBytes, it.outcome, it.reason]),
      { onConflict: ITEM_ON_CONFLICT, batchRows: perStatement },
    );
    written += slice.length;
    opts.onItems?.(slice[slice.length - 1].relPath, written);
  }
  return written;
}

/**
 * Is the row for `file` already describing the bytes currently on disk? The mtime-change gate.
 *
 * Compares BOTH size and mtime_ms. mtime alone is not enough on a filesystem whose timestamp granularity can
 * coarsen (and APFS's does not, but a network mount's does); size alone is not enough because an append that
 * replaced one outcome line with another of the same length would not move it. Together they are the same
 * identity pair `yaml-store` and `file_artifact` already trust.
 */
export async function manifestIsIndexed(file: string, st: ManifestSourceStat): Promise<boolean> {
  const row = await q1<{ src_size: string; src_mtime_ms: string }>(
    `SELECT src_size::text, src_mtime_ms::text FROM ${S}.batch_manifest WHERE manifest_path = $1`,
    [file],
  );
  if (!row) return false;
  return Number(row.src_size) === st.sizeBytes && Number(row.src_mtime_ms) === st.mtimeMs;
}

export interface BatchIndexSyncResult {
  filesSeen: number;
  manifestsIngested: number;
  manifestsUnchanged: number;
  itemsWritten: number;
  rejected: Array<{ file: string; reason: string }>;
}

/**
 * Bring `lfb.batch_manifest` / `lfb.batch_item` up to date with `_batches/` — the "ingest on mtime change"
 * entry point.
 *
 * NEVER CALL THIS FROM A REQUEST HANDLER. Re-parsing the 486,861 B manifest is ~40 ms of synchronous
 * `YAML.parse` on the single Node thread, and putting that on the event loop is the same class of mistake
 * this slice's watcher fix removes. The two legitimate callers are the backfill harness (area 12, which adds
 * resume + rejects + the ledger around it) and a future scheduled sweep.
 *
 * Returns an all-zero result with no database — a machine with no Postgres has an accurate, empty index, and
 * `listManifests()` on disk is unaffected either way (R2).
 */
export async function syncBatchIndex(): Promise<BatchIndexSyncResult> {
  const out: BatchIndexSyncResult = {
    filesSeen: 0,
    manifestsIngested: 0,
    manifestsUnchanged: 0,
    itemsWritten: 0,
    rejected: [],
  };
  if (!dbEnabled()) return out;

  for (const file of manifestFiles()) {
    const st = manifestStat(file);
    if (!st) continue; // vanished under us
    out.filesSeen += 1;
    try {
      if (await manifestIsIndexed(file, st)) {
        out.manifestsUnchanged += 1;
        continue;
      }
      const parsed = parseManifest(file);
      out.itemsWritten += await writeManifestRows(file, parsed, st);
      out.manifestsIngested += 1;
    } catch (e) {
      // One unusable manifest is one un-indexed forensic record — never a reason to abandon the others.
      out.rejected.push({ file, reason: (e as Error).message });
      log.warn("batch-index", `could not index ${path.basename(file)}: ${(e as Error).message}`);
    }
  }
  return out;
}

// ── the read side: available, deliberately NOT wired ────────────────────────────────────────────────────
//
// R3: reads do not cut over unless the task names the surface, and slice 12's does not. `listManifests()`
// and `readManifest()` in `batch-manifest.service.ts` still read the disk and are still the product's
// answer. These two exist because 0013's index comments name exactly these queries as what
// `batch_manifest_recent` and `batch_item_outcome` are for, and a projection whose intended readers are not
// written down is a projection nobody can safely adopt later.
//
// THE PRECONDITION FOR CUTTING EITHER OVER: `BACKFILL_BATCH_MANIFESTS.verify()` passes with zero mismatches
// AND the projection covers every file currently in `_batches/` — because a manifest written since the last
// sync is on disk and not in Postgres, and a reader that trusted the table would silently lose the most
// recent batch, which is the one anybody is ever asking about.

export interface IndexedManifestSummary {
  batchId: string;
  file: string;
  op: string;
  started: string;
  scope: string;
  fileCount: number;
  finished: string | null;
  terminalState: BatchTerminalState;
}

/** `listManifests()`'s question, served by `batch_manifest_recent` instead of a readdir + 200 YAML parses. */
export async function listIndexedManifests(limit = 50): Promise<IndexedManifestSummary[]> {
  return tryDb(
    async () => {
      const rows = await q<{
        batch_id: string;
        manifest_path: string;
        op: string;
        started: string;
        scope: string;
        file_count: number;
        finished: string | null;
        terminal_state: BatchTerminalState;
      }>(
        `SELECT batch_id, manifest_path, op, scope, file_count, terminal_state,
                to_char(started_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started,
                to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished
           FROM ${S}.batch_manifest
          ORDER BY started_at DESC
          LIMIT $1`,
        [Math.max(1, Math.min(limit, 1000))],
      );
      return rows.map((r) => ({
        batchId: r.batch_id,
        file: r.manifest_path,
        op: r.op,
        started: r.started,
        scope: r.scope,
        fileCount: r.file_count,
        // `finished` stays NULL for a crashed batch, matching `ManifestSummary` on the disk path exactly —
        // the projection adds `terminalState='crashed'`, it does not invent a finish time.
        finished: r.finished,
        terminalState: r.terminal_state,
      }));
    },
    [],
    "batch-index.listIndexedManifests",
  );
}

/**
 * `readManifest()`'s question — the unfinished remainder, for "Retry failed (N)" — served by
 * `batch_item_outcome` instead of re-parsing the whole document.
 *
 * The predicate is `readManifest`'s, verbatim: a file is unfinished when it has no outcome at all, or its
 * outcome is `halted` / `never_attempted` / `failed`. Those three are re-queueable BY DESIGN (§2.4) — that
 * is the entire point of having them as distinct states.
 */
export async function unfinishedFromIndex(batchId: string): Promise<string[]> {
  return tryDb(
    async () => {
      const rows = await q<{ rel_path: string }>(
        `SELECT rel_path FROM ${S}.batch_item
          WHERE batch_id = $1
            AND (outcome IS NULL OR outcome IN ('halted','never_attempted','failed'))
          ORDER BY rel_path`,
        [batchId],
      );
      return rows.map((r) => r.rel_path);
    },
    [],
    "batch-index.unfinishedFromIndex",
  );
}

// ── counters, for the backfill's verify() ───────────────────────────────────────────────────────────────

export async function countIndexedManifests(): Promise<number> {
  const row = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.batch_manifest`);
  return Number(row?.n ?? 0);
}

export async function countIndexedItems(batchId?: string): Promise<number> {
  const row = await q1<{ n: string }>(
    batchId
      ? `SELECT count(*)::text AS n FROM ${S}.batch_item WHERE batch_id = $1`
      : `SELECT count(*)::text AS n FROM ${S}.batch_item`,
    batchId ? [batchId] : undefined,
  );
  return Number(row?.n ?? 0);
}

export async function countCrashedManifests(): Promise<number> {
  const row = await q1<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${S}.batch_manifest WHERE terminal_state = 'crashed'`,
  );
  return Number(row?.n ?? 0);
}

/** Drop a manifest's projected rows. Used only when a scope restarts from zero — see the backfill. */
export async function deleteIndexedManifest(batchId: string): Promise<number> {
  // ON DELETE CASCADE takes the items with it (0013).
  return exec(`DELETE FROM ${S}.batch_manifest WHERE batch_id = $1`, [batchId]);
}
