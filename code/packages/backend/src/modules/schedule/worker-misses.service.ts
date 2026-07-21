// MISSED CYCLES — the durable record of a scheduled worker fire that could not be delivered.
//
// The charter requires the web app to be transparent about the background process. "Installed" and
// "on/off" were surfaced; a fire that HAPPENED but never reached the backend was not. Before this, the
// launchd trigger wrote a WARN to error.err and exited 0, and the app had no idea — the cycle vanished
// with no record any UI could show. (Worse, the WARN blamed "app not running" for what were client-side
// timeouts against a perfectly healthy backend — see run-job.ts.)
//
// So the trigger now writes a small JSON file in the state root, and the app reads it into WorkerState.
// The file is the only channel that works in the case that matters most: when the app is DOWN, there is
// nobody to POST to, so the record has to be left on disk for the app to find when it comes back.
//
// WRITER: code/deploy/launchd/run-worker.mjs (dependency-free — it cannot import this module; the shape
// below is the contract between them). READER/CLEARER: this module.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import type { WorkerMiss, WorkerKind } from "@lfb/shared";
import { log } from "../../shared/logging.js";

/** The state-root file the trigger writes and the app reads. Same path formula on both sides. */
export function workerMissFile(): string {
  return path.join(resolveStateDir(), "worker-misses.json");
}

type MissMap = Partial<Record<WorkerKind, WorkerMiss>>;

function readAll(): MissMap {
  try {
    const raw = fs.readFileSync(workerMissFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as MissMap;
  } catch {
    // absent or unparseable — no misses recorded is the correct answer either way
  }
  return {};
}

/** The last missed cycle recorded for this worker, or null when its cycles have all been delivered. */
export function workerMiss(kind: WorkerKind): WorkerMiss | null {
  const m = readAll()[kind];
  if (!m || typeof m.at !== "string") return null;
  return m;
}

/**
 * Forget this worker's missed cycles — called when a run actually completes, so the surfaced "cycles were
 * missed" signal clears itself the moment the flow recovers. Best-effort: losing this write only means a
 * stale banner until the next successful run.
 */
export function clearWorkerMiss(kind: WorkerKind): void {
  try {
    const all = readAll();
    if (!all[kind]) return;
    delete all[kind];
    const file = workerMissFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    log.debug("schedule", `clearing ${kind} missed-cycle record failed: ${(e as Error).message}`);
  }
}
