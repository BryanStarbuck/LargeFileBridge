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
import { queueDepth, queueDepthByOp, listBatches, workerUtilization } from "../jobqueue/jobqueue.service.js";
import { getScanJob } from "../scanner/scan-job.js";
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
    const data: ProgressListResult = {
      jobs,
      ...(queued > 0 ? { queued } : {}),
      ...(Object.keys(queuedByOp).length > 0 ? { queuedByOp } : {}),
      ...(batches.length > 0 ? { batches } : {}),
      ...(workers.busy > 0 ? { workers } : {}),
    };
    res.json({ ok: true, data });
  } catch (e) {
    log.error("progress", `list failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
