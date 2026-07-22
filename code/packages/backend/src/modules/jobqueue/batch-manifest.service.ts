// The BATCH MANIFEST (to_fix.mdx §4, rows C1–C5). One durable, timestamped YAML per bulk run, written
// BEFORE anything is enqueued and carrying THE FULL FILE LIST.
//
// WHY THIS EXISTS. On 2026-07-15 a 1,440-file AI-description batch was queued 106 minutes after the
// provider's credits died, ground through ~4,070 doomed retries, and died in a V8 OOM. Reconstructing
// what had been in it took hours, because nothing on disk knew. The queue journal
// (crash_recovery.mdx) records TASKS so the machine can replay them; the ledger (transactions_log.mdx)
// records CALLS so an auditor can trace them. Neither captures the INTENT at click time — this scope,
// these files, this provider, this config, this moment. That is this file's whole job, and the file
// list is the mandatory part: without it a lost batch cannot be reconstructed (§4.1).
//
// FORMAT — one YAML file, appended to, valid at every instant. The header + file list are written once
// under writeYaml's atomic tmp+rename; per-file outcomes then APPEND as list items beneath an open
// `outcomes:` key, and the terminal record appends as top-level keys after them. Appending is not a
// stylistic choice: rewriting the whole document per outcome would be O(n²) on the exact 1,440-file
// batch this was built for — a manifest that itself became a performance incident would be a poor
// monument to one. Every append is a single O(1) fs.appendFileSync, and because a list item and a
// top-level key are both legal continuations, a reader can parse the file mid-run.
//
// A MANIFEST WITH NO TERMINAL RECORD MEANS IT CRASHED (§4.2). That absence is the durable signal — do
// not "helpfully" write a terminal record on a path that did not actually reach a terminal state.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import v8 from "node:v8";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { resolveBatchesDir } from "../../config/state-dir.js";
import { log } from "../../shared/logging.js";

/** What a batch did to each file. `halted` and `never_attempted` are NOT failures (§4.2, §7.3). */
export type BatchOutcome =
  | "described"
  | "transcribed"
  | "compressed"
  | "ocred"
  | "processed" // a Videos-scan item (hash/fingerprint/signature/pair compare) that completed (videos.mdx §4)
  | "rejected" // the provider REFUSED this file — a verdict, not a fault (processing_batches.mdx §4.2)
  | "failed"
  | "halted"
  | "never_attempted"
  | "skipped";

/** How a batch ended. The absence of any of these on disk means it crashed (§4.2). */
export type BatchTerminalState = "completed" | "halted" | "crashed";

export interface ManifestFile {
  path: string;
  sizeBytes?: number;
}

export interface ManifestInput {
  op: string; // EXPLICIT, never inferred (§4.1 / §5)
  scope: string;
  provider?: string;
  model?: string;
  providerPreflight?: string;
  counts?: Record<string, number>;
  concurrency?: Record<string, number>;
  files: ManifestFile[];
}

export interface ManifestHandle {
  batchId: string;
  file: string;
}

/**
 * `2026-07-15_21-35-02_describe_1440_a1b2c3d4.yaml` — sorts chronologically, says what it was at a
 * glance, and cannot collide.
 *
 * The batch_id's first 8 hex are NOT decoration. Timestamp+op+count alone collide whenever two batches
 * start in the same SECOND with the same op and size — two clicks on the same folder, or any programmatic
 * enqueue — and a collision would silently OVERWRITE the earlier manifest. Destroying one batch's only
 * durable record while writing another's is precisely the failure this file exists to prevent, so the
 * name carries the one field guaranteed unique.
 */
function manifestFileName(op: string, count: number, now: Date, batchId: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_` +
    `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  const safeOp = op.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "batch";
  return `${stamp}_${safeOp}_${count}_${batchId.slice(0, 8)}.yaml`;
}

/** One outcome/terminal line appended to an open manifest. Never throws: a manifest that cannot be
 *  written must not take down the batch it is only observing. */
function append(file: string, text: string): void {
  try {
    fs.appendFileSync(file, text, "utf8");
  } catch (e) {
    log.warn("batch-manifest", `could not append to ${file}: ${(e as Error).message}`);
  }
}

/**
 * Write the manifest and return its id + path. Call this BEFORE enqueuing (§4.1, invariant §10.4) —
 * a manifest written afterwards would miss exactly the crash it exists to explain.
 *
 * Never throws. If the manifest cannot be written we log and hand back a handle anyway, so the batch
 * still runs: observability failing must not cost the user their work.
 */
