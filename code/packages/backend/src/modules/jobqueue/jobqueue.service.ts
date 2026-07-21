// The server-side BACKGROUND JOB QUEUE (job_queue.mdx). A producing PAGE ACTION (Create Transcriptions /
// Create AI descriptions — page_actions.mdx) resolves its eligible set and calls enqueue(); enqueue pushes
// the tasks onto this in-process FIFO and RETURNS IMMEDIATELY. A bounded pool of workers drains the queue
// in the background, calling the op's existing per-file runner (transcribeOne / describeOne) — each of
// which already registers a track("transcribe"/"describe", …) progress-registry job, so a started item
// shows a live dock card. The queue writes no dock code of its own.
//
// DURABLE since crash_recovery.mdx. The original design was in-memory only, arguing that "the process IS the
// single API server, so a task that outlived a restart was not in flight anymore; on restart the queue is
// empty; re-invoking a page action re-queues only the still-unfinished files (skip-already-done makes that
// safe)." That reasoning is now PROVEN WRONG and the correction is the point of this module's rewrite: it
// assumed a human was present to re-invoke, and that the user could tell an empty queue from an annihilated
// one. On 2026-07-15 a 1,440-file batch died with the process at 22:13 (V8 heap 4.1GB) and vanished in
// silence. The backlog is now journaled to disk and restored at boot (queue-journal.ts / queue-restore.ts).
//
// It also now admits on TWO budgets, not one (memory.mdx §2.5). The old code admitted `describe` purely by
// COUNT (24) on the theory that a network-bound job has "no hardware bottleneck" — true for CPU, false for
// memory: every in-flight upload pins its full base64 payload, and 24 × ~66-90MB is what reached 4.1GB.
// Admission is now `count cap AND byte reservation`.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { transcribeOne } from "../transcribe/transcribe.service.js";
import { describeOne } from "../describe/describe.service.js";
import { ocrOne } from "../ocr/ocr.service.js";
import { compressFile } from "../compress/compression.service.js";
import { track } from "../progress/progress.registry.js";
import { bumpTopic, bumpTopicThrottled, JOBS_TOPIC } from "../events/state-events.service.js";
import type { ProviderId } from "../describe/adapters.js";
import { selectAdapter } from "../describe/adapters.js";
// The provider-account circuit (to_fix.mdx §2.4). The adapter CLASSIFIES a fault, provider-health HOLDS the
// state, and the queue — here — DECIDES what to do about it: never admit work that cannot succeed.
import { isCircuitOpen, circuitReason } from "../describe/provider-health.service.js";
import type { DeleteOriginalMode, ProcessingBatch, ProgressKind, QueuedItemView, FailedItemView } from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { coreBudget, memoryBudget } from "../../shared/concurrency.js";
import { transcribeConcurrency, activeTranscribeModelKey } from "../transcribe/transcribe-concurrency.js";
import { log, withLogContext } from "../../shared/logging.js";
import { registerHeapContextSource } from "../../shared/heap-watch.js";
import { settleOne, type BatchOutcome } from "./batch-manifest.service.js";
import { txnBegin, txnEnd, registerHeartbeatSource, startHeartbeat } from "../../shared/transactions.js";
import {
  appendEnqueued,
  appendAttempt,
  appendTerminal,
  compact,
  journalNeedsCompaction,
  liveSetCeiling,
  QUEUE_MAX_ATTEMPTS,
  type JournalTask,
  type TerminalReason,
} from "./queue-journal.js";

export type JobOp = "transcribe" | "describe" | "compress" | "ocr";
export type CompressMediaKind = "image" | "video";

export interface QueueTask {
  id?: string; // journal identity (crash_recovery.mdx §3.2) — minted at enqueue, echoed by the restore fold
  attempts?: number; // persisted strike count; QUEUE_MAX_ATTEMPTS strikes → quarantined, never replayed (§4.3)
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
//
// `ocr` is media-aware for the SAME reason compress is, and its shape is the deliberate opposite of
// describe's (ocr.mdx §10.1): OCR is LOCAL CPU — Vision/Tesseract burn cores, nothing waits on a network — so
// it draws the MASS-COMPUTE budget, not a generous network fan-out. Fanning OCR ~24-wide would be exactly the
// cores² over-subscription this table exists to prevent.
//   • ocr:image — one recognition ≈ one core → fan WIDE (`budget` jobs).
//   • ocr:video — sampling frames shells out to ffmpeg, so it fans NARROW; the extraction additionally takes
//     the SHARED transcode slot in fit-media.ts (ocr.mdx §10.3), so an OCR extraction and a describe
//     compress-to-fit compete for ONE budget instead of each believing it owns the machine.
type Bucket = "transcribe" | "describe" | "compress:image" | "compress:video" | "ocr:image" | "ocr:video";
const VIDEO_THREADS = 4; // per-job ffmpeg threads for a BATCHED video compress (a one-off passes no cap)
const WHISPER_THREADS = 4; // Whisper is multi-threaded; a couple of runs saturate the machine
// Describe waits on a vision-API network ROUND-TRIP, not local CPU — it has NO hardware bottleneck, so it
// fans MUCH wider than transcribe/compress (parallelization.mdx §3, ai_description.mdx §12.6): overlap many
// in-flight uploads instead of trickling a few through a core budget. Not core-bound — a generous fixed cap,
// bounded only by the provider's rate limit, tunable via LFB_DESCRIBE_CONCURRENCY (default 24).
const DESCRIBE_CONCURRENCY = Math.max(1, Number(process.env.LFB_DESCRIBE_CONCURRENCY) || 24);

/** The admission bucket a task competes in (compress and ocr split by media kind).
 *  OCR's kind comes straight from the FILENAME rather than a producer-stamped field: unlike compress — where
 *  the producer already knows the kind when it plans the batch — every OCR producer would have to stamp it,
 *  and a single un-stamped path would silently land a video in the wide image bucket. */
function bucketOf(t: QueueTask): Bucket {
  if (t.op === "compress") return t.compress?.mediaKind === "video" ? "compress:video" : "compress:image";
  if (t.op === "ocr") return mediaKindForName(t.path) === "video" ? "ocr:video" : "ocr:image";
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
        model: activeTranscribeModelKey(),
      });
    case "describe":
      return DESCRIBE_CONCURRENCY; // network-parallel, not core-bound
    case "ocr:image":
      return budget; // WIDE — a recognition is ~single-threaded, so one job per core (ocr.mdx §16.2 rule 3)
    case "ocr:video":
      // NARROW — each video shells out to ffmpeg to sample frames. The extraction ALSO takes the shared
      // transcode slot (ocr.mdx §10.3), so this cap and that gate agree rather than compete.
      return Math.max(1, Math.floor(budget / VIDEO_THREADS));
  }
}

