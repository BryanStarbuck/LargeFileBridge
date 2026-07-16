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
// THE HEAP IS ONLY ONE OF FOUR LAYERS (to_fix.mdx §6). heapUsed sees our JS objects and base64; it does NOT
// see child processes (ffmpeg, and Whisper at 2–6 GB PER INSTANCE) and it does NOT see the OS. So a module
// that samples heapUsed alone reports HEALTHY through a transcription-driven memory crisis — the machine
// swaps, every process crawls, and our fault trail says nothing is wrong. Meanwhile the other half of the
// system, transcribeConcurrency(), budgets those children's RAM but is blind to OUR heap. Two blind halves
// facing each other, able to peak simultaneously. This file now samples all three layers it can reach:
// heapUsed (V8), child RSS (`ps`, attributed to the job that spawned it), and OS pressure (`vm_stat`).
//
// Zero dependencies beyond node builtins — instrumentation must never be the thing that takes the server
// down. Every probe here is ASYNC (charter T3: no spawnSync on a queue/request path — and a `ps` that
// blocks the event loop to report on memory would be a self-parody), best-effort, and swallows its errors:
// a diagnostic that throws, blocks, or holds the loop open is worse than no diagnostic at all.
import { spawn } from "node:child_process";
import os from "node:os";
import v8 from "node:v8";
import { log } from "./logging.js";
import { txnBegin, txnEnd, type TxnFields } from "./transactions.js";

const MIB = 1024 * 1024;
const KIB = 1024;

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

// ── Layer 2: child-process RSS (to_fix.mdx §6.1) ────────────────────────────────────────────────────────
//
// Whisper is 2 GB resident per instance and ffmpeg is not free either, and NONE of it appears in heapUsed —
// it is not our heap, it is not even our process. The registry below is how a child becomes visible: the
// module that spawns one calls registerChildProcess() with a LABEL naming the job (op + file), and the RSS
// we read back is attributed to that job rather than landing as an anonymous number. "4.2 GB in children"
// tells you the box is in trouble; "4.2 GB in children, 2.1 of it transcribe:interview.mp4" tells you what
// to stop.
//
// Registration is a courtesy, not a requirement: an unregistered child is simply invisible, exactly as it is
// today, so nothing breaks by not calling these. The API is exported for other modules to adopt (2_2_do.mdx
// §E1); this file deliberately does not reach into them, because heap-watch must stay a LEAF — a warning
// that fires because memory is exhausted must not depend on an import cycle through the subsystem that
// exhausted it (the same rule that made the context source a registration).

/** What a registered child is doing, for attribution in the warning — e.g. `transcribe:interview.mp4`. */
const childLabels = new Map<number, string>();

/** Track a spawned child's RSS against `label`. Safe to call for any pid; unregister in a finally. */
export function registerChildProcess(pid: number | undefined, label: string): void {
  if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) childLabels.set(pid, label);
}

/** Stop tracking a child. Idempotent — a double-unregister (close + error) must be harmless. */
export function unregisterChildProcess(pid: number | undefined): void {
  if (typeof pid === "number") childLabels.delete(pid);
}

/** How many children we ask `ps` about at once. A runaway registry must not build an unbounded argv. */
const MAX_PROBED_CHILDREN = 64;

/**
 * The external probes are far more expensive than process.memoryUsage() — each forks a process — so they run
 * on their own, slower cadence and their result is CACHED for the heap sampler to read. That ordering is the
 * point: the warning path itself stays synchronous and instant, and never waits on a fork to say the process
 * is about to die.
 */
const PROBE_MS = Math.max(15_000, Number(process.env.LFB_MEM_PROBE_MS) || 60_000);

/** Swapping this much between probes means the machine is paging, not merely busy — concurrency is too high. */
const SWAPOUT_WARN_BYTES = Math.max(8 * MIB, Number(process.env.LFB_SWAP_WARN_BYTES) || 64 * MIB);

/** Re-warn about OS pressure at most this often; the fault trail is only useful while it stays readable. */
const SWAP_REWARN_MS = 5 * 60_000;

interface ChildRssSnapshot {
  totalBytes: number;
  /** Largest-first, `label=MB`, already truncated to a readable few. */
  top: string[];
  count: number;
}

interface OsMemSnapshot {
  freeBytes: number;
  /** macOS compressed-memory footprint — pressure BEFORE the box starts swapping. */
  compressedBytes: number | null;
  /** Cumulative pages swapped out since boot; only the DELTA between probes is meaningful. */
  swapouts: number | null;
  /** vm_stat's OWN page size — 16 KB on Apple Silicon, 4 KB on Intel. Never assume one (see probeOsMem). */
  pageSize: number;
}

