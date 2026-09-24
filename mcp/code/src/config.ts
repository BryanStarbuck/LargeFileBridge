// Runtime configuration (pm/mcp.mdx §11). Environment only — never tool arguments: a tool argument that could
// redirect the base URL or stretch a timeout is an injection surface (the sister app's ruling R9).
import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "lfb";
export const SERVER_VERSION = "0.1.0";

/** The backend port. BE_PORT is what the justfile and the CLI already honor. */
export function backendPort(): number {
  const raw = process.env.LFB_BACKEND_PORT ?? process.env.BE_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8787;
}

/** Always loopback. There is deliberately no host setting: this server never talks to another machine. */
export function apiBase(): string {
  return `http://127.0.0.1:${backendPort()}/api`;
}

/**
 * The HTTP timeout per call. It must exceed the longest server-side wait we ask for (50 s) plus margin, so
 * the server — not the socket — decides when to hand back a pending job.
 */
export function httpTimeoutMs(): number {
  const n = Number(process.env.LFB_MCP_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5_000 ? Math.min(n, 10 * 60_000) : 75_000;
}

/** Cap on one tool result's JSON, so a 50,000-file job cannot flood the model's context (pm/mcp.mdx §12). */
export function maxResultBytes(): number {
  const n = Number(process.env.LFB_MCP_MAX_BYTES);
  return Number.isFinite(n) && n >= 10_000 ? Math.min(n, 2 * 1024 * 1024) : 200_000;
}

export function credsFilePath(): string {
  return process.env.LFB_CREDENTIALS_FILE || path.join(os.homedir(), ".credentials", "large_files_bridge.json");
}

/** The app's state root — where the backend keeps error.err. Same resolution as backend state-dir.ts. */
export function stateDir(): string {
  if (process.env.LFB_STATE_DIR) return process.env.LFB_STATE_DIR;
  try {
    return path.join(os.homedir(), "T", "_large_files_bridge");
  } catch {
    return path.join(os.tmpdir(), "_large_files_bridge");
  }
}

export function logDir(): string {
  return process.env.LFB_LOG_DIR || stateDir();
}
