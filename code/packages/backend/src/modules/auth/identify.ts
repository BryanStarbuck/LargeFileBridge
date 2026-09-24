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
 * The machine-caller channel for the CLI and the MCP server (cli.mdx §3.2, mcp.mdx §6): X-LFB-Api-Key
 * verified against the shared secret in ~/.credentials/large_files_bridge.json. Localhost-ONLY by
 * construction — a non-loopback caller presenting the header is ignored (falls through to real auth), never
 * honored. Possession of the same-user 0600 file is the proof of identity, so the fabricated principal maps
 * to the first allow-listed email (same visibility as the browser session — no privilege beyond what the
 * local user already has).
 *
 * Hardening (apis.mdx §3, learned from the sister apps):
 *   * LENGTH-INDEPENDENT compare: both sides are SHA-256'd first, then timingSafeEqual — a wrong-length key
 *     takes the same path as a wrong key, so timing leaks nothing about the secret's length.
 *   * FAILURE THROTTLE: more than MAX_KEY_FAILURES bad keys per minute from one address and the header is
 *     ignored for the rest of the window — a runaway script cannot grind the secret or flood error.err.
 *   * The caller may NAME itself with `X-LFB-Client: cli | mcp` so audit lines say who acted. The name is
 *     taken from a fixed list — it can label a request, never elevate one.
 */
const MAX_KEY_FAILURES = 20;
const KEY_FAILURE_WINDOW_MS = 60_000;
const keyFailures = new Map<string, { count: number; resetAt: number }>();

function keyThrottled(addr: string): boolean {
  const cur = keyFailures.get(addr);
  return !!cur && Date.now() < cur.resetAt && cur.count >= MAX_KEY_FAILURES;
}

function noteKeyFailure(addr: string): number {
  const now = Date.now();
  const cur = keyFailures.get(addr);
  if (!cur || now >= cur.resetAt) {
    if (keyFailures.size > 1000) keyFailures.clear();
    keyFailures.set(addr, { count: 1, resetAt: now + KEY_FAILURE_WINDOW_MS });
    return 1;
  }
  cur.count += 1;
  return cur.count;
}

/** Constant-time equality that does not leak length (sha256 both sides, then compare the digests). */
export function secretsMatch(presented: string, secret: string): boolean {
  if (!presented || !secret) return false;
  const a = crypto.createHash("sha256").update(presented, "utf8").digest();
  const b = crypto.createHash("sha256").update(secret, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

const MACHINE_CLIENTS: Record<string, { name: string; sessionId: string }> = {
  cli: { name: "Large File Bridge CLI", sessionId: "cli" },
  mcp: { name: "Large File Bridge MCP", sessionId: "mcp" },
};

/**
 * DNS-rebinding defense (apis.mdx §3.7): a page on evil.example that re-resolves its own name to 127.0.0.1
 * reaches our port FROM loopback, but its requests still say `Host: evil.example`. The machine channel only
 * ever comes from our own CLI/MCP, which always address 127.0.0.1 / localhost / [::1] — so any other Host
 * is refused outright.
 */
export function loopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

function apiKeyUser(req: Request): AuthUser | null {
  const presented = req.header("x-lfb-api-key");
  if (!presented || !isLoopback(req)) return null;
  if (!loopbackHost(req.header("host"))) {
    log.warn("auth", `Ignored X-LFB-Api-Key call with non-loopback Host "${String(req.header("host")).slice(0, 80)}" (${req.method} ${req.path}) — possible DNS rebinding`);
    return null;
  }
  if (getAppConfig().server.mode !== "local") return null; // shared-file trick is a same-machine mechanism only
  const addr = req.socket.remoteAddress ?? "unknown";
  if (keyThrottled(addr)) return null;
  const secret = loadApiSecret();
  if (!secret) {
    log.warn("auth", `X-LFB-Api-Key presented (${req.method} ${req.path}) but no API secret exists yet — restart the backend to create it`);
    return null;
  }
  if (!secretsMatch(presented, secret)) {
    const n = noteKeyFailure(addr);
    if (n <= 3 || n === MAX_KEY_FAILURES) {
      log.warn(
        "auth",
        `Rejected X-LFB-Api-Key call (${req.method} ${req.path}): key mismatch` +
          (n === MAX_KEY_FAILURES ? ` — ${n} failures in a minute, ignoring this caller's key until the window resets` : ""),
      );
    }
    return null;
  }
  const client = MACHINE_CLIENTS[(req.header("x-lfb-client") ?? "cli").trim().toLowerCase()] ?? MACHINE_CLIENTS.cli;
  const email = getAppConfig().access.allowed_emails[0] || "cli@localhost";
  return {
    authenticated: true,
    email,
    name: client.name,
    roles: ["admin"],
    permissions: [],
    allowListed: true,
    sessionId: client.sessionId,
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
