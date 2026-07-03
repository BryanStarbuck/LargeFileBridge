// The on-demand scan JOB runner (scan.mdx §10). The discovery walk is expensive; running it inside
// the HTTP request that triggers it means the browser owns the work — navigate away and the progress
// UI vanishes, and an aborted/timed-out request looks like a cancelled scan. So the walk runs here as
// a SERVER-SIDE background job, detached from any request:
//
//   * Single-flight — only ever one scan runs at a time; a second Rescan is COALESCED (queues exactly
//     one follow-up pass) instead of racing the first on the same status.yaml files.
//   * Detached — startScan() kicks the walk off and returns immediately. The walk is NOT awaited by
//     the request handler, so disconnects/timeouts/navigation can never cancel it.
//   * Observable — live progress lives in module state that GET /api/repos/scan-status returns, so the
//     web app can poll from any page and re-attach after navigating away and back.
import type { ScanJob, ScanPhase } from "@lfb/shared";
import { scanAll, type ProgressSink } from "./scanner.service.js";
import { stampRun } from "../schedule/schedule.service.js";
import { log } from "../../shared/logging.js";

const IDLE: ScanJob = {
  status: "idle",
  source: null,
  startedAt: null,
  finishedAt: null,
  phase: "idle",
  reposTotal: 0,
  reposDone: 0,
  currentUnit: null,
  candidatesFound: 0,
  error: null,
  ok: null,
  rerunQueued: false,
};

let job: ScanJob = { ...IDLE };

/** A snapshot of the current/last scan job — what the status endpoint and progress bar read. */
export function getScanJob(): ScanJob {
  return { ...job };
}

/** Is a scan actively walking the filesystem right now? */
export function scanIsRunning(): boolean {
  return job.status === "running";
}

/**
 * Start a discovery scan in the background and return immediately. Single-flight: if a scan is already
 * running, this does NOT start a second one — it flags a rerun (so a repo added mid-scan, or a
 * double-click, still gets covered) and returns the in-flight job. `manual` wins the recorded source
 * so the UI shows a user-triggered scan even if it coalesced onto a scheduled one.
 */
export function startScan(source: "manual" | "scheduled"): { started: boolean; job: ScanJob } {
  if (job.status === "running") {
    job.rerunQueued = true;
    if (source === "manual") job.source = "manual";
    log.info("scan", `Rescan requested while a scan is running — queued a follow-up pass.`);
    return { started: false, job: getScanJob() };
  }
  job = {
    ...IDLE,
    status: "running",
    source,
    startedAt: new Date().toISOString(),
    phase: "discovering",
  };
  // Detach: do NOT await. The walk outlives the request that asked for it.
  void runJob();
  return { started: true, job: getScanJob() };
}

async function runJob(): Promise<void> {
  const source = job.source ?? "manual";
  const sink: ProgressSink = {
    setPhase(phase: ScanPhase) {
      job.phase = phase;
    },
    setReposTotal(n: number) {
      job.reposTotal = n;
    },
    unitStart(name: string) {
      job.currentUnit = name;
    },
    unitDone(candidatesInUnit: number) {
      job.reposDone += 1;
      job.candidatesFound += candidatesInUnit;
    },
  };
  let ok = true;
  try {
    await scanAll(source, sink);
  } catch (e) {
    ok = false;
    job.error = (e as Error).message;
    log.error("scan", `Scan (${source}) failed: ${job.error}`);
  }
  job.status = ok ? "done" : "error";
  job.ok = ok;
  job.phase = "done";
  job.currentUnit = null;
  job.finishedAt = new Date().toISOString();
  // Stamp last_run_at/last_run_ok here — for BOTH manual and scheduled runs — so the record reflects
  // the actual completion, not the moment the (now non-blocking) trigger route returned (scan.mdx §5).
  try {
    await stampRun("scan", ok);
  } catch (e) {
    log.error("scan", `stampRun failed: ${(e as Error).message}`);
  }
  // A Rescan that arrived mid-run (or a repo added while scanning) queued one more pass — run it now.
  if (job.rerunQueued) {
    const nextSource = job.source ?? "manual";
    job = {
      ...IDLE,
      status: "running",
      source: nextSource,
      startedAt: new Date().toISOString(),
      phase: "discovering",
    };
    void runJob();
  }
}
