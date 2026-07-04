// The Sync page: both workers' installed/on-off + control (scan.mdx §7, storage.mdx §13).
import { Router } from "express";
import { z } from "zod";
import { syncPageData, control } from "../schedule/schedule.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";

export const syncRouter = Router();
syncRouter.use(requireAllowListed);

syncRouter.get("/", async (_req, res) => {
  try {
    res.json({ ok: true, data: await syncPageData() });
  } catch (e) {
    // Express 4 won't forward an async rejection — log it and return the error envelope explicitly.
    log.error("sync", `Load sync page data failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/sync/:worker/:action  — worker ∈ scan|sync, action ∈ install|uninstall|enable|disable
syncRouter.post("/:worker/:action", async (req, res) => {
  const params = z
    .object({
      worker: z.enum(["scan", "sync"]),
      action: z.enum(["install", "uninstall", "enable", "disable"]),
    })
    .safeParse(req.params);
  if (!params.success) return res.status(400).json({ ok: false, error: "bad worker/action" });
  try {
    const state = await control(params.data.worker, params.data.action);
    res.json({ ok: true, data: state });
  } catch (e) {
    log.error("sync", `worker control ${params.data.worker}/${params.data.action} failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
