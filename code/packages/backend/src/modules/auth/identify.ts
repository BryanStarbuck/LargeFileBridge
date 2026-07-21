// "Identify, don't gate" middleware (sister pattern) + LFB's allow-list enforcement.
// Verifies the Bearer access token via @auth/backend, then re-checks the email against the LIVE
// security allow-list (security.mdx §1/§6.2 — companies OR individuals; charter: allow-listed only).
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "@auth/backend";
import { getAppConfig } from "../store-model/config.service.js";
import { AUTH_ISSUER } from "./auth-frontend.js";
import { hasGoogleCreds, loadApiSecret } from "../../config/credentials-file.js";
import { allowListed, securityConfigured } from "../security/security.service.js";
import { DEFAULT_USER, type AuthUser } from "./current-user.js";
import { isLoopback } from "../../shared/loopback.js";
import { log } from "../../shared/logging.js";

/**
 * The CLI's machine-caller channel (cli.mdx §3.2): X-LFB-Api-Key verified against the shared secret
 * in ~/.credentials/large_files_bridge.json. Localhost-ONLY by construction — a non-loopback caller
 * presenting the header is ignored (falls through to real auth), never honored. Constant-time
 * comparison; possession of the same-user 0600 file is the proof of identity, so the fabricated
 * principal maps to the first allow-listed email (same visibility as the browser session — no
 * privilege beyond what the local user already has).
 */
function apiKeyUser(req: Request): AuthUser | null {
  const presented = req.header("x-lfb-api-key");
  if (!presented || !isLoopback(req)) return null;
  if (getAppConfig().server.mode !== "local") return null; // shared-file trick is a same-machine mechanism only
  const secret = loadApiSecret();
  if (!secret) return null;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    log.warn("auth", `Rejected X-LFB-Api-Key call (${req.method} ${req.path}): key mismatch`);
    return null;
  }
  const email = getAppConfig().access.allowed_emails[0] || "cli@localhost";
  return {
    authenticated: true,
    email,
    name: "Large File Bridge CLI",
    roles: ["admin"],
    permissions: [],
    allowListed: true,
    sessionId: "cli",
  };
}

export async function identify(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const withUser = req as Request & { user?: AuthUser };

  // CLI machine caller (cli.mdx §3) — checked FIRST: a valid loopback API key needs no Bearer token.
  const cliUser = apiKeyUser(req);
  if (cliUser) {
    withUser.user = cliUser;
    return next();
  }

  // Localhost dev bypass (security audit finding 1). This fabricates an admin principal, so it is
  // gated on ALL of the following — never on "no Google creds" alone, which previously handed an
  // unauthenticated, network-reachable caller full admin:
  //   • local mode (never in server mode — a server deployment fails closed to real sign-in),
  //   • the request actually originates from loopback (this machine),
  //   • an EXPLICIT opt-in: LFB_DEV_AUTH === "true" (not merely unset),
  //   • security is configured (else the one-time Security Setup page shows first — security.mdx §3),
  //   • no Google creds are present (otherwise real OIDC sign-in is used).
  const isLocalMode = getAppConfig().server.mode === "local";
  if (
    isLocalMode &&
    isLoopback(req) &&
    process.env.LFB_DEV_AUTH === "true" &&
    securityConfigured() &&
    !hasGoogleCreds()
  ) {
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
    // Force the embedded (HS256, in-process) path: this app has no JWKS endpoint. `embedded: true`
    // guarantees the symmetric verification path even if configuration ordering ever changes, so a
    // stale/invalid token fails with a proper signature error (caught below) rather than the
    // misleading "issuer must be an absolute URL" thrown on the JWKS path for a bare issuer string.
    const claims = await verifyToken(token, { issuer: AUTH_ISSUER, embedded: true });
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
    // Include the route (method + path, never the query string — media tokens ride in queries) so a
    // recurring failure identifies its caller instead of reading as an anonymous expired token.
    log.warn("auth", `Token verification failed (${req.method} ${req.path}): ${(e as Error).message}`);
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
