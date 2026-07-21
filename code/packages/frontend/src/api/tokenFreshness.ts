// The three pure time decisions behind "never send a Bearer that the backend will reject" —
// kept out of api/authCore.ts (which owns the SDK, timers and listeners) so they can be unit-tested
// directly (authentication.mdx §4). All times are epoch SECONDS, matching a JWT's `exp`.
//
// THE BUG THESE LOCK CLOSED: error.err carried real page loads failing as
// `[auth] Token verification failed (GET /todo/batches): "exp" claim timestamp check failed` — the
// browser attached an access token that had already lapsed, so the user silently got no data.

/** Attach-time floor: below this much remaining life a Bearer can lapse in flight — never send it. */
export const TOKEN_HARD_FLOOR_S = 10;

/** Attach-time target: inside this window we mint a fresh Bearer BEFORE the request goes out. */
export const TOKEN_MIN_TTL_S = 60;

/** Keep-alive target: the watchdog renews this far ahead of `exp`, well before the attach guard bites. */
export const WATCHDOG_MIN_TTL_S = 120;

/** Seconds of life left in a token, given its `exp` claim. */
export function secondsRemaining(exp: number, nowSeconds: number): number {
  return exp - nowSeconds;
}

/** Should the request interceptor force a fresh mint before attaching this token? */
export function needsRefreshBeforeUse(exp: number, nowSeconds: number): boolean {
  return secondsRemaining(exp, nowSeconds) < TOKEN_MIN_TTL_S;
}

/** Should the background keep-alive renew now? (Earlier than the attach guard, so it rarely bites.) */
export function needsProactiveRenewal(exp: number, nowSeconds: number): boolean {
  return secondsRemaining(exp, nowSeconds) < WATCHDOG_MIN_TTL_S;
}

/**
 * A re-mint just failed and all we hold is the old token — may we still send it? Only with a real
 * margin. "Not expired yet" is NOT good enough: the token still has to survive the network hop and the
 * backend's event loop before `exp` is checked.
 */
export function safeToAttachStaleToken(exp: number, nowSeconds: number): boolean {
  return secondsRemaining(exp, nowSeconds) > TOKEN_HARD_FLOOR_S;
}
