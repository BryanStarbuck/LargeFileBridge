// OpenAuthFederated embedded Frontend API (charter auth; storage.mdx §10).
// Mounted at /api/v1; runs the real Google Workspace OIDC round-trip in-process. HS256 session
// + access tokens signed with one on-disk secret — no separate auth server, no JWKS to host.
import type { RequestHandler } from "express";
import {
  createFederatedFrontend,
  configureEmbeddedVerification,
  FileSessionStore,
  loadOrCreateSecret,
} from "@auth/backend";
import { loadGoogleCreds, hasGoogleCreds } from "../../config/credentials-file.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { authSecretPath } from "../../shared/store/scopes.js";
import { oafAllowedDomains } from "../security/security.service.js";
import { getAppConfig } from "../store-model/config.service.js";
import { log } from "../../shared/logging.js";

export const AUTH_ISSUER = "large-file-bridge";

/**
 * Configure @auth/backend's embedded (HS256, in-process) token verification unconditionally — even
 * when Google creds are absent. This is an embedded/in-process deployment with NO JWKS endpoint, so
 * verifyToken() must always take the HS256 path. Without this, `createFederatedFrontend()` (which
 * calls configureEmbeddedVerification internally) only runs when Google creds exist; with creds
 * absent, `embeddedVerification` stays null and any stale Bearer token in identify.ts falls to the
 * JWKS path, where the bare "large-file-bridge" issuer throws the misleading "issuer must be an
 * absolute URL" error. We seed the verifier with the SAME sessionSecret + issuer the frontend mints
 * with, so minting and verification share one source of truth. Idempotent — safe to call repeatedly.
 */
export function ensureEmbeddedVerification(): void {
  try {
    configureEmbeddedVerification({
      sessionSecret: loadOrCreateSecret(authSecretPath()),
      issuer: AUTH_ISSUER,
    });
  } catch (e) {
    // Secret load/create is on-disk I/O; if it fails, embedded token verification is broken — surface
    // it to the fault trail, then rethrow so the caller (boot / rebuild) fails loudly rather than
    // silently falling through to the misleading JWKS path.
    log.error("auth", `Failed to configure embedded verification: ${(e as Error).message}`);
    throw e;
  }
}

// OAF's coarse OIDC domain pre-filter (security.mdx §6.1): company domains ∪ individual-email domains
// ∪ explicit AUTH_ALLOWED_DOMAINS. Re-read every time the middleware is (re)built — at boot and on each
// rebuildAuthFrontend() after an allow-list write — so it tracks the live list. The authoritative gate
// is still identify.ts → allowListed (security.mdx §6.3); this is never trusted as the sole gate.
export function allowedDomains(): string[] {
  return oafAllowedDomains();
}

/**
 * Origins the OpenAuthFederated callback may bounce back to after a successful sign-in. Google
 * redirects the browser straight to the backend (:8787), so the post-login `redirect_url` MUST be an
 * ABSOLUTE url back to the SPA's own origin — otherwise it resolves relative to :8787, which serves
 * no SPA ("Cannot GET /sso-callback"). safeRedirectTarget() only honors an absolute target when its
 * origin is on this list; anything else it strips to a bare path (which then lands on the backend).
 * In local mode the web app defaults to :2222 but may increment past a port collision (code_plan.mdx
 * §2), so we allowlist that band on both loopback hostnames. In server mode we trust only the
 * explicitly configured CORS origins.
 */
