// heap-watch.ts — the predictive half of our OOM story (memory.mdx P-32).
//
// The hard constraint that shapes this whole file: a V8 out-of-memory abort is NOT an exception. The
// runtime prints its own `FATAL ERROR: Ineffective mark-compacts near heap limit` banner to stderr and
// calls abort(3). No JavaScript runs after that — no process.on("uncaughtException"), no shutdown
// flush, no RollingFileWriter write. On 2026-07-15 at 22:13 PDT that is exactly what happened: the heap
// reached 4.1 GB during a 1,440-file AI-description batch and the process vanished, leaving log.log and
// error.err with NOTHING in them. The only trace was launcher.log, a file we never designed to be a
// crash log.
//
// So we do not try to log the abort. We log the APPROACH. This module samples the heap on a timer and,
// when it crosses a fraction of the real ceiling, writes a WARN to error.err AND a line to the work
// ledger — minutes before the runtime would give up. That is the signal that would have let us catch
// the incident at 21:40 instead of discovering it at 04:00, and it is what invariant 8 in memory.mdx
// demands: "Every OOM-class failure must be preceded by a WARN we wrote."
//
// This is a BACKSTOP and a DETECTOR, not a cure. The cure is the byte-based admission gate (P-28) that
// stops 24 concurrent uploads from pinning ~2 GB of base64 in the first place. A warning that fires
// every night is a bug report about the gate, not a feature of this file.
//
// Zero dependencies beyond node:v8 — instrumentation must never be the thing that takes the server down.
import v8 from "node:v8";
import { log } from "./logging.js";
import { txnBegin, txnEnd, type TxnFields } from "./transactions.js";

const MIB = 1024 * 1024;

/**
 * ~12s. Fast enough that a heap climbing from 2 GB to the ceiling under a saturated describe batch is
 * caught with minutes to spare, slow enough that the sample itself is free: process.memoryUsage() is a
 * cheap synchronous read (microseconds — it does NOT force a GC), so 5 samples/minute costs nothing
 * measurable against a workload whose unit is a 35-second network round trip.
 */
const SAMPLE_MS = Math.max(1000, Number(process.env.LFB_HEAP_SAMPLE_MS) || 12_000);

/**
 * Warn at 80% of the ceiling (memory.mdx P-32). The number is a compromise between two failure modes:
 * too low and a healthy batch cries wolf every night until the warning is ignored; too high and V8 is
 * already thrashing mark-compacts by the time we speak, which is the situation we are trying to get
 * ahead of. 80% of a 6 GB ceiling is ~4.8 GB — roughly 1.2 GB of headroom, which at the incident's
 * observed climb rate is minutes of warning, not seconds.
 */
const WARN_FRACTION = clampFraction(Number(process.env.LFB_HEAP_WARN_FRACTION) || 0.8);

/**
 * Hysteresis: once we have warned we do not re-arm until the heap falls a few points BELOW the
 * threshold. Without this, a heap oscillating around the line (which is precisely what a busy heap
 * does — it saws up to a GC and back down) would re-cross it constantly and re-arm the "crossing"
 * warning on every tick, defeating the cooldown.
 */
const REARM_FRACTION = Math.max(0, WARN_FRACTION - 0.05);

/**
 * After the crossing warning, warn at most every 5 minutes while we stay over the line. A long batch
 * parked just above the threshold must leave a periodic trail (so the ledger shows the heap sitting
 * hot for an hour) without flooding error.err — the fault trail is only useful if it stays readable.
 */
const REWARN_MS = Math.max(10_000, Number(process.env.LFB_HEAP_WARN_COOLDOWN_MS) || 5 * 60_000);

/**
 * The TRUTHFUL ceiling. v8.getHeapStatistics().heap_size_limit reflects --max-old-space-size when we
 * set it (package.json's NODE_OPTIONS, P-31) and V8's own default when we don't — so the denominator on
 * every warning is the number the runtime will actually abort at, never a number we assumed. Read once:
 * the limit cannot change during the life of a process.
 */
function heapCeilingBytes(): number {
  try {
    const limit = v8.getHeapStatistics().heap_size_limit;
    return Number.isFinite(limit) && limit > 0 ? limit : 0;
  } catch {
    return 0;
  }
}

function clampFraction(n: number): number {
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return 0.8;
  return n;
}

