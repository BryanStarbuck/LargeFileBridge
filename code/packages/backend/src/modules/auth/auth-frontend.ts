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
import { log } from "../../shared/logging.js";

export const AUTH_ISSUER = "large-file-bridge";

export function allowedDomains(): string[] {
  return (process.env.AUTH_ALLOWED_DOMAINS || "act3ai.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the auth middleware. When Google credentials are absent we return a passthrough so the app
 * still boots (the SPA shows the sign-in screen; localhost dev-auth covers offline use).
 */
export function buildAuthFrontend(): RequestHandler {
  if (!hasGoogleCreds()) {
    log.info("auth", "No Google creds — auth Frontend API not mounted (dev/offline mode).");
    return (_req, _res, next) => next();
  }
  const { clientId, clientSecret } = loadGoogleCreds();
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
    sessionSecret: loadOrCreateSecret(authSecretPath()),
    issuer: AUTH_ISSUER,
    cookiePrefix: process.env.AUTH_COOKIE_PREFIX || "oaf_lfb",
    sessionStore: new FileSessionStore(resolveStateDir()),
    cookieSecure: process.env.COOKIE_SECURE === "true",
    logger: (level, message) => log[level === "error" ? "error" : level === "warn" ? "warn" : "info"]("auth", message),
  });
  log.info("auth", "OpenAuthFederated Frontend API mounted at /api/v1.");
  return middleware as unknown as RequestHandler;
}
