// The server-side BACKGROUND JOB QUEUE (job_queue.mdx). A producing PAGE ACTION (Create Transcriptions /
// Create AI descriptions — page_actions.mdx) resolves its eligible set and calls enqueue(); enqueue pushes
// the tasks onto this in-process FIFO and RETURNS IMMEDIATELY. A bounded pool of workers drains the queue
// in the background, calling the op's existing per-file runner (transcribeOne / describeOne) — each of
// which already registers a track("transcribe"/"describe", …) progress-registry job, so a started item
// shows a live dock card. The queue writes no dock code of its own.
//
// In-memory only, exactly like the job registry (webapp.mdx §12): the process IS the single API server, so
// a task that outlived a restart was not "in flight" anymore. On restart the queue is empty; re-invoking a
// page action re-queues only the still-unfinished files (skip-already-done makes that safe).
import { transcribeOne } from "../transcribe/transcribe.service.js";
import { describeOne } from "../describe/describe.service.js";
import type { ProviderId } from "../describe/adapters.js";
import { log } from "../../shared/logging.js";

export type JobOp = "transcribe" | "describe";

export interface QueueTask {
  op: JobOp;
  path: string; // absolute media file path
  overwrite: boolean; // re-do even if the output exists (default false)
  provider?: string; // describe only — the chosen vision provider (or "auto")
}

// Per-op concurrency caps (job_queue.mdx §3). Whisper is CPU/GPU-heavy → 2; describe is network + a
// bounded ffmpeg/ImageMagick fit step → 3. Constants in one place, easy to tune per machine later.
const CONCURRENCY: Record<JobOp, number> = { transcribe: 2, describe: 3 };

const pending: QueueTask[] = []; // FIFO backlog (tasks not yet started)
const inflight = new Set<string>(); // op|path currently pending OR running — the dedup set
const running: Record<JobOp, number> = { transcribe: 0, describe: 0 };

const keyOf = (t: Pick<QueueTask, "op" | "path">): string => `${t.op}|${t.path}`;

/**
 * Append `tasks` to the queue and kick the drain loop, then return immediately. `queued` = how many were
 * actually added; `deduped` = how many were dropped because an identical op+path was already pending/running
 * (job_queue.mdx §2 — a double-click never double-queues).
 */
export function enqueue(tasks: QueueTask[]): { queued: number; deduped: number } {
  let queued = 0;
  let deduped = 0;
  for (const t of tasks) {
    const k = keyOf(t);
    if (inflight.has(k)) {
      deduped++;
      continue;
    }
    inflight.add(k);
    pending.push(t);
    queued++;
  }
  pump();
  return { queued, deduped };
}

/** The pending backlog size — tasks waiting to start (folded into GET /api/progress as `queued`, §4). */
export function queueDepth(): number {
  return pending.length;
}

/** Start as many pending tasks as the per-op caps allow. Synchronous; parks when nothing is runnable. */
function pump(): void {
  for (;;) {
    const next = takeRunnable();
    if (!next) return;
    start(next);
  }
}

/** Remove and return the first pending task whose op has a free slot, else undefined (FIFO by op). */
function takeRunnable(): QueueTask | undefined {
  for (let i = 0; i < pending.length; i++) {
    const t = pending[i];
    if (running[t.op] < CONCURRENCY[t.op]) {
      pending.splice(i, 1);
      return t;
    }
  }
  return undefined;
}

function start(t: QueueTask): void {
  running[t.op]++;
  // Fire-and-forget: run the task, then free its slot + dedup key and re-pump for the next waiter.
  void runTask(t).finally(() => {
    running[t.op]--;
    inflight.delete(keyOf(t));
    pump();
  });
}

/**
 * Run one task by calling its per-file runner. Per-item isolation (job_queue.mdx §3): a throw is caught and
 * logged, and the worker moves on — one bad file never stalls the queue. The runners themselves already
 * return a truthful status (and register their own progress card) rather than throwing for expected outcomes.
 */
async function runTask(t: QueueTask): Promise<void> {
  try {
    if (t.op === "transcribe") {
      await transcribeOne(t.path, t.overwrite);
    } else {
      await describeOne(t.path, {
        overwrite: t.overwrite,
        provider: (t.provider as ProviderId | "auto" | undefined) ?? undefined,
      });
    }
  } catch (e) {
    log.error("jobqueue", `${t.op} failed for ${t.path}: ${(e as Error).message}`);
  }
}
