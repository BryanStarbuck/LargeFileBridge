// transactions.log — THE WORK LEDGER (transactions_log.mdx).
//
// log.log is where the app TALKS (noisy, batched, cheap). transactions.log is where the app records what it
// DID: every unit of background work and every outbound API call gets a BEGIN line and an END line, with a
// timestamp, a duration, the full absolute file path, and the fields needed to reconstruct the run later.
//
// Why it exists (the 2026-07-15 incident): a 1,440-file AI-description batch died at 22:13 PDT when V8's heap
// hit 4.1GB (`FATAL ERROR: Ineffective mark-compacts near heap limit`). The in-memory queue vaporized the
// backlog silently. Nothing in log.log or error.err showed which files were in flight, how heap had been
// climbing, or that work had stopped at all — because describeOne/transcribeOne logged ONLY terminal outcomes
// and never a START. A job that dies mid-flight left no trace it had ever begun. This ledger is that trace.
//
// Three properties, all load-bearing (transactions_log.mdx §8):
//   1. SYNCHRONOUS writes. These lines only matter ACROSS a crash; a batched async write is exactly what a
//      crash eats. The cost is ~5-6 writes/sec under a full batch — not a hot loop.
//   2. heapUsedMB/rssMB on EVERY line. One cheap process.memoryUsage() call; it is what makes an OOM legible
//      in hindsight (memory.mdx) — the last HEARTBEAT before a gap is the crash's fingerprint.
//   3. BOOT/SHUTDOWN markers. A BEGIN with no END followed by a BOOT with no intervening SHUTDOWN means
//      exactly one thing: the process died while that file was in flight. A gap becomes unambiguous.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RollingFileWriter, stripControlChars } from "./logging.js";
import { resolveLogDir } from "../config/state-dir.js";

const TXN_FILE = path.join(resolveLogDir(), "transactions.log");

// Same 5 MiB × 5 generations policy as log.log / error.err — one rotation rule, one implementation.
const writer = new RollingFileWriter(TXN_FILE);

export type TxnVerb = "BOOT" | "BEGIN" | "END" | "HEARTBEAT" | "SHUTDOWN";
export type TxnOutcome = "ok" | "failed" | "skipped" | "blocked";

/** Field values are scalars only — a ledger line is greppable key=value, never nested JSON. */
export type TxnFields = Record<string, string | number | boolean | null | undefined>;

/** A minted transaction handle. `id` correlates the BEGIN with its END and any child txns via `parent=`. */
export interface Txn {
  id: string;
  op: string;
  startedAt: number;
}

/** 6 hex chars — enough to de-interleave 24-way concurrency in a day's ledger, short enough to read. */
function mintId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6);
}

const MIB = 1024 * 1024;

/** heapUsedMB/rssMB for every line (transactions_log.mdx §3.2). Never throws. */
function memFields(): TxnFields {
  try {
    const m = process.memoryUsage();
    return { heapUsedMB: Math.round(m.heapUsed / MIB), rssMB: Math.round(m.rss / MIB) };
  } catch {
    return {};
  }
}

/**
 * Render `key=value` pairs, dropping undefined/null so an absent field never becomes the string "undefined".
 * EVERY value passes through stripControlChars(): file paths are untrusted input and a newline inside one
 * would forge a ledger line (the same log-injection defense logging.ts applies).
 */
