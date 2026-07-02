// Auth plumbing: who am I + is OAuth configured (drives the sign-in screen remediation).
import { Router } from "express";
import type { CurrentUser } from "@lfb/shared";
import { currentUser } from "./current-user.js";
import { hasGoogleCreds } from "../../config/credentials-file.js";

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
export function authConfig() {
  return {
    oauthConfigured: hasGoogleCreds(),
    devAuth: !hasGoogleCreds() && process.env.LFB_DEV_AUTH !== "false",
  };
}
