// OpenAuthFederated client wiring. The backend embeds the Frontend API at /api/v1 (auth-frontend.ts),
// so we drive it with @auth/react's RealAuthCore instead of a hosted OpenAuthFederated server:
//   • load()                     → GET  /api/v1/client            (rehydrate session from the cookie)
//   • getToken()                 → POST /api/v1/client/sessions/:id/tokens (mint the Bearer identify.ts wants)
//   • authenticateWithRedirect() → GET  /api/v1/sign_in/sso       (start the Google round-trip)
//   • completeRedirectCallback() → finish the /sso-callback handshake
// The embedded server authenticates these calls by the session cookie, not the publishable key, so the
// key below is a placeholder it never checks. Registering the token getter here is what lets every
// /api request carry a Bearer token — without it a completed login still reads as unauthenticated.
import { RealAuthCore } from "@auth/react";
import { registerAuthBridge } from "./axios.js";
import {
  needsProactiveRenewal,
  needsRefreshBeforeUse,
  safeToAttachStaleToken,
} from "./tokenFreshness.js";
import { clientLog } from "../lib/clientLog.js";
import { AUTH_DEADLINE_MS, withDeadline, withDeadlineOr } from "../lib/deadline.js";

// Coarse pre-filter only (mirrors the backend default); the authoritative allow-list gate is
// server-side (identify.ts). Used here just to label the Google connection for the sign-in redirect.
const ALLOWED_DOMAINS = ["act3ai.com"];

// frontendApi "/api" → the SDK targets "/api/v1/*", which Vite proxies (dev) / the backend serves
// (prod) at the same origin, so the session cookie rides along with credentials: "include".
export const authCore = new RealAuthCore("/api", "lfb-embedded", ALLOWED_DOMAINS);

// The attach/renew time thresholds live in ./tokenFreshness.js (pure, unit-tested):
//   • needsRefreshBeforeUse   — the SDK reuses its cached token down to ~10s before `exp`, which is not
//     enough once real delivery delays exist, so we re-mint inside a 60s window at ATTACH time.
//   • safeToAttachStaleToken  — the hard floor. A Bearer that could lapse between attach and the
//     backend's `exp` check is never sent (that IS the `"exp" claim timestamp check failed` line).
//   • needsProactiveRenewal   — the watchdog's earlier target, so the attach guard rarely bites.

