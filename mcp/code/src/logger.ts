// Logging for the MCP process (pm/mcp.mdx §14).
//
// THE ONE RULE: NOTHING IS EVER WRITTEN TO STDOUT. stdout is the JSON-RPC wire; one stray line desynchronizes
// the transport and Claude Code just shows a dead server. Everything goes to stderr (which Claude Code keeps
// in its MCP log) and — for WARN and ERROR — ALSO to the app's own fault trail, error.err in the state root,
// in the backend's exact line format, so there is ONE place to look for every Large File Bridge failure.
//
// The append is a single small synchronous write of a whole line (O_APPEND), which is atomic enough beside
// the backend's own writer. Rotation stays the backend's job; we only append.
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

function write(level: Level, ctx: string, msg: string): void {
  if (ORDER[level] < threshold() && level !== "ERROR" && level !== "WARN") return;
  const line = `[${new Date().toISOString()}] [${level}] [mcp:${ctx}] ${clean(msg)}\n`;
  try {
    process.stderr.write(line);
  } catch {
    /* stderr closed — nothing else to do */
  }
  if ((level === "WARN" || level === "ERROR") && !errFileBroken) {
    try {
      const dir = logDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "error.err"), line);
    } catch (e) {
      errFileBroken = true; // say it once, then stop trying on every line
      try {
        process.stderr.write(`[mcp] cannot append to error.err: ${(e as Error).message}\n`);
      } catch {
        /* ignore */
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
