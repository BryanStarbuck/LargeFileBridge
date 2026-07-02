import { Router } from "express";
import * as ipfs from "../ipfs/ipfs.service.js";
import { authConfig } from "../auth/auth.router.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  res.json({ ok: true, data: { status: "ok", ipfs: await ipfs.health() } });
});

healthRouter.get("/auth-config", (_req, res) => {
  res.json({ ok: true, data: authConfig() });
});
