// REST for OCR (ocr.mdx §18). Engine status, read existing OCR text, run OCR, preview a batch, and
// background-queue one. Allow-list-gated like every data route.
//
// Note what is NOT here, versus /api/describe: no /providers, no /credentials, no /config, no /resume, no
// /health. OCR is 100% LOCAL (§4) — there is no account to configure, to be depleted, or to resume. That
// absence is the feature, not an omission.
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import { ocrEngines, readOcr, ocrOne, ocrMany, ocrTree, enqueueOcr, previewOcr } from "./ocr.service.js";

export const ocrRouter = Router();
ocrRouter.use(requireAllowListed);

const Engine = z.enum(["auto", "vision", "tesseract"]);

// GET /api/ocr/engines — which OCR engines are usable here + whether the VIDEO path's ffmpeg is present.
ocrRouter.get("/engines", (_req, res) => {
  res.json({ ok: true, data: ocrEngines() });
});

// GET /api/ocr/file?path=<abs> — the existing OCR text for a media file, or null.
// `text: ""` on a real artifact is a SUCCESS, not a null (ocr.mdx §2.3) — the service enforces that.
ocrRouter.get("/file", (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  if (!p) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: readOcr(p) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ocr/file — run (or re-run) OCR on ONE file (explicit user action).
ocrRouter.post("/file", async (req, res) => {
  const body = z.object({ path: z.string().min(1), overwrite: z.boolean().optional(), engine: Engine.optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: await ocrOne(body.data.path, { overwrite: body.data.overwrite, engine: body.data.engine }) });
  } catch (e) {
    log.error("ocr", `ocrOne failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ocr/batch — run OCR over a SELECTED set of image/video files.
ocrRouter.post("/batch", async (req, res) => {
  const body = z.object({ paths: z.array(z.string().min(1)).min(1), overwrite: z.boolean().optional(), engine: Engine.optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] required" });
  try {
    res.json({ ok: true, data: await ocrMany(body.data.paths, { overwrite: body.data.overwrite, engine: body.data.engine }) });
  } catch (e) {
    log.error("ocr", `ocrMany failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ocr/tree — run OCR over ALL image/video under a directory or repo.
ocrRouter.post("/tree", async (req, res) => {
  const body = z.object({ path: z.string().min(1), overwrite: z.boolean().optional(), engine: Engine.optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: await ocrTree(body.data.path, { overwrite: body.data.overwrite, engine: body.data.engine }) });
  } catch (e) {
    log.error("ocr", `ocrTree failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ocr/enqueue — the "Create OCR text" page action (ocr.mdx §8.5). Plans the eligible set, queues it
// (op `ocr`), and returns the PLAN immediately — the request never waits for the work.
ocrRouter.post("/enqueue", async (req, res) => {
  const body = z
    .object({ paths: z.array(z.string().min(1)).optional(), root: z.string().min(1).optional(), overwrite: z.boolean().optional(), engine: Engine.optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] or root required" });
  try {
    res.json({ ok: true, data: await enqueueOcr(body.data) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/ocr/plan — PREVIEW the eligible candidates for the batch popup (dialogs.mdx §5.2). Same narrowing
// as /enqueue but QUEUES NOTHING. Video rows carry `frames` so the popup can show why one row is expensive
// before the user commits (ocr.mdx §9.2).
ocrRouter.post("/plan", async (req, res) => {
  const body = z
    .object({ paths: z.array(z.string().min(1)).optional(), root: z.string().min(1).optional(), overwrite: z.boolean().optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] or root required" });
  try {
    res.json({ ok: true, data: await previewOcr(body.data) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
