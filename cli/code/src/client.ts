// REST client — the only way the CLI gets answers (cli.mdx §1: the CLI computes nothing itself).
// Speaks to the local backend on :8787 (BE_PORT honored, same as the justfile) with the shared
// X-LFB-Api-Key secret on every call (cli.mdx §3.2).
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
