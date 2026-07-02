// Two append-only rolling logs at the state root (storage.mdx §12). Never throws.
import fs from "node:fs";
import path from "node:path";
import { resolveLogDir } from "../config/state-dir.js";

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const BACKUPS = 5;

const logDir = resolveLogDir();
const LOG_FILE = path.join(logDir, "log.log");
const ERR_FILE = path.join(logDir, "error.err");

function rotateIfNeeded(file: string): void {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    for (let i = BACKUPS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // absence or stat failure is fine — nothing to rotate
  }
}

function append(file: string, line: string): void {
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, line);
  } catch (e) {
    // logging must never throw — fall back to stderr and continue
    try {
      process.stderr.write(line);
    } catch {
      /* give up quietly */
    }
    void e;
  }
}

function write(level: Level, context: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] [${context}] ${message}\n`;
  append(LOG_FILE, line); // log.log keeps everything for context
  if (level === "WARN" || level === "ERROR" || level === "FATAL") {
    append(ERR_FILE, line); // error.err is the complete fault trail
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
