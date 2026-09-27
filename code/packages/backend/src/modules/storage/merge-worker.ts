// THE MERGE WORKER THREAD — where the multi-megabyte shared-document merges run, off the event loop
// (performance.mdx P-59). A thin shell: every line of merge logic is in merge-tasks.ts, which the event loop
// also runs inline, so this file cannot drift from it.
import { parentPort } from "node:worker_threads";
import { forwardLogsTo } from "../../shared/logging.js";
import { runMergeTask, type MergeTask } from "./merge-tasks.js";

if (!parentPort) throw new Error("merge-worker.ts must be started as a worker thread");
const port = parentPort;

// One writer per log file: this thread's lines are replayed by the main thread (merge-offload.ts).
forwardLogsTo((level, context, message) => port.postMessage({ log: [level, context, message] }));

port.on("message", (msg: { id: number; task: MergeTask }) => {
  port.postMessage({ id: msg.id, result: runMergeTask(msg.task) });
});
