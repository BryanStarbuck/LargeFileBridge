// First-run Security Setup endpoints (security.mdx §7). Deliberately UNAUTHENTICATED — there is no
// user yet on a fresh install — but the write is protected by a one-time lock (§8.1) and a loopback
// guard (§8.4). Return-visit editing lives on the admin-gated /settings/security route instead.
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { getPublicSecurityConfig, completeSetup, SecurityError } from "./security.service.js";
import { rebuildAuthFrontend } from "../auth/auth-frontend.js";
import { log } from "../../shared/logging.js";

export const securityRouter = Router();

// GET /api/security/config — public. Returns ONLY { configured, appName }; never the allow-list (§8.3).
securityRouter.get("/config", (_req, res) => {
  res.json({ ok: true, data: getPublicSecurityConfig() });
});

// Loopback-only guard (same as internal.router). `trust proxy: loopback` (main.ts) keeps a spoofed
// X-Forwarded-For from faking loopback.
function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "";
  if (ip.includes("127.0.0.1") || ip.includes("::1") || ip === "::ffff:127.0.0.1") return next();
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
    throw e;
  }
});
