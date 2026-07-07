// Loopback-only trigger the launchd workers hit (code_plan §6). Not for browsers.
import { Router, type Request, type Response, type NextFunction } from "express";
import { startScan } from "../scanner/scan-job.js";
import { syncAll, syncDeviceRegistrations } from "../sync/sync.service.js";
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
    if (worker === "scan") {
      // Start the detached scan job and return immediately. The full-filesystem walk can far exceed
      // the run-worker's 60s fetch timeout; blocking here would make launchd abort the request and log
      // a phantom failure while the scan actually keeps running. The job runner stamps last_run on
      // completion (scan-job.ts), so we do NOT stamp here.
      const { started } = startScan("scheduled");
      return res.json({ ok: true, data: { ran: worker, started } });
    }
    // The every-10-min DEVICE-REGISTRATION worker (devices.mdx §12): make sure THIS computer's device
    // info is written & pushed to each Git-backed storage's repo, pulling first even with nothing to
    // change. Decoupled from the IPFS opt-in.
    if (worker === "device") {
      await syncDeviceRegistrations();
      await stampRun("device", true);
      return res.json({ ok: true, data: { ran: worker } });
    }
    if (worker === "sync") await syncAll();
    else return res.status(400).json({ ok: false, error: "unknown worker" });
    await stampRun("sync", true);
    res.json({ ok: true, data: { ran: worker } });
  } catch (e) {
    log.error("internal", `${worker} run failed: ${(e as Error).message}`);
    // Stamp the failed run best-effort — a stamp write error here must not mask the original failure.
    if (worker === "sync" || worker === "device") {
      await stampRun(worker as "sync" | "device", false).catch((se) =>
        log.error("internal", `stamping failed ${worker} run failed: ${(se as Error).message}`),
      );
    }
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
