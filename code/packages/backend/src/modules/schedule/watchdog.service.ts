// The in-process pin watchdog (backbone_resilience.mdx §3). The launchd/cron worker is only ONE trigger, and
// OS triggers are brittle: a plist can point at a moved run-worker.mjs, a job can be booted out and never
// re-bootstrapped, an upgrade can rename a path. When that happens the job crashes on every fire and writes
// NOTHING to our own logs — the most dangerous stall because it is perfectly silent (the 2026-07-07
// incident, backbone_resilience.mdx §8). So the always-on web app watches its OWN workers: any installed +
// enabled worker that has gone overdue (last successful run older than 2× its interval, isWorkerOverdue) is
// (a) run in-process right now, so the flow moves without waiting for a reboot, and (b) repaired via
// reconcileWorkerSchedules(), which rewrites the plist with the correct interval + trigger path and reloads
// it so the OS cadence resumes on its own. While the app runs, a dead OS trigger can never silently halt
// the flow.
import type { WorkerKind } from "@lfb/shared";
import { workerState, reconcileWorkerSchedules, stampRun } from "./schedule.service.js";
import { pinAll, pushDeviceBackbone } from "../pin/pin.service.js";
import { startScan } from "../scanner/scan-job.js";
import { log } from "../../shared/logging.js";

// Re-evaluate every 5 minutes — frequent enough that a dead worker is caught well within its own cadence
// (device 10 min, pin 15 min), cheap enough to be negligible. The first check is delayed (startWatchdog)
// so it never races boot provisioning.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;

// The workers the watchdog covers, most-frequent first (the device write-back is the flow's main carrier).
const WATCHED: WorkerKind[] = ["device", "pin", "scan"];

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false; // single-flight: never let two ticks overlap

/** Run the same work the OS worker would have, in-process, and stamp it (mirrors internal.router `/run/:worker`). */
async function runWorkerInProcess(kind: WorkerKind): Promise<void> {
  if (kind === "scan") {
    startScan("scheduled"); // detached job; it stamps its own last-run on completion (scan-job.ts)
    return;
  }
  if (kind === "device") {
    await pushDeviceBackbone();
    await stampRun("device", true);
    return;
  }
  await pinAll();
  await stampRun("pin", true);
}

/** One heartbeat: run and repair any overdue worker. Single-flighted; never throws (a fault is logged). */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    let healedAny = false;
    for (const kind of WATCHED) {
      let st;
      try {
        st = await workerState(kind);
      } catch (e) {
        log.warn("watchdog", `could not read ${kind} worker state: ${(e as Error).message}`);
        continue;
      }
      if (!st.installed || !st.enabled || !st.overdue) continue;
      log.warn(
        "watchdog",
        `${kind} worker overdue (last ok ${st.lastRunAt ?? "never"}, every ${Math.round(st.intervalSeconds / 60)} min) — running it in-process and repairing its OS schedule`,
      );
      try {
        await runWorkerInProcess(kind);
        log.info("watchdog", `${kind} worker: in-process run complete`);
      } catch (e) {
        // stamp the in-process failure so the overdue signal (and the next tick) reflect reality
        if (kind === "device" || kind === "pin") await stampRun(kind, false).catch(() => {});
        log.error("watchdog", `${kind} worker in-process run failed: ${(e as Error).message}`);
      }
      healedAny = true;
    }
    // If any worker was overdue, its launchd job is likely dead/stale — rewrite + reload the plists so the
    // OS cadence resumes and the app stops having to cover for it. Best-effort; the in-process run already
    // moved the flow this cycle regardless.
    if (healedAny) {
      await reconcileWorkerSchedules().catch((e) =>
        log.warn("watchdog", `schedule reconcile after overdue worker failed: ${(e as Error).message}`),
      );
    }
  } finally {
    ticking = false;
  }
}

/**
 * Start the watchdog heartbeat. Idempotent (a second call is a no-op). Started once from main.ts
 * bootstrapState(). The timer is unref'd so it never keeps the process alive on its own, and the first tick
 * is delayed so it never races boot-time provisioning/reconcile.
 */
export function startWatchdog(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref?.();
  const kick = setTimeout(() => void tick(), INITIAL_DELAY_MS);
  kick.unref?.();
  log.info("watchdog", `pin watchdog started — checks every ${CHECK_INTERVAL_MS / 60000} min`);
}
