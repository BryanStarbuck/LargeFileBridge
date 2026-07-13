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
import { coreBudget } from "../../shared/concurrency.js";
import { transcribeConcurrency } from "../transcribe/transcribe-concurrency.js";
import { log } from "../../shared/logging.js";

export type JobOp = "transcribe" | "describe" | "compress";
export type CompressMediaKind = "image" | "video";

export interface QueueTask {
  op: JobOp;
  path: string; // absolute media file path
  overwrite: boolean; // re-do even if the output exists (default false)
  provider?: string; // describe only — the chosen vision provider (or "auto")
  // compress only — per-run originals disposition + which media-aware budget this task draws (§3). The
  // producer stamps `mediaKind` from the file's extension when it plans the batch (compress_inside.mdx §5).
  compress?: { deleteOriginal: DeleteOriginalMode; mediaKind: CompressMediaKind };
  batchId?: string; // groups a bulk run (a "Compress inside" batch — processing.mdx §4)
}

// ── The CORE BUDGET, media-aware (job_queue.mdx §3 / parallelization.mdx §2) ──────────────────────────
// Concurrency is NOT a fixed tiny constant — it is DERIVED from the machine's core count so a many-core
// box actually gets used ("use up to ~90% of cores"). The `compress` op is MEDIA-AWARE because the two
// media kinds have OPPOSITE tool profiles, so it splits into two admission buckets:
//   • compress:image — image tools (oxipng/cwebp/mozjpeg/magick) are ~single-threaded → fan WIDE:
//     `budget` jobs at 1 thread each (one job per core).
//   • compress:video — ffmpeg is internally multi-threaded → fan NARROW: floor(budget / VIDEO_THREADS)
//     jobs, and each ffmpeg is thread-CAPPED to VIDEO_THREADS so N videos don't each grab every core.
// transcribe (Whisper, multi-threaded) fans narrow too; describe waits on a vision-API round-trip so it
// is NETWORK-parallel, not core-bound. The invariant (parallelization.mdx §2): for every bucket
// `concurrentJobs × threadsPerJob ≈ budget`, NEVER cores². Caps are read LIVE from coreBudget() at
// admission, so the Settings knob (performance.max_core_fraction) takes effect on the next task, no restart.
type Bucket = "transcribe" | "describe" | "compress:image" | "compress:video";
const VIDEO_THREADS = 4; // per-job ffmpeg threads for a BATCHED video compress (a one-off passes no cap)
const WHISPER_THREADS = 4; // Whisper is multi-threaded; a couple of runs saturate the machine
const DESCRIBE_CONCURRENCY = 6; // network round-trip, not local CPU — a fixed small overlap, not core-bound

/** The admission bucket a task competes in (compress splits by media kind). */
function bucketOf(t: QueueTask): Bucket {
  if (t.op === "compress") return t.compress?.mediaKind === "video" ? "compress:video" : "compress:image";
  return t.op;
}

/** The concurrency cap for a bucket, given a Core Budget snapshot (parallelization.mdx §1). The budget is
 *  passed in — NOT read here — so the admission scan can snapshot it ONCE per pass instead of re-reading
 *  (and re-parsing) config.yaml for every pending task, which would block the event loop on a big backlog. */
function capFor(bucket: Bucket, budget: number): number {
  switch (bucket) {
    case "compress:image":
      return budget; // WIDE — one single-threaded job per core
    case "compress:video":
      return Math.max(1, Math.floor(budget / VIDEO_THREADS)); // NARROW — thread-capped jobs fill the budget
    case "transcribe":
      // NARROW + RAM/GPU-clamped (transcribe_engine.mdx §5.1): Whisper is heavy + multi-threaded AND multi-GB
      // per instance, so beyond the CPU term we clamp by RAM — a low-power box runs 1, a big box runs several.
      return transcribeConcurrency({
        budget,
        whisperThreads: WHISPER_THREADS,
        model: process.env.LFB_TRANSCRIBE_MODEL || "base",
      });
    case "describe":
      return DESCRIBE_CONCURRENCY; // network-parallel, not core-bound
  }
}

/** Per-job internal thread cap plumbed into the compress tool so a batched job stays inside its slice
 *  (parallelization.mdx §2). image → 1 (fan wide), video → VIDEO_THREADS (fan narrow). */
function compressThreadsFor(kind: CompressMediaKind | undefined): number {
  return kind === "video" ? VIDEO_THREADS : 1;
}

const pending: QueueTask[] = []; // FIFO backlog (tasks not yet started)
const inflight = new Set<string>(); // op|path currently pending OR running — the dedup set
const running: Record<Bucket, number> = {
  transcribe: 0,
  describe: 0,
  "compress:image": 0,
  "compress:video": 0,
};

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

/** Remove and return the first pending task whose ADMISSION BUCKET has a free slot, else undefined
 *  (FIFO per bucket — an image task never blocks behind a full video bucket, and vice versa). */
function takeRunnable(): QueueTask | undefined {
  // Snapshot the live Core Budget ONCE for this whole admission scan. Reading it per-element would call
  // coreBudget() → getAppConfig() (a synchronous config.yaml read + Zod parse) for every pending task on
  // every pump cycle — O(N²) blocking disk I/O over a big batch, defeating the responsiveness the budget
  // exists to protect. Still read LIVE per pass, so a Settings change lands on the very next admission.
  const budget = coreBudget();
  for (let i = 0; i < pending.length; i++) {
    const t = pending[i];
    const b = bucketOf(t);
    if (running[b] < capFor(b, budget)) {
      pending.splice(i, 1);
      return t;
    }
  }
  return undefined;
}

function start(t: QueueTask): void {
  const b = bucketOf(t);
  running[b]++;
  // Fire-and-forget: run the task, then free its slot + dedup key and re-pump for the next waiter.
  void runTask(t).finally(() => {
    running[b]--;
    inflight.delete(keyOf(t));
    pump();
  });
}

/**
 * Worker utilization for the Processing page's parallelism read (processing.mdx §3a): how many of the
 * mass-compute Core Budget's core-slots are BUSY right now vs the budget total. Compute jobs count their
 * thread-equivalents (a video job occupies VIDEO_THREADS cores, a transcribe WHISPER_THREADS, an image 1),
 * so "busy" reflects real cores in use; describe is network (not core-bound) and is excluded. Clamped to
 * the budget for a sane display.
 */
export function workerUtilization(): { busy: number; budget: number } {
  const budget = coreBudget();
  const busy =
    running["compress:image"] * 1 +
    running["compress:video"] * VIDEO_THREADS +
    running["transcribe"] * WHISPER_THREADS;
  return { busy: Math.min(budget, busy), budget };
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
      // Pass the per-job THREAD CAP (parallelization.mdx §2): image → 1 (fan wide), video → VIDEO_THREADS
      // (fan narrow). This is what lets many jobs run at once without cores² oversubscription. A one-off
      // single-file compress (the file/viewer menu) passes NO threads and uses the tool's all-core default.
      const r = await track("compress", name, async () =>
        compressFile(t.path, {
          deleteOriginal: t.compress?.deleteOriginal,
          threads: compressThreadsFor(t.compress?.mediaKind),
        }),
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
