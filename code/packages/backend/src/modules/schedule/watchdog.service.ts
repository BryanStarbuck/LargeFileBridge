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
import { startScan, scanIsRunning } from "../scanner/scan-job.js";
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
    const overdueKinds: WorkerKind[] = [];
    for (const kind of WATCHED) {
      let st;
      try {
        st = await workerState(kind);
      } catch (e) {
        log.warn("watchdog", `could not read ${kind} worker state: ${(e as Error).message}`);
        continue;
      }
      if (!st.installed || !st.enabled || !st.overdue) continue;

      // A scan already in flight isn't a dead trigger — scanAll() can legitimately run longer than the
      // scan interval on a big filesystem, and startScan() is single-flight (scan-job.ts): calling it
      // again here would only set a rerun-queued flag, not actually start anything. Note it quietly and
      // leave the in-flight pass to finish and stamp itself — don't alarm as if the OS trigger died.
      if (kind === "scan" && scanIsRunning()) {
        log.debug(
          "watchdog",
          `scan worker overdue (last ok ${st.lastRunAt ?? "never"}) but a scan is already in flight — leaving it to finish`,
        );
        continue;
      }

      // This is the watchdog doing exactly what it's for (backbone_resilience.mdx §3): covering a missed
      // OS fire. That is routine, self-healing operation, not a fault — it belongs in log.log at INFO, not
      // in the error.err fault trail. Only a repair that genuinely can't be fixed (checked below, after
      // reconcile) escalates to WARN.
      log.info(
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
      overdueKinds.push(kind);
    }
    // If any worker was overdue, its launchd job is likely dead/stale — rewrite + reload the plists so the
    // OS cadence resumes and the app stops having to cover for it. Best-effort; the in-process run already
    // moved the flow this cycle regardless.
    if (overdueKinds.length > 0) {
      const results = await reconcileWorkerSchedules().catch((e) => {
        log.warn("watchdog", `schedule reconcile after overdue worker failed: ${(e as Error).message}`);
        return [];
      });
      // The genuine fault this watchdog exists to catch: a worker still configured on whose OS schedule
      // reconcile just tried to fix and STILL isn't loaded (launchd bootstrap failing outright). The
      // in-process fallback is covering it this cycle regardless, but an operator should know the OS
      // cadence itself is not resuming on its own — WARN so it lands in error.err.
      for (const r of results) {
        if (overdueKinds.includes(r.kind) && r.wantsOn && r.osEnabledAfter === false) {
          log.warn(
            "watchdog",
            `${r.kind} worker: OS schedule repair did not take — launchd still won't load the job; the in-process fallback will keep covering it every cycle until this is fixed`,
          );
        }
      }
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
