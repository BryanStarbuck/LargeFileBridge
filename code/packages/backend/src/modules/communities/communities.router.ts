// REST for the Communities page (communities.mdx §6–§8). Allow-list-gated like every data route.
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import { getCommunitiesPage, setCommunityBudget, setCommunitySubscription } from "./communities.service.js";

export const communitiesRouter = Router();
communitiesRouter.use(requireAllowListed);

// GET /api/communities — the page payload: storage-math header + one row per community.
communitiesRouter.get("/", async (_req, res) => {
  try {
    res.json({ ok: true, data: await getCommunitiesPage() });
  } catch (e) {
    log.error("communities", `getCommunitiesPage failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// PUT /api/communities/budget — set the single computer-wide community storage budget (§5.2).
communitiesRouter.put("/budget", async (req, res) => {
  const body = z.object({ bytes: z.number().nonnegative().nullable() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "bytes (number|null) required" });
  try {
    res.json({ ok: true, data: await setCommunityBudget(body.data.bytes) });
  } catch (e) {
    log.warn("communities", `setCommunityBudget failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/communities/:id — update one community's subscription (intent + backup mode + bookmark).
communitiesRouter.patch("/:id", async (req, res) => {
  const body = z
    .object({
      get: z.boolean().optional(),
      support: z.boolean().optional(),
      backupMode: z.enum(["block", "recommended", "full"]).optional(),
      bookmarked: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.message });
  try {
    res.json({ ok: true, data: await setCommunitySubscription(req.params.id, body.data) });
  } catch (e) {
    log.warn("communities", `setCommunitySubscription ${req.params.id} failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
