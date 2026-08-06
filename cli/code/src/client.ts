// REST client — the only way the CLI gets answers (cli.mdx §1: the CLI computes nothing itself).
// Speaks to the local backend on :8787 (BE_PORT honored, same as the justfile) with the shared
// X-LFB-Api-Key secret on every call (cli.mdx §3.2).
import http from "node:http";
import { ensureApiSecret } from "./credentials";

export function backendPort(): number {
  return Number(process.env.BE_PORT) || 8787;
}

export function apiBase(): string {
  return `http://127.0.0.1:${backendPort()}/api`;
}

/** True when the backend answers /api/health quickly. FRONTEND UP ≠ APP UP — we only ever gate on this. */
export async function backendHealthy(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface FilesListCategory {
  key: string;
  title: string;
  paths: string[];
}
export interface FilesListResult {
  scope: string;
  unitsSearched: number;
  categories: FilesListCategory[];
  /** everything mode only: the walk stopped at the backend's soft path cap — announce it (cli.mdx §4.2). */
  truncated?: boolean;
}

/**
 * Fire-and-forget invocation trail (cli.mdx §7): CLI usage lands in the app's own rotating logs in
 * the state root via the client-log bridge — the CLI never writes a log file of its own (and never
 * to /tmp). Best-effort by design; a down backend or slow socket must never delay or fail a command.
 */
export async function logInvocation(message: string): Promise<void> {
  try {
    await fetch(`${apiBase()}/client-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LFB-Api-Key": ensureApiSecret() },
      body: JSON.stringify({ level: "info", context: "cli", message }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* best-effort */
  }
}

export async function apiGet<T>(pathAndQuery: string): Promise<T> {
  const secret = ensureApiSecret();
  const url = `${apiBase()}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: { "X-LFB-Api-Key": secret },
    signal: AbortSignal.timeout(10 * 60 * 1000), // long scopes are real; do not strangle them
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
  if (res.status === 401) {
    throw new Error(
      `The backend rejected the Large File Bridge API key (401). The shared secret lives at\n` +
        `~/.credentials/large_files_bridge.json — if the backend was started under a different\n` +
        `user or LFB_CREDENTIALS_FILE, align them and retry.`,
    );
  }
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ? `${res.status}: ${body.error}` : `HTTP ${res.status} from ${url}`);
  }
  return body.data as T;
}

/**
 * POST for the create-artifact calls (cli.mdx §9). Deliberately node:http, not fetch: a transcription
 * of a long video can run MANY minutes before the server sends its response headers, and fetch/undici's
 * default 300 s headers timeout would abort it mid-run. A fresh, unpooled socket with NO timeout — the
 * server answers exactly once, when the work is done.
 */
export async function apiPost<T>(pathname: string, payload: unknown): Promise<T> {
  const secret = ensureApiSecret();
  const body = JSON.stringify(payload ?? {});
  const raw = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: backendPort(),
        path: `/api${pathname}`,
        method: "POST",
        agent: false, // one fresh socket per call — no pooling, no idle-socket reuse stalls
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-LFB-Api-Key": secret,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  const parsed = ((): { ok?: boolean; data?: T; error?: string } | null => {
    try {
      return JSON.parse(raw.text) as { ok?: boolean; data?: T; error?: string };
    } catch {
      return null;
    }
  })();
  if (raw.status === 401) {
    throw new Error(
      `The backend rejected the Large File Bridge API key (401). The shared secret lives at\n` +
        `~/.credentials/large_files_bridge.json — if the backend was started under a different\n` +
        `user or LFB_CREDENTIALS_FILE, align them and retry.`,
    );
  }
  if (raw.status < 200 || raw.status >= 300 || !parsed?.ok) {
    throw new Error(parsed?.error ? `${raw.status}: ${parsed.error}` : `HTTP ${raw.status} from POST /api${pathname}`);
  }
  return parsed.data as T;
}