export function allowedRedirectOrigins(): string[] {
  const cfg = getAppConfig();
  const explicit = [
    ...(process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
    ...cfg.server.cors_origins,
  ];
  if (cfg.server.mode !== "local") return [...new Set(explicit)];
  const band: string[] = [];
  const base = cfg.server.frontend_port || 2222;
  for (let p = base; p < base + 16; p++) {
    band.push(`http://localhost:${p}`, `http://127.0.0.1:${p}`);
  }
  return [...new Set([...explicit, ...band])];
}

// The live embedded middleware. Built from the CURRENT config at boot and re-built whenever the
// allow-list changes (rebuildAuthFrontend). The OpenAuthFederated SDK freezes `allowedDomains` /
// `allowedRedirectOrigins` at construction (no live getter), so hot-swapping the whole middleware is
// the only way to make an allow-list edit take effect WITHOUT a process restart (security.mdx §6.3).
let activeMiddleware: RequestHandler | null = null;

/**
 * Construct the auth middleware from the current config + creds. When Google credentials are absent we
 * return a passthrough so the app still boots (the SPA shows the sign-in screen; localhost dev-auth
 * covers offline use).
 */
function constructAuthFrontend(): RequestHandler {
  if (!hasGoogleCreds()) {
    log.info("auth", "No Google creds — auth Frontend API not mounted (dev/offline mode).");
    return (_req, _res, next) => next();
  }
  try {
  const { clientId, clientSecret } = loadGoogleCreds();
  // Over plain-http localhost (cookieSecure=false) we must NOT emit HSTS: the OpenAuthFederated
  // security headers include `Strict-Transport-Security`, which is set on EVERY /api/v1 response —
  // including /api/v1/oauth_callback. The browser caches that policy for the whole `localhost` host
  // (~2 years) and then force-upgrades http://localhost:8787/... to https, so Google's redirect back
  // to the callback silently dies (no TLS server) and sign-in is stuck. HSTS is only meaningful with
  // real TLS, so these hardening headers ride with cookieSecure (on in server mode, off on http).
  // cookieSecure policy (security audit finding 5). Secure cookies are MANDATORY in server mode (real
  // TLS) — we never rely on the operator remembering to flip an env flag for prod. Only local http
  // dev may run without Secure, and even then only because HSTS/Secure over plain-http localhost
  // breaks the Google OAuth callback (see note above). So: server mode → always Secure; local mode →
  // off (the env flag can no longer accidentally ship a non-Secure cookie to production).
  const isLocal = getAppConfig().server.mode === "local";
  const secure = isLocal ? process.env.COOKIE_SECURE === "true" : true;
  // Session lifetime policy (charter: "authentication should not time out — last 10 months"), decided
  // here and passed to the library by API. The absolute maximum lifetime stays long so a returning user
  // is not forced to re-authenticate after an overnight break; the session survives server/browser/OS
  // restarts because the signing secret (authSecretPath) and the durable session records
  // (FileSessionStore) both persist to the state dir. Access tokens stay short-lived (15m) and refresh
  // silently from the session cookie. Security audit finding 8: a real INACTIVITY timeout is now set
  // (was disabled at == the absolute lifetime), so an idle/stolen session ages out in weeks, not the
  // full 10 months, while revocation via FileSessionStore covers offboarding.
  const TEN_MONTHS_SECONDS = 10 * 30 * 24 * 60 * 60; // 10 months (30-day months) = 300 days = 25,920,000s
  const IDLE_TIMEOUT_SECONDS = 14 * 24 * 60 * 60; // 14-day inactivity timeout (real idle expiry)
  const middleware = createFederatedFrontend({
    connections: [
      {
        strategy: "oauth_google",
        clientId,
        clientSecret,
        redirectUri:
          process.env.GOOGLE_REDIRECT_URI || "http://localhost:8787/api/v1/oauth_callback",
      },
    ],
    allowedDomains: allowedDomains(),
    allowedRedirectOrigins: allowedRedirectOrigins(),
    sessionSecret: loadOrCreateSecret(authSecretPath()),
    issuer: AUTH_ISSUER,
    cookiePrefix: process.env.AUTH_COOKIE_PREFIX || "oaf_lfb",
    sessionTtlSeconds: TEN_MONTHS_SECONDS,
    accessTokenTtlSeconds: 15 * 60,
    inactivityTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    // Workspace-gated deployment (charter): require the Google-asserted hosted-domain (hd) claim, so
    // membership is proven cryptographically, not inferred from the email suffix (security audit
    // finding 3). A consumer account lacking hd is rejected even if its email domain is allow-listed.
    requireHostedDomain: true,
    sessionStore: new FileSessionStore(resolveStateDir()),
    cookieSecure: secure,
    securityHeaders: secure, // no HSTS/hardening headers over http localhost (see note above)
    logger: (level, message) => log[level === "error" ? "error" : level === "warn" ? "warn" : "info"]("auth", message),
  });
  log.info(
    "auth",
    `OpenAuthFederated Frontend API mounted at /api/v1 (allowed domains: ${allowedDomains().join(", ") || "none"}).`,
  );
  return middleware as unknown as RequestHandler;
  } catch (e) {
    // Building the federated frontend touches on-disk secrets and the OAF SDK; a failure here would
    // otherwise crash boot (or a live rebuildAuthFrontend) without a fault trail. Log, then rethrow.
    log.error("auth", `Failed to construct auth Frontend API: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * Swap in a freshly-built middleware from the CURRENT allow-list. Call after any allow-list write so a
 * newly added company domain (or redirect origin) takes effect on the very next sign-in — no restart.
 */
export function rebuildAuthFrontend(): void {
  ensureEmbeddedVerification();
  activeMiddleware = constructAuthFrontend();
}

/**
 * The stable handler handed to `app.use('/api/v1', ...)`. Its identity never changes, but it delegates
 * to `activeMiddleware`, which rebuildAuthFrontend() can hot-swap underneath it — so a saved allow-list
 * edit is enforced immediately without re-mounting or restarting.
 */
export function buildAuthFrontend(): RequestHandler {
  // Always seed embedded verification at boot — this runs regardless of whether Google creds exist,
  // so identify.ts verifies stale/any Bearer token via the HS256 path (never the JWKS path).
  ensureEmbeddedVerification();
  if (!activeMiddleware) rebuildAuthFrontend();
  return (req, res, next) => activeMiddleware!(req, res, next);
}
