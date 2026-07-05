// Auth plumbing: who am I + is OAuth configured (drives the sign-in screen remediation).
import { Router } from "express";
import type { AuthConfig, CurrentUser } from "@lfb/shared";
import { currentUser } from "./current-user.js";
import { hasGoogleCreds, credentialsFileInfo } from "../../config/credentials-file.js";
import { allowedDomains } from "./auth-frontend.js";

// The EXACT redirect URI to register on the Google Cloud OAuth client (webapp.mdx §3.2 item 3) — built
// from the API port 8787, mirroring auth-frontend.ts. Single source so the panel can never drift.
function resolvedRedirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI || "http://localhost:8787/api/v1/oauth_callback";
}

export const authRouter = Router();

authRouter.get("/me", (req, res) => {
  const u = currentUser(req);
  const out: CurrentUser = {
    authenticated: u.authenticated,
    email: u.email,
    name: u.name,
    roles: u.roles,
    permissions: u.permissions,
    allowListed: u.allowListed,
  };
  res.json({ ok: true, data: out });
});

// GET /api/health/auth-config — mounted under /api/health. Security audit finding 9: only a LOOPBACK
// caller (this machine, doing first-run setup) gets the sensitive setup guidance — the on-disk
// credentials-file path and the dev-bypass state. A non-loopback / remote caller gets only the
// oauthConfigured boolean, with the path/filename/directory redacted and devAuth never disclosed
// (which would confirm the unauthenticated-admin bypass is active). Secret VALUES are never returned.
export function authConfig(includeSensitive: boolean): AuthConfig {
  const configured = hasGoogleCreds();
  const info = credentialsFileInfo();
  if (!includeSensitive) {
    return {
      oauthConfigured: configured,
      devAuth: false, // never echo dev-bypass state to a non-loopback caller
      credentialsFile: { ...info, path: "", filename: "", directory: "", schemaExample: {} },
      redirectUri: "", // redacted for a remote caller, like the creds path
      allowedDomains: [],
    };
  }
  return {
    oauthConfigured: configured,
    devAuth: !configured && process.env.LFB_DEV_AUTH === "true",
    credentialsFile: info,
    redirectUri: resolvedRedirectUri(),
    allowedDomains: allowedDomains(),
  };
}
