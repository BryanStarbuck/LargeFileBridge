// Loopback-only trigger the launchd workers hit (code_plan §6). Not for browsers.
import { Router, type Request, type Response, type NextFunction } from "express";
import { startScan } from "../scanner/scan-job.js";
import { startRun } from "../schedule/run-job.js";
import { requestShutdown } from "./shutdown-hook.js";
import { log } from "../../shared/logging.js";

export const internalRouter = Router();

function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "";
  if (ip.includes("127.0.0.1") || ip.includes("::1") || ip === "::ffff:127.0.0.1") return next();
  res.status(403).json({ ok: false, error: "loopback only" });
}
internalRouter.use(loopbackOnly);

// FIRE-AND-ACKNOWLEDGE — every worker kick ACCEPTS the job and returns immediately; the work runs detached.
//
// This route must never hold the request open for the duration of the work. A pin pass walks every repo and
// a device pass git-pulls/commits/pushes every storage — minutes, routinely longer than any sane client
// timeout. When `pin`/`device` awaited their pass here, the launchd trigger aborted the socket at 60s and
// logged "backend unreachable … app not running? Skipping this interval." while the pass carried on
// perfectly well behind it: a false fault, a false diagnosis, and a false claim that the cycle was skipped
// (nothing was skipped — Express cannot cancel an async handler because the client hung up). `scan` was
// always shaped this way; `pin` and `device` now match it via run-job.ts, which stamps last_run on
// COMPLETION so the record still reflects the work rather than the accept.
internalRouter.post("/run/:worker", (req, res) => {
  const worker = req.params.worker;
  try {
    if (worker === "scan") {
      const { started } = startScan("scheduled");
      return res.json({ ok: true, data: { ran: worker, accepted: true, started } });
    }
    // `pin` (the IPFS sync pass) and `device` (the every-10-min device-registration write-back,
    // devices.mdx §12). `started: false` means a pass of that kind was already in flight and this kick
    // coalesced onto it — a normal, successful outcome for the caller, not an error.
    if (worker === "pin" || worker === "device") {
      const { started } = startRun(worker, "scheduled");
      return res.json({ ok: true, data: { ran: worker, accepted: true, started } });
    }
    return res.status(400).json({ ok: false, error: "unknown worker" });
  } catch (e) {
    // Only an ACCEPT failure can land here now (the work itself reports through run-job.ts) — so there is
    // no run to stamp: nothing started.
    log.error("internal", `${worker} run could not be accepted: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// STOP CLEANLY — what `just stop` asks for before it signals anything (scripts/dev/dev.mjs `cmdStop`).
//
// The point is the ledger's SHUTDOWN marker, which only main.ts's handler may write and whose ABSENCE
// before the next BOOT is what defines a crash. On Windows there is no SIGTERM to ask with, so without
// this route every stop on that platform would read as a crash at the next boot — see shutdown-hook.ts.
// Loopback-only, like everything on this router: the trust boundary is the same one `/run/:worker` sits
// behind, and a process already running on this machine can stop the app in a dozen other ways.
internalRouter.post("/shutdown", (_req, res) => {
  log.info("internal", "Clean shutdown requested over the loopback route.");
  // ANSWER FIRST. `shutdown()` destroys live sockets (`closeAllConnections`) so the exit is not held open
  // by an SSE stream, and this response is one of those sockets — start the teardown only once it has
  // actually left, or the caller sees a socket error and concludes the app was never asked.
  res.json({ ok: true, data: { stopping: true } });
  let started = false;
  const begin = (): void => {
    if (started) return;
    started = true;
    if (!requestShutdown("api-shutdown")) {
      // Still booting: the handler is registered immediately after the BOOT marker, so this is a narrow
      // window. Exiting here is still a DELIBERATE stop and main.ts's `exit` listener records it as one.
      log.warn("internal", "No shutdown handler registered yet — exiting directly.");
      process.exit(0);
    }
  };
  res.on("finish", begin);
  setTimeout(begin, 1000).unref(); // the response never finished (a client that hung up) — stop anyway
});
