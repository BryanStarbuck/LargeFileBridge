// Global settings (settings.mdx) + allow-list (admin only, settings.mdx §4).
import { Router } from "express";
import { z } from "zod";
import { toBytes, type GlobalSettings } from "@lfb/shared";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { logicalCores } from "../../shared/concurrency.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { requireAllowListed, requireAdmin } from "../auth/identify.js";
import { rebuildAuthFrontend } from "../auth/auth-frontend.js";
import {
  getSecurityAccess,
  updateSecurity,
  SecurityError,
} from "../security/security.service.js";
import { log } from "../../shared/logging.js";

export const settingsRouter = Router();
settingsRouter.use(requireAllowListed);

async function toGlobalSettings(): Promise<GlobalSettings> {
  const c = getAppConfig();
  return {
    bigFile: {
      thresholdBytes: c.big_file.threshold_bytes,
      display: { value: c.big_file.threshold_display.value, unit: c.big_file.threshold_display.unit },
    },
    scannerRoots: c.scanner.roots,
    ignoreGlobs: c.scanner.ignore_globs,
    personalAccounts: c.personal_accounts,
    ipfs: {
      apiAddr: c.ipfs.api_addr,
      gatewayAddr: c.ipfs.gateway_addr,
      reprovideStrategy: c.ipfs.reprovide_strategy,
      publicGateway: c.ipfs.public_gateway,
      health: await ipfs.health(),
      compliant: await ipfs.isCompliant(),
    },
    allowedEmails: c.access.allowed_emails,
    access: getSecurityAccess(),
    performance: { maxCoreFraction: c.performance.max_core_fraction, cores: logicalCores() },
  };
}

settingsRouter.get("/", async (_req, res) => {
  try {
    res.json({ ok: true, data: await toGlobalSettings() });
  } catch (e) {
    // Express 4 won't forward an async rejection — log it and return the error envelope explicitly.
    log.error("settings", `Load global settings failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

const SettingsPatch = z.object({
  bigFile: z
    .object({ value: z.number().positive(), unit: z.enum(["MB", "GB", "TB"]) })
    .optional(),
  scannerRoots: z.array(z.string()).optional(),
  ignoreGlobs: z.array(z.string()).optional(),
  // The user's own forge accounts (repo_company_mapping.mdx §4) — repos owned by these derive to Personal.
  personalAccounts: z.array(z.object({ host: z.string().optional(), owner: z.string().min(1) })).optional(),
  // Parallelism knob (parallelization.mdx §4) — the mass-compute core fraction (0.01–1, default 0.9).
  performance: z.object({ maxCoreFraction: z.number().min(0.01).max(1) }).optional(),
  ipfs: z
    .object({
      apiAddr: z.string(),
      gatewayAddr: z.string(),
      reprovideStrategy: z.enum(["pinned", "roots", "all"]),
      publicGateway: z.boolean(),
    })
    .partial()
    .optional(),
});

settingsRouter.patch("/", async (req, res) => {
  const patch = SettingsPatch.safeParse(req.body);
  if (!patch.success) return res.status(400).json({ ok: false, error: patch.error.message });
  const p = patch.data;
  try {
    await updateAppConfig((c) => {
      if (p.bigFile) {
        c.big_file.threshold_display = { value: p.bigFile.value, unit: p.bigFile.unit };
        c.big_file.threshold_bytes = toBytes(p.bigFile.value, p.bigFile.unit);
      }
      if (p.scannerRoots) c.scanner.roots = p.scannerRoots;
      if (p.ignoreGlobs) c.scanner.ignore_globs = p.ignoreGlobs;
      if (p.personalAccounts) {
        // Normalize: lowercase host, trim owner, drop blank owners, de-dup on host+owner.
        const seen = new Set<string>();
        c.personal_accounts = p.personalAccounts
          .map((a) => ({ host: a.host?.trim().toLowerCase() || undefined, owner: a.owner.trim() }))
          .filter((a) => a.owner.length > 0)
          .filter((a) => {
            const k = `${a.host ?? "*"}/${a.owner.toLowerCase()}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
      }
      if (p.performance) c.performance.max_core_fraction = p.performance.maxCoreFraction;
      if (p.ipfs) {
        if (p.ipfs.apiAddr !== undefined) c.ipfs.api_addr = p.ipfs.apiAddr;
        if (p.ipfs.gatewayAddr !== undefined) c.ipfs.gateway_addr = p.ipfs.gatewayAddr;
        if (p.ipfs.reprovideStrategy !== undefined) c.ipfs.reprovide_strategy = p.ipfs.reprovideStrategy;
        if (p.ipfs.publicGateway !== undefined) c.ipfs.public_gateway = p.ipfs.publicGateway;
      }
      return c;
    });
    res.json({ ok: true, data: await toGlobalSettings() });
  } catch (e) {
    // Config write / reload can fail — record it and return the error envelope (Express 4 won't).
    log.error("settings", `Save global settings failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── Security allow-list editor — the return-visit surface (security.mdx §7.3, §10) ──
// The ONLY way to change the allow-list after first-run setup. Admin-only; shares the setup page's
// two sections (companies + individuals), normalization, and non-empty invariant.
settingsRouter.get("/security", (_req, res) => {
  res.json({ ok: true, data: getSecurityAccess() });
});

const SecurityPatch = z.object({
  allowCompanies: z.boolean(),
  domains: z.array(z.string()).default([]),
  allowIndividuals: z.boolean(),
  emails: z.array(z.string()).default([]),
});

settingsRouter.patch("/security", requireAdmin, async (req, res) => {
  const parsed = SecurityPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    const access = await updateSecurity(parsed.data);
    // Hot-swap OAF's OIDC pre-filter so an added/removed company domain applies immediately — no
    // restart (restartRecommended is retained in the contract but always false now).
    rebuildAuthFrontend();
    res.json({ ok: true, data: { access, restartRecommended: false } });
  } catch (e) {
    if (e instanceof SecurityError) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
    // Unexpected failure (config write / auth rebuild) — record it with context before it bubbles up.
    log.error("settings", `Security allow-list update failed: ${(e as Error).message}`);
    throw e;
  }
});

// Back-compat alias: the flat email-only allow-list (superseded by /security above).
settingsRouter.get("/allow-list", (_req, res) => {
  res.json({ ok: true, data: getAppConfig().access.allowed_emails });
});