let lastChildRss: ChildRssSnapshot | null = null;
let lastOsMem: OsMemSnapshot | null = null;
let lastSwapouts: number | null = null;
let lastSwapWarnAt = 0;
let probeInFlight = false;
let probeTimer: NodeJS.Timeout | null = null;

/**
 * Run a short probe command and return its stdout, or null on ANY failure (missing binary, non-zero exit,
 * timeout, unparseable — all the same to us: no reading this tick). Async by charter (T3), capped, killed on
 * a timeout, and it never rejects: instrumentation reports what it can and stays quiet about what it can't.
 */
function probeCmd(bin: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const chunks: string[] = [];
    let captured = 0;
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child!.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      if (captured >= 256 * KIB) return; // a `ps`/`vm_stat` answer is a few hundred bytes; past this, drop
      chunks.push(c);
      captured += c.length;
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? chunks.join("") : null));
  });
}

/**
 * Sum the RSS of every registered child via one `ps -o pid=,rss= -p a,b,c` (RSS is in KB). One fork for all
 * of them, not one per child. Dead pids are dropped from the registry as we go — a module that forgot to
 * unregister must not make this list grow forever.
 */
// Exported for its test (heap-watch.spec.ts). The warning path that consumes it only fires under real
// memory pressure, which a test cannot honestly manufacture — so the probe itself is the seam where
// "does child RSS actually become visible?" can be answered against a real child process.
export async function probeChildRss(): Promise<ChildRssSnapshot | null> {
  // Reap the dead FIRST, with signal 0 — a liveness test that sends no signal and forks nothing. This is
  // both cheaper than asking `ps` and, more importantly, CORRECT in a case `ps` cannot express: `ps -p`
  // exits NON-ZERO when none of the requested pids are alive, which `probeCmd` (rightly) reports as a
  // failed probe — so an all-dead list used to return `null` and bail out BEFORE the reap below, leaving
  // those pids in the registry forever. Every later probe then re-asked about the same corpses, got the
  // same non-zero exit, and reported "unknown" instead of "no children" until some new live child
  // happened to register. Establishing liveness before we fork removes the ambiguity entirely.
  for (const pid of [...childLabels.keys()]) {
    try {
      process.kill(pid, 0); // signal 0 = "does this pid exist and may I signal it?" — sends nothing
    } catch {
      childLabels.delete(pid); // ESRCH: it is gone. That IS the death certificate.
    }
  }
  const pids = [...childLabels.keys()].slice(0, MAX_PROBED_CHILDREN);
  // No live children is a FACT (zero), not a failed measurement (null) — the warning must be able to say
  // "nothing in children" rather than shrug.
  if (pids.length === 0) return { totalBytes: 0, top: [], count: 0 };
  const out = await probeCmd("ps", ["-o", "pid=,rss=", "-p", pids.join(",")]);
  if (out == null) return null;

  const seen = new Set<number>();
  const rows: Array<{ label: string; bytes: number }> = [];
  let totalBytes = 0;
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const bytes = Number(m[2]) * KIB; // ps reports RSS in kilobytes
    seen.add(pid);
    totalBytes += bytes;
    rows.push({ label: childLabels.get(pid) ?? `pid ${pid}`, bytes });
  }
  // `ps` omits pids that have exited — that omission IS the death certificate, so reap them here.
  for (const pid of pids) if (!seen.has(pid)) childLabels.delete(pid);

  rows.sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes,
    top: rows.slice(0, 3).map((r) => `${r.label}=${Math.round(r.bytes / MIB)}MB`),
    count: rows.length,
  };
}

/**
 * OS memory pressure. `vm_stat` is darwin-only and this app's home is a Mac, so elsewhere we report free
 * memory alone rather than pretend. Page size is read from vm_stat's own header — it is 16 KB on Apple
 * Silicon and 4 KB on Intel, and hardcoding either would silently mis-scale every number by 4×.
 */
async function probeOsMem(): Promise<OsMemSnapshot> {
  const snap: OsMemSnapshot = { freeBytes: os.freemem(), compressedBytes: null, swapouts: null, pageSize: 4096 };
  if (os.platform() !== "darwin") return snap;
  const out = await probeCmd("vm_stat", []);
  if (out == null) return snap;

  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1]) || 4096;
  snap.pageSize = pageSize;
  const field = (name: string): number | null => {
    const m = out.match(new RegExp(`^${name}:\\s+(\\d+)\\.?`, "m"));
    return m ? Number(m[1]) : null;
  };
  const compressorPages = field("Pages occupied by compressor");
  if (compressorPages != null) snap.compressedBytes = compressorPages * pageSize;
  snap.swapouts = field("Swapouts");
  return snap;
}

