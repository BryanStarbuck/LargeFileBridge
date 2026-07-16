// The DURABLE BACKLOG JOURNAL (crash_recovery.mdx §3) — the file that makes a queued batch survive the
// process that hosts it.
//
// Why this exists: on 2026-07-15 a 1,440-file AI-description batch was queued and walked away from. At 22:13
// the backend OOM'd (V8 heap 4.1GB) and the ENTIRE backlog vanished, because the queue was a plain in-memory
// array. The old design argued that was fine — "on restart the queue is empty; re-invoking a page action
// re-queues only the still-unfinished files". That reasoning assumed a human is present to re-invoke, and
// that the user could TELL an empty queue from an annihilated one. Neither held. A background queue that
// cannot survive its own process is not a queue, it is a plan.
//
// The format is an APPEND-ONLY JSONL log, not a YAML document, and that choice is load-bearing (§3.1): a
// rewritten-whole document costs a full serialize+fsync per completed file — thousands of O(N) rewrites of a
// growing file, on the hot path of the very batch we are protecting. An append-only line log makes the common
// case (one task terminated) a single small append, which is the only discipline that survives `kill -9`
// without either losing data or costing O(N) per event.
//
// The three commit points are SYNCHRONOUS + fsync'd (§3.3). A batched async write is wrong here by
// construction: a 200ms flush window is a 200ms hole exactly the size of the failure we are defending
// against. Everything outside these three points is best-effort and must never block.
import fs from "node:fs";
import path from "node:path";
import { resolveQueueDir } from "../../config/state-dir.js";
import { log } from "../../shared/logging.js";

const JOURNAL_FILE = path.join(resolveQueueDir(), "queue.jsonl");

/** Compact once the journal passes this size, so an append-only log can never become a leak (§3.4). */
const JOURNAL_MAX_BYTES = Math.max(1, Number(process.env.LFB_QUEUE_JOURNAL_MAX_BYTES) || 8 * 1024 * 1024);
/** Hard ceiling on the LIVE set — excess is refused and REPORTED, never silently truncated (§3.4). */
const JOURNAL_MAX_ENTRIES = Math.max(1, Number(process.env.LFB_QUEUE_JOURNAL_MAX_ENTRIES) || 50_000);
/** Strikes before a task that keeps killing us is quarantined (§4.3). Two, not five — bias hard. */
export const QUEUE_MAX_ATTEMPTS = Math.max(1, Number(process.env.LFB_QUEUE_MAX_ATTEMPTS) || 2);

// "halted" (to_fix.mdx §2.4) is NOT a synonym for "failed". A halted task was NEVER ATTEMPTED — the
// provider's circuit opened (credits depleted, key revoked) and the queue dropped it before it could burn a
// doomed upload. It ends the task in the journal, so a restart does NOT silently resume 1,290 uploads
// against a still-dead account (to_fix.mdx §13); the user re-queues via the page action, which preflights
// first (§2.5). Recording it as "failed" would be a lie the user acts on — they would see 1,440 failures and
// conclude the files are bad, when nothing was ever tried.
export type TerminalReason = "done" | "skipped" | "failed" | "quarantined" | "halted";

/** The `enq` record — everything needed to reconstruct a task from nothing (§3.2). Nothing DERIVED is
 *  journaled: the bucket, thread cap and budgets are recomputed live at admission, so a restart never
 *  replays a stale budget. */
export interface JournalTask {
  id: string;
  op: string;
  path: string;
  overwrite: boolean;
  provider?: string;
  compress?: { deleteOriginal: string; mediaKind: string };
  batchId?: string;
  attempts: number;
}

type Record_ =
  | ({ t: "enq"; at: string } & JournalTask)
  | { t: "end"; at: string; id: string; r: TerminalReason }
  | { t: "try"; at: string; id: string; n: number };

/**
 * TORN-TAIL REPAIR — the first append after boot must not glue itself onto a half-written line.
 *
 * A `kill -9` or a V8 abort can land in the MIDDLE of an append, leaving a partial, newline-less final line.
 * That much the fold tolerates (it skips unparseable lines). What it cannot tolerate is the NEXT record being
 * concatenated onto that stump: `{"t":"enq","id":"torn-{"t":"end",…}` is one corrupt line, so a perfectly good
 * record is destroyed by the previous crash's debris. Found by test, not by inspection: a quarantined task's
 * `end` record was eaten this way and the poison task RESURRECTED on the next boot — the exact outcome the
 * strike counter exists to prevent.
 *
 * So: once per process, before our first append, check whether the file ends in a newline and heal it if not.
 * Every line WE write ends in "\n", so after that first check the invariant holds for the rest of the process
 * and the check costs nothing more.
 */
let tailChecked = false;
function healTornTail(fd: number): string {
  if (tailChecked) return "";
  tailChecked = true;
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return "";
    const buf = Buffer.alloc(1);
    // Read the final byte directly — an append-mode fd can still be read positionally.
    const rfd = fs.openSync(JOURNAL_FILE, "r");
    try {
      fs.readSync(rfd, buf, 0, 1, size - 1);
    } finally {
      fs.closeSync(rfd);
    }
    if (buf[0] !== 0x0a) {
      log.warn("queue-journal", "journal ended mid-line (a previous run died while writing) — healing the tail");
      return "\n"; // terminate the stump so the fold discards IT and nothing after it
    }
  } catch {
    // If we cannot tell, prefer a harmless extra newline over a corrupted record.
    return "\n";
  }
  return "";
}

