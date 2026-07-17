// REST for the single-entity views + the ⋯ / right-click entity menus (files.mdx, directories.mdx,
// menus.mdx §5). One EntityView per file/dir; the two sticky flags; the pin decision shortcut; and
// the compress OFFER (charter §6.1: explicit-click only, never automatic).
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import { buildEntityView, setEntityFlags, setEntityDecision, moveEntity, deleteEntity } from "./entity.service.js";

export const entityRouter = Router();
entityRouter.use(requireAllowListed);

// GET /api/entity?path=<abs> — the single-entity payload (files.mdx §2, directories.mdx §3).
entityRouter.get("/", async (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  // `?rollup=0` skips the expensive directory category rollup (buildDirRollup's up-to-20k-`statSync`
  // walk). `?badges=0` skips the code-badge context, which readdirs the PARENT dir and runs
  // `git check-ignore` over every sibling. The right-click / ⋯ menu passes BOTH (it reads neither) so
  // opening the menu on a big/cloud-mounted directory is instant instead of blocking past its 10 s
  // timeout. Defaults keep both — the single-entity pages need the rollup and the badges.
  const rollup = req.query.rollup !== "0";
  const badges = req.query.badges !== "0";
  try {
    res.json({ ok: true, data: await buildEntityView(p, { rollup, badges }) });
  } catch (e) {
    log.warn("entity", `buildEntityView failed for ${p ?? "<none>"}: ${(e as Error).message}`);
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
    log.error("entity", `setEntityFlags failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/entity/decision — Add to IPFS (pin) / Remove from IPFS (ignore) / Undecided.
// The decision body enum is the FROZEN wire value; the "pin" decision travels as literal "sync".
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
    log.warn("entity", `setEntityDecision failed for ${body.data.path} -> ${body.data.decision}: ${(e as Error).message}`);
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

// POST /api/entity/move — move/rename a file (media_viewer.mdx §4.4). Explicit, guarded (parent exists,
// no overwrite). Relocates real bytes, so it is an explicit-click action confirmed in the UI.
entityRouter.post("/move", (req, res) => {
  const body = z.object({ path: z.string().min(1), dest: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path + dest required" });
  try {
    res.json({ ok: true, data: moveEntity(body.data.path, body.data.dest) });
  } catch (e) {
    log.warn("entity", `move failed for ${body.data.path} -> ${body.data.dest}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/entity/delete — RECOVERABLE delete (media_viewer.mdx §4.4). Moves the file into LFBridge's
// trash under the state dir; never `unlink`s (charter: never destroy bytes silently). UI confirms first.
entityRouter.post("/delete", (req, res) => {
  const body = z.object({ path: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: deleteEntity(body.data.path) });
  } catch (e) {
    log.warn("entity", `delete failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
