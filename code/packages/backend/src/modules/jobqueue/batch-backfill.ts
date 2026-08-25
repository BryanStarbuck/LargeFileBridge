// BACKFILL AREA 12 — THE BATCH MANIFESTS (database_migration.mdx §4.1 area 12; backfillPlan.txt).
//
// Source: `_batches/*.yaml`. Measured on this machine: 5 files, 502,924 B, largest 486,861 B / 1,779 items,
// 1,834 items in total. Small by the standards of this workstream — area 9 alone is 8.5 MB — which is
// precisely why this area is worth doing carefully rather than quickly: it is the one whose SEMANTICS are
// easy to lose, and its row count is too small for a mismatch to show up as a wrong-looking number.
//
// WHAT IT WOULD BE EASY TO GET WRONG, in one line each:
//
//   * A manifest with NO terminal record is `terminal_state='crashed'`, not NULL. THE ABSENCE IS THE SIGNAL
//     (batch-manifest.service.ts:20-21). Projecting it as "no verdict yet" would erase the only durable
//     record that a batch was killed — the exact fact the manifest format was invented to preserve, after a
//     1,440-file batch died in a V8 OOM and reconstructing it took hours.
//   * The files stay AUTHORITATIVE and APPEND-ONLY. Nothing here writes a manifest (R1/R4). The projection
//     is re-derivable from disk at any moment and carries `src_size`/`src_mtime_ms` so a reader can tell.
//   * Item identity is `(batch_id, rel_path)` — 0013's primary key. Manifest outcome records carry no task
//     id, so the plan asked for `uuid_v5(batch_id, rel_path)`; the composite PK is that determinism made
//     structural, so a re-run inserts zero new rows by construction rather than by arithmetic.
//
// ONE SCOPE PER MANIFEST FILE, which makes the harness's mechanic (a) do exactly the "ingest on mtime
// change" this slice asks for, with no second implementation: the scope's watermark IS the file's
// (ino, size, mtime_ms), so an APPENDED manifest — the normal state of a batch that is still running — has a
// changed fingerprint and is re-done from zero on the next pass, while an untouched one is skipped entirely.
import path from "node:path";
import {
  registerBackfill,
  type BackfillArea,
  type BackfillContext,
  type BackfillScope,
} from "../../shared/persistence/backfill.js";
import {
  countCrashedManifests,
  countIndexedItems,
  countIndexedManifests,
  manifestFiles,
  manifestStat,
  parseManifest,
  writeManifestRows,
  ManifestUnusableError,
  type ParsedManifest,
} from "./batch-index.service.js";

/** Item rows per INSERT. The largest manifest is 1,779 items, so this is four statements at worst. */
const BATCH_ROWS = 500;

interface ScopeData {
  file: string;
}

function batchScopes(): BackfillScope[] {
  return manifestFiles().map((file) => ({
    // The BASENAME, not the absolute path: the key is what the ledger and `lfb.backfill_reject` file this
    // scope under, and manifest names are already unique-by-construction (timestamp + op + count + 8 hex of
    // the batch id, chosen so two clicks in the same second cannot collide — batch-manifest.service.ts).
    key: path.basename(file),
    sources: [file],
    data: { file } satisfies ScopeData,
  }));
}

async function runManifestScope(file: string, ctx: BackfillContext): Promise<number> {
  const st = manifestStat(file);
  // Vanished between `scopes()` and here. Not a failure: `_batches` is user-visible and a manifest can be
  // deleted. Returning the prior count leaves the ledger honest and lets the scope close clean.
  if (!st) return ctx.rowsBefore;

  let parsed: ParsedManifest;
  try {
    parsed = parseManifest(file);
  } catch (e) {
    if (e instanceof ManifestUnusableError) {
      // Mechanic (c): record and CONTINUE. The most likely cause is a half-written final append — i.e. the
      // crash this manifest exists to record — and it must not stop the other manifests from indexing.
      ctx.reject(file, e.message);
      return ctx.rowsBefore;
    }
    throw e;
  }

  /**
   * RESUME (mechanic (a)) IS DELIBERATELY FROM ZERO WITHIN A SCOPE.
   *
   * `ctx.resumeFrom` is honoured by every other area because their scopes are megabytes. Here the largest
   * scope is 1,779 rows across four INSERT statements, and skipping forward would mean holding the document
   * in memory anyway (the file list and the outcome list must both be read to merge them, and the outcome
   * list is at the END of the file). Re-presenting 1,779 idempotent upserts costs less than the bookkeeping
   * to avoid them. The cursor is still CHECKPOINTED, because that is what tells an interrupted run which
   * scopes it had already finished.
   */
  let written = 0;
  await writeManifestRows(file, parsed, st, {
    batchRows: BATCH_ROWS,
    onItems: (lastRelPath, itemsSoFar) => {
      written = itemsSoFar;
      ctx.checkpoint(lastRelPath, written);
    },
  });
  // A manifest whose file list is empty still produced a header row, and the header is the record that
  // matters most for a crashed batch. Count it, so an all-empty area does not report zero rows migrated.
  return written + 1;
}

