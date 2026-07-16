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
import fs from "node:fs";
import { foldLiveSet, appendTerminal, compact, QUEUE_MAX_ATTEMPTS, type JournalTask } from "./queue-journal.js";
import { log } from "../../shared/logging.js";
import { txnBegin, txnEnd } from "../../shared/transactions.js";

export interface RestoreSummary {
  restored: number;
  quarantined: number;
  quarantinedPaths: string[];
  /** Dropped because the output already existed — the work HAD been done before the crash (§4.1 step 2). */
  skipped: number;
  /** Dropped because the file is gone — the user deleted or moved it since (§4.1 step 3). */
  vanished: number;
  /** The quarantined tasks, for surfacing as Failed rows (§4.3). */
  quarantinedTasks: Array<{ op: string; path: string; attempts: number }>;
}

/** Set once at boot so the Processing page can render "interrupted" rather than an ambiguous empty queue
 *  (crash_recovery.mdx §5 — finished, empty and interrupted are three DIFFERENT states). */
let lastRestore: RestoreSummary = { restored: 0, quarantined: 0, quarantinedPaths: [], skipped: 0, vanished: 0, quarantinedTasks: [] };
export function lastRestoreSummary(): RestoreSummary {
  return lastRestore;
}

/**
 * The op-specific "is this already done?" check, injected by the composition root (main.ts).
 *
 * INJECTED, not imported: this module is a LEAF on purpose (see the header) — the restore pass must not
 * pull the describe/transcribe services, and everything they transitively import, into the boot path that
 * runs before the queue accepts its first task. main.ts already owns both sides and is the right place to
 * marry them. An absent hook simply means nothing is skipped, which is SAFE: the runners are idempotent,
 * so an un-skipped already-done task costs one stat inside the runner instead of one here.
 */
export interface RestoreHooks {
  isAlreadyDone?: (task: JournalTask) => boolean;
}

/**
 * Fold the journal, drop the poison, and hand the survivors back to the caller to re-admit. Called once at
 * boot from main.ts BEFORE any new work is accepted.
 *
 * The re-admission itself is done by the caller (jobqueue's `enqueue`) rather than here, so this module stays
 * a leaf and the restored tasks pass through the exact same admission path — the same dedup, the same core
 * and memory budgets — as freshly-queued ones. A restored task is not a special kind of task.
 */
export function restoreQueueOnBoot(hooks: RestoreHooks = {}): { tasks: JournalTask[]; summary: RestoreSummary } {
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
  const quarantinedTasks: Array<{ op: string; path: string; attempts: number }> = [];
  let skipped = 0;
  let vanished = 0;
  for (const task of live) {
    if ((task.attempts ?? 0) >= QUEUE_MAX_ATTEMPTS) {
      // Poison: it has already had its strikes and we are still here to talk about it. Close its journal
      // record so the fold never surfaces it again, and surface it as a failure the user can SEE.
      appendTerminal(task.id, "quarantined");
      quarantinedPaths.push(task.path);
      quarantinedTasks.push({ op: task.op, path: task.path, attempts: task.attempts ?? 0 });
      log.warn(
        "queue-restore",
        `quarantined ${task.path} after ${task.attempts} attempt(s) — it did not survive a previous run and will NOT be retried`,
      );
      continue;
    }
    // §4.1 step 3 — DROP THE VANISHED. The user deleted or moved it overnight. Re-admitting it would
    // spend a queue slot to produce a guaranteed failure and a Failed row for a file that no longer
    // exists, which reads as a bug rather than as the non-event it is.
    if (!fs.existsSync(task.path)) {
      appendTerminal(task.id, "skipped");
      vanished++;
      continue;
    }
    // §4.1 step 2 — DROP THE ALREADY-DONE. Cheap (a stat + small sidecar read) and it is what makes the
    // restore's generosity affordable: the count also feeds the banner, which must be able to say "1,291
    // restored, 146 already finished" rather than implying the finished work is about to be redone.
    try {
      if (hooks.isAlreadyDone?.(task)) {
        appendTerminal(task.id, "skipped");
        skipped++;
        continue;
      }
    } catch (e) {
      // A skip-check that throws must never cost us the task — fall through and let the runner decide.
      log.warn("queue-restore", `skip-check failed for ${task.path}: ${(e as Error).message} — restoring it anyway`);
    }
    survivors.push(task);
  }

  lastRestore = { restored: survivors.length, quarantined: quarantinedPaths.length, quarantinedPaths, skipped, vanished, quarantinedTasks };
  if (survivors.length || quarantinedPaths.length || skipped || vanished) {
    log.warn(
      "queue-restore",
      `previous session ended with unfinished work: restoring ${survivors.length} job(s), ` +
        `quarantining ${quarantinedPaths.length}, skipping ${skipped} already-done, dropping ${vanished} vanished`,
    );
  }
  // The journal is now the survivors plus a pile of closed records — collapse it.
  compact();
  txnEnd(t, "ok", { restored: survivors.length, quarantined: quarantinedPaths.length, skipped, vanished });
  return { tasks: survivors, summary: lastRestore };
}
