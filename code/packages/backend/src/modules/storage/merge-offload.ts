// RUN A MERGE OFF THE EVENT LOOP — the main thread's side of the merge worker (performance.mdx P-59).
//
// WHY. After the churn fixes (P-51…P-58) a SETTLED pass costs almost nothing, but a pass where a shared
// document genuinely changed still pays one multi-megabyte YAML parse + merge + serialize as ONE synchronous
// step — 0.3 s for the 1.1 MB manifest, over a second for the 3.6 MB charlie-kirk ledger. Nothing is answered
// while it runs, so every such merge is a spinner in the browser. Slicing cannot help: a parse is atomic. So
// the interruptible drivers hand the whole step to a worker thread and give the loop back while it runs.
//
// ONE WORKER, ONE TASK AT A TIME. The merges are already serialized by the passes that issue them, and one
// warm thread keeps the YAML/zod modules compiled across tasks. A worker that fails to start, crashes or
// times out is replaced on the next task; a task it could not finish comes back as an `error` result, which
// the caller treats like any failed merge (logged, retried next pass) — it is never re-run inline, because
// the whole point is that this work must not land on the event loop.
//
// Off in tests (`VITEST`) unless `LFB_MERGE_WORKER=on`: the suites assert through the SYNCHRONOUS driver,
// and the offloaded path has its own test.
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { log } from "../../shared/logging.js";
import { runMergeTask, type MergeTask, type MergeResult } from "./merge-tasks.js";

/** A merge this slow is a hung worker, not a big file (the largest real one is a few seconds of CPU). */
const TASK_TIMEOUT_MS = Math.max(5_000, Number(process.env.LFB_MERGE_WORKER_TIMEOUT_MS) || 120_000);

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: MergeResult) => void; timer: NodeJS.Timeout }>();

export function mergeWorkerEnabled(): boolean {
  const flag = process.env.LFB_MERGE_WORKER;
  if (flag === "off") return false;
  if (flag === "on") return true;
  return !process.env.VITEST;
}

/** The worker needs the same TypeScript loader the app runs under; outside it (a test), tsx's own. */
function workerExecArgv(): string[] {
  const argv = [...process.execArgv];
  if (!argv.some((a) => /[\\/]tsx[\\/]dist[\\/]/.test(a))) {
    argv.push("--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href);
  }
  return argv;
}

function failAll(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ outcome: "error", message: reason });
    pending.delete(id);
  }
}

function getWorker(): Worker {
  if (worker) return worker;
  // A worker thread gets its OWN V8 heap, and without resourceLimits it inherits the backend's 6 GB ceiling
  // (memory incident 2026-10-15). The largest real merge is a ~3.6 MB YAML ledger; 1 GB is generous. A merge
  // that blows through it fails as an `error` result (retried next pass) instead of growing the process.
  const w = new Worker(new URL("./merge-worker.ts", import.meta.url), {
    execArgv: workerExecArgv().filter((a) => !/^--(max-old-space-size|heapsnapshot-near-heap-limit)=/.test(a)),
    resourceLimits: { maxOldGenerationSizeMb: Math.max(256, Number(process.env.LFB_MERGE_WORKER_HEAP_MB) || 1024) },
  });
  w.unref(); // an idle merge thread must never hold the process open
  w.on("message", (msg: { id?: number; result?: MergeResult; log?: [string, string, string] }) => {
    if (msg.log) {
      const [level, context, message] = msg.log;
      const fn = (log as Record<string, (c: string, m: string) => void>)[level.toLowerCase()] ?? log.info;
      fn(context, message);
      return;
    }
    const p = msg.id === undefined ? undefined : pending.get(msg.id);
    if (!p || !msg.result) return;
    clearTimeout(p.timer);
    pending.delete(msg.id!);
    p.resolve(msg.result);
  });
  const retire = (why: string): void => {
    if (worker === w) worker = null;
    failAll(why);
  };
  w.on("error", (e: Error) => {
    log.warn("merge-worker", `merge worker failed: ${e.message} — the next merge starts a fresh one`);
    retire(`merge worker failed: ${e.message}`);
  });
  w.on("exit", (code) => retire(`merge worker exited (code ${code})`));
  worker = w;
  return w;
}

/**
 * Run `task` on the merge worker and resolve with its result — or run it inline when the worker is off.
 * Never rejects: every fault is an `error` result.
 */
export function runMergeOffloaded(task: MergeTask): Promise<MergeResult> {
  if (!mergeWorkerEnabled()) return Promise.resolve(runMergeTask(task));
  return new Promise<MergeResult>((resolve) => {
    let w: Worker;
    try {
      w = getWorker();
    } catch (e) {
      resolve({ outcome: "error", message: `merge worker could not start: ${(e as Error).message}` });
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      const what = "dstFile" in task ? task.dstFile : "file" in task ? task.file : "a ledger";
      log.warn("merge-worker", `a ${task.kind} task took over ${TASK_TIMEOUT_MS} ms (${what}) — restarting the worker; the work is retried`);
      if (worker === w) worker = null;
      void w.terminate();
      resolve({ outcome: "error", message: "merge worker timed out" });
    }, TASK_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { resolve, timer });
    w.postMessage({ id, task });
  });
}

/** Stop the worker (orderly shutdown, tests). */
export async function stopMergeWorker(): Promise<void> {
  const w = worker;
  worker = null;
  failAll("merge worker stopped");
  if (w) await w.terminate();
}
