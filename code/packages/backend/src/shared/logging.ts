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
// Zero dependencies (node:fs only) — the one thing that must never fail carries no supply-chain surface.
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

const logDir = resolveLogDir();
const LOG_FILE = path.join(logDir, "log.log");
const ERR_FILE = path.join(logDir, "error.err");

// A size-capped, rotating, append-only writer with a CACHED byte counter (no statSync per write).
// Never throws: a failed write falls back to process.stderr.
class RollingFileWriter {
  private size = 0;
  private ready = false;
  private queue: string[] = [];
  private scheduled = false;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes = MAX_BYTES,
    private readonly maxBackups = BACKUPS,
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

  // Rotate: drop .maxBackups, shift .n → .(n+1) … .1 → .2, move the live file to .1, reset the counter.
  private roll(): void {
    try {
      const oldest = `${this.filePath}.${this.maxBackups}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
      for (let i = this.maxBackups - 1; i >= 1; i--) {
        const from = `${this.filePath}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${i + 1}`);
      }
      fs.renameSync(this.filePath, `${this.filePath}.1`);
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
  writeSync(line: string): void {
    this.writeNow(line.endsWith("\n") ? line : `${line}\n`);
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

const outWriter = new RollingFileWriter(LOG_FILE);
const errWriter = new RollingFileWriter(ERR_FILE);

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
  const line = `[${new Date().toISOString()}] [${level}] [${context}] ${message}\n`;
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
export function flushLogs(): void {
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
