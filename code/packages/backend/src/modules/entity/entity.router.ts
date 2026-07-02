// REST for the single-entity views + the ⋯ / right-click entity menus (files.mdx, directories.mdx,
// menus.mdx §5). One EntityView per file/dir; the two sticky flags; the sync decision shortcut; and
// the compress OFFER (charter §6.1: explicit-click only, never automatic).
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import { buildEntityView, setEntityFlags, setEntityDecision } from "./entity.service.js";

export const entityRouter = Router();
entityRouter.use(requireAllowListed);

// GET /api/entity?path=<abs> — the single-entity payload (files.mdx §2, directories.mdx §3).
entityRouter.get("/", (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  try {
    res.json({ ok: true, data: buildEntityView(p) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/entity/flags — set Never IPFS / Do not compress (menus.mdx §6.6). Partial.
entityRouter.patch("/flags", async (req, res) => {
  const body = z
    .object({
      path: z.string().min(1),
      neverIpfs: z.boolean().optional(),
      noCompress: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path + flag required" });
  try {
    const view = await setEntityFlags(body.data.path, {
      neverIpfs: body.data.neverIpfs,
      noCompress: body.data.noCompress,
    });
    log.info("entity", `flags ${body.data.path}: ${JSON.stringify(body.data)}`);
    res.json({ ok: true, data: view });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/entity/decision — Add to IPFS (sync) / Remove from IPFS (ignore) / Undecided.
entityRouter.post("/decision", async (req, res) => {
  const body = z
    .object({ path: z.string().min(1), decision: z.enum(["sync", "ignore", "undecided"]) })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path + decision required" });
  try {
    const view = await setEntityDecision(body.data.path, body.data.decision);
    log.info("entity", `decision ${body.data.path} -> ${body.data.decision}`);
    res.json({ ok: true, data: view });
  } catch (e) {
    res.status(409).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/entity/compress — the compress OFFER (charter §6.1). Explicit-click only; we acknowledge
// and queue. Actual transcode is a later `compress` op (webapp.mdx §11) — never automatic.
entityRouter.post("/compress", (req, res) => {
  const body = z.object({ path: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  log.info("entity", `compress requested (queued): ${body.data.path}`);
  res.json({ ok: true, data: { queued: true } });
});
