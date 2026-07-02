// REST for the IPFS page (ipfs.mdx): the local pinset as ground truth + import of untracked pins.
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { scanAll } from "../scanner/scanner.service.js";
import { computeIpfsPage, importPins } from "./ipfs-page.service.js";
import * as ipfs from "./ipfs.service.js";
import { log } from "../../shared/logging.js";

export const ipfsRouter = Router();
ipfsRouter.use(requireAllowListed);

// GET /api/ipfs — node card + one row per pinned root CID + the pinning-repo groups (left-bar children).
ipfsRouter.get("/", async (_req, res) => {
  res.json({ ok: true, data: await computeIpfsPage() });
});

// POST /api/ipfs/rescan — manual reconciliation: refresh candidates, then re-read the pinset (ipfs.mdx §6).
ipfsRouter.post("/rescan", async (_req, res) => {
  await scanAll("manual");
  res.json({ ok: true, data: await computeIpfsPage() });
});

// POST /api/ipfs/import — bring untracked pins under tracking (metadata-only, ipfs.mdx §4).
ipfsRouter.post("/import", async (req, res) => {
  const body = z
    .object({ cids: z.array(z.string()).optional(), all: z.boolean().optional() })
    .safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.message });
  const imported = await importPins(body.data);
  log.info("ipfs", `imported ${imported} untracked pin(s) into tracking`);
  const data = await computeIpfsPage();
  const skipped = (body.data.cids?.length ?? 0) - imported;
  res.json({ ok: true, data: { imported, skipped: Math.max(0, skipped), data } });
});

// POST /api/ipfs/enforce — restore only-our-content defaults on the live node (ipfs.mdx §3.1 Fix).
ipfsRouter.post("/enforce", async (_req, res) => {
  await ipfs.enforceCompliance();
  log.info("ipfs", "enforced only-our-content defaults on the local node");
  res.json({ ok: true, data: await computeIpfsPage() });
});
