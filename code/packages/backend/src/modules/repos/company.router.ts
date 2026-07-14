// REST for the cross-member repo→company ownership review flow (repo_owner_propagation.mdx §3/§4). Surfaces
// the pending mappings computed from pulled `owner_map.yaml` assertions and applies the member's batch consent.
// The per-repo reassign that CREATES an assertion lives on repos.router (`POST /api/repos/:repoId/owner`); this
// router is the receiving member's review-and-consent side.
import { Router } from "express";
import { z } from "zod";
import { computePendingMappings, applyPendingMappings } from "../storage/owner-propagation.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";

export const companyRouter = Router();
companyRouter.use(requireAllowListed);

// GET /api/company-mappings/pending — the review page's rows (repo_owner_propagation.mdx §3). Recomputed fresh
// each call (no cache) so it always reflects the latest pulled assertions + local overrides + declines.
companyRouter.get("/pending", (_req, res) => {
  try {
    res.json({ ok: true, data: computePendingMappings() });
  } catch (e) {
    log.error("repos", `company-mappings pending failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/company-mappings/apply — commit the review page's batch (repo_owner_propagation.mdx §4.3). Body is
// an array of { repoId, decision: "company" | "personal" }: accepted rows get a local owner_override to the
// company; declined rows are remembered so they never re-nag.
const ApplyBody = z.array(
  z.object({ repoId: z.string().min(1), decision: z.enum(["company", "personal"]) }),
);
companyRouter.post("/apply", async (req, res) => {
  const body = ApplyBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "array of { repoId, decision } required" });
  try {
    const result = await applyPendingMappings(body.data);
    log.info("repos", `company-mappings applied: ${result.accepted} accepted, ${result.declined} declined, ${result.skipped} skipped`);
    res.json({ ok: true, data: result });
  } catch (e) {
    log.error("repos", `company-mappings apply failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
