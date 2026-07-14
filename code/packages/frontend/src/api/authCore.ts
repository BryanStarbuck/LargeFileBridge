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

// Attach the minted access token to every axios request, and re-hydrate on a 401 so a rolled/expired
// session recovers instead of hard-failing.
registerAuthBridge(
  () => authCore.getToken(),
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