/**
 * Refresh the cached child/OS numbers and, independently of the heap, warn when the machine is PAGING.
 *
 * Swap gets its own warning because it is its own failure (to_fix.mdx §6.1: "swap is the signal concurrency
 * is too high even when nothing OOMs"). A box that is swapping is not about to abort — it is simply doing
 * everything 100× slower, indefinitely, with no error anywhere. Nothing else in this process would ever say
 * so. Swapouts is cumulative since boot, so only the delta between probes carries information: a machine
 * that swapped during last month's Xcode build must not warn us today.
 */
async function probeSystem(): Promise<void> {
  if (probeInFlight) return; // a `ps` that outlives its interval must not stack up forks behind itself
  probeInFlight = true;
  try {
    const [child, osMem] = await Promise.all([probeChildRss(), probeOsMem()]);
    if (child) lastChildRss = child;
    lastOsMem = osMem;

    if (osMem.swapouts == null) return;
    const prev = lastSwapouts;
    lastSwapouts = osMem.swapouts;
    if (prev == null || osMem.swapouts <= prev) return; // first probe (no baseline), or no new swapping

    // Pages → bytes via vm_stat's OWN page size, never an assumed 4 KB: this Mac reports 16 KB pages, so a
    // hardcoded 4096 would under-report every swap event by 4× and hold the warning below its threshold.
    const swappedBytes = (osMem.swapouts - prev) * osMem.pageSize;
    const now = Date.now();
    if (swappedBytes < SWAPOUT_WARN_BYTES || now - lastSwapWarnAt < SWAP_REWARN_MS) return;
    lastSwapWarnAt = now;
    log.warn(
      "heap-watch",
      `MEMORY PRESSURE: the machine swapped ~${Math.round(swappedBytes / MIB)}MB out in the last ` +
        `${Math.round(PROBE_MS / 1000)}s (free=${Math.round(osMem.freeBytes / MIB)}MB` +
        (osMem.compressedBytes != null ? `, compressed=${Math.round(osMem.compressedBytes / MIB)}MB` : "") +
        `). Nothing will crash — it will just get slower and stay slower, which is why nothing else reports ` +
        `this. It means we are running MORE work at once than this box has RAM for` +
        (lastChildRss && lastChildRss.count > 0
          ? `: ${lastChildRss.count} child process(es) holding ~${Math.round(lastChildRss.totalBytes / MIB)}MB` +
            (lastChildRss.top.length ? ` (${lastChildRss.top.join(", ")})` : "")
          : "") +
        `. See to_fix.mdx §6.1 — the RAM clamp in transcribeConcurrency() is admitting too much.`,
    );
    const t = txnBegin("memory_pressure", {
      swappedMB: Math.round(swappedBytes / MIB),
      freeMB: Math.round(osMem.freeBytes / MIB),
      childRssMB: lastChildRss ? Math.round(lastChildRss.totalBytes / MIB) : undefined,
      children: lastChildRss?.count,
    });
    txnEnd(t, "ok", {});
  } catch {
    // Best-effort by design: a probe that cannot read the machine tells us nothing and must cost nothing.
  } finally {
    probeInFlight = false;
  }
}

/** The cached child/OS numbers, formatted for the heap warning — never blocks, never forks. */
function machineContext(): TxnFields {
  const f: TxnFields = {};
  if (lastChildRss) {
    f.childRssMB = Math.round(lastChildRss.totalBytes / MIB);
    f.children = lastChildRss.count;
    if (lastChildRss.top.length) f.topChildren = lastChildRss.top.join(",");
  }
  if (lastOsMem) {
    f.freeMB = Math.round(lastOsMem.freeBytes / MIB);
    if (lastOsMem.compressedBytes != null) f.compressedMB = Math.round(lastOsMem.compressedBytes / MIB);
  }
  return f;
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
  // The queue context (what we were doing) PLUS the machine context (what the rest of the box was holding).
  // heapUsed alone has never been enough to act on: "4.8 GB of 6 GB" reads the same whether the heap is the
  // whole story or whether children are holding another 4 GB on top of it and the machine is already paging
  // (to_fix.mdx §6). These are cached numbers from probeSystem() — reading them costs nothing.
  const ctx = { ...context(), ...machineContext() };
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

  // The external probes (child RSS + OS pressure) on their own slower cadence — they fork, so they must not
  // ride the 12s heap tick. void'd deliberately: probeSystem() never rejects, and the sampler must not await
  // a fork. Both timers are unref()'d — a diagnostic that holds the event loop open breaks `just stop`.
  probeTimer = setInterval(() => {
    void probeSystem();
  }, PROBE_MS);
  probeTimer.unref?.();
}

export function stopHeapWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = null;
}
