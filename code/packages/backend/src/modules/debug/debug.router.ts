// Export Debug Information — the HTTP surface (pm/debug.mdx §12).
//
// Two routes, and they back BOTH invocation surfaces (Settings power section + the View-one-repo More ⌄
// menu) because those are the SAME operation differing only in scope (§2.3):
//   GET  /api/debug/export/target  → where it would land, so the UI can show the path and disable itself
//   POST /api/debug/export         → run it
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import { exportDebugInfo, resolveDebugTarget } from "./debug-export.service.js";

export const debugRouter = Router();
debugRouter.use(requireAllowListed);

debugRouter.get("/export/target", (_req, res) => {
  try {
    res.json({ ok: true, data: resolveDebugTarget() });
  } catch (e) {
    log.error("debug", `resolve debug target failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

const ExportBody = z.object({
  scope: z.enum(["computer", "repo"]).default("computer"),
  repoId: z.string().optional(),
  invokedFrom: z.enum(["settings", "one_repo_more_menu"]).default("settings"),
});

debugRouter.post("/export", async (req, res) => {
  const body = ExportBody.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.message });
  try {
    const data = await exportDebugInfo(body.data);
    res.json({ ok: true, data });
  } catch (e) {
    // §3 — a missing personal storage repo is a REFUSAL with a stable, readable reason, never a 500 and
    // never a quiet fallback write to somewhere that cannot reach the user's other computers.
    log.warn("debug", `debug export failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