export const BACKFILL_BATCH_MANIFESTS: BackfillArea = {
  name: "backfill_batch_manifests",
  version: 1,
  kind: "backfill",
  sources: () => manifestFiles(),
  scopes: () => batchScopes(),

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    const rows = await runManifestScope((scope.data as ScopeData).file, ctx);
    ctx.checkpoint(null, rows); // scope complete — the harness stamps `done` from here
    return { rows };
  },

  /**
   * VERIFY AGAINST THE DISK, not against our own row counts.
   *
   * The three assertions are the three properties a reader would have to be able to trust before
   * `listManifests()` / `readManifest()` could ever be cut over to the projection (R3, and the note in
   * batch-index.service.ts):
   *
   *   1. Every manifest on disk that CAN be projected has a row.
   *   2. Every manifest's item count matches the number of distinct paths its document mentions.
   *   3. The crashed count in Postgres equals the count of terminal-record-less documents on disk. This is
   *      the one that would be invisible otherwise: rows 1 and 2 would still look perfect on a projection
   *      that had flattened every crashed batch into NULL, and the only symptom in production would be a
   *      "Retry failed" button that stopped offering the batches that most needed it.
   */
  async verify() {
    const mismatches: string[] = [];
    let diskManifests = 0;
    let diskItems = 0;
    let diskCrashed = 0;

    for (const file of manifestFiles()) {
      const st = manifestStat(file);
      if (!st) continue;
      let parsed: ParsedManifest;
      try {
        parsed = parseManifest(file);
      } catch {
        // An unusable document is a REJECT, not a mismatch — it is already on record in
        // `lfb.backfill_reject` with its reason, and counting it here would report the same fault twice.
        continue;
      }
      diskManifests += 1;
      diskItems += parsed.items.length;
      if (parsed.terminalState === "crashed") diskCrashed += 1;

      const pgItems = await countIndexedItems(parsed.batchId);
      if (pgItems !== parsed.items.length) {
        mismatches.push(
          `${path.basename(file)}: batch_item has ${pgItems} row(s) for ${parsed.items.length} path(s) on disk`,
        );
      }
    }

    const pgManifests = await countIndexedManifests();
    if (pgManifests < diskManifests) {
      mismatches.push(`batch_manifest has ${pgManifests} row(s) for ${diskManifests} projectable manifest(s)`);
    }
    const pgCrashed = await countCrashedManifests();
    if (pgCrashed !== diskCrashed) {
      mismatches.push(
        `batch_manifest reports ${pgCrashed} crashed batch(es); ${diskCrashed} manifest(s) on disk have no ` +
          `terminal record — the ABSENCE IS THE SIGNAL and it did not survive the projection`,
      );
    }

    return { yamlRows: diskManifests + diskItems, pgRows: pgManifests + (await countIndexedItems()), mismatches };
  },
};

/**
 * Register area 12.
 *
 * NO ORDERING REQUIREMENT. `batch_manifest` and `batch_item` have no FK onto `lfb.unit` or anything else an
 * earlier area produces — a batch's scope is a list of absolute paths that routinely spans repos and can name
 * files in no registered repo at all. Registered last only so a `just db-backfill` run reads in the order the
 * plan lists the areas.
 */
export function registerBatchBackfill(): void {
  registerBackfill(BACKFILL_BATCH_MANIFESTS);
}