export function writeManifest(input: ManifestInput): ManifestHandle {
  const batchId = randomUUID();
  const now = new Date();
  const file = path.join(resolveBatchesDir(), manifestFileName(input.op, input.files.length, now, batchId));
  const header: Record<string, unknown> = {
    batch_id: batchId,
    op: input.op,
    started: now.toISOString(),
    scope: input.scope,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.providerPreflight ? { provider_preflight: input.providerPreflight } : {}),
    ...(input.counts ? { counts: input.counts } : {}),
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    environment: {
      heap_limit_mb: Math.round(heapLimitBytes() / (1024 * 1024)),
      machine_ram_gb: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
      cores: os.cpus().length,
      node: process.version,
    },
    files: input.files.map((f) => ({ path: f.path, ...(f.sizeBytes != null ? { size_bytes: f.sizeBytes } : {}) })),
  };
  try {
    // Write the header+list in ONE shot, then leave `outcomes:` open for O(1) appends.
    fs.writeFileSync(file, `${YAML.stringify(header)}outcomes:\n`, "utf8");
    log.info("batch-manifest", `wrote ${path.basename(file)} — ${input.files.length} file(s), op=${input.op}`);
  } catch (e) {
    log.warn("batch-manifest", `could not write manifest for ${input.op}: ${(e as Error).message}`);
  }
  const handle = { batchId, file };
  remember(handle);
  return handle;
}

// V8's REAL old-space ceiling, for the manifest's environment block (memory.mdx P-31). Read from V8
// rather than parsed back out of NODE_OPTIONS: the incident's root condition was a ~4 GB limit nobody
// had chosen, so the manifest must record the limit that was actually in force, not the one we meant.
function heapLimitBytes(): number {
  try {
    return v8.getHeapStatistics().heap_size_limit;
  } catch {
    return 0;
  }
}

/** Append one file's outcome (§4.2). Safe to call from any task, in any order. */
export function appendOutcome(handle: ManifestHandle | undefined, filePath: string, outcome: BatchOutcome, reason?: string): void {
  if (!handle) return;
  const entry: Record<string, unknown> = { path: filePath, outcome };
  if (reason) entry.reason = reason.slice(0, 300);
  // JSON, deliberately: YAML is a superset of JSON, so this is a valid YAML flow mapping AND it is
  // guaranteed to be exactly ONE line. A block-style dump could wrap or fold, and a wrapped line breaks
  // both the O(1)-append property and `grep outcome=failed`. One outcome, one line, one write.
  append(handle.file, `  - ${JSON.stringify(entry)}\n`);
}

/**
 * Close the manifest with a terminal record (§4.2). Its PRESENCE is what distinguishes a batch that
 * ended from one that was killed — so only call it when a terminal state was genuinely reached.
 */
export function finalizeManifest(
  handle: ManifestHandle | undefined,
  state: BatchTerminalState,
  finalCounts?: Record<string, number>,
): void {
  if (!handle) return;
  const terminal: Record<string, unknown> = { finished: new Date().toISOString(), terminal_state: state };
  if (finalCounts) terminal.final_counts = finalCounts;
  append(handle.file, YAML.stringify(terminal));
  log.info("batch-manifest", `finalized ${path.basename(handle.file)} — ${state}`);
}

// ── batchId → open manifest ────────────────────────────────────────────────────────────────────────────
// Tasks carry a batchId, not a file path, so the runner needs a way back to the manifest. The map is the
// fast path; the disk scan behind it is what makes this survive a RESTART — after a crash the queue
// journal restores tasks whose batchId refers to a manifest this process never opened, and those
// outcomes belong in the original manifest rather than being silently dropped. Resolved handles are
// memoized, including nothing-found, so a restored batch scans once rather than per file.
const openManifests = new Map<string, ManifestHandle | null>();

/** The manifest for `batchId`, from memory or (after a restart) from disk. `undefined` ⇒ no manifest,
 *  which is a normal state: a one-off single-file job has no batch and writes no manifest. */
export function handleFor(batchId: string | undefined): ManifestHandle | undefined {
  if (!batchId) return undefined;
  const cached = openManifests.get(batchId);
  if (cached !== undefined) return cached ?? undefined;
  const found = listManifests(200).find((m) => m.batchId === batchId);
  const handle = found ? { batchId, file: found.file } : null;
  openManifests.set(batchId, handle);
  return handle ?? undefined;
}

/** Remember a freshly written manifest so the first outcome doesn't pay for a disk scan. */
function remember(handle: ManifestHandle): void {
  openManifests.set(handle.batchId, handle);
  // Bound the map: a long-running process that ran thousands of batches must not accumulate handles.
  if (openManifests.size > 200) {
    const oldest = openManifests.keys().next().value;
    if (oldest) openManifests.delete(oldest);
  }
}

