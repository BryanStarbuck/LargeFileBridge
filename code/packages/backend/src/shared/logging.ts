// Two append-only rolling logs at the state root (storage.mdx §12). Never throws.
//
// Converged on the family's gold-standard logger (Philosophers_Stone / Marketing AI), keeping this
// app's dir/filename conventions (log.log / error.err) and its stable log.{debug,info,warn,error,
// fatal}(ctx, msg) API. Refinements over the original per-write statSync appender:
//   1. CACHED SIZE — an in-memory byte counter (seeded from the file size on open) replaces the
//      statSync() on every write (the perf win).
//   2. BATCHED ASYNC hot path — DEBUG/INFO enqueue and flush on the next tick so logging never blocks
//      the request; the fault path (WARN/ERROR/FATAL) is written SYNCHRONOUSLY so it is durable across
//      a crash/exit.
//   3. logError({...}) structured helper so error sites call one function with a consistent shape.
//   4. stripControlChars() log-injection guard for untrusted values.
//   5. flush-on-shutdown — SIGINT/SIGTERM/beforeExit/uncaughtException drain the async batch to disk.
//   6. BATCH CONTEXT — an AsyncLocalStorage scope stamps [batch=… op=…] on every line (to_fix.mdx §4.4).
//   7. COLLAPSE — repeated near-identical fault lines fold into [×N since HH:MM] (to_fix.mdx §4.5).
// Zero dependencies (node: builtins only) — the one thing that must never fail carries no supply-chain
// surface.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { resolveLogDir } from "../config/state-dir.js";

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
const ERROR_LEVELS: ReadonlySet<Level> = new Set<Level>(["WARN", "ERROR", "FATAL"]);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Policy mirrors scripts/log_rotate_pipe.mjs (same env vars, same defaults) so every LFB log file obeys
// one rule. Defaults: 5 MiB per file, 5 rotated generations kept.
const MAX_BYTES = envInt("LFB_LOG_MAX_BYTES", 5 * 1024 * 1024);
const BACKUPS = envInt("LFB_LOG_GENERATIONS", 5);

// Collapse policy (to_fix.mdx §4.5). The window bounds how long a repeat can sit un-summarized; the
// key cap bounds how much memory the dedupe table can hold before it force-flushes.
const COLLAPSE_WINDOW_MS = envInt("LFB_LOG_COLLAPSE_MS", 60_000);
const COLLAPSE_MAX_KEYS = envInt("LFB_LOG_COLLAPSE_KEYS", 500);

const logDir = resolveLogDir();
const LOG_FILE = path.join(logDir, "log.log");
const ERR_FILE = path.join(logDir, "error.err");

// ── Batch context (to_fix.mdx §4.4, invariant §10.6) ────────────────────────────────────────────
// "Nothing joins log.log, error.err, launcher.log, transactions.log, and the manifest today." An
// AsyncLocalStorage scope carries the batch_id (and, where known, the op) through every async
// continuation, so NO call site has to pass it and no line inside the batch can be forgotten. One
// grep on `batch=<id>` then reconstructs a whole run.
interface LogContext {
  batchId?: string;
  op?: string;
}

const contextStore = new AsyncLocalStorage<LogContext>();

// Run fn with every log line inside it (including async continuations) stamped `[batch=<id>]`.
// An undefined batchId is a no-op — today's behavior, unchanged.
export function withBatchContext<T>(batchId: string | undefined, fn: () => T): T {
  if (!batchId) return fn();
  return contextStore.run({ ...contextStore.getStore(), batchId }, fn);
}

// Same scope, but also stamps `op=` (to_fix.mdx §5 / 2_2_do row D2 — op is EXPLICIT, never inferred).
// Fields left undefined inherit from the enclosing scope.
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = contextStore.getStore();
  const merged: LogContext = {
    batchId: ctx.batchId ?? parent?.batchId,
    op: ctx.op ?? parent?.op,
  };
  if (!merged.batchId && !merged.op) return fn();
  return contextStore.run(merged, fn);
}

// The batch_id in scope, if any — for call sites that must put it somewhere other than a log line
// (a manifest, a ledger span, an API response).
export function currentBatchId(): string | undefined {
  return contextStore.getStore()?.batchId;
}