/** Per-job internal thread cap plumbed into the compress tool so a batched job stays inside its slice
 *  (parallelization.mdx §2). image → 1 (fan wide), video → VIDEO_THREADS (fan narrow). */
function compressThreadsFor(kind: CompressMediaKind | undefined): number {
  return kind === "video" ? VIDEO_THREADS : 1;
}

// ── The MEMORY BUDGET — concurrency's SECOND admission test (memory.mdx §2) ──────────────────────────────
// The core budget above answers "how many jobs may run at once?". It cannot answer "how many BYTES may be in
// flight at once?", and that is the question that killed the process on 2026-07-15. A `describe` job holds its
// upload payload resident for the whole provider round-trip — Buffer + base64 + JSON body — so 24 of them is
// a ~1.6-2.2GB heap reservation that no core count can see.
//
// `INFLATION` is the honest multiplier for every representation one payload takes simultaneously (memory.mdx
// §2.2). It is ~4.0 today and the spec is explicit that it may be retuned DOWNWARD ONLY when P-29 lands and
// actually removes copies — never optimistically. Estimation is deliberately conservative: over-reserving
// costs throughput, under-reserving costs the process.
const INLINE_MAX_BYTES = 18 * 1024 * 1024; // mirrors adapters.ts INLINE_MAX_BYTES — fit-media compresses anything larger down under it
const INFLATION = 4.0;
const PER_JOB_OVERHEAD = 8 * 1024 * 1024; // response text, headers, adapter scaffolding, transient GC garbage

/**
 * What a task will cost the HEAP, estimated from `stat` alone — we must decide BEFORE reading the file.
 *
 * Only `describe` reserves: it is the one op that pulls a payload into THIS process's heap. `transcribe` and
 * `compress` stream file→file through child processes, so their memory is subprocess RSS — already governed
 * by transcribeConcurrency()'s RAM clamp and by the thread caps — and charging them against the V8 heap budget
 * would throttle them for bytes they never allocate here.
 */
function estimatedBytes(t: QueueTask): number {
  if (t.op !== "describe") return 0;
  let size = INLINE_MAX_BYTES;
  try {
    size = Math.min(fs.statSync(t.path).size, INLINE_MAX_BYTES);
  } catch {
    // unreadable → assume the worst rather than admit an unbounded job on an optimistic guess
  }
  return Math.round(size * INFLATION) + PER_JOB_OVERHEAD;
}

let memoryActive = 0; // bytes reserved by in-flight tasks

/**
 * The byte half of the admission test (memory.mdx §2.5). Admission is the CONJUNCTION:
 *
 *   admit ⇔ (running[bucket] < capFor(bucket)) AND (memoryActive + est ≤ budget OR memoryActive === 0)
 *
 * The `memoryActive === 0` clause is the LOCKED oversize rule (§2.4): a file whose estimate exceeds the whole
 * budget is admitted ALONE — it waits until nothing else is in flight, then runs as the sole job, exceeding
 * the budget by design. It is never rejected and never left waiting forever. The budget SHAPES concurrency;
 * it must never BLOCK progress. A budget that can refuse the only remaining job is a bug, not a safeguard.
 */
function memoryFits(est: number, budget: number): boolean {
  if (est <= 0) return true;
  if (memoryActive === 0) return true; // oversize-runs-alone — the anti-deadlock valve
  return memoryActive + est <= budget;
}

const pending: QueueTask[] = []; // FIFO backlog (tasks not yet started)
const inflight = new Set<string>(); // op|path currently pending OR running — the dedup set
const running: Record<Bucket, number> = {
  transcribe: 0,
  describe: 0,
  "compress:image": 0,
  "compress:video": 0,
  "ocr:image": 0,
  "ocr:video": 0,
};

const keyOf = (t: Pick<QueueTask, "op" | "path">): string => `${t.op}|${t.path}`;

/**
 * Append `tasks` to the queue and kick the drain loop, then return immediately. `queued` = how many were
 * actually added; `deduped` = how many were dropped because an identical op+path was already pending/running
 * (job_queue.mdx §2 — a double-click never double-queues).
 */
export function enqueue(tasks: QueueTask[]): { queued: number; deduped: number; refused: number } {
  let deduped = 0;
  let refused = 0;
  const admitted: QueueTask[] = [];
  const ceiling = liveSetCeiling();
  for (const t of tasks) {
    const k = keyOf(t);
    if (inflight.has(k)) {
      deduped++;
      continue;
    }
    // The live-set hard ceiling (crash_recovery.mdx §3.4): refuse the excess and REPORT it rather than write
    // an unbounded journal. A surfaced refusal, never a silent truncation.
    if (pending.length + admitted.length >= ceiling) {
      refused++;
      continue;
    }
    t.id ??= randomUUID();
    t.attempts ??= 0;
    inflight.add(k);
    admitted.push(t);
  }

  // COMMIT POINT 1 (crash_recovery.mdx §3.3): every admitted task is journaled in ONE write + ONE fsync
  // BEFORE we return. 1,440 tasks are a single ~200KB append, not 1,440 appends — the enqueue path is an HTTP
  // request that must return immediately, and per-task appends here are forbidden.
  if (admitted.length) appendEnqueued(admitted.map(toJournalTask));
  pending.push(...admitted);
  if (admitted.length) bumpTopic(JOBS_TOPIC); // an open Processing/Scans page learns the queue moved (performance.mdx Aspect 6b)

  if (refused) {
    log.warn(
      "jobqueue",
      `refused ${refused} task(s): the backlog is at its ${ceiling}-entry ceiling (LFB_QUEUE_JOURNAL_MAX_ENTRIES)`,
    );
  }
  if (admitted.length || deduped || refused) {
    // One ledger line per BATCH, not per task — the per-task pairs come from runTask (transactions_log.mdx §5.1).
    const t = txnBegin("queue_batch", {
      op: admitted[0]?.op ?? tasks[0]?.op,
      count: admitted.length,
      deduped,
      refused,
      batch: admitted[0]?.batchId,
      depth: pending.length,
    });
    txnEnd(t, refused ? "blocked" : "ok", { queued: admitted.length });
  }
  pump();
  return { queued: admitted.length, deduped, refused };
}

