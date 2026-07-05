// The Devices / Peers page payload (devices.mdx §6). One row per computer that carries the user's files:
// this machine (always injected — never an empty table), the machine-local peers.yaml, and the travelling
// devices/ registry across every storage, unioned by id and disambiguated. Read-only aggregate.
import { Router } from "express";
import { deviceRows } from "../storage/devices.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";

export const devicesRouter = Router();
devicesRouter.use(requireAllowListed);

devicesRouter.get("/", async (_req, res) => {
  try {
    res.json({ ok: true, data: await deviceRows() });
  } catch (e) {
    log.error("peers", `devices list failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
