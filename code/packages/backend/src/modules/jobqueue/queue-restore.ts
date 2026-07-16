// BOOT RESTORE (crash_recovery.mdx §4) — the half of durability that turns a journal into a promise kept.
//
// Writing the backlog to disk is worthless if nothing reads it back. On 2026-07-15 the user queued 1,440
// files, the process OOM'd, and the backlog was gone; the only recovery was for a human to notice and
// re-invoke by hand — which is exactly what "I queued it and walked away" means we cannot require.
//
// Three properties make replay SAFE rather than reckless:
//   1. SKIP-ALREADY-DONE. The runners are idempotent (describeOne checks readDescription(), transcribeOne the
//      equivalent), so re-admitting a task that actually finished costs a stat, not a re-run. This is what
//      makes it safe to be generous about what we restore.
//   2. QUARANTINE. A task that has already burned QUEUE_MAX_ATTEMPTS strikes is NOT re-admitted — a file that
//      reproducibly aborts the runtime would otherwise resurrect the crash on every boot, forever. Two
//      strikes, not five: each attempt costs the user another crash (§4.3).
//   3. IT IS ANNOUNCED. A restore is never silent (§4.2/D6). The count is surfaced so the Processing page can
//      say so, because the defect we are fixing is not merely "work was lost" — it is "work was lost and the
//      product said nothing."
import { foldLiveSet, appendTerminal, compact, QUEUE_MAX_ATTEMPTS, type JournalTask } from "./queue-journal.js";
import { log } from "../../shared/logging.js";
import { txnBegin, txnEnd } from "../../shared/transactions.js";

export interface RestoreSummary {
  restored: number;
  quarantined: number;
  quarantinedPaths: string[];
}

/** Set once at boot so the Processing page can render "interrupted" rather than an ambiguous empty queue
 *  (crash_recovery.mdx §5 — finished, empty and interrupted are three DIFFERENT states). */
let lastRestore: RestoreSummary = { restored: 0, quarantined: 0, quarantinedPaths: [] };
export function lastRestoreSummary(): RestoreSummary {
  return lastRestore;
}

/**
 * Fold the journal, drop the poison, and hand the survivors back to the caller to re-admit. Called once at
 * boot from main.ts BEFORE any new work is accepted.
 *
 * The re-admission itself is done by the caller (jobqueue's `enqueue`) rather than here, so this module stays
 * a leaf and the restored tasks pass through the exact same admission path — the same dedup, the same core
 * and memory budgets — as freshly-queued ones. A restored task is not a special kind of task.
 */
export function restoreQueueOnBoot(): { tasks: JournalTask[]; summary: RestoreSummary } {
  const t = txnBegin("queue_restore", {});
  let live: JournalTask[];
  try {
    live = foldLiveSet();
  } catch (e) {
    txnEnd(t, "failed", { reason: (e as Error).message });
    return { tasks: [], summary: lastRestore };
  }

  const survivors: JournalTask[] = [];
  const quarantinedPaths: string[] = [];
  for (const task of live) {
    if ((task.attempts ?? 0) >= QUEUE_MAX_ATTEMPTS) {
      // Poison: it has already had its strikes and we are still here to talk about it. Close its journal
      // record so the fold never surfaces it again, and surface it as a failure the user can SEE.
      appendTerminal(task.id, "quarantined");
      quarantinedPaths.push(task.path);
      log.warn(
        "queue-restore",
        `quarantined ${task.path} after ${task.attempts} attempt(s) — it did not survive a previous run and will NOT be retried`,
      );
      continue;
    }
    survivors.push(task);
  }

  lastRestore = { restored: survivors.length, quarantined: quarantinedPaths.length, quarantinedPaths };
  if (survivors.length || quarantinedPaths.length) {
    log.warn(
      "queue-restore",
      `previous session ended with unfinished work: restoring ${survivors.length} job(s), quarantining ${quarantinedPaths.length}`,
    );
  }
  // The journal is now the survivors plus a pile of closed records — collapse it.
  compact();
  txnEnd(t, "ok", { restored: survivors.length, quarantined: quarantinedPaths.length });
  return { tasks: survivors, summary: lastRestore };
}
