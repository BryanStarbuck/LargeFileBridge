// GET /api/progress (webapp.mdx §12, §14). The progress dock's active-job set is the UNION of two
// server sources folded into one list:
//   A. the in-process job registry (progress.registry.ts) — manual pins, compress, hash, … , and
//   B. the detached discovery scan job (scan-job.ts), which already tracks its own live progress and
//      runs under launchd on its own 4h schedule.
// Folding the scan job in here (rather than making the scanner import the registry) keeps the scanner
// untouched while still surfacing a launchd-triggered scan in the dock — the whole point of source B.
// Allow-listed only: the dock is a signed-in-app surface.
import { Router } from "express";
import type { ProgressJob, ProgressListResult } from "@lfb/shared";
import { requireAllowListed } from "../auth/identify.js";
import { list } from "./progress.registry.js";
import { queueDepth, queueDepthByOp, listBatches, workerUtilization, listQueuedItems, listRecentFailures, stopBatch } from "../jobqueue/jobqueue.service.js";
import { lastRestoreSummary } from "../jobqueue/queue-restore.js";
import { getScanJob } from "../scanner/scan-job.js";
import { sessionState } from "../../shared/session.js";
import { log } from "../../shared/logging.js";

export const progressRouter = Router();
progressRouter.use(requireAllowListed);

progressRouter.get("/", (_req, res) => {
  try {
    const jobs: ProgressJob[] = [...list()];

    // Fold the active discovery scan into the same dock (source B). One card per running scan; its
    // determinate detail is repos-walked when the total is known, else the running candidate count.
    const scan = getScanJob();
    if (scan.status === "running") {
      const determinate = scan.reposTotal > 0;
      jobs.push({
        id: "scan-job", // stable id → de-duped by the frontend across polls (no doubles)
        kind: "scan",
        target: scan.currentUnit ?? "filesystem",
        startedAt: scan.startedAt ?? new Date().toISOString(),
        ...(determinate
          ? { done: scan.reposDone, total: scan.reposTotal, unit: "repos" }
          : {}),
      });
    }

    // Fold in the background job queue's pending backlog (job_queue.mdx §4) — the dock shows a "+ N queued"
    // footer while tasks wait to start. Running items already appear above as their own registry cards.
    const queued = queueDepth();
    // Processing surfaces (processing.mdx §4/§5): the per-op backlog split + the compress batches
    // (active + recently-finished, for the Processing page's progress + error list).
    const queuedByOp = queueDepthByOp();
    const batches = listBatches();
    // Worker utilization — the parallelism read (processing.mdx §3a): core-slots busy vs the mass-compute
    // Core Budget. Only sent while something is actually running, so an idle poll stays tiny.
    const workers = workerUtilization();
    // Per-item Processing table rows (processing.mdx §4.3): the head of the pending queue + recent failures.
    const queuedItems = listQueuedItems();
    const recentFailures = listRecentFailures();
    // THE SESSION BLOCK (crash_recovery.mdx §5.1) — the three durable inputs that let the page tell
    // Finished, Empty and Interrupted apart instead of rendering all three as a bare zero. Sent on EVERY
    // poll, not only when interesting: it is the denominator for the empty state, and an empty state that
    // only sometimes knows whether we crashed is exactly the ambiguity D2 forbids.
    const session = sessionState();
    const restore = lastRestoreSummary();
    const data: ProgressListResult = {
      jobs,
      ...(queued > 0 ? { queued } : {}),
      ...(Object.keys(queuedByOp).length > 0 ? { queuedByOp } : {}),
      ...(batches.length > 0 ? { batches } : {}),
      ...(workers.busy > 0 ? { workers } : {}),
      ...(queuedItems.length > 0 ? { queuedItems } : {}),
      ...(recentFailures.length > 0 ? { recentFailures } : {}),
      ...(session
        ? {
            session: {
              ...session,
              ...(restore.restored ? { restored: restore.restored } : {}),
              ...(restore.skipped ? { restoreSkipped: restore.skipped } : {}),
              ...(restore.vanished ? { restoreVanished: restore.vanished } : {}),
              ...(restore.quarantined ? { quarantined: restore.quarantined } : {}),
            },
          }
        : {}),
    };
    res.json({ ok: true, data });
  } catch (e) {
    log.error("progress", `list failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/**
 * POST /api/progress/batches/:id/stop — stop a batch (processing_batches.mdx §6.2).
 *
 * Drains that batch's PENDING tasks to `halted` and lets the in-flight ones finish. A halted file was NEVER
 * ATTEMPTED, so it costs nothing to re-run — which is why this is safe to expose as a one-click action and
 * why the halted files must never read as failures.
 */
progressRouter.post("/batches/:id/stop", (req, res) => {
  try {
    const halted = stopBatch(req.params.id);
    res.json({ halted });
  } catch (e) {
    log.warn("progress", `stop batch ${req.params.id} failed: ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message });
  }
});
