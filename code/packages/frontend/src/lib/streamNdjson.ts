// A tiny fetch-based NDJSON stream reader (performance.mdx Part III, Aspect 3).
//
// We stream with fetch() + ReadableStream rather than EventSource (SSE) because every /api call must
// carry the OpenAuthFederated Bearer token (axios.ts / identify.ts) and EventSource CANNOT set an
// Authorization header — SSE would bypass the allow-list gate. fetch lets us attach the same token
// (and the session cookie via credentials:"include") AND read the body incrementally. Backpressure
// and cancellation come free from the reader + the caller's AbortSignal.
import { getFreshToken, refreshTokenOnce } from "../api/authCore.js";
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
  // getFreshToken (not raw getToken): a stream (re)connect after a laptop wakes from sleep is exactly
  // the moment the cached Bearer has silently lapsed — refresh-before-use, never attach a stale token.
  const open = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = { Accept: "application/x-ndjson" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`/api${pathAndQuery}`, { headers, credentials: "include", signal });
  };

  let res = await open(
    await getFreshToken().catch((e) => {
      clientLog.warn("streamNdjson.getToken", e);
      return null;
    }),
  );

  // THE 401 BACKSTOP THE STREAM PATH WAS MISSING. Every axios call already recovers from a 401 by forcing
  // one shared re-mint and retrying (api/axios.ts `registerAuthBridge`); streams did not, and they are the
  // requests MOST exposed to it — `getFreshToken()` hands over a Bearer it believes is good, and the token
  // can still be rejected because it lapsed between attach and verify (the backend needed longer than
  // TOKEN_HARD_FLOOR_S to reach the check — see backend `loop-watch.ts`) or because the clocks disagree.
  //
  // Without a retry the caller backed off and reconnected with the SAME cached token, which fails
  // identically, so the tab sat in a reconnect loop writing `stream failed: HTTP 401` into the fault trail
  // until the token finally expired outright and the SDK re-minted on its own. Forcing the re-mint HERE
  // makes the second attempt carry a genuinely new Bearer, which is the difference between recovering in
  // one round trip and recovering in fifteen minutes. Exactly one retry — a 401 that survives a fresh mint
  // is a real authorization answer (signed out, off the allow-list) and must surface, not spin.
  if (res.status === 401) {
    const minted = await refreshTokenOnce();
    if (minted) res = await open(minted);
  }

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