/** Append raw lines with a single write + fsync. Never throws — a journal failure must not take down the
 *  queue it protects; it degrades us to the old in-memory behavior, loudly. */
function appendSync(lines: string[]): void {
  if (!lines.length) return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(JOURNAL_FILE, "a");
    fs.writeSync(fd, healTornTail(fd) + lines.join(""));
    fs.fsyncSync(fd); // the whole point: on disk BEFORE the thing it describes can be lost
  } catch (e) {
    log.warn("queue-journal", `failed to append ${lines.length} record(s): ${(e as Error).message}`);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

const line = (r: Record_): string => `${JSON.stringify(r)}\n`;

/**
 * COMMIT POINT 1 — enqueue. ALL admitted tasks are journaled in ONE write + ONE fsync before enqueue returns.
 * 1,440 tasks are one ~200KB append, NOT 1,440 appends (§3.3) — per-task appends on enqueue are forbidden,
 * because the enqueue path is a single HTTP request that must return immediately.
 */
export function appendEnqueued(tasks: JournalTask[]): void {
  const at = new Date().toISOString();
  appendSync(tasks.map((t) => line({ t: "enq", at, ...t })));
}

/**
 * COMMIT POINT 3 — attempt. Written synchronously BEFORE the runner is invoked, because a task that crashes
 * the process must be KNOWN to have been attempted when we come back (§4.3). This is the one write whose
 * entire purpose is to survive the very next instruction.
 */
export function appendAttempt(id: string, n: number): void {
  appendSync([line({ t: "try", at: new Date().toISOString(), id, n })]);
}

/** COMMIT POINT 2 — terminal transition. A ~80-byte synchronous append per file: at 24-way concurrency that
 *  is a couple dozen tiny appends a minute, orders of magnitude below the transcode and network cost of the
 *  work itself. A synchronous append here is affordable; a lost backlog is not. */
export function appendTerminal(id: string, r: TerminalReason): void {
  appendSync([line({ t: "end", at: new Date().toISOString(), id, r })]);
}

/**
 * The LIVE BACKLOG is the FOLD of the journal: every `enq` whose id has no `end`, carrying the highest
 * attempt number seen for it. A torn final line (killed mid-write) is skipped rather than fatal — the whole
 * file must remain readable after the exact crash it exists to survive.
 */
export function foldLiveSet(): JournalTask[] {
  let raw: string;
  try {
    raw = fs.readFileSync(JOURNAL_FILE, "utf8");
  } catch {
    return []; // no journal = nothing was in flight
  }
  const live = new Map<string, JournalTask>();
  const ended = new Set<string>();
  const attempts = new Map<string, number>();
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let r: Record_;
    try {
      r = JSON.parse(l) as Record_;
    } catch {
      continue; // a torn line (crash mid-append) — skip it, never fail the whole fold
    }
    if (r.t === "enq") live.set(r.id, { ...r });
    else if (r.t === "end") ended.add(r.id);
    else if (r.t === "try") attempts.set(r.id, Math.max(attempts.get(r.id) ?? 0, r.n));
  }
  const out: JournalTask[] = [];
  for (const [id, t] of live) {
    if (ended.has(id)) continue;
    out.push({ ...t, attempts: Math.max(t.attempts ?? 0, attempts.get(id) ?? 0) });
  }
  return out;
}

/**
 * Compaction (§3.4) — rewrite the journal down to just the folded live set. Called when the queue drains to
 * empty (the common case: a healthy machine's journal is normally empty) and when the file passes the size
 * cap. temp + fsync + rename: the rename is the atomic commit, so a crash mid-compaction leaves either the
 * whole old journal or the whole new one, never a torn file.
 */
export function compact(): void {
  try {
    const size = fs.existsSync(JOURNAL_FILE) ? fs.statSync(JOURNAL_FILE).size : 0;
    if (size === 0) return;
    const live = foldLiveSet();
    const at = new Date().toISOString();
    const body = live.map((t) => line({ t: "enq", at, ...t })).join("");
    const tmp = `${JOURNAL_FILE}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, JOURNAL_FILE); // atomic commit
  } catch (e) {
    log.warn("queue-journal", `compaction failed (harmless, will retry): ${(e as Error).message}`);
  }
}

/** True when the journal has grown past its size cap and should be compacted (§3.4). */
export function journalNeedsCompaction(): boolean {
  try {
    return fs.existsSync(JOURNAL_FILE) && fs.statSync(JOURNAL_FILE).size > JOURNAL_MAX_BYTES;
  } catch {
    return false;
  }
}

/** The live-set ceiling (§3.4). enqueue() refuses the excess and REPORTS it rather than writing an unbounded
 *  file — a surfaced refusal, never a silent truncation. */
export function liveSetCeiling(): number {
  return JOURNAL_MAX_ENTRIES;
}

export function journalPath(): string {
  return JOURNAL_FILE;
}
