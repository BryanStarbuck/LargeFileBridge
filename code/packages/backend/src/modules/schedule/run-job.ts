// The DETACHED runner for the `pin` and `device` scheduled workers — the same shape scan already had
// (scan-job.ts), for the same reason.
//
// WHY THIS EXISTS (the 2026-07-21 "app not running? Skipping this interval." bug). The launchd trigger
// (deploy/launchd/run-worker.mjs) POSTs /api/internal/run/<worker> and waits for the response. `scan` was
// already fire-and-acknowledge, but `pin` and `device` AWAITED the whole pass inside the request handler.
// A pin pass walks every repo and a device pass does a git pull/commit/push for every storage — minutes of
// work, routinely past the trigger's fetch timeout. So the trigger aborted the socket and logged
// "backend unreachable … app not running? Skipping this interval." Every word of that was wrong: the app
// was up, the pass was running fine (it kept logging for another 90s after the abort), and nothing was
// skipped — Express cannot cancel an async handler because the client hung up. Nine bogus WARNs in two days
// and, worse, a fault trail that pointed at the wrong thing.
//
// The fix is the interaction SHAPE, not the timeout: the kick endpoints now ACCEPT the job and return
// immediately, and the long work proceeds here, detached from any request. Single-flight per kind, so an
// overlapping trigger (launchd + watchdog + a manual kick) coalesces instead of racing; the run stamps its
// own last_run on COMPLETION (never at accept time, which would record a success before the work happened).
import type { WorkerKind } from "@lfb/shared";
import { pinAll, pushDeviceBackbone } from "../pin/pin.service.js";
import { stampRun } from "./schedule.service.js";
import { setWorkerActive } from "./worker-activity.js";
import { log } from "../../shared/logging.js";

/** The kinds this runner covers. `scan` has its own job runner (scan-job.ts). */
export type RunJobKind = Extract<WorkerKind, "pin" | "device">;

export interface RunJobSnapshot {
  kind: RunJobKind;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
}

const IDLE = (kind: RunJobKind): RunJobSnapshot => ({
  kind,
  running: false,
  startedAt: null,
  finishedAt: null,
  ok: null,
  error: null,
});

const jobs: Record<RunJobKind, RunJobSnapshot> = {
  pin: IDLE("pin"),
  device: IDLE("device"),
};

/** Is this worker's pass actively running right now? */
export function runIsActive(kind: RunJobKind): boolean {
  return jobs[kind].running;
}

/** A snapshot of the current/last pass — what the transparency surfaces read. */
export function runJobState(kind: RunJobKind): RunJobSnapshot {
  return { ...jobs[kind] };
}

async function work(kind: RunJobKind): Promise<void> {
  if (kind === "device") return pushDeviceBackbone();
  return pinAll();
}

/**
 * Start a worker pass in the background and return IMMEDIATELY. Single-flight: if that kind's pass is
 * already running, this starts nothing and reports `started: false` — the caller's cycle is covered by the
 * pass already in flight, which is a normal outcome, NOT a failure.
 */
export function startRun(kind: RunJobKind, source: "scheduled" | "manual" | "watchdog"): {
  started: boolean;
  job: RunJobSnapshot;
} {
  if (jobs[kind].running) {
    log.info("schedule", `${kind} run requested (${source}) while a pass is already running — coalesced.`);
    return { started: false, job: runJobState(kind) };
  }
  jobs[kind] = { ...IDLE(kind), running: true, startedAt: new Date().toISOString() };
  setWorkerActive(kind, true);
  // Detach: do NOT await. The pass outlives the request that asked for it, so a client timeout, a
  // disconnect, or launchd reaping the trigger can never cancel or truncate it.
  void runDetached(kind, source);
  return { started: true, job: runJobState(kind) };
}

async function runDetached(kind: RunJobKind, source: string): Promise<void> {
  let ok = true;
  let error: string | null = null;
  try {
    await work(kind);
  } catch (e) {
    ok = false;
    error = (e as Error).message;
    log.error("schedule", `${kind} run (${source}) failed: ${error}`);
  }
  jobs[kind] = {
    ...jobs[kind],
    running: false,
    finishedAt: new Date().toISOString(),
    ok,
    error,
  };
  setWorkerActive(kind, false);
  // Stamp on COMPLETION — the record must reflect the work, not the moment the kick was accepted.
  try {
    await stampRun(kind, ok);
  } catch (e) {
    log.error("schedule", `stamping ${kind} run failed: ${(e as Error).message}`);
  }
  if (ok) log.info("schedule", `${kind} run (${source}) complete`);
}
