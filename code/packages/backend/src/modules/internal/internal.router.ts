// Loopback-only trigger the launchd workers hit (code_plan §6). Not for browsers.
import { Router, type Request, type Response, type NextFunction } from "express";
import { scanAll } from "../scanner/scanner.service.js";
import { syncAll } from "../sync/sync.service.js";
import { stampRun } from "../schedule/schedule.service.js";
import { log } from "../../shared/logging.js";

export const internalRouter = Router();

function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "";
  if (ip.includes("127.0.0.1") || ip.includes("::1") || ip === "::ffff:127.0.0.1") return next();
  res.status(403).json({ ok: false, error: "loopback only" });
}
internalRouter.use(loopbackOnly);

internalRouter.post("/run/:worker", async (req, res) => {
  const worker = req.params.worker;
  try {
    if (worker === "scan") await scanAll("scheduled");
    else if (worker === "sync") await syncAll();
    else return res.status(400).json({ ok: false, error: "unknown worker" });
    await stampRun(worker as "scan" | "sync", true);
    res.json({ ok: true, data: { ran: worker } });
  } catch (e) {
    log.error("internal", `${worker} run failed: ${(e as Error).message}`);
    await stampRun(worker as "scan" | "sync", false);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
