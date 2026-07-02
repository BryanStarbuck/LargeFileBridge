// Global settings (settings.mdx) + allow-list (admin only, settings.mdx §4).
import { Router } from "express";
import { z } from "zod";
import { toBytes, type GlobalSettings } from "@lfb/shared";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { requireAllowListed, requireAdmin } from "../auth/identify.js";

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
    ipfs: {
      apiAddr: c.ipfs.api_addr,
      gatewayAddr: c.ipfs.gateway_addr,
      reprovideStrategy: c.ipfs.reprovide_strategy,
      publicGateway: c.ipfs.public_gateway,
      health: await ipfs.health(),
      compliant: await ipfs.isCompliant(),
    },
    allowedEmails: c.access.allowed_emails,
  };
}

settingsRouter.get("/", async (_req, res) => {
  res.json({ ok: true, data: await toGlobalSettings() });
});

const SettingsPatch = z.object({
  bigFile: z
    .object({ value: z.number().positive(), unit: z.enum(["MB", "GB", "TB"]) })
    .optional(),
  scannerRoots: z.array(z.string()).optional(),
  ignoreGlobs: z.array(z.string()).optional(),
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
  await updateAppConfig((c) => {
    if (p.bigFile) {
      c.big_file.threshold_display = { value: p.bigFile.value, unit: p.bigFile.unit };
      c.big_file.threshold_bytes = toBytes(p.bigFile.value, p.bigFile.unit);
    }
    if (p.scannerRoots) c.scanner.roots = p.scannerRoots;
    if (p.ignoreGlobs) c.scanner.ignore_globs = p.ignoreGlobs;
    if (p.ipfs) {
      if (p.ipfs.apiAddr !== undefined) c.ipfs.api_addr = p.ipfs.apiAddr;
      if (p.ipfs.gatewayAddr !== undefined) c.ipfs.gateway_addr = p.ipfs.gatewayAddr;
      if (p.ipfs.reprovideStrategy !== undefined) c.ipfs.reprovide_strategy = p.ipfs.reprovideStrategy;
      if (p.ipfs.publicGateway !== undefined) c.ipfs.public_gateway = p.ipfs.publicGateway;
    }
    return c;
  });
  res.json({ ok: true, data: await toGlobalSettings() });
});

// Allow-list editing is admin-only (settings.mdx §4).
settingsRouter.get("/allow-list", (_req, res) => {
  res.json({ ok: true, data: getAppConfig().access.allowed_emails });
});

settingsRouter.patch("/allow-list", requireAdmin, async (req, res) => {
  const body = z.object({ emails: z.array(z.string().email()) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "emails[] required" });
  await updateAppConfig((c) => {
    c.access.allowed_emails = body.data.emails.map((e) => e.toLowerCase());
    return c;
  });
  res.json({ ok: true, data: getAppConfig().access.allowed_emails });
});
