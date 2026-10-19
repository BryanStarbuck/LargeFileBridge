// Logging for the MCP process (pm/mcp.mdx §14).
//
// THE ONE RULE: NOTHING IS EVER WRITTEN TO STDOUT. stdout is the JSON-RPC wire; one stray line desynchronizes
// the transport and Claude Code just shows a dead server. Everything goes to stderr (which Claude Code keeps
// in its MCP log) and — for WARN and ERROR — ALSO to the app's own fault trail, error.err in the state root,
// in the backend's exact line format, so there is ONE place to look for every Large File Bridge failure.
//
// The append is a single small synchronous write of a whole line (O_APPEND), which is atomic enough beside
// the backend's own writer. ROTATION IS OURS TOO (2026-10-19): "the backend rotates it" was the assumption that let
// error.err reach 175 GB — the backend only rotates when IT writes, and it counts only its own bytes. So every
// append here checks the real size first and rolls the file under the same rule as the backend's logging.ts
// (5 MiB per file by default, never past 10 MiB, 5 generations; LFB_LOG_MAX_BYTES / LFB_LOG_GENERATIONS tune
// down). On top of that, at most ERR_LINES_PER_MIN lines a minute reach error.err from this process.
import fs from "node:fs";
import path from "node:path";
import { logDir } from "./config.js";

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";
const ORDER: Record<Level, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function threshold(): number {
  const raw = (process.env.LFB_MCP_LOG_LEVEL ?? "info").toUpperCase() as Level;
  return ORDER[raw] ?? ORDER.INFO;
}

/** Strip control characters so an untrusted value (a file name, a server message) cannot forge log lines. */
export function clean(v: unknown, max = 4000): string {
  let s: string;
  if (v instanceof Error) s = v.stack || v.message;
  else if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f]/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

let errFileBroken = false;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const MAX_BYTES = Math.min(envInt("LFB_LOG_MAX_BYTES", 5 * 1024 * 1024), 10 * 1024 * 1024);
const GENERATIONS = Math.min(envInt("LFB_LOG_GENERATIONS", 5), 10);
const ERR_LINES_PER_MIN = 120;

/** Write the last maxBytes of `from` to `to` from a line boundary — a file already over the cap is cut, not kept. */
function copyTail(from: string, to: string, size: number): void {
  const take = Math.min(size, MAX_BYTES);
  const buf = Buffer.alloc(take);
  const fd = fs.openSync(from, "r");
  try {
    fs.readSync(fd, buf, 0, take, size - take);
  } finally {
    fs.closeSync(fd);
  }
  const nl = take < size ? buf.indexOf(0x0a) : -1;
  fs.writeFileSync(to, nl >= 0 ? buf.subarray(nl + 1) : buf);
}

function moveCapped(from: string, to: string): void {
  const size = fs.statSync(from).size;
  if (size > MAX_BYTES) {
    copyTail(from, to, size);
    fs.rmSync(from, { force: true });
  } else {
    fs.renameSync(from, to);
  }
}

/** file → file.1 → … → file.N (oldest dropped); no file in the chain is left over MAX_BYTES. Same as logging.ts. */
function roll(file: string): void {
  fs.rmSync(`${file}.${GENERATIONS}`, { force: true });
  for (let i = GENERATIONS - 1; i >= 1; i--) {
    if (fs.existsSync(`${file}.${i}`)) moveCapped(`${file}.${i}`, `${file}.${i + 1}`);
  }
  moveCapped(file, `${file}.1`);
}

/** Append one line to error.err, rolling first when it would pass the cap. Throws only when the file is unwritable. */
function appendRolling(file: string, line: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* absent — it will be created */
  }
  if (size > 0 && size + Buffer.byteLength(line) > MAX_BYTES) {
    try {
      roll(file);
    } catch {
      // Another process (the backend, a sibling MCP server) may be rolling the same chain right now. Its roll
      // wins; appending to whatever error.err is now is still right.
    }
  }
  fs.appendFileSync(file, line);
}

// The per-minute budget for error.err. A loop is not N faults, it is one; past the budget the rest of the
// minute is counted and summarized in a single line when the next minute's first line is written.
let budget = { minute: 0, used: 0, dropped: 0 };
function admitErrLine(): { ok: boolean; note?: string } {
  const minute = Math.floor(Date.now() / 60_000);
  let note: string | undefined;
  if (minute !== budget.minute) {
    if (budget.dropped)
      note = `[${new Date().toISOString()}] [WARN] [mcp:logger.ts] ${budget.dropped} more error line(s) from pid ${process.pid} suppressed (over ${ERR_LINES_PER_MIN}/min)\n`;
    budget = { minute, used: 0, dropped: 0 };
  }
  if (budget.used >= ERR_LINES_PER_MIN) {
    budget.dropped++;
    return { ok: false };
  }
  budget.used++;
  return { ok: true, note };
}

// THE EPIPE LOOP (2026-10-19: four orphans at 35% CPU each, error.err grown to 171 GB). When the client is gone,
// stderr is a broken pipe — and on a pipe the failure is NOT thrown by write(): it arrives later as an 'error'
// event, which with no listener becomes an uncaughtException, whose handler logs, which writes to stderr, which
// fails again... forever, and fast enough to starve the shutdown path. Once stderr has failed we never touch it
// again; index.ts also treats that failure as "the client is gone" and exits.
let stderrBroken = false;
export function markStderrBroken(): void {
  stderrBroken = true;
}

function write(level: Level, ctx: string, msg: string): void {
  if (ORDER[level] < threshold() && level !== "ERROR" && level !== "WARN") return;
  const line = `[${new Date().toISOString()}] [${level}] [mcp:${ctx}] ${clean(msg)}\n`;
  if (!stderrBroken) {
    try {
      process.stderr.write(line);
    } catch {
      stderrBroken = true;
    }
  }
  if ((level === "WARN" || level === "ERROR") && !errFileBroken) {
    const admit = admitErrLine();
    if (!admit.ok) return;
    try {
      const dir = logDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "error.err");
      if (admit.note) appendRolling(file, admit.note);
      appendRolling(file, line);
    } catch (e) {
      errFileBroken = true; // say it once, then stop trying on every line
      if (!stderrBroken) {
        try {
          process.stderr.write(`[mcp] cannot append to error.err: ${(e as Error).message}\n`);
        } catch {
          stderrBroken = true;
        }
      }
    }
  }
}

export const log = {
  debug: (ctx: string, msg: string) => write("DEBUG", ctx, msg),
  info: (ctx: string, msg: string) => write("INFO", ctx, msg),
  warn: (ctx: string, msg: string) => write("WARN", ctx, msg),
  error: (ctx: string, msg: string) => write("ERROR", ctx, msg),
};

/** The structured error line, same shape as the backend's logError(). */
export function logError(f: { operation: string; error: unknown; data?: unknown; file?: string }): void {
  const parts = [`op=${clean(f.operation)}`, `error=${clean(f.error)}`];
  if (f.data !== undefined) parts.push(`data=${clean(f.data)}`);
  write("ERROR", f.file ?? "mcp", parts.join(" "));
}