// ── Batch lifecycle: knowing when a batch is DONE ──────────────────────────────────────────────────────
// The in-memory ProcessingBatch registry can't answer this: it is compress-only and its recordBatchResult
// early-returns for describe/transcribe. So the manifest keeps its own outstanding-count, seeded at
// enqueue and decremented as each file settles. At zero we write the terminal record (§4.2) — the
// presence of which is precisely what distinguishes "this batch ended" from "this batch was killed."
//
// A batch whose count never reaches zero (the process died) therefore leaves a manifest with NO terminal
// record — the durable crash signal, obtained for free by not writing one.
interface BatchTally {
  outstanding: number;
  counts: Record<string, number>;
}
const tallies = new Map<string, BatchTally>();

/** Seed the outstanding count at enqueue. `total` is how many tasks actually entered the queue. */
export function trackBatch(batchId: string | undefined, total: number): void {
  if (!batchId || total <= 0) return;
  tallies.set(batchId, { outstanding: total, counts: {} });
}

/**
 * Record one file's outcome and, when the batch's last file settles, close the manifest (§4.2).
 * Safe to call for a task with no batch, no manifest, or an unknown id — all no-op.
 */
export function settleOne(batchId: string | undefined, filePath: string, outcome: BatchOutcome, reason?: string): void {
  if (!batchId) return;
  const handle = handleFor(batchId);
  appendOutcome(handle, filePath, outcome, reason);
  const tally = tallies.get(batchId);
  if (!tally) return;
  tally.counts[outcome] = (tally.counts[outcome] ?? 0) + 1;
  tally.outstanding--;
  if (tally.outstanding > 0) return;
  tallies.delete(batchId);
  // A batch that ends with any file halted ended BECAUSE it was halted — say so, so the terminal record
  // reflects why it stopped rather than flattening a mass-halt into "completed" (§2.4, §7.3).
  const state: BatchTerminalState = (tally.counts.halted ?? 0) > 0 ? "halted" : "completed";
  finalizeManifest(handle, state, tally.counts);
}

/** Drop a batch's tally without finalizing — for an enqueue that ultimately queued nothing. */
export function forgetBatch(batchId: string | undefined): void {
  if (batchId) tallies.delete(batchId);
}

export interface ManifestSummary {
  batchId: string;
  file: string;
  op: string;
  started: string;
  scope: string;
  fileCount: number;
  finished: string | null; // null ⇒ no terminal record ⇒ it crashed (§4.2)
  terminalState: BatchTerminalState | null;
}

/** Every manifest on disk, newest first. Powers "what ran last night, and did it finish?" (§4.3). */
export function listManifests(limit = 50): ManifestSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(resolveBatchesDir()).filter((n) => n.endsWith(".yaml"));
  } catch {
    return [];
  }
  const out: ManifestSummary[] = [];
  for (const name of names.sort().reverse().slice(0, limit)) {
    const file = path.join(resolveBatchesDir(), name);
    try {
      const doc = YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> | null;
      if (!doc) continue;
      out.push({
        batchId: String(doc.batch_id ?? ""),
        file,
        op: String(doc.op ?? "?"),
        started: String(doc.started ?? ""),
        scope: String(doc.scope ?? ""),
        fileCount: Array.isArray(doc.files) ? doc.files.length : 0,
        finished: doc.finished ? String(doc.finished) : null,
        terminalState: (doc.terminal_state as BatchTerminalState) ?? null,
      });
    } catch (e) {
      log.warn("batch-manifest", `could not parse ${name}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Read a manifest's file list + outcomes so the unfinished remainder can be re-queued (§4.3). */
export function readManifest(batchId: string): { op: string; provider?: string; unfinished: string[] } | null {
  for (const s of listManifests(200)) {
    if (s.batchId !== batchId) continue;
    try {
      const doc = YAML.parse(fs.readFileSync(s.file, "utf8")) as Record<string, unknown>;
      const files = (Array.isArray(doc.files) ? doc.files : []) as Array<{ path?: string }>;
      const outcomes = (Array.isArray(doc.outcomes) ? doc.outcomes : []) as Array<{ path?: string; outcome?: string }>;
      // "Unfinished" is anything that did not reach a SUCCESSFUL terminal outcome. A halted or
      // never_attempted file is by definition re-queueable (§2.4) — that is the point of the state.
      const settled = new Set(
        outcomes.filter((o) => o.outcome && !["halted", "never_attempted", "failed"].includes(o.outcome)).map((o) => o.path),
      );
      return {
        op: String(doc.op ?? ""),
        provider: doc.provider ? String(doc.provider) : undefined,
        unfinished: files.map((f) => f.path).filter((p): p is string => !!p && !settled.has(p)),
      };
    } catch (e) {
      log.warn("batch-manifest", `could not read manifest ${batchId}: ${(e as Error).message}`);
      return null;
    }
  }
  return null;
}
