// The "Processing" nav item's LINGER (processing.mdx §2.1) — pure derivation, unit-tested next door.
//
// Why this exists. §2 used to gate the ONLY route to /processing on live work: the item appeared while a
// job ran and vanished the instant it finished. That reads fine for a 20-minute compress run and fails
// completely for a fast one — a 16-image OCR batch settles in ~4 SECONDS, which is barely more than the
// dock's 3s idle poll. The item had at most one poll to render in and then went away for good, so the user
// saw nothing and reasonably concluded no work had happened. Meanwhile the backend keeps the finished batch
// for 24h (jobqueue.service.ts `BATCH_RETENTION_MS`) precisely so its outcome stays readable, and
// ProcessingPage renders finished batches happily — the record outlived every way of reaching it.
//
// The linger closes that gap: the item outlives the batch by a few minutes so a fast run is still
// clickable, then leaves so an idle machine keeps a clean nav list.
import type { ProcessingBatch } from "@lfb/shared";

/** How long the item outlives the batch it describes. Long enough to notice and click; short enough that
 *  a row labelled "Processing" never sits over an idle machine all day. */
export const FINISHED_LINGER_MS = 5 * 60 * 1000;

/** When the most recent batch settled (epoch ms), or null if none has. Unparseable/absent stamps are
 *  ignored rather than treated as epoch 0 — a bad stamp must not fake a decades-old finish. */
export function lastBatchFinishedAt(batches: ProcessingBatch[]): number | null {
  let last: number | null = null;
  for (const b of batches) {
    if (!b.finishedAt) continue;
    const t = Date.parse(b.finishedAt);
    if (Number.isNaN(t)) continue;
    if (last === null || t > last) last = t;
  }
  return last;
}

/**
 * Is a batch settled recently enough that the nav item should still be reachable?
 *
 * FALSE while `processing` — that case is already covered by §1's live predicate, and the two must not
 * both claim the item or the spinner/check state becomes ambiguous.
 *
 * A finish stamped in the FUTURE (clock skew between the poll and the browser) counts as recent rather
 * than expired: the honest reading of "finished 2s from now" is "just finished", and expiring it would
 * hide the very run the user is waiting to see.
 */
export function isRecentlyFinished(opts: {
  processing: boolean;
  lastFinishedAt: number | null;
  now: number;
}): boolean {
  if (opts.processing) return false;
  if (opts.lastFinishedAt === null) return false;
  return opts.now - opts.lastFinishedAt < FINISHED_LINGER_MS;
}
