// OpenAuthFederated embedded Frontend API (charter auth; storage.mdx §10).
// Mounted at /api/v1; runs the real Google Workspace OIDC round-trip in-process. HS256 session
// + access tokens signed with one on-disk secret — no separate auth server, no JWKS to host.
import type { RequestHandler } from "express";
import {
  createFederatedFrontend,
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
  const { clientId, clientSecret } = loadGoogleCreds();
  // Over plain-http localhost (cookieSecure=false) we must NOT emit HSTS: the OpenAuthFederated
  // security headers include `Strict-Transport-Security`, which is set on EVERY /api/v1 response —
  // including /api/v1/oauth_callback. The browser caches that policy for the whole `localhost` host
  // (~2 years) and then force-upgrades http://localhost:8787/... to https, so Google's redirect back
  // to the callback silently dies (no TLS server) and sign-in is stuck. HSTS is only meaningful with
  // real TLS, so these hardening headers ride with cookieSecure (on in server mode, off on http).
  const secure = process.env.COOKIE_SECURE === "true";
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
}

/**
 * Swap in a freshly-built middleware from the CURRENT allow-list. Call after any allow-list write so a
 * newly added company domain (or redirect origin) takes effect on the very next sign-in — no restart.
 */
export function rebuildAuthFrontend(): void {
  activeMiddleware = constructAuthFrontend();
}

/**
 * The stable handler handed to `app.use('/api/v1', ...)`. Its identity never changes, but it delegates
 * to `activeMiddleware`, which rebuildAuthFrontend() can hot-swap underneath it — so a saved allow-list
 * edit is enforced immediately without re-mounting or restarting.
 */
export function buildAuthFrontend(): RequestHandler {
  if (!activeMiddleware) rebuildAuthFrontend();
  return (req, res, next) => activeMiddleware!(req, res, next);
}
