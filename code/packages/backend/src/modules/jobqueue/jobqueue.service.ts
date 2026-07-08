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
import { randomUUID } from "node:crypto";
import path from "node:path";
import { transcribeOne } from "../transcribe/transcribe.service.js";
import { describeOne } from "../describe/describe.service.js";
import { compressFile } from "../compress/compression.service.js";
import { track } from "../progress/progress.registry.js";
import type { ProviderId } from "../describe/adapters.js";
import type { DeleteOriginalMode, ProcessingBatch, ProgressKind } from "@lfb/shared";
import { log } from "../../shared/logging.js";

export type JobOp = "transcribe" | "describe" | "compress";

export interface QueueTask {
  op: JobOp;
  path: string; // absolute media file path
  overwrite: boolean; // re-do even if the output exists (default false)
  provider?: string; // describe only — the chosen vision provider (or "auto")
  compress?: { deleteOriginal: DeleteOriginalMode }; // compress only — per-run originals disposition
  batchId?: string; // groups a bulk run (a "Compress inside" batch — processing.mdx §4)
}

// Per-op concurrency caps (job_queue.mdx §3). Whisper is CPU/GPU-heavy → 2; describe is network + a
// bounded ffmpeg/ImageMagick fit step → 3; compress runs a heavy async ffmpeg/oxipng transcode → 2.
// Constants in one place, easy to tune per machine later.
const CONCURRENCY: Record<JobOp, number> = { transcribe: 2, describe: 3, compress: 2 };

const pending: QueueTask[] = []; // FIFO backlog (tasks not yet started)
const inflight = new Set<string>(); // op|path currently pending OR running — the dedup set
const running: Record<JobOp, number> = { transcribe: 0, describe: 0, compress: 0 };

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

/** Pending backlog split by op (processing.mdx §5) — labels the Processing page's per-op backlog. */
export function queueDepthByOp(): Partial<Record<ProgressKind, number>> {
  const by: Partial<Record<ProgressKind, number>> = {};
  for (const t of pending) by[t.op] = (by[t.op] ?? 0) + 1;
  return by;
}

// ── Processing batches (processing.mdx §4) ────────────────────────────────────
// A batch groups the per-file tasks of one bulk run (a "Compress inside" run) so the Processing page
// can show one progress bar and, when it finishes, the ERROR LIST for that run. Finished batches are
// kept for a retention window so their errors stay visible if the user opens the page after the fact.
const batches = new Map<string, ProcessingBatch>();
const BATCH_RETENTION_MS = 30 * 60 * 1000;

export function createBatch(input: {
  kind: ProgressKind;
  label: string;
  total: number;
  deleteOriginal: DeleteOriginalMode;
}): string {
  const id = randomUUID();
  batches.set(id, {
    id,
    kind: input.kind,
    label: input.label,
    total: input.total,
    done: 0,
    failed: 0,
    errors: [],
    deleteOriginal: input.deleteOriginal,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
  return id;
}

/** Fold one task's outcome into its batch; stamp finishedAt once every task has reported. */
function recordBatchResult(batchId: string | undefined, r: { ok: boolean; path: string; reason?: string }): void {
  if (!batchId) return;
  const b = batches.get(batchId);
  if (!b) return;
  if (r.ok) b.done++;
  else {
    b.failed++;
    b.errors.push({ path: r.path, reason: r.reason ?? "failed" });
  }
  if (b.done + b.failed >= b.total && !b.finishedAt) {
    b.finishedAt = new Date().toISOString();
    log.info("jobqueue", `batch "${b.label}" finished: ${b.done} ok, ${b.failed} failed`);
  }
}

/** Active + recently-finished batches (finished ones pruned past the retention window). */
export function listBatches(): ProcessingBatch[] {
  const now = Date.now();
  for (const [id, b] of batches) {
    if (b.finishedAt && now - Date.parse(b.finishedAt) > BATCH_RETENTION_MS) batches.delete(id);
  }
  return [...batches.values()];
}

/** Count of batches still running (used to keep the Processing nav item visible). */
export function activeBatchCount(): number {
  let n = 0;
  for (const b of batches.values()) if (!b.finishedAt) n++;
  return n;
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
    } else if (t.op === "describe") {
      await describeOne(t.path, {
        overwrite: t.overwrite,
        provider: (t.provider as ProviderId | "auto" | undefined) ?? undefined,
      });
    } else {
      // compress — wrap in a track("compress", …) so the file shows a live dock card while it runs.
      // The heavy transcode is async inside compressFile (spawn), so this does NOT block the event loop.
      // Per-file transactional safety lives in compressFile: the original is only disposed AFTER the
      // temp verified, so a failure here never deletes the original (compress_inside.mdx §4).
      const name = path.basename(t.path);
      const r = await track("compress", name, async () =>
        compressFile(t.path, { deleteOriginal: t.compress?.deleteOriginal }),
      );
      // "compressed" / "skipped" (no-gain, already-compressed) are both fine — the file is safe and
      // present. "blocked" / "failed" are errors surfaced in the batch's final error list.
      const ok = r.status === "compressed" || r.status === "skipped";
      recordBatchResult(t.batchId, { ok, path: t.path, reason: r.reason ?? undefined });
    }
  } catch (e) {
    // A thrown compress task must still be counted against its batch, else the batch never finishes.
    if (t.op === "compress") recordBatchResult(t.batchId, { ok: false, path: t.path, reason: (e as Error).message });
    log.error("jobqueue", `${t.op} failed for ${t.path}: ${(e as Error).message}`);
  }
}
