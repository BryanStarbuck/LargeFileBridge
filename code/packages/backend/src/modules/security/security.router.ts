// First-run Security Setup endpoints (security.mdx §7). Deliberately UNAUTHENTICATED — there is no
// user yet on a fresh install — but the write is protected by a one-time lock (§8.1) and a loopback
// guard (§8.4). Return-visit editing lives on the admin-gated /settings/security route instead.
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { getPublicSecurityConfig, completeSetup, SecurityError } from "./security.service.js";
import { rebuildAuthFrontend } from "../auth/auth-frontend.js";
import { isLoopback } from "../../shared/loopback.js";
import { log, logError } from "../../shared/logging.js";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { apiSecretStatus, ensureApiSecret, rotateApiSecret } from "../../config/credentials-file.js";

export const securityRouter = Router();

// GET /api/security/config — public. Returns ONLY { configured, appName }; never the allow-list (§8.3).
securityRouter.get("/config", (_req, res) => {
  res.json({ ok: true, data: getPublicSecurityConfig() });
});

// Loopback-only guard (same as internal.router). Asks the TCP PEER, not `req.ip` — this route writes the
// allow-list with no authentication at all, so it must not be reachable by a caller who merely claims to
// be local in a header (shared/loopback.ts).
function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
  if (isLoopback(req)) return next();
  const ip = req.socket?.remoteAddress ?? "unknown";
  log.warn("security", `Rejected non-loopback setup attempt from ${ip}`);
  res.status(403).json({ ok: false, error: "Setup is only available on this computer (loopback).", code: "not_loopback" });
}

const SetupBody = z.object({
  allowCompanies: z.boolean(),
  domains: z.array(z.string()).default([]),
  allowIndividuals: z.boolean(),
  emails: z.array(z.string()).default([]),
});

// POST /api/security/setup — one-time (409 once configured), loopback-only (403 otherwise).
securityRouter.post("/setup", loopbackOnly, async (req, res) => {
  const parsed = SetupBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message, code: "bad_request" });
  }
  try {
    const result = await completeSetup(parsed.data);
    // Hot-swap OAF's OIDC pre-filter to the just-saved allow-list so the very next Google sign-in is
    // accepted — no restart, which is also what previously risked clobbering this write.
    rebuildAuthFrontend();
    log.info("security", "Security allow-list configured via first-run setup; auth middleware rebuilt.");
    res.json({ ok: true, data: result });
  } catch (e) {
    if (e instanceof SecurityError) {
      return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
    }
    // Unexpected failure (config write / auth rebuild) — record it with context before it bubbles up.
    log.error("security", `First-run setup failed: ${(e as Error).message}`);
    throw e;
  }
});

// ── The local machine key (CLI + MCP) — apis.mdx §3 ──────────────────────────────────────────────────
// The web app is where a person SEES and MANAGES the key the CLI and the MCP server use: whether it
// exists, when it was made, a fingerprint (never the key), and buttons to create or rotate it. The key
// itself never crosses HTTP — both machine callers read it from the 0600 file on this computer.

/** Rotate/create must come from a person in the browser, never from a machine caller using the key itself. */
function browserAdminOnly(req: Request, res: Response, next: NextFunction): void {
  const user = currentUser(req);
  if (!user.allowListed || !user.roles.includes("admin")) {
    res.status(403).json({ ok: false, error: "Admin only", code: "forbidden" });
    return;
  }
  if (user.sessionId === "cli" || user.sessionId === "mcp") {
    res.status(403).json({ ok: false, error: "The API key cannot be managed with the API key — use the web app.", code: "forbidden" });
    return;
  }
  next();
}

// GET /api/security/api-key — status only (allow-listed).
securityRouter.get("/api-key", requireAllowListed, (_req, res) => {
  try {
    res.json({ ok: true, data: apiSecretStatus() });
  } catch (e) {
    logError({ file: "security.router.ts", operation: "GET /api-key", error: e });
    res.status(500).json({ ok: false, error: (e as Error).message, code: "internal" });
  }
});

// POST /api/security/api-key/create — create the key if it does not exist yet (idempotent).
securityRouter.post("/api-key/create", requireAllowListed, browserAdminOnly, (req, res) => {
  try {
    ensureApiSecret();
    res.json({ ok: true, data: apiSecretStatus() });
  } catch (e) {
    logError({ file: "security.router.ts", operation: "POST /api-key/create", error: e, data: { by: currentUser(req).email } });
    res.status(500).json({ ok: false, error: (e as Error).message, code: "internal" });
  }
});

// POST /api/security/api-key/rotate — new key now; the old one stops working at once.
securityRouter.post("/api-key/rotate", requireAllowListed, browserAdminOnly, (req, res) => {
  try {
    rotateApiSecret();
    log.info("security", `Local API key rotated by ${currentUser(req).email}`);
    res.json({ ok: true, data: apiSecretStatus() });
  } catch (e) {
    logError({ file: "security.router.ts", operation: "POST /api-key/rotate", error: e, data: { by: currentUser(req).email } });
    res.status(500).json({ ok: false, error: (e as Error).message, code: "internal" });
  }
});
