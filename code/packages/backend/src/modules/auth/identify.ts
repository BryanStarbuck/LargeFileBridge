// "Identify, don't gate" middleware (sister pattern) + LFB's allow-list enforcement.
// Verifies the Bearer access token via @auth/backend, then re-checks the email against
// config.access.allowed_emails (charter: allow-listed users only, no anonymous account).
import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "@auth/backend";
import { getAppConfig } from "../store-model/config.service.js";
import { AUTH_ISSUER, allowedDomains } from "./auth-frontend.js";
import { hasGoogleCreds } from "../../config/credentials-file.js";
import { DEFAULT_USER, type AuthUser } from "./current-user.js";
import { log } from "../../shared/logging.js";

function allowListed(email: string | null): boolean {
  if (!email) return false;
  const cfg = getAppConfig();
  const list = cfg.access.allowed_emails.map((e) => e.toLowerCase());
  const domainOk = allowedDomains().some((d) => email.toLowerCase().endsWith("@" + d.toLowerCase()));
  // Allow-listed if explicitly listed, or (no explicit list yet) if the domain matches.
  if (list.length > 0) return list.includes(email.toLowerCase());
  return domainOk;
}

export async function identify(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const withUser = req as Request & { user?: AuthUser };

  // Localhost dev bypass: no Google creds + LFB_DEV_AUTH -> act as the first allow-listed user.
  if (!hasGoogleCreds() && process.env.LFB_DEV_AUTH !== "false") {
    const email = getAppConfig().access.allowed_emails[0] || "dev@localhost";
    withUser.user = {
      authenticated: true,
      email,
      name: "Local Dev",
      roles: ["admin"],
      permissions: [],
      allowListed: true,
      sessionId: "dev",
    };
    return next();
  }

  const auth = req.header("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    withUser.user = DEFAULT_USER;
    return next();
  }
  try {
    const claims = await verifyToken(token, { issuer: AUTH_ISSUER });
    const email = (claims.email as string | undefined) ?? null;
    const listed = allowListed(email);
    withUser.user = {
      authenticated: true,
      email,
      name: (claims.name as string | undefined) ?? email,
      roles: (claims.roles as string[] | undefined) ?? [],
      permissions: (claims.permissions as string[] | undefined) ?? [],
      allowListed: listed,
      sessionId: (claims.sid as string | undefined) ?? null,
    };
    if (!listed) log.warn("auth", `Rejected non-allow-listed sign-in: ${email}`);
  } catch (e) {
    log.warn("auth", `Token verification failed: ${(e as Error).message}`);
    withUser.user = DEFAULT_USER;
  }
  return next();
}

/** Gate a route to allow-listed users; 401 otherwise (used to wrap all data routes). */
export function requireAllowListed(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: AuthUser }).user ?? DEFAULT_USER;
  if (!user.allowListed) {
    res.status(401).json({ ok: false, error: "Not signed in", code: "unauthenticated" });
    return;
  }
  next();
}

/** Gate a route to admins (allow-list editing) — settings.mdx §4. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: AuthUser }).user ?? DEFAULT_USER;
  const isAdmin = user.roles.includes("admin");
  if (!user.allowListed || !isAdmin) {
    res.status(403).json({ ok: false, error: "Admin only", code: "forbidden" });
    return;
  }
  next();
}
