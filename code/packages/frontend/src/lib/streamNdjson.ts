// A tiny fetch-based NDJSON stream reader (performance.mdx Part III, Aspect 3).
//
// We stream with fetch() + ReadableStream rather than EventSource (SSE) because every /api call must
// carry the OpenAuthFederated Bearer token (axios.ts / identify.ts) and EventSource CANNOT set an
// Authorization header — SSE would bypass the allow-list gate. fetch lets us attach the same token
// (and the session cookie via credentials:"include") AND read the body incrementally. Backpressure
// and cancellation come free from the reader + the caller's AbortSignal.
import { authCore } from "../api/authCore.js";
import { clientLog } from "./clientLog.js";

export interface NdjsonStreamOptions {
  signal?: AbortSignal;
  onEvent: (event: unknown) => void;
}

/**
 * Open `/api{pathAndQuery}` as a stream and invoke `onEvent` once per newline-delimited JSON object.
 * `pathAndQuery` is relative to the /api base, e.g. "/fs/flat/stream?path=...". Resolves when the
 * stream ends; rejects on a network/HTTP error (an aborted stream resolves silently, matching fetch).
 */
export async function streamNdjson(
  pathAndQuery: string,
  { signal, onEvent }: NdjsonStreamOptions,
): Promise<void> {
  // A missing/failed token is non-fatal (the request may still resolve, or the backend rejects it and
  // we surface that below) — but a swallowed token error is worth a breadcrumb, so log and continue.
  const token = await authCore.getToken().catch((e) => {
    clientLog.warn("streamNdjson.getToken", e);
    return null;
  });
  const headers: Record<string, string> = { Accept: "application/x-ndjson" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${pathAndQuery}`, {
    headers,
    credentials: "include",
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`stream failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // Parse one NDJSON line. A malformed line rejects the whole stream (the documented contract), but
  // log it first so the offending line lands in the fault trail rather than a bare parse error.
  const parseLine = (line: string): unknown => {
    try {
      return JSON.parse(line);
    } catch (e) {
      clientLog.error("streamNdjson.parse", e);
      throw e;
    }
  };

  const drain = (final: boolean) => {
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(parseLine(line));
    }
    if (final) {
      const tail = buf.trim();
      if (tail) onEvent(parseLine(tail));
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    drain(false);
  }
  drain(true);
}