/**
 * Context supplied by whoever owns the queue — queue depth, in-flight counts, reservation totals. It is
 * REGISTERED here rather than imported so this module stays a leaf: a warning that fires because memory
 * is exhausted must not depend on an import cycle through the subsystem that exhausted it.
 *
 * Optional by design. With no source registered the warning still carries the heap numbers, which alone
 * are enough to tell you the process is about to die; the queue fields tell you WHY, and are what turn a
 * five-hour archaeology dig into a five-second read (memory.mdx §1.7).
 */
type HeapContextSource = () => TxnFields;
let contextSource: HeapContextSource | null = null;
export function registerHeapContextSource(fn: HeapContextSource): void {
  contextSource = fn;
}

let timer: NodeJS.Timeout | null = null;
let armed = true; // false once we have warned, until the heap falls back under REARM_FRACTION
let lastWarnAt = 0;

/** Never throws — a context source that misbehaves must not silence the warning it was decorating. */
function context(): TxnFields {
  try {
    return contextSource?.() ?? {};
  } catch {
    return {};
  }
}

function sample(): void {
  const ceiling = heapCeilingBytes();
  if (!ceiling) return; // no truthful denominator → no honest warning; stay silent rather than guess

  const heapUsed = process.memoryUsage().heapUsed;
  const fraction = heapUsed / ceiling;

  // Back under the line with hysteresis to spare: re-arm so the NEXT climb warns as a fresh crossing.
  if (fraction < REARM_FRACTION) {
    armed = true;
    return;
  }
  if (fraction < WARN_FRACTION) return;

  // Over the line. Warn on the crossing itself, then at most once per REWARN_MS while we stay hot.
  const now = Date.now();
  if (!armed && now - lastWarnAt < REWARN_MS) return;
  const crossing = armed;
  armed = false;
  lastWarnAt = now;

  const heapUsedMB = Math.round(heapUsed / MIB);
  const ceilingMB = Math.round(ceiling / MIB);
  const pct = Math.round(fraction * 1000) / 10;
  const ctx = context();
  const ctxText = Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");

  // (a) error.err — the durable fault trail, written synchronously, where a human looks first.
  log.warn(
    "heap-watch",
    `HEAP PRESSURE ${crossing ? "(crossed threshold)" : "(still elevated)"}: heapUsed=${heapUsedMB}MB of ` +
      `ceiling=${ceilingMB}MB (${pct}% — warning at ${Math.round(WARN_FRACTION * 100)}%). ` +
      `A V8 OOM abort cannot run our handlers, so THIS is the last warning you will get before the ` +
      `process disappears (memory.mdx P-32). ` +
      (ctxText ? `In flight: ${ctxText}. ` : "") +
      `If this fires during an AI-description batch, the byte-based admission gate is admitting more ` +
      `payload than the heap can hold — see memory.mdx P-28.`,
  );

  // (b) transactions.log — the ledger, so the pressure event sits inline with the BEGIN/END lines of
  // the exact files that were in flight when it happened. Emitted as a paired BEGIN/END (an
  // instantaneous event, not a span) because the ledger's verb set is a fixed allow-list and a lone
  // BEGIN means "died in flight" — a warning must never masquerade as a lost unit of work
  // (transactions_log.mdx §3.1, AC-2 conservation of work).
  const t = txnBegin("heap_pressure", { heapUsedMB, ceilingMB, pct, crossing, ...ctx });
  txnEnd(t, "ok", { heapUsedMB, ceilingMB, pct });
}

/**
 * Start sampling. Idempotent. The timer is unref()'d so it can never keep a finished process alive —
 * a diagnostic that holds the event loop open is a diagnostic that breaks `just stop`.
 */
export function startHeapWatch(): void {
  if (timer) return;
  const ceiling = heapCeilingBytes();
  // Record the ceiling once at startup. This single line answers "what were we actually running with?"
  // — the question nobody could answer after the incident, because the 4 GB we hit was V8's accidental
  // default that nobody chose and nothing printed (memory.mdx P-31).
  log.info(
    "heap-watch",
    `Heap watch armed: ceiling=${Math.round(ceiling / MIB)}MB (v8 heap_size_limit), ` +
      `warn at ${Math.round(WARN_FRACTION * 100)}%, sampling every ${Math.round(SAMPLE_MS / 1000)}s.`,
  );
  timer = setInterval(() => {
    try {
      sample();
    } catch {
      // Instrumentation must never crash the app it is instrumenting.
    }
  }, SAMPLE_MS);
  timer.unref?.();
}

export function stopHeapWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
