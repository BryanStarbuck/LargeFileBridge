// The REST client (pm/mcp.mdx §11). Loopback only, the X-LFB-Api-Key machine channel, one envelope.
//
// Every failure becomes an ApiError with a STABLE code the playbook (ai/lfb_mcp.md §6) teaches the model to
// act on: backend_down, unauthorized, timeout, bad_request, not_found, http_error, credentials_*. Nothing
// here retries: a fingerprint request is a job on the server, and a blind retry would start a second job.
import { apiBase, httpTimeoutMs } from "./config.js";
import { CredentialError, readApiKey } from "./credentials.js";
import { log, logError } from "./logger.js";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface ApiReply<T> {
  status: number;
  data: T;
}

export async function api<T>(method: "GET" | "POST", pathAndQuery: string, body?: unknown): Promise<ApiReply<T>> {
  let key: string;
  try {
    key = readApiKey();
  } catch (e) {
    if (e instanceof CredentialError) {
      log.warn("credentials", `${e.code}: ${e.message}`);
      throw new ApiError(e.code, e.message, e.hint);
    }
    throw e;
  }
  const url = `${apiBase()}${pathAndQuery}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "X-LFB-Api-Key": key,
        "X-LFB-Client": "mcp",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(httpTimeoutMs()),
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      logError({ operation: `${method} ${pathAndQuery}`, error: `timed out after ${httpTimeoutMs()} ms` });
      throw new ApiError(
        "timeout",
        `The Large File Bridge backend did not answer within ${Math.round(httpTimeoutMs() / 1000)} s.`,
        "Any job it started may still be running — check lfb_list_jobs before starting it again.",
      );
    }
    const code = err.cause?.code ?? "";
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || /fetch failed/.test(err.message)) {
      log.warn("http", `backend unreachable at ${apiBase()} (${code || err.message})`);
      throw new ApiError(
        "backend_down",
        `The Large File Bridge web app is not running (nothing answered at ${apiBase()}).`,
        "Start it: `just run` in ~/BGit/Bryan_git/LargeFileBridge (or run any `lfb` CLI command, which starts it).",
      );
    }
    logError({ operation: `${method} ${pathAndQuery}`, error: e });
    throw new ApiError("http_error", err.message, "See ~/T/_large_files_bridge/error.err.");
  }

  const text = await res.text().catch(() => "");
  let env: Envelope<T> | null = null;
  try {
    env = text ? (JSON.parse(text) as Envelope<T>) : null;
  } catch {
    env = null;
  }
  if (res.status === 401 || res.status === 403) {
    log.warn("http", `${method} ${pathAndQuery} → ${res.status} (${env?.error ?? "unauthorized"})`);
    throw new ApiError(
      "unauthorized",
      `The backend rejected the Large File Bridge API key (${res.status}).`,
      "Open the web app → Settings → Security → Local API key, and make sure the backend and this server read the same credentials file (LFB_CREDENTIALS_FILE).",
      res.status,
    );
  }
  if (res.status === 404) throw new ApiError("not_found", env?.error ?? "not found", "Check the id or path.", 404);
  if (res.status === 400 || res.status === 422) {
    throw new ApiError(env?.code ?? "bad_request", env?.error ?? `bad request (${res.status})`, "Fix the arguments and call again.", res.status);
  }
  if (!res.ok || !env?.ok) {
    logError({ operation: `${method} ${pathAndQuery}`, error: `HTTP ${res.status}: ${env?.error ?? text.slice(0, 300)}` });
    throw new ApiError(env?.code ?? "http_error", env?.error ?? `HTTP ${res.status}`, "See ~/T/_large_files_bridge/error.err.", res.status);
  }
  return { status: res.status, data: env.data as T };
}
