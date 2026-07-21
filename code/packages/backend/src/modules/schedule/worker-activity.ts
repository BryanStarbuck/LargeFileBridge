// A leaf module holding "is this worker's pass executing right now?" for all three workers.
//
// It exists to keep the transparency surface (schedule.service.ts workerState) from having to import the
// job runners — scan-job.ts and run-job.ts both import schedule.service.ts for stampRun, so reading their
// state directly would close an import cycle. The runners PUSH their liveness here instead; everyone else
// reads it.
//
// Why the flag matters: now that a worker pass is detached from the request that kicked it (run-job.ts), a
// pass can legitimately run for minutes. A long-running pass must never be mistaken for a stalled worker.
import type { WorkerKind } from "@lfb/shared";

const active: Record<WorkerKind, boolean> = { scan: false, pin: false, device: false };

/** Called by a job runner as its pass starts and finishes. */
export function setWorkerActive(kind: WorkerKind, on: boolean): void {
  active[kind] = on;
}

/** Is this worker's pass executing right now? */
export function isWorkerActive(kind: WorkerKind): boolean {
  return active[kind];
}