function renderFields(fields: TxnFields): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${typeof v === "number" || typeof v === "boolean" ? String(v) : stripControlChars(v, 1024)}`);
  }
  return parts.join(" ");
}

/** Write one ledger line SYNCHRONOUSLY. Never throws — the ledger must never take the app down. */
function emit(verb: TxnVerb, context: string, fields: TxnFields): void {
  try {
    const line = `[${new Date().toISOString()}] [${verb}]${" ".repeat(Math.max(1, 10 - verb.length))}[${stripControlChars(
      context,
      64,
    )}] ${renderFields({ ...fields, ...memFields() })}`;
    writer.writeSync(line);
  } catch {
    // A ledger write must never crash the app or mask the real error.
  }
}

/**
 * Open a transaction: emit BEGIN and return the handle to close with txnEnd(). Prefer txn() below, which
 * guarantees the END via `finally` — a BEGIN whose END can be skipped by an early return is a lie in the
 * ledger (it reads as "died in flight").
 */
export function txnBegin(op: string, fields: TxnFields = {}): Txn {
  const id = mintId();
  emit("BEGIN", op, { txn: id, op, ...fields });
  return { id, op, startedAt: Date.now() };
}

/** Close a transaction: emit END with the elapsed wall duration and an outcome. */
export function txnEnd(t: Txn, outcome: TxnOutcome, fields: TxnFields = {}): void {
  emit("END", t.op, { txn: t.id, op: t.op, outcome, ms: Date.now() - t.startedAt, ...fields });
}

/**
 * Wrap a unit of work in a BEGIN/END pair. The END fires in a `finally`, so it survives a throw, an early
 * return, and a rejected promise — the ONLY thing that can suppress it is the process dying, which is exactly
 * the signal we want a missing END to carry.
 *
 * `body` receives the Txn so it can (a) parent child txns to it and (b) attach END fields it discovers while
 * running (chars written, bytes out, the model that actually served the call) via the `end` accumulator.
 */
export async function txn<T>(
  op: string,
  fields: TxnFields,
  body: (t: Txn, end: (f: TxnFields) => void) => Promise<T>,
): Promise<T> {
  const t = txnBegin(op, fields);
  let endFields: TxnFields = {};
  const addEndFields = (f: TxnFields): void => {
    endFields = { ...endFields, ...f };
  };
  try {
    const r = await body(t, addEndFields);
    txnEnd(t, endFields.outcome === undefined ? "ok" : (endFields.outcome as TxnOutcome), endFields);
    return r;
  } catch (e) {
    txnEnd(t, "failed", { ...endFields, reason: (e as Error)?.message ?? String(e) });
    throw e;
  }
}

// ── Liveness: BOOT / SHUTDOWN / HEARTBEAT ────────────────────────────────────────────────────────────────
// A ledger with no BOOT marker cannot distinguish "the batch finished" from "the process was replaced".

/** Emitted once at startup, before any work is admitted — a fresh ledger epoch. */
export function txnBoot(fields: TxnFields = {}): void {
  emit("BOOT", "process", { pid: process.pid, node: process.version, ...fields });
}

/** Emitted on a CLEAN exit (SIGINT/SIGTERM). Its ABSENCE before a BOOT is what proves a crash. */
export function txnShutdown(fields: TxnFields = {}): void {
  emit("SHUTDOWN", "process", { pid: process.pid, ...fields });
}

/**
 * The heartbeat's payload is supplied by whoever owns the queue, registered here rather than imported, so
 * this module stays a leaf: jobqueue.service.ts imports transactions.ts, never the reverse (an import cycle
 * through the queue would be a boot-order hazard in the one module that must always work).
 */
type HeartbeatSource = () => TxnFields;
let heartbeatSource: HeartbeatSource | null = null;
export function registerHeartbeatSource(fn: HeartbeatSource): void {
  heartbeatSource = fn;
}

const HEARTBEAT_MS = Math.max(1000, Number(process.env.LFB_HEARTBEAT_MS) || 30_000);
let heartbeatTimer: NodeJS.Timeout | null = null;

/**
 * While ANY work is in flight, emit a HEARTBEAT every ~30s carrying queue depth, running counts, and heap.
 * This is the line that makes an OOM predictable instead of mysterious: heap climbing across successive
 * heartbeats toward the ceiling IS the crash, visible before it happens (memory.mdx P-32).
 *
 * The timer is unref()'d so a heartbeat never keeps a finished process alive, and it only ticks while the
 * source reports work — an idle app writes nothing.
 */
export function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    try {
      const f = heartbeatSource?.() ?? {};
      // Only beat while there is work — an idle app must not fill the ledger with noise.
      const busy = Number(f.depth ?? 0) + Number(f.running ?? 0);
      if (busy > 0) emit("HEARTBEAT", "queue", f);
    } catch {
      // never let a heartbeat throw
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
}