/** Project the in-memory task onto its journal record (crash_recovery.mdx §3.2). Nothing DERIVED travels —
 *  bucket, thread cap and budgets are recomputed live at admission so a restart never replays a stale budget. */
function toJournalTask(t: QueueTask): JournalTask {
  return {
    id: t.id!,
    op: t.op,
    path: t.path,
    overwrite: t.overwrite,
    provider: t.provider,
    compress: t.compress,
    batchId: t.batchId,
    attempts: t.attempts ?? 0,
  };
}

/**
 * Re-admit the backlog a previous session left behind (crash_recovery.mdx §4). Called ONCE at boot from
 * main.ts before any new work is accepted. Restored tasks go through the SAME admission path as fresh ones —
 * same dedup, same core budget, same memory budget — because a restored task is not a special kind of task.
 * Their journal ids and attempt counts are preserved, which is what makes the strike counter meaningful
 * across the very crash it is counting.
 */
export function admitRestored(tasks: JournalTask[]): number {
  const restored: QueueTask[] = tasks.map((j) => ({
    id: j.id,
    attempts: j.attempts,
    op: j.op as JobOp,
    path: j.path,
    overwrite: j.overwrite,
    provider: j.provider,
    compress: j.compress as QueueTask["compress"],
    batchId: j.batchId,
  }));
  let n = 0;
  for (const t of restored) {
    const k = keyOf(t);
    if (inflight.has(k)) continue;
    inflight.add(k);
    pending.push(t);
    n++;
  }
  // NOT re-journaled: these tasks are already `enq` records in the journal we just folded. Writing them again
  // would double the file on every boot.
  if (n) log.info("jobqueue", `re-admitted ${n} restored job(s) from the previous session`);
  pump();
  return n;
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
// §5 — 24h, superseding the old 30-MINUTE window. A user who opened the Processing page an hour after a
// long run found the row already swept and the errors they came to read gone. Bounded by MAX_BATCHES too.
const BATCH_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Open a batch, ADOPTING the manifest's `batchId` (processing_batches.mdx §1 — LOCKED).
 *
 * It must never mint its own id. `writeManifest()` already mints one and stamps it on every task; a second
 * id here meant the durable manifest on disk and the live row on the Processing page were describing the
 * same run under two different names, with nothing to join them.
 */
export function createBatch(input: {
  batchId: string;
  kind: ProgressKind;
  label: string;
  scope: string;
  total: number;
  provider?: string;
  engine?: string;
  deleteOriginal?: DeleteOriginalMode;
  manifestPath?: string;
}): string {
  batches.set(input.batchId, {
    batchId: input.batchId,
    kind: input.kind,
    label: input.label,
    scope: input.scope,
    provider: input.provider,
    engine: input.engine,
    total: input.total,
    ok: 0,
    rejected: 0,
    failed: 0,
    halted: 0,
    running: 0,
    errors: [],
    deleteOriginal: input.deleteOriginal,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    manifestPath: input.manifestPath,
  });
  bumpTopic(JOBS_TOPIC);
  return input.batchId;
}

/** §5 — the error list is capped so a 1,440-file failure run can't ship 1,440 rows on every 1-2s poll. */
const MAX_BATCH_ERRORS = 200;

/**
 * Fold ONE task's terminal outcome into its batch (processing_batches.mdx §4) and stamp `finishedAt` once
 * every file has settled.
 *
 * Called from `runTask`'s `finally` — the SAME choke point as the journal terminal and the manifest settle,
 * so the three can never disagree about what happened to a file. It used to be called only from the compress
 * branch, which is why a 1,440-file describe run produced NO batch row at all.
 *
 * The counters are the five-way taxonomy, not a boolean. `ok + rejected + failed + halted + running +
 * pending === total` is the identity that makes the table trustworthy (§4.1) — a two-way fold could not even
 * express it, so a batch containing a refusal or a halt could never reach `finishedAt` and hung "running"
 * forever.
 */
function recordBatchResult(
  batchId: string | undefined,
  r: { state: "ok" | "rejected" | "failed" | "halted"; path: string; reason?: string },
): void {
  if (!batchId) return;
  const b = batches.get(batchId);
  if (!b) return;

  if (r.state === "ok") b.ok++;
  else if (r.state === "rejected") b.rejected++; // a verdict — never `failed`, never `ok` (§4.2)
  else {
    if (r.state === "failed") b.failed++;
    else b.halted++;
    // `failed`/`halted` stay EXACT even when the list is capped — the count is the truth, the list is the
    // sample. Dropping the oldest keeps the most recent (usually most relevant) reasons visible.
    if (b.errors.length >= MAX_BATCH_ERRORS) b.errors.shift();
    b.errors.push({ path: r.path, reason: r.reason ?? r.state, state: r.state });
  }

  const settled = b.ok + b.rejected + b.failed + b.halted;
  if (settled >= b.total && !b.finishedAt) {
    b.finishedAt = new Date().toISOString();
    log.info(
      "jobqueue",
      `batch "${b.label}" finished: ${b.ok} ok, ${b.rejected} rejected, ${b.failed} failed, ${b.halted} halted (of ${b.total})`,
    );
  }
}

/**
 * Stop a batch (processing_batches.mdx §6.2): drain its PENDING tasks to `halted` and let the in-flight
 * ones finish. A halted file was never attempted, so it costs nothing to re-run.
 */
export function stopBatch(batchId: string): number {
  const b = batches.get(batchId);
  const n = haltPending((t) => t.batchId === batchId, "Stopped by the user", "jobqueue");
  if (b) {
    b.stoppedBy = "user";
    // A stop with nothing left pending (everything already in flight) must still settle the row rather
    // than leave it "running" until the last task drains it.
    const settled = b.ok + b.rejected + b.failed + b.halted;
    if (settled >= b.total && !b.finishedAt) b.finishedAt = new Date().toISOString();
  }
  bumpTopic(JOBS_TOPIC);
  return n;
}

/**
 * Active + recently-finished batches (§5 — retention is PROCESS LIFETIME bounded by count and age, which
 * supersedes the old 30-minute window: a user who opened the page an hour after a 1,440-file run found the
 * row already swept, so the errors they came to read were gone).
 */
const MAX_BATCHES = 200;
export function listBatches(): ProcessingBatch[] {
  const now = Date.now();
  for (const [id, b] of batches) {
    if (b.finishedAt && now - Date.parse(b.finishedAt) > BATCH_RETENTION_MS) batches.delete(id);
  }
  // FIFO ceiling on top of the age bound — oldest finished first, so a live batch is never evicted.
  if (batches.size > MAX_BATCHES) {
    const finished = [...batches.values()]
      .filter((b) => b.finishedAt)
      .sort((a, z) => Date.parse(a.finishedAt!) - Date.parse(z.finishedAt!));
    for (const b of finished) {
      if (batches.size <= MAX_BATCHES) break;
      batches.delete(b.batchId);
    }
  }
  return [...batches.values()];
}

/** Count of batches still running (used to keep the Processing nav item visible). */
export function activeBatchCount(): number {
  let n = 0;
  for (const b of batches.values()) if (!b.finishedAt) n++;
  return n;
}

// ── Per-item Processing table feeds (processing.mdx §4.3) ──────────────────────
// PENDING items as rows (the head of the queue, capped) + recently-FAILED items with their reason (kept
// through a retention window). These drive the Processing page's per-item table's Pending and Failed rows.
const QUEUED_ITEMS_CAP = 500;
/** The head of the pending backlog as rows (op + path + media kind), capped for a light poll. */
export function listQueuedItems(): QueuedItemView[] {
  return pending.slice(0, QUEUED_ITEMS_CAP).map((t) => ({
    op: t.op,
    path: t.path,
    kind: mediaKindForName(path.basename(t.path)),
    // The join to the batches table (processing.mdx §5 / AC5). `QueueTask.batchId` already existed and was
    // simply dropped here, so the two tables had nothing to join on.
    batchId: t.batchId,
  }));
}

const recentFailures: FailedItemView[] = [];
const FAILURE_RETENTION_MS = 30 * 60 * 1000;
const MAX_FAILURES = 500;
function recordFailure(f: Omit<FailedItemView, "at">): void {
  recentFailures.push({ ...f, at: new Date().toISOString() });
  if (recentFailures.length > MAX_FAILURES) recentFailures.splice(0, recentFailures.length - MAX_FAILURES);
}
/**
 * Surface tasks the boot restore QUARANTINED as Failed rows (crash_recovery.mdx §4.3, AC6).
 *
 * Quarantine used to be a `log.warn` and nothing else, which made it invisible in the product: a file
 * that crashed the app twice simply disappeared from the backlog, and the user was never told the app had
 * stopped trying. "A quarantined task is surfaced, not swallowed" — this is the surfacing.
 *
 * It lives here, rather than in queue-restore, because `recentFailures` is this module's state and
 * queue-restore is deliberately a leaf. main.ts wires the two together at boot.
 */
export function recordQuarantined(tasks: Array<{ op: string; path: string; attempts: number }>): void {
  for (const t of tasks) {
    recordFailure({
      op: t.op as JobOp,
      path: t.path,
      reason: `Quarantined — this file crashed Large File Bridge ${t.attempts === 1 ? "once" : `${t.attempts} times`} and was not retried.`,
    });
  }
  if (tasks.length) bumpTopicThrottled(JOBS_TOPIC);
}

/** Recently-failed items, pruned past the retention window (so failures stay readable after a run). */
export function listRecentFailures(): FailedItemView[] {
  const now = Date.now();
  for (let i = recentFailures.length - 1; i >= 0; i--) {
    if (now - Date.parse(recentFailures[i].at) > FAILURE_RETENTION_MS) recentFailures.splice(i, 1);
  }
  return [...recentFailures];
}

// ── A10 — the per-batch retry budget (to_fix.mdx §2.7) ─────────────────────────────────────────────────
//
// Defence in depth, BEHIND the circuit breaker. §2.4 catches the account-level faults we ENUMERATED
// (credits depleted). This catches the one we didn't: a revoked key, a region block, a model retired
// mid-run — any systemic fault that shows up only as "everything is failing." We don't have to predict
// it; we only have to notice that a batch is grinding and stop.
//
// > "Pause the batch and ask — don't grind."
//
// The ceiling is on the batch's OBSERVED failure ratio. It counts every failure rather than only
// provably-transient ones: at the queue we hold a reason string, not a classification, and a batch
// failing >20% is systemically wrong whichever kind of failure it is. Counting all of them is the
// conservative superset — it can only make us stop sooner, and stopping is the safe direction.
const BATCH_FAILURE_CEILING = 0.2;
// A ratio needs a denominator worth trusting. With <10 settled files "20%" is two files, which is noise —
// and halting a small batch on two ordinary failures would be its own bug. Below the sample floor the
// batch simply runs; per-file retry and the circuit breaker still apply.
const BATCH_CEILING_MIN_SAMPLE = 10;

interface BatchHealth {
  settled: number;
  failed: number;
  halted: boolean;
}
const batchHealth = new Map<string, BatchHealth>();

/**
 * Count one settled file against its batch's retry budget and halt the batch if it has blown through it.
 * Called from runTask's `finally`, after the task's own outcome is recorded.
 */
function noteBatchOutcome(batchId: string | undefined, reason: TerminalReason): void {
  if (!batchId) return;
  // `halted` and `skipped` are not evidence of anything going wrong: halted files were never attempted,
  // and a skip means the work was already done. Counting either would let a healthy batch halt itself.
  if (reason === "halted" || reason === "skipped") return;
  const h = batchHealth.get(batchId) ?? { settled: 0, failed: 0, halted: false };
  h.settled++;
  if (reason === "failed" || reason === "quarantined") h.failed++;
  batchHealth.set(batchId, h);
  // Bound the map. There is no reliable "batch finished" signal here to delete on — a batch can end by
  // completing, halting, or the process dying — so evict oldest-first rather than leak one entry per batch
  // in a process that runs for weeks. Insertion order is age order; the evicted batch is long settled.
  if (batchHealth.size > 200) {
    const oldest = batchHealth.keys().next().value;
    if (oldest && oldest !== batchId) batchHealth.delete(oldest);
  }
  if (h.halted || h.settled < BATCH_CEILING_MIN_SAMPLE) return;
  const ratio = h.failed / h.settled;
  if (ratio <= BATCH_FAILURE_CEILING) return;
  h.halted = true;
  const pct = Math.round(ratio * 100);
  haltPending(
    (t) => t.batchId === batchId,
    `${pct}% of this batch is failing (${h.failed} of ${h.settled}) — stopped before it ground through the rest`,
    "jobqueue",
  );
}

/**
 * Drain every pending task matching `match`, marking each HALTED — never failed (invariant §10.5).
 *
 * The shared mechanic behind BOTH stop conditions: the provider circuit (§2.4) and the batch retry
 * budget (§2.7). They differ only in which tasks they select and what they call the reason, so the
 * splice/inflight/journal/manifest bookkeeping — the part that is easy to get subtly wrong — lives once.
 */
function haltPending(match: (t: QueueTask) => boolean, reason: string, context: string): number {
  const halted: QueueTask[] = [];
  for (let i = pending.length - 1; i >= 0; i--) {
    if (!match(pending[i])) continue;
    halted.push(...pending.splice(i, 1));
  }
  if (halted.length === 0) return 0;
  for (const t of halted) {
    inflight.delete(keyOf(t));
    recordFailure({ op: t.op, path: t.path, reason, state: "halted", batchId: t.batchId });
    if (t.id) appendTerminal(t.id, "halted");
    settleOne(t.batchId, t.path, "halted", reason);
    // The live batch row too. These tasks are SPLICED OUT of `pending`, so `runTask`'s `finally` — the
    // choke point that folds every other outcome — will never run for them. Without this the halted files
    // are never counted, `ok + rejected + failed + halted` never reaches `total`, and the row hangs
    // "running" forever: the §4.1 identity broken by the very path that exists to end a doomed batch.
    recordBatchResult(t.batchId, { state: "halted", path: t.path, reason });
  }
  // ONE line for the whole drain, never one per file — the flood of identical lines is the very thing that
  // buried the signal and rotated the evidence away last time (to_fix.mdx §4.5).
  log.error(
    context,
    `HALTED ${halted.length} queued job(s): ${reason}. They were NOT attempted and NOT failed — ` +
      `fix the cause and re-run the action to queue them again (to_fix.mdx §2.4/§2.7).`,
  );
  return halted.length;
}

/** Start as many pending tasks as the per-op caps allow. Synchronous; parks when nothing is runnable. */
/**
 * Which provider circuit would block this describe task, if any (to_fix.mdx §2.4).
 *
 * Resolved through `selectAdapter` — the SAME resolution `describeOne` will perform — because a task may
 * carry `provider: "auto"` or nothing at all. Asking about a provider that would never actually run would
 * be a meaningless gate: it would either halt work that was fine or wave through work that is doomed.
 */
function blockedByCircuit(t: QueueTask): string | null {
  if (t.op !== "describe") return null;
  const kind = mediaKindForName(path.basename(t.path));
  if (kind !== "image" && kind !== "video") return null;
  const adapter = selectAdapter(kind, (t.provider as ProviderId | "auto" | undefined) ?? undefined);
  if (!adapter) return null;
  return isCircuitOpen(adapter.id) ? circuitReason(adapter.id) ?? "the provider is refusing work" : null;
}

/**
 * Drain every pending task whose provider circuit is open, marking it HALTED (to_fix.mdx §2.4).
 *
 * This is the piece that turns "the account died" from a 1,440-file retry storm into a single event. On
 * 2026-07-15 the credits ran out mid-run and every remaining file marched into the provider one at a time,
 * each holding its payload in the heap across four retries and their backoff. The queue sat pinned at
 * 24-in-flight at maximum residency for 38 minutes and then the process died.
 *
 * Halted ≠ failed: these were NEVER ATTEMPTED. They are ended in the journal (so a restart does not resume
 * them against a still-dead account) and surfaced as `halted` rows the user can re-queue in one click —
 * which re-runs the page action, which preflights first (§2.5).
 */
function haltDoomedTasks(): void {
  // The reason is read from the FIRST blocked task before the drain, because `haltPending` splices as it
  // goes and a reason resolved afterwards would be asking about a task no longer in the queue.
  const first = pending.find((t) => blockedByCircuit(t));
  if (!first) return;
  haltPending(
    (t) => blockedByCircuit(t) !== null,
    blockedByCircuit(first) ?? "the provider is refusing work",
    "jobqueue",
  );
}

function pump(): void {
  // Before admitting anything, drop work that cannot possibly succeed. The cheapest failure is the one we
  // never attempt (to_fix.mdx §2.4).
  haltDoomedTasks();
  for (;;) {
    const next = takeRunnable();
    if (!next) return;
    start(next);
  }
}

/** Remove and return the first pending task whose ADMISSION BUCKET has a free slot, else undefined
 *  (FIFO per bucket — an image task never blocks behind a full video bucket, and vice versa). */
function takeRunnable(): QueueTask | undefined {
  // Snapshot both live budgets ONCE for this whole admission scan. Reading them per-element would call
  // coreBudget()/memoryBudget() → getAppConfig() (a synchronous config.yaml read + Zod parse) for every
  // pending task on every pump cycle — O(N²) blocking disk I/O over a big batch, defeating the
  // responsiveness the budgets exist to protect. Still read LIVE per pass, so a Settings change lands on the
  // very next admission.
  const budget = coreBudget();
  const memBudget = memoryBudget();
  // A bucket whose HEAD could not be admitted for MEMORY is closed for this pass (memory.mdx §2.3 — waiters
  // are FIFO). Without this, a steady stream of small files would walk past a large one forever and starve
  // it; with it, the large file simply waits for the bucket to drain and then runs.
  const memBlocked = new Set<Bucket>();
  for (let i = 0; i < pending.length; i++) {
    const t = pending[i];
    const b = bucketOf(t);
    if (memBlocked.has(b)) continue;
    if (running[b] >= capFor(b, budget)) continue; // count cap — the upper bound
    const est = estimatedBytes(t);
    if (!memoryFits(est, memBudget)) {
      memBlocked.add(b); // head-of-line: nothing behind it in this bucket jumps the queue
      continue;
    }
    // Reserve at admission, release in the runner's `finally` (memory.mdx §2.3). The reservation covers the
    // WHOLE in-flight lifetime — fit-media's transcode buffers and the upload payload overlap in time — not
    // merely the HTTP call.
    if (est > 0) {
      memoryActive += est;
      reserved.set(t, est);
      if (est > memBudget) {
        log.warn(
          "jobqueue",
          `${t.path} needs ~${Math.round(est / 1048576)}MB, over the whole ${Math.round(memBudget / 1048576)}MB memory budget — running it ALONE (memory.mdx §2.4)`,
        );
      }
    }
    pending.splice(i, 1);
    return t;
  }
  return undefined;
}

/** Bytes reserved per in-flight task, so release is exact even if the file changed size mid-flight. A leaked
 *  reservation is a PERMANENT budget loss that degrades into a deadlock over a long run — this is the
 *  highest-risk line in the design, which is why release lives in a `finally` and keys off this map rather
 *  than re-estimating. */
const reserved = new Map<QueueTask, number>();

function releaseMemory(t: QueueTask): void {
  const est = reserved.get(t);
  if (est === undefined) return;
  reserved.delete(t);
  memoryActive = Math.max(0, memoryActive - est);
}

// ── Tell heap-watch what the queue is doing (to_fix.mdx §6.1, row E8) ──────────────────────────────────
// heap-watch is a LEAF and must never import this module (a warning that fires because memory is
// exhausted must not depend on the subsystem that exhausted it), so the dependency is inverted: the
// queue pushes a context reader in at module load and heap-watch pulls from it when it warns.
//
// This is what turns "heap at 82% of 6144MB" — true, and useless — into a line that names the 24
// in-flight describes and the 2.1 GB they reserved. memory.mdx §1.7: the numbers say you are dying, the
// queue fields say why.
registerHeapContextSource(() => ({
  queued: pending.length,
  running: running.transcribe + running.describe + running["compress:image"] + running["compress:video"],
  runningDescribe: running.describe,
  runningTranscribe: running.transcribe,
  runningCompressImage: running["compress:image"],
  runningCompressVideo: running["compress:video"],
  reservedMB: Math.round(memoryActive / (1024 * 1024)),
  // The actual in-flight FILES, newest reservations last — capped, because a heap warning that dumps 24
  // absolute paths into one line is a line nobody reads.
  inflightFiles: [...reserved.keys()]
    .slice(0, 5)
    .map((t) => `${t.op}:${path.basename(t.path)}`)
    .join(", "),
}));

function start(t: QueueTask): void {
  const b = bucketOf(t);
  running[b]++;
  // COMMIT POINT 3 (crash_recovery.mdx §3.3): the attempt is on disk BEFORE the runner is invoked. This is the
  // one write whose entire purpose is to survive the very next instruction — a task that crashes the process
  // must be KNOWN to have been attempted when we come back, or we replay the crash forever.
  t.attempts = (t.attempts ?? 0) + 1;
  if (t.id) appendAttempt(t.id, t.attempts);
  // Fire-and-forget: run the task, then free its slot + dedup key + memory reservation and re-pump.
  void runTask(t).finally(() => {
    running[b]--;
    inflight.delete(keyOf(t));
    releaseMemory(t); // ALWAYS — success, throw, timeout, abort. A leak here deadlocks the queue.
    pump();
    // Drain-to-empty compaction (crash_recovery.mdx §3.4) is the common case: a healthy machine's journal
    // collapses to nothing the moment its batch finishes.
    if (!pending.length && totalRunning() === 0) compact();
    else if (journalNeedsCompaction()) compact();
  });
}

function totalRunning(): number {
  return (
    running.transcribe +
    running.describe +
    running["compress:image"] +
    running["compress:video"] +
    running["ocr:image"] +
    running["ocr:video"]
  );
}

/**
 * Worker utilization for the Processing page's parallelism read (processing.mdx §3a): how many of the
 * mass-compute Core Budget's core-slots are BUSY right now vs the budget total. Compute jobs count their
 * thread-equivalents (a video job occupies VIDEO_THREADS cores, a transcribe WHISPER_THREADS, an image 1),
 * so "busy" reflects real cores in use; describe is network (not core-bound) and is excluded. Clamped to
 * the budget for a sane display.
 *
 * OCR IS INCLUDED, and that is the point of ocr.mdx §10.1: it is LOCAL CPU, so leaving it out — the way
 * describe is left out — would under-report a busy machine during the one op most likely to be run over an
 * entire tree.
 */
export function workerUtilization(): { busy: number; budget: number } {
  const budget = coreBudget();
  const busy =
    running["compress:image"] * 1 +
    running["compress:video"] * VIDEO_THREADS +
    running["ocr:image"] * 1 +
    running["ocr:video"] * VIDEO_THREADS +
    running["transcribe"] * WHISPER_THREADS;
  return { busy: Math.min(budget, busy), budget };
}

/**
 * Run one task by calling its per-file runner. Per-item isolation (job_queue.mdx §3): a throw is caught and
 * logged, and the worker moves on — one bad file never stalls the queue. The runners themselves already
 * return a truthful status (and register their own progress card) rather than throwing for expected outcomes.
 */
/** Queue-level durable record of a NON-thrown task failure (the runner returned a "failed"/"tool_missing"/
 *  "blocked"/… status rather than throwing). The `catch` below already logs thrown errors; this makes the
 *  queue self-sufficient — a job that fails silently is invisible — so a background run's failures always
 *  reach error.err even if a future op's runner forgets to self-log. Duplicate lines (a runner that also
 *  logs) are harmless; a missing line is not. */
function queueFailureLog(op: JobOp, filePath: string, reason: string): void {
  log.warn("jobqueue", `${op} reported failure for ${filePath}: ${reason}`);
}

/**
 * Map the queue's terminal reason onto the manifest's outcome vocabulary (to_fix.mdx §4.2).
 *
 * The `halted` mapping is the load-bearing one: a halted task was NEVER ATTEMPTED (its provider's
 * circuit was open), and recording it as `failed` would tell the user 1,440 files were tried and
 * rejected when in fact none were touched — the exact lie invariant §10.5 exists to forbid.
 */
/** Map a task's terminal reason onto the batch's five-way taxonomy (processing_batches.mdx §4). */
function batchResultState(reason: TerminalReason): "ok" | "rejected" | "failed" | "halted" {
  if (reason === "rejected") return "rejected"; // a verdict — slate, never red (§4.2)
  if (reason === "halted") return "halted"; // never attempted — amber, costs nothing to re-run (§4.3)
  if (reason === "failed" || reason === "quarantined") return "failed";
  return "ok"; // "done" | "skipped" — the output is present and correct
}

function manifestOutcome(op: JobOp, reason: TerminalReason): BatchOutcome {
  if (reason === "halted") return "halted";
  if (reason === "failed" || reason === "quarantined") return "failed";
  if (reason === "skipped") return "skipped";
  // A REFUSAL is its own outcome (processing_batches.mdx §4.2). It used to reach here as "done" and be
  // recorded on disk as "described" — the durable manifest asserting a description exists for a file that
  // has only a `.ai_description_rejected`.
  if (reason === "rejected") return "rejected";
  return op === "describe" ? "described" : op === "transcribe" ? "transcribed" : op === "ocr" ? "ocred" : "compressed";
}

/**
 * Run one task inside its ledger transaction and close its journal record whatever happens.
 *
 * The `finally` is the load-bearing line: COMMIT POINT 2 (crash_recovery.mdx §3.3) must fire on success, on
 * failure, and on a throw — the ONLY thing allowed to skip it is the process dying, which is exactly the
 * signal a missing `end` record carries to the next boot's restore.
 */
async function runTask(t: QueueTask): Promise<void> {
  // withLogContext wraps the WHOLE task (to_fix.mdx §4.4 + invariant §10.6, row C7/D2). Every log line
  // written anywhere beneath this — including from async continuations deep inside describeOne/
  // compressFile and their children — is stamped `[batch=<id> op=<op>]`, so ONE grep on a batch_id
  // reconstructs a run across log.log and error.err. It is wired HERE, at the single choke point every
  // task passes through, rather than at each call site: a call site can be forgotten, this cannot.
  // `op` is stamped EXPLICITLY (to_fix.mdx §5.1) so a "why is this run eating memory" question is
  // answered by the line itself instead of being inferred from surrounding context.
  return withLogContext({ batchId: t.batchId, op: t.op }, async () => {
    const ledger = txnBegin("queue_task", {
      op: t.op,
      file: t.path,
      attempt: t.attempts,
      maxAttempts: QUEUE_MAX_ATTEMPTS,
      depth: pending.length,
      batch: t.batchId,
    });
    let reason: TerminalReason = "done";
    let failReason: string | undefined;
    try {
      reason = await runTaskInner(t);
      txnEnd(ledger, reason === "failed" ? "failed" : "ok", { reason });
    } catch (e) {
      reason = "failed";
      failReason = (e as Error)?.message ?? String(e);
      txnEnd(ledger, "failed", { reason: failReason });
    } finally {
      if (t.id) appendTerminal(t.id, reason);
      // The manifest's per-file outcome (to_fix.mdx §4.2), recorded at the SAME choke point as the
      // journal terminal so the two can never disagree about what happened to a file.
      settleOne(t.batchId, t.path, manifestOutcome(t.op, reason), failReason);
      // …and the LIVE batch row (processing_batches.mdx §4). Hoisted here from the compress branch: every
      // op folds into its batch at the one choke point, which is what makes `describe`/`transcribe`/`ocr`
      // produce a batch row at all. `skipped` counts as `ok` — the file is present and correct, which is
      // the question the Done column answers.
      recordBatchResult(t.batchId, { state: batchResultState(reason), path: t.path, reason: failReason });
      // …and count it against the batch's retry budget (§2.7). Ordered AFTER settleOne so that, if this
      // outcome is the one that trips the ceiling, the halted remainder settles into a manifest whose
      // earlier outcomes are already recorded.
      noteBatchOutcome(t.batchId, reason);
      // Throttled: a 1,440-task batch must not become 1,440 stream lines + 1,440 client refetches.
      bumpTopicThrottled(JOBS_TOPIC);
    }
  });
}

async function runTaskInner(t: QueueTask): Promise<TerminalReason> {
  let outcome: TerminalReason = "done";
  try {
    if (t.op === "transcribe") {
      // Capture the per-file result so a failure (incl. a truncated-transcript failure — transcribe_engine
      // §4) surfaces as a Failed ROW on the Processing table (processing.mdx §4.3), not just a log line.
      const tr = await transcribeOne(t.path, t.overwrite);
      if (tr.status === "failed" || tr.status === "tool_missing") {
        outcome = "failed";
        recordFailure({ op: "transcribe", path: t.path, reason: tr.reason ?? tr.status, batchId: t.batchId });
        queueFailureLog("transcribe", t.path, tr.reason ?? tr.status);
      } else if (tr.status === "skipped" || tr.status === "needs_setup") outcome = "skipped";
    } else if (t.op === "describe") {
      const dr = await describeOne(t.path, {
        overwrite: t.overwrite,
        provider: (t.provider as ProviderId | "auto" | undefined) ?? undefined,
      });
      // NOTE the status that is NOT a failure: `rejected` — the provider CONSIDERED the file and refused it
      // (ai_description.mdx §2.3), after every retry was spent. That is an answer, and it is already durably
      // recorded in the file's `.ai_description_rejected`. Counting it as failed would (a) paint a tree of
      // copyrighted slides red when nothing is broken, and (b) feed the §2.7 batch ceiling — which is
      // exactly what halted 483 files on 2026-07-16. It drains green, same as OCR's text-free image below.
      if (dr.status === "failed" || dr.status === "no_provider" || dr.status === "unsupported") {
        outcome = "failed";
        recordFailure({ op: "describe", path: t.path, reason: dr.reason ?? dr.status, batchId: t.batchId });
        queueFailureLog("describe", t.path, dr.reason ?? dr.status);
      } else if (dr.status === "rejected") {
        // Surface the refusal as a ROW (processing.mdx §4.3.1 / §5) with its own state — slate, no Retry.
        // It is NOT a failure: `recordFailure` is only the transport for "recent per-file outcomes the
        // items table renders", and `state` is what keeps the three apart. Without this the user can see
        // that 41 files have no description (the batch counter) but never WHICH ones.
        recordFailure({ op: "describe", path: t.path, reason: dr.reason ?? "provider declined this file", state: "rejected", batchId: t.batchId });
        // Carry the verdict THROUGH to the settle point (processing_batches.mdx §4.2). This used to fall
        // through to `done`, which destroyed the signal one line before `settleOne`/`recordBatchResult`
        // could see it — so the Rejected column had nothing to count and the manifest on disk recorded a
        // refusal as "described". Still NOT a failure: it never calls recordFailure, never logs a queue
        // failure, and never feeds the §2.7 ceiling.
        outcome = "rejected";
      } else if (dr.status === "skipped" || dr.status === "needs_setup") outcome = "skipped";
    } else if (t.op === "ocr") {
      // OCR (ocr.mdx §10.5). ocrOne registers its own track("ocr", …), so the dock card comes for free.
      // NOTE the statuses that are NOT failures: `ocred` with 0 chars is a SUCCESS — most images have no text
      // (ocr.mdx §2.3) — so a tree of text-free photos must drain green, not red.
      const or = await ocrOne(t.path, { overwrite: t.overwrite });
      if (or.status === "failed" || or.status === "no_engine" || or.status === "needs_ffmpeg" || or.status === "unsupported") {
        outcome = "failed";
        recordFailure({ op: "ocr", path: t.path, reason: or.reason ?? or.status, batchId: t.batchId });
        queueFailureLog("ocr", t.path, or.reason ?? or.status);
        // `needs_setup` wrote NO artifact — the file was redirected to the storage wizard. Draining it as
        // `done` (the old fall-through, shared by all three ops above) counted work that never happened, so
        // the batch read complete while the file still has no OCR text. It is a skip, exactly as
        // summarizeOcr() has always counted it.
      } else if (or.status === "skipped" || or.status === "needs_setup") outcome = "skipped";
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
      // NOTE: no recordBatchResult here — runTask's `finally` folds EVERY op into its batch at one choke
      // point (§4). Counting here too would double-count every compressed file.
      const ok = r.status === "compressed" || r.status === "skipped";
      if (!ok) {
        outcome = "failed";
        recordFailure({ op: "compress", path: t.path, reason: r.reason ?? r.status, batchId: t.batchId });
        queueFailureLog("compress", t.path, r.reason ?? r.status);
      } else if (r.status === "skipped") outcome = "skipped";
    }
    return outcome;
  } catch (e) {
    // A throw needs no recordBatchResult here: runTask's `finally` folds the "failed" terminal for EVERY
    // op, including this one. (It used to be needed because only compress was counted.)
    // Any thrown op surfaces as a Failed row on the Processing table (processing.mdx §4.3).
    recordFailure({ op: t.op, path: t.path, reason: (e as Error).message, batchId: t.batchId });
    log.error("jobqueue", `${t.op} failed for ${t.path}: ${(e as Error).message}`);
    return "failed";
  }
}

// ── The HEARTBEAT source (transactions_log.mdx §6) ───────────────────────────────────────────────────────
// While any work is in flight the ledger emits a HEARTBEAT every ~30s carrying queue depth, running counts
// and heap. This is the line that makes an OOM PREDICTABLE instead of mysterious: heap climbing across
// successive heartbeats toward the ceiling IS the crash, visible before it happens. On 2026-07-15 there was
// no such line, so the last thing the logs knew was a successful describe at 19:50 and then four hours of
// nothing. The queue registers itself as the source rather than being imported by the ledger, so
// transactions.ts stays a leaf with no import cycle through the queue.
registerHeartbeatSource(() => ({
  depth: pending.length,
  running: totalRunning(),
  transcribe: running.transcribe,
  describe: running.describe,
  compressImage: running["compress:image"],
  compressVideo: running["compress:video"],
  // OCR joins the per-op counts (ocr.mdx §18.1): without these, a 2,000-file OCR run is invisible in the
  // heartbeat — exactly the blindness the heartbeat exists to end.
  ocrImage: running["ocr:image"],
  ocrVideo: running["ocr:video"],
  memActiveMB: Math.round(memoryActive / 1048576),
  memBudgetMB: Math.round(memoryBudget() / 1048576),
}));
startHeartbeat();

/** Internal seam for tests only (batch-taxonomy.spec.ts) — the two pure mappers at the settle choke point.
 *  Exported here rather than making them public API: they are an implementation detail of §4's taxonomy,
 *  but they are also exactly the thing a future edit is most likely to get subtly wrong. */
export const __test = { batchResultState, manifestOutcome };
