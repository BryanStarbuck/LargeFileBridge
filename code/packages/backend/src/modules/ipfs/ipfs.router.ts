// REST for the IPFS page (ipfs.mdx): the local pinset as ground truth + import of untracked pins.
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { scanAll } from "../scanner/scanner.service.js";
import { computeIpfsPage, importPins } from "./ipfs-page.service.js";
import { nodeStatus, startInstall, getJob, controlDaemon } from "./ipfs-node.service.js";
import { installAutostart, removeAutostart } from "./ipfs-autostart.service.js";
import * as ipfs from "./ipfs.service.js";
import { log } from "../../shared/logging.js";

export const ipfsRouter = Router();
ipfsRouter.use(requireAllowListed);

// ── The IPFS dashboard (ipfs_ui.mdx): node status, install, on/off toggle ────
// GET /api/ipfs/node — installed? running? version, peerId, live metrics, gateway, posture.
ipfsRouter.get("/node", async (_req, res) => {
  try {
    res.json({ ok: true, data: await nodeStatus() });
  } catch (e) {
    log.error("ipfs", `node status failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ipfs/install — start the single-flight install job (progress via /install/status).
ipfsRouter.post("/install", (_req, res) => {
  res.json({ ok: true, data: startInstall() });
});

// GET /api/ipfs/install/status — poll the current install/start/stop job for the progress view.
ipfsRouter.get("/install/status", (_req, res) => {
  res.json({ ok: true, data: getJob() });
});

// POST /api/ipfs/daemon — the on/off toggle: { action: "start" | "stop", autostart?: boolean }.
// `autostart` (start only) ALSO sets IPFS to come back on its own after a reboot (ipfs_ui.mdx §12).
ipfsRouter.post("/daemon", async (req, res) => {
  const body = z
    .object({ action: z.enum(["start", "stop"]), autostart: z.boolean().optional() })
    .safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.message });
  log.info("ipfs", `daemon ${body.data.action} requested${body.data.autostart ? " (+autostart)" : ""}`);
  try {
    res.json({ ok: true, data: await controlDaemon(body.data.action, { autostart: body.data.autostart }) });
  } catch (e) {
    log.error("ipfs", `daemon ${body.data.action} failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ipfs/autostart — set up or remove reboot auto-start directly: { action: "install"|"remove" }.
// Backs the running dashboard's auto-start toggle and the off-page's retry (ipfs_ui.mdx §13). Returns
// the fresh node status so the UI settles on the real launchd state.
ipfsRouter.post("/autostart", async (req, res) => {
  const body = z.object({ action: z.enum(["install", "remove"]) }).safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.message });
  log.info("ipfs", `autostart ${body.data.action} requested`);
  try {
    if (body.data.action === "install") await installAutostart();
    else await removeAutostart();
    res.json({ ok: true, data: await nodeStatus() });
  } catch (e) {
    log.error("ipfs", `autostart ${body.data.action} failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/ipfs — node card + one row per pinned root CID + the pinning-repo groups (left-bar children).
ipfsRouter.get("/", async (_req, res) => {
  try {
    res.json({ ok: true, data: await computeIpfsPage() });
  } catch (e) {
    log.error("ipfs", `compute ipfs page failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ipfs/rescan — manual reconciliation: refresh candidates, then re-read the pinset (ipfs.mdx §6).
ipfsRouter.post("/rescan", async (_req, res) => {
  try {
    await scanAll("manual");
    res.json({ ok: true, data: await computeIpfsPage() });
  } catch (e) {
    log.error("ipfs", `rescan failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ipfs/import — bring untracked pins under tracking (metadata-only, ipfs.mdx §4).
ipfsRouter.post("/import", async (req, res) => {
  const body = z
    .object({ cids: z.array(z.string()).optional(), all: z.boolean().optional() })
    .safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.message });
  try {
    const imported = await importPins(body.data);
    log.info("ipfs", `imported ${imported} untracked pin(s) into tracking`);
    const data = await computeIpfsPage();
    const skipped = (body.data.cids?.length ?? 0) - imported;
    res.json({ ok: true, data: { imported, skipped: Math.max(0, skipped), data } });
  } catch (e) {
    log.error("ipfs", `import pins failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ipfs/pin — pin/unpin a single CID (ipfs.mdx §3). Backs the toggle pin control shown
// wherever a file/CID that can be pinned appears. Reads the state back so the UI settles on truth.
ipfsRouter.post("/pin", async (req, res) => {
  const body = z
    .object({ cid: z.string().min(1), pinned: z.boolean() })
    .safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.message });
  const { cid, pinned } = body.data;
  try {
    if (pinned) await ipfs.pinAdd(cid);
    else await ipfs.pinRm(cid);
    const verified = await ipfs.isPinned(cid);
    log.info("ipfs", `pin ${pinned ? "add" : "rm"} ${cid} -> pinned=${verified}`);
    res.json({ ok: true, data: { cid, pinned: verified } });
  } catch (e) {
    log.error("ipfs", `pin ${pinned ? "add" : "rm"} ${cid} failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ipfs/enforce — restore only-our-content defaults on the live node (ipfs.mdx §3.1 Fix).
ipfsRouter.post("/enforce", async (_req, res) => {
  try {
    await ipfs.enforceCompliance();
    log.info("ipfs", "enforced only-our-content defaults on the local node");
    res.json({ ok: true, data: await computeIpfsPage() });
  } catch (e) {
    log.error("ipfs", `enforce compliance failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
