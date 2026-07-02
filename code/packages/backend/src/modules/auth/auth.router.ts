// Auth plumbing: who am I + is OAuth configured (drives the sign-in screen remediation).
import { Router } from "express";
import type { AuthConfig, CurrentUser } from "@lfb/shared";
import { currentUser } from "./current-user.js";
import { hasGoogleCreds, credentialsFileInfo } from "../../config/credentials-file.js";

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

// GET /api/health/auth-config — mounted under /api/health by the health router below.
// Includes credentialsFile setup guidance (path/filename/schema) so a fresh computer can be told
// exactly which file to create. Never returns the secret values themselves.
export function authConfig(): AuthConfig {
  const configured = hasGoogleCreds();
  return {
    oauthConfigured: configured,
    devAuth: !configured && process.env.LFB_DEV_AUTH !== "false",
    credentialsFile: credentialsFileInfo(),
  };
}
