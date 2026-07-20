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
import { clientLog } from "../lib/clientLog.js";

// Coarse pre-filter only (mirrors the backend default); the authoritative allow-list gate is
// server-side (identify.ts). Used here just to label the Google connection for the sign-in redirect.
const ALLOWED_DOMAINS = ["act3ai.com"];

// frontendApi "/api" → the SDK targets "/api/v1/*", which Vite proxies (dev) / the backend serves
// (prod) at the same origin, so the session cookie rides along with credentials: "include".
export const authCore = new RealAuthCore("/api", "lfb-embedded", ALLOWED_DOMAINS);

// Minimum remaining validity a Bearer must have at ATTACH time. The SDK reuses its cached token until
// ~10s before `exp`, which is not enough once real delivery delays exist: a tab that slept past expiry
// can fire a request before the (sleep-paused) proactive-refresh timer runs, and a backend whose event
// loop is briefly blocked can verify a nearly-expired token AFTER it lapsed. Both showed up in
// error.err as `[auth] Token verification failed: "exp" claim timestamp check failed`.
const TOKEN_MIN_TTL_S = 60;

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

/**
 * Refresh-before-use token getter (authentication.mdx §4): returns the cached Bearer unless it is
 * within TOKEN_MIN_TTL_S of expiry, in which case it forces a fresh mint FIRST so no request ever
 * leaves with a token about to (or already) lapse. Concurrent callers queue on the SDK's single-flight
 * mint, so a refresh never fans out into parallel /tokens calls. If the mint fails (backend blip), a
 * still-valid old token is used as-is; a known-expired one is dropped (send no Bearer, let the
 * reactive 401→reload backstop recover) — never knowingly attach an expired token.
 */
export async function getFreshToken(): Promise<string | null> {
  const token = await authCore.getToken();
  if (!token) return null;
  const exp = readJwtExp(token);
  const now = Math.floor(Date.now() / 1000);
  if (exp !== null && exp - now < TOKEN_MIN_TTL_S) {
    const fresh = await authCore.refresh().catch(() => null);
    if (fresh) return fresh;
    return exp > now ? token : null;
  }
  return token;
}

// Attach the minted access token to every axios request, and re-hydrate on a 401 so a rolled/expired
// session recovers instead of hard-failing.
registerAuthBridge(
  () => getFreshToken(),
  () => authCore.load(),
);

// Proactively re-mint the 15-min Bearer ~30s before it expires so an open tab never has to discover
// expiry via a failed request. Without this the SDK only re-mints reactively (axios catches a 401,
// reloads the session, and retries) — one stuttered call per 15 min, the "lots of timeouts" symptom.
// The session cookie also rolls forward on each mint, so an actively-used tab keeps its login alive.
authCore.enableAutoRefresh();

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