// Proactive keep-alive. The SDK arms a one-shot timer ~30s before each token's own `exp`, but that timer
// is (a) paused while the machine sleeps and throttled while the tab is hidden, and (b) permanently
// disarmed if a single mint fails — RealAuthCore.clearTokenCache() cancels it and only a SUCCESSFUL mint
// re-arms it. A tab that hit one transient mint failure therefore fell back to reactive-only renewal for
// the rest of its life, which is how a 15-minute token lapsed unnoticed and rode out on a real page load.
// This watchdog is an independent, self-healing safety net: a cheap local check every WATCHDOG_INTERVAL_MS
// (plus on wake / tab-visible / back-online), re-minting only when little life remains.
// It is NOT background polling (performance.mdx P-07): the check is local, it never runs while the tab is
// hidden, and it touches the network at most once per token lifetime (~15 min).
const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * Read the `exp` (epoch seconds) claim WITHOUT verifying — used only to decide "refresh before use",
 * never for a trust decision (mirrors the SDK's own readJwtExp).
 */
function readJwtExp(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

// SINGLE-FLIGHT FORCED REFRESH. `authCore.refresh()` is NOT single-flight: it clears the token cache
// and then mints, so N concurrent callers that all land in the "less than TOKEN_MIN_TTL_S left" window
// each clear the cache and each fire their own POST /tokens (error.err's sibling log.log shows 3-4
// "Access token refreshed" lines in the SAME millisecond). Worse, every clear cancels the SDK's pending
// proactive-refresh timer, so a storm whose last mint fails leaves the tab with no scheduled renewal at
// all. Funnelling every forced refresh through one shared promise gives exactly ONE mint per storm.
let refreshInFlight: Promise<string | null> | null = null;

/** Force one fresh mint, shared by all concurrent callers. Never throws — resolves null on failure.
 *
 *  DEADLINED. `authCore.refresh()` POSTs `/api/v1/client/sessions/:id/tokens` with a bare `fetch` and no
 *  `AbortSignal` (OpenAuthFederated is a sister library, read-only to us), so a socket that is never
 *  answered leaves this promise pending forever — and because it is SINGLE-FLIGHT, every later caller
 *  joins the same wedged promise rather than starting a fresh one. That is the shape that took the whole
 *  tab down: see lib/deadline.ts. Blowing the deadline resolves null, which every caller already handles
 *  as "mint failed" — and clears `refreshInFlight`, so the NEXT caller gets a genuinely new attempt. */
export function refreshTokenOnce(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = withDeadlineOr(authCore.refresh(), AUTH_DEADLINE_MS, null)
      .catch((e) => {
        clientLog.warn("authCore.refreshTokenOnce", e);
        return null;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * Refresh-before-use token getter (authentication.mdx §4): returns the cached Bearer unless it is
 * within TOKEN_MIN_TTL_S of expiry, in which case it forces a fresh mint FIRST so no request ever
 * leaves with a token about to (or already) lapse. Concurrent callers share ONE mint (refreshTokenOnce),
 * so a refresh never fans out into parallel /tokens calls. If the mint fails (backend blip), the old
 * token is reused ONLY while it still has a real safety margin (TOKEN_HARD_FLOOR_S); anything closer to
 * `exp` is dropped (send no Bearer, let the reactive 401 backstop recover) — we never attach a Bearer
 * that can lapse in flight.
 */
export async function getFreshToken(): Promise<string | null> {
  // DEADLINED, and this one matters most: it is awaited INSIDE the axios request interceptor, so a wedged
  // mint here stalls every request in the tab before any of them is even sent — which is exactly why the
  // spinner named `authInit`, `me`, `securityConfig`, `progress`, `ipfsLiveness` and `repo` all at once
  // (lib/deadline.ts). Falling back to "no Bearer" is safe and self-healing: the request goes out
  // unauthenticated, the backend answers 401, and api/axios.ts's single-flight 401 backstop recovers it in
  // one round trip. A null here costs one extra round trip; a hang here costs the whole page.
  const token = await withDeadlineOr(authCore.getToken(), AUTH_DEADLINE_MS, null);
  if (!token) return null;
  const exp = readJwtExp(token);
  const now = Math.floor(Date.now() / 1000);
  if (exp !== null && needsRefreshBeforeUse(exp, now)) {
    const fresh = await refreshTokenOnce();
    if (fresh) return fresh;
    return safeToAttachStaleToken(exp, now) ? token : null;
  }
  return token;
}

// Attach the minted access token to every axios request; on a 401 recover the session ONCE (shared by
// every concurrent caller) and retry, instead of hard-failing or fanning out N recoveries.
registerAuthBridge({
  getToken: () => getFreshToken(),
  refreshToken: () => refreshTokenOnce(),
  // Deadlined for the same reason as the mint above: `load()` retries `/api/v1/client` on a backoff, but
  // only when the fetch REJECTS — an unanswered socket rejects never, so the backoff never fires and the
  // deeper 401 recovery hangs instead of failing. `recoverSession()` already treats a thrown reload as
  // non-fatal and asks `isSignedIn()` for the authoritative answer.
  reloadSession: () => withDeadline(authCore.load(), AUTH_DEADLINE_MS, "session reload").then(() => undefined),
  isSignedIn: () => authCore.getSnapshot().isSignedIn,
});

// Proactively re-mint the 15-min Bearer ~30s before it expires so an open tab never has to discover
// expiry via a failed request. Without this the SDK only re-mints reactively (axios catches a 401,
// reloads the session, and retries) — one stuttered call per 15 min, the "lots of timeouts" symptom.
// The session cookie also rolls forward on each mint, so an actively-used tab keeps its login alive.
authCore.enableAutoRefresh();

/**
 * Is the currently cached Bearer due for renewal? The common answer is "no" and costs nothing: the SDK
 * serves its cached token and we compare the token's own `exp` locally — no network call.
 */
async function tokenDueForRenewal(): Promise<boolean> {
  // getToken() serves the cached token when it still has >10s of life; when the cache has already
  // lapsed it mints — which is exactly the renewal we want, so either outcome is correct here.
  const token = await authCore.getToken().catch(() => null);
  if (!token) return false; // signed out, or the mint failed — the 401 backstop owns that case
  const exp = readJwtExp(token);
  if (exp === null) return false;
  return needsProactiveRenewal(exp, Math.floor(Date.now() / 1000));
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Keep the session's Bearer ahead of its own expiry for as long as this tab is open and active
 * (authentication.mdx §4). Self-healing by design: it re-checks from scratch every minute, so a missed
 * or disarmed SDK timer, a sleep, or a failed mint can never leave the tab renewing reactively-only.
 * Idempotent — safe to call once at boot.
 */
export function startSessionKeepAlive(): void {
  if (watchdogTimer || typeof window === "undefined") return;

  const check = (): void => {
    // Never work while hidden: performance.mdx P-07 locks "no background polling", and a hidden tab's
    // renewal is picked up the moment it becomes visible again (below).
    if (typeof document !== "undefined" && document.hidden) return;
    if (!authCore.getSnapshot().isSignedIn) return;
    void (async () => {
      if (await tokenDueForRenewal()) await refreshTokenOnce();
    })().catch((e) => clientLog.warn("authCore.keepAlive", e));
  };

  watchdogTimer = setInterval(check, WATCHDOG_INTERVAL_MS);
  // The three moments a paused timer leaves a stale token behind: the machine woke / the tab came back
  // to the foreground, the page was restored from the back-forward cache, or the network returned.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
  window.addEventListener("pageshow", check);
  window.addEventListener("online", check);
}

// Kick off the Google sign-in redirect. redirectUrl is the SPA landing that finishes the handshake
// (/sso-callback); redirectUrlComplete is where we end up afterward. The SDK expands both to ABSOLUTE
// SPA-origin URLs, which the backend allowlists (allowedRedirectOrigins) so the callback lands back
// on the web app rather than on the API-only backend origin.
export function startGoogleSignIn(): Promise<void> {
  // A failed redirect start (SDK/network error) otherwise vanishes; log it, then rethrow so the
  // caller's UX handling is unchanged.
  return authCore
    .authenticateWithRedirect({
      redirectUrl: "/sso-callback",
      redirectUrlComplete: "/",
    })
    .catch((e) => {
      clientLog.error("authCore.startGoogleSignIn", e);
      throw e;
    });
}