// Render the in-scope context as the `[batch=… op=…]` field of a log line, or "" when unscoped.
function contextTag(): string {
  const ctx = contextStore.getStore();
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.batchId) parts.push(`batch=${stripControlChars(ctx.batchId, 200)}`);
  if (ctx.op) parts.push(`op=${stripControlChars(ctx.op, 100)}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

// Roll filePath's .N chain in place: drop .maxBackups, shift .n → .(n+1) … .1 → .2, live file → .1.
// Best-effort — a failed rename/remove is swallowed so a rotation never throws. Shared by
// RollingFileWriter (below) and rotateIfOversized() (for logs written by external processes).
function rollChain(filePath: string, maxBackups: number): void {
  const oldest = `${filePath}.${maxBackups}`;
  if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
  for (let i = maxBackups - 1; i >= 1; i--) {
    const from = `${filePath}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${filePath}.${i + 1}`);
  }
  fs.renameSync(filePath, `${filePath}.1`);
}

// Rotate a log file we do NOT write ourselves — one whose fd is held by an external process (a launchd
// job's StandardOutPath, or a detached `ipfs daemon` we spawn with a plain append fd). We can't cap it
// per-write like RollingFileWriter does, so we roll it at the boundary where the writer reopens it
// (daemon (re)start / autostart (re)install): if it's already at/over the cap, roll the chain so the
// process reopens onto a fresh empty file. Applies the same 5 MiB × 5 policy. Never throws.
export function rotateIfOversized(filePath: string, maxBytes = MAX_BYTES, maxBackups = BACKUPS): void {
  try {
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (size >= maxBytes) rollChain(filePath, maxBackups);
  } catch {
    // best-effort — never block a daemon start/install on log rotation
  }
}

// Fold a fault line down to what makes it "the same fact repeated" (to_fix.mdx §4.5): drop the leading
// timestamp, then blank out the parts that vary between otherwise-identical faults — absolute paths, any
// number (attempt counters, sizes, ids, ports), and hex blobs. `429 rate limited on /a/b.mp4 (attempt 3)`
// and `429 rate limited on /c/d.mp4 (attempt 1)` therefore share a key and collapse together.
function collapseKey(line: string): string {
  return line
    .replace(/^\[[^\]]*\]\s*/, "") // leading ISO timestamp
    .replace(/\[batch=[^\]]*\]\s*/, "") // batch/op tag — same fault, different batch still folds
    .replace(/\/[^\s'"]+/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+/g, "#")
    .trim()
    .slice(0, 300);
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// One suppressed-repeat group: how many folded, when the run started, and the most recent raw line
// (so the summary shows a real, current example rather than the normalized key).
interface CollapseEntry {
  count: number;
  since: Date;
  lastLine: string;
}

// A size-capped, rotating, append-only writer with a CACHED byte counter (no statSync per write).
// Never throws: a failed write falls back to process.stderr.
// Exported so the TRANSACTION LEDGER (shared/transactions.ts — transactions_log.mdx) writes transactions.log
// under the exact same 5 MiB × 5 rotation policy as log.log / error.err. One rotation rule, one implementation.
export class RollingFileWriter {
  private size = 0;
  private ready = false;
  private queue: string[] = [];
  private scheduled = false;
  // Collapse state (to_fix.mdx §4.5) — only populated when constructed with { collapseRepeats: true }.
  private readonly collapsing: Map<string, CollapseEntry> = new Map();
  private collapseTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes = MAX_BYTES,
    private readonly maxBackups = BACKUPS,
    private readonly collapseRepeats = false,
  ) {}

  // Seed the in-memory byte counter once from the file's current size (or 0 if absent).
  private ensureReady(): void {
    if (this.ready) return;
    try {
      this.size = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    } catch {
      this.size = 0;
    }
    this.ready = true;
  }

  // Rotate: roll the .N chain (drop .maxBackups, shift up, live → .1), then reset the byte counter.
  private roll(): void {
    try {
      rollChain(this.filePath, this.maxBackups);
      this.size = 0;
    } catch {
      // best-effort — keep appending to the over-cap file rather than throw
    }
  }

  private writeNow(data: string): void {
    try {
      this.ensureReady();
      const n = Buffer.byteLength(data);
      if (this.size > 0 && this.size + n > this.maxBytes) this.roll();
      fs.appendFileSync(this.filePath, data);
      this.size += n;
    } catch {
      // logging must never throw — fall back to stderr and continue
      try {
        process.stderr.write(data);
      } catch {
        /* last resort — give up silently */
      }
    }
  }

  // Durable, synchronous write — used for WARN/ERROR/FATAL so the fault trail is on disk immediately
  // (and before a process.exit(1) after an uncaughtException).
  //
  // With collapseRepeats on (to_fix.mdx §4.5), a line whose normalized key we have already written in
  // this window is FOLDED instead of appended: 4,070 near-identical 429s become one line plus an
  // `[×4070 since 19:49]` summary. Two guarantees are preserved deliberately:
  //   * The FIRST occurrence of a key is always written straight through, synchronously — collapse
  //     never delays a fault reaching disk, it only suppresses the repeats behind it.
  //   * Every suppressed run is summarized on a bounded timer and again at exit — a suppressed error
  //     that is never summarized would be worse than a noisy one.
  writeSync(line: string): void {
    const withNewline = line.endsWith("\n") ? line : `${line}\n`;
    if (!this.collapseRepeats) {
      this.writeNow(withNewline);
      return;
    }
    const key = collapseKey(withNewline);
    const entry = this.collapsing.get(key);
    if (entry) {
      // Seen this fact already in this window — fold it, write nothing.
      entry.count++;
      entry.lastLine = withNewline;
      return;
    }
    // First of its kind in this window: through to disk now, and open a fold group behind it.
    this.writeNow(withNewline);
    if (this.collapsing.size >= COLLAPSE_MAX_KEYS) this.flushCollapsed(); // bound the table
    this.collapsing.set(key, { count: 0, since: new Date(), lastLine: withNewline });
    this.armCollapseTimer();
  }

  // One unref'd timer per writer — it summarizes on a bounded window and never holds the event loop
  // (or the process) open on its own.
  private armCollapseTimer(): void {
    if (this.collapseTimer) return;
    try {
      this.collapseTimer = setTimeout(() => {
        this.collapseTimer = undefined;
        this.flushCollapsed();
      }, COLLAPSE_WINDOW_MS);
      this.collapseTimer.unref?.();
    } catch {
      // a timer we cannot arm must not break logging — the exit flush still summarizes
    }
  }

  // Emit `[×N since HH:MM] <last example>` for every group that folded repeats, then clear the table so
  // the next occurrence of a fact prints in full again. Called on the window timer and at process exit.
  flushCollapsed(): void {
    if (!this.collapsing.size) return;
    const groups = [...this.collapsing.values()];
    this.collapsing.clear();
    if (this.collapseTimer) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = undefined;
    }
    for (const g of groups) {
      if (g.count < 1) continue; // written in full already, nothing was suppressed
      const body = g.lastLine.replace(/^\[[^\]]*\]\s*/, "").trimEnd();
      this.writeNow(`[${new Date().toISOString()}] [×${g.count} since ${hhmm(g.since)}] ${body}\n`);
    }
  }

  // High-performance async path — batch on the next tick so the caller never blocks on I/O.
  writeAsync(line: string): void {
    this.queue.push(line.endsWith("\n") ? line : `${line}\n`);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.flush());
    }
  }

  // Drain the queue in one syscall (batched) — called on the next tick and synchronously on exit.
  flush(): void {
    this.scheduled = false;
    if (!this.queue.length) return;
    const batch = this.queue.join("");
    this.queue.length = 0;
    this.writeNow(batch);
  }
}

// Collapse is enabled on BOTH writers (to_fix.mdx §4.5). It only ever engages on the writeSync path,
// which carries WARN/ERROR/FATAL — exactly the storm that buried the signal on 2026-07-15 and rotated
// error.err.1 past 5 MiB, destroying the earlier evidence. The batched async DEBUG/INFO path is
// untouched: those lines are progress, not repeated faults, and folding them would hide real work.
const outWriter = new RollingFileWriter(LOG_FILE, MAX_BYTES, BACKUPS, true);
const errWriter = new RollingFileWriter(ERR_FILE, MAX_BYTES, BACKUPS, true);

// Log-injection defense: strip control chars (incl. newlines/CR) from untrusted values so an attacker
// can't forge log lines, and cap length so one value can't blow out a log.
export function stripControlChars(value: unknown, maxLength = 8000): string {
  const s = typeof value === "string" ? value : safeStringify(value);
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, " ");
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function write(level: Level, context: string, message: string): void {
  const header = `[${new Date().toISOString()}] [${level}] [${context}]${contextTag()}`;
  // EVERY physical line carries the header. A message with embedded newlines — a child process's
  // stderr folded into an Error message (`Command failed: git check-ignore …\nfatal: Pathspec …`),
  // a multi-line stack trace — would otherwise land in log.log/error.err as BARE continuation lines
  // with no timestamp or level, unparseable and unattributable. Re-stamping the same header keeps
  // multi-line messages readable while making each line greppable on its own.
  const body = message.replace(/\s+$/, "").split(/\r?\n/).join(`\n${header} `);
  const line = `${header} ${body}\n`;
  if (ERROR_LEVELS.has(level)) {
    // Durable: synchronous to BOTH files so the fault trail is never lost across a crash/exit.
    errWriter.writeSync(line); // error.err is the complete fault trail
    outWriter.writeSync(line); // log.log keeps everything for context
  } else {
    // Hot path: batched + async so callers never block on disk I/O.
    outWriter.writeAsync(line);
  }
  if (process.env.LFB_LOG_CONSOLE === "1" || level === "ERROR" || level === "FATAL") {
    const out = level === "DEBUG" || level === "INFO" ? process.stdout : process.stderr;
    try {
      out.write(line);
    } catch {
      /* ignore */
    }
  }
}

export const log = {
  debug: (ctx: string, msg: string) => write("DEBUG", ctx, msg),
  info: (ctx: string, msg: string) => write("INFO", ctx, msg),
  warn: (ctx: string, msg: string) => write("WARN", ctx, msg),
  error: (ctx: string, msg: string) => write("ERROR", ctx, msg),
  fatal: (ctx: string, msg: string) => write("FATAL", ctx, msg),
};

// Structured error helper (mirrors the family's logError). Error sites call ONE function with a
// consistent shape instead of hand-formatting a string; it routes to the durable ERROR path. Every
// interpolated field is run through stripControlChars so untrusted values can't forge log lines.
export interface LogErrorFields {
  file: string; // source file the error occurred in (e.g. "ipfs.service.ts")
  className?: string; // optional class/module name for extra context
  operation: string; // what was being attempted when it failed
  expected?: string; // optional: what a correct outcome looked like
  error: unknown; // the thrown value / Error (stack captured when present)
  data?: unknown; // optional structured context (ids, paths, …)
}

export function logError(fields: LogErrorFields): void {
  const where = fields.className
    ? `${stripControlChars(fields.file)}#${stripControlChars(fields.className)}`
    : stripControlChars(fields.file);
  const parts = [`op=${stripControlChars(fields.operation)}`];
  if (fields.expected !== undefined) parts.push(`expected=${stripControlChars(fields.expected)}`);
  parts.push(`error=${stripControlChars(safeStringify(fields.error))}`);
  if (fields.data !== undefined) parts.push(`data=${stripControlChars(safeStringify(fields.data))}`);
  write("ERROR", where, parts.join(" "));
}

// Flush any queued async lines synchronously — called on exit and before a crash-exit so nothing in
// the batch buffer is lost.
//
// flushCollapsed() runs FIRST and is why this order matters: a folded run only exists in memory until
// it is summarized, so a crash between the last fold and the window timer would silently discard the
// count of an ongoing fault storm — the exact evidence an incident needs most. Summarize, then drain.
export function flushLogs(): void {
  errWriter.flushCollapsed();
  outWriter.flushCollapsed();
  outWriter.flush();
  errWriter.flush();
}

// Wire flush-on-shutdown ONCE (idempotent). These handlers flush ONLY (they do not call process.exit)
// so they compose with the app's own SIGINT/SIGTERM shutdown in main.ts — both listeners fire; the
// flush is synchronous and runs before the app's async server.close()→exit completes.
let shutdownWired = false;
export function installLogShutdownFlush(): void {
  if (shutdownWired) return;
  shutdownWired = true;
  process.on("beforeExit", flushLogs);
  process.on("SIGINT", flushLogs);
  process.on("SIGTERM", flushLogs);
  process.on("uncaughtException", flushLogs);
}

// Self-install on import so every entry point (main.ts, cli.ts) is covered without extra wiring.
installLogShutdownFlush();
