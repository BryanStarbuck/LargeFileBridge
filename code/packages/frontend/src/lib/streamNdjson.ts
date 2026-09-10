// A tiny fetch-based NDJSON stream reader (performance.mdx Part III, Aspect 3).
//
// We stream with fetch() + ReadableStream rather than EventSource (SSE) because every /api call must
// carry the OpenAuthFederated Bearer token (axios.ts / identify.ts) and EventSource CANNOT set an
// Authorization header — SSE would bypass the allow-list gate. fetch lets us attach the same token
// (and the session cookie via credentials:"include") AND read the body incrementally. Backpressure
// and cancellation come free from the reader + the caller's AbortSignal.
import { getFreshToken, refreshTokenOnce } from "../api/authCore.js";
import { clientLog } from "./clientLog.js";
import { timeoutError } from "./deadline.js";

/**
 * How long the CONNECT phase — request out, response headers back — may take before we call the stream
 * dead and let the caller's backoff reconnect. Only the headers are bounded: an NDJSON stream's BODY is
 * long-lived by design (`/events/stream` deliberately holds open between heartbeats), so a deadline on the
 * read loop would sever every healthy stream on a schedule. `liveStream.ts` already has the right guard
 * for the body — a stall watchdog that aborts when no line has arrived for two heartbeats.
 *
 * WHY THE CONNECT PHASE NEEDS ONE AT ALL: `fetch` has no default timeout. A stream that goes out over a
 * socket nobody answers (the backend replaced under a kept-alive connection, the laptop woken mid-flight)
 * never resolves and never rejects, so `runLoop`'s `catch` never runs, the backoff never fires, and the
 * subscription is silently dead for the life of the tab — no data, no error, no reconnect. See
 * lib/deadline.ts for the same defect on the axios and auth paths.
 */
const CONNECT_DEADLINE_MS = 20_000;

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
  // THE ABORT CHAIN. The fetch is driven by OUR controller, not the caller's, because the connect
  // deadline has to be able to abort it. The caller's `signal` is relayed into that controller, and the
  // relay STAYS ATTACHED for the life of the response — detaching it once headers arrived would quietly
  // sever the caller's control over the BODY, which is the only thing that ends a long-lived stream
  // (`liveStream.ts` aborts on teardown and on its stall watchdog). Only the TIMER is disarmed on headers.
  const relays: Array<() => void> = [];

  // A missing/failed token is non-fatal (the request may still resolve, or the backend rejects it and
  // we surface that below) — but a swallowed token error is worth a breadcrumb, so log and continue.
  // getFreshToken (not raw getToken): a stream (re)connect after a laptop wakes from sleep is exactly
  // the moment the cached Bearer has silently lapsed — refresh-before-use, never attach a stale token.
  const open = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = { Accept: "application/x-ndjson" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const connectAc = new AbortController();
    if (signal) {
      if (signal.aborted) connectAc.abort();
      const relay = (): void => connectAc.abort();
      signal.addEventListener("abort", relay);
      relays.push(() => signal.removeEventListener("abort", relay));
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      connectAc.abort();
    }, CONNECT_DEADLINE_MS);
    try {
      return await fetch(`/api${pathAndQuery}`, { headers, credentials: "include", signal: connectAc.signal });
    } catch (e) {
      // Our own deadline, not the caller's abort: report it as a transient timeout so the caller's backoff
      // treats it like any other unreachable-backend failure rather than a silent cancellation.
      if (timedOut && !signal?.aborted) throw timeoutError(`stream ${pathAndQuery}`, CONNECT_DEADLINE_MS);
      throw e;
    } finally {
      clearTimeout(timer); // headers are in (or the attempt failed) — the deadline must never reach the body
    }
  };

  try {
    await pump(open, onEvent);
  } finally {
    for (const off of relays) off();
  }
}

/** The stream itself, once the connect policy above is in place. */
async function pump(
  open: (token: string | null) => Promise<Response>,
  onEvent: (event: unknown) => void,
): Promise<void> {
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
