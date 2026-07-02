// The user's other computers (storage.mdx §11).
import { Router } from "express";
import { peerRows } from "../store-model/peers.service.js";
import { requireAllowListed } from "../auth/identify.js";

export const peersRouter = Router();
peersRouter.use(requireAllowListed);

peersRouter.get("/", (_req, res) => {
  res.json({ ok: true, data: peerRows() });
});
