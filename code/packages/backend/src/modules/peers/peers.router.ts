// The user's other computers (storage.mdx §11).
import { Router } from "express";
import { peerRows, removePeer } from "../store-model/peers.service.js";
import { requireAllowListed } from "../auth/identify.js";

export const peersRouter = Router();
peersRouter.use(requireAllowListed);

peersRouter.get("/", (_req, res) => {
  res.json({ ok: true, data: peerRows() });
});

// DELETE /api/peers/:id — forget this computer (menus.mdx §5.4). Removes the peers.yaml entry only;
// touches no remote content and no local file. Idempotent.
peersRouter.delete("/:id", async (req, res) => {
  const removed = await removePeer(req.params.id);
  res.json({ ok: true, data: { removed } });
});
