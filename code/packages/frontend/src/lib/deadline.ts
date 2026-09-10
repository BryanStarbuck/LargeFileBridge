// A DEADLINE FOR EVERY WAIT THE UI CAN BLOCK ON (performance.mdx T3, debugging.mdx Node 0).
//
// THE BUG THIS EXISTS TO CLOSE. `error.err` on 2026-09-09 held 36 `[client:perf.route] PAGE STILL
// SPINNING` lines — up to 80 seconds on `/repos/…`, waiting on `["authInit"]`, `["me"]`,
// `["securityConfig"]`, `["scanStatus"]` — and for the same moments the BACKEND logged nothing at all:
// zero `[request] STILL OPEN`, zero `[request] SLOW` and zero `[client:perf.longtask]`. That combination
// is the cross-check `loop-watch.ts` documents, and it eliminates both usual suspects: the server was not
// slow (probed cold, `/api/auth/me` answers in 3 ms) and the tab's main thread was not busy. The requests
// simply never completed — and NOTHING in the client bounded that wait:
//
//   • `axios.create({ baseURL: "/api" })` sets no `timeout`, and axios's default is 0 = wait forever.
//   • `RealAuthCore`'s `fetch(.../client)` and `fetch(.../tokens)` (OpenAuthFederated, a SISTER library we
//     do not edit) carry no `AbortSignal` either. `load()` retries on a backoff — but only when the fetch
//     REJECTS. A socket that is never answered and never reset (the laptop slept mid-flight, the backend
//     was replaced under a kept-alive connection) rejects never, so the backoff never fires and `load()`
//     never resolves.
//   • `getFreshToken()` is awaited INSIDE the axios request interceptor, so one wedged mint stalls every
//     request in the tab before it is even sent — which is why the spinner names every query at once.
//
// And an unbounded wait defeats the recovery the app already has. `main.tsx`'s boot gate reads
// `retryingTransiently(q)` = `q.isPending && q.failureCount > 0 && isTransientNetworkError(…)`: a request
// that never FAILS has `failureCount === 0`, so `backendUnreachable` stays false, "Reconnecting to Large
// File Bridge…" never appears, and the gate falls through to a bare, permanent `Loading…`. The machinery
// for riding out an absent backend was correct and simply never armed.
//
// THE RULE: every await the render path can block on carries a deadline, and blowing it produces an error
// that `isTransientNetworkError()` already classifies as "the backend isn't there" (`ECONNABORTED`) — so
// the timeout hands the existing retry/Reconnecting path a live wire instead of inventing a second one.

/** Axios's own code for "the deadline passed". `lib/transientError.ts` already treats it as transient, so
 *  a synthesized timeout is indistinguishable from a real one to every gate that reads it. */
export const TIMEOUT_CODE = "ECONNABORTED";

/**
 * How long a READ may take before we call the backend absent. Deliberately far above anything this app
 * has ever measured (`[request] SLOW` tops out at 8.4 s, on `/api/ipfs/liveness` behind a busy reconcile
 * window) and far below "forever". Above it, retrying is strictly better than staring: a GET is idempotent.
 */
export const READ_DEADLINE_MS = 45_000;

/**
 * How long an AUTH round trip may take. Much tighter than a read: `/api/v1/client` and the `/tokens` mint
 * are small, local, and sit in front of EVERY other request, so a slow one is felt app-wide. Blowing this
 * is not fatal — the caller falls back to "no Bearer" (the backend's 401 backstop recovers) or to
 * "backend unreachable" (the boot gate polls until it is).
 */
export const AUTH_DEADLINE_MS = 12_000;

/** An axios-shaped timeout error: `isAxiosError` + `code` are exactly what `isTransientNetworkError()`
 *  reads, and hand-rolling a bare `Error` here is the mistake `api/axios.ts`'s `unwrap` header warns
 *  about — stripped of those fields it reads as an authoritative failure and stops the retry. */
export function timeoutError(what: string, ms: number): Error & { isAxiosError: true; code: string } {
  const e = new Error(`${what} timed out after ${ms}ms`) as Error & { isAxiosError: true; code: string };
  e.name = "AxiosError";
  e.isAxiosError = true;
  e.code = TIMEOUT_CODE;
  return e;
}

/**
 * Resolve `p`, or REJECT with a transient timeout error once `ms` have passed.
 *
 * The underlying promise is not cancelled — it cannot be, for an SDK call we do not own — it is merely no
 * longer waited on. That is the whole point: the wedged mint may sit there until the browser tears the
 * socket down, while the UI has already moved on to "Reconnecting…" and its own retry.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(what, ms)), ms);
    }),
  ]);
}

/**
 * Resolve `p`, or resolve `fallback` once `ms` have passed — the non-throwing form, for waits where
 * "carry on without it" beats "fail". `getFreshToken()` is the case: no Bearer still reaches the backend,
 * which answers 401, which the axios interceptor already recovers from in one round trip.
 */
export async function withDeadlineOr<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  try {
    return await withDeadline(p, ms, "request");
  } catch {
    return fallback;
  }
}
