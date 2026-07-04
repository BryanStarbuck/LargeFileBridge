// The user's other computers (storage.mdx §11).
import { Router } from "express";
import { peerRows, removePeer } from "../store-model/peers.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";

export const peersRouter = Router();
peersRouter.use(requireAllowListed);

peersRouter.get("/", (_req, res) => {
  try {
    res.json({ ok: true, data: peerRows() });
  } catch (e) {
    log.error("peers", `list failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// DELETE /api/peers/:id — forget this computer (menus.mdx §5.4). Removes the peers.yaml entry only;
// touches no remote content and no local file. Idempotent.
peersRouter.delete("/:id", async (req, res) => {
  try {
    const removed = await removePeer(req.params.id);
    res.json({ ok: true, data: { removed } });
  } catch (e) {
    log.error("peers", `remove ${req.params.id} failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
