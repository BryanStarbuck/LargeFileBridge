// The Jobs page: both workers' installed/on-off + control (scan.mdx §7, storage.mdx §13).
import { Router } from "express";
import { z } from "zod";
import { jobsPageData, control } from "../schedule/schedule.service.js";
import { setWatcherEnabled } from "../watcher/watcher.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";

export const jobsRouter = Router();
jobsRouter.use(requireAllowListed);

jobsRouter.get("/", async (_req, res) => {
  try {
    res.json({ ok: true, data: await jobsPageData() });
  } catch (e) {
    // Express 4 won't forward an async rejection — log it and return the error envelope explicitly.
    log.error("jobs", `Load jobs page data failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/jobs/watcher/:action — the live filesystem watcher (scan.mdx §2.2). Not a scheduled
// worker, so it has NO install step — only enable|disable, which binds/unbinds the OS watch at runtime
// and persists watcher.enabled. Registered BEFORE the generic /:worker/:action route so "watcher" is
// not mis-parsed as a scan|pin worker.
jobsRouter.post("/watcher/:action", async (req, res) => {
  const params = z.object({ action: z.enum(["enable", "disable"]) }).safeParse(req.params);
  if (!params.success) return res.status(400).json({ ok: false, error: "bad action" });
  try {
    const state = await setWatcherEnabled(params.data.action === "enable");
    res.json({ ok: true, data: state });
  } catch (e) {
    log.error("jobs", `watcher control ${params.data.action} failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/jobs/:worker/:action  — worker ∈ scan|pin|device, action ∈ install|uninstall|enable|disable
jobsRouter.post("/:worker/:action", async (req, res) => {
  const params = z
    .object({
      worker: z.enum(["scan", "pin", "device"]),
      action: z.enum(["install", "uninstall", "enable", "disable"]),
    })
    .safeParse(req.params);
  if (!params.success) return res.status(400).json({ ok: false, error: "bad worker/action" });
  try {
    const state = await control(params.data.worker, params.data.action);
    res.json({ ok: true, data: state });
  } catch (e) {
    log.error("jobs", `worker control ${params.data.worker}/${params.data.action} failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
