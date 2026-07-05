// REST for the compression engine (compression.mdx). Tool status, the codec settings, the per-file
// dry-run check (drives the pre-compress warning), and the actual compress (one / many). Allow-list-gated.
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import {
  detectTools,
  getCompressionSettings,
  setCompressionSettings,
  checkFile,
  compressFile,
  compressBatch,
} from "./compression.service.js";

export const compressRouter = Router();
compressRouter.use(requireAllowListed);

// GET /api/compress/tools — which brew tools are installed (compression.mdx §2).
compressRouter.get("/tools", (_req, res) => {
  res.json({ ok: true, data: detectTools() });
});

// GET /api/compress/settings — the per-media codec allow/deny + quality prefs (compression.mdx §7).
compressRouter.get("/settings", (_req, res) => {
  res.json({ ok: true, data: getCompressionSettings() });
});

// PATCH /api/compress/settings — partial update of the prefs.
compressRouter.patch("/settings", async (req, res) => {
  try {
    res.json({ ok: true, data: await setCompressionSettings(req.body ?? {}) });
  } catch (e) {
    log.error("compress", `setSettings failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/compress/check?path=<abs> — dry-run plan + alpha safety (compression.mdx §3/§6). No side effects.
compressRouter.get("/check", (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  if (!p) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: checkFile(p) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/compress/file — compress ONE file (explicit user action, compression.mdx §1/§8).
compressRouter.post("/file", (req, res) => {
  const body = z.object({ path: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: compressFile(body.data.path) });
  } catch (e) {
    log.warn("compress", `compressFile failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/compress/batch — compress MANY files (checked rows / whole filter, compression.mdx §4).
compressRouter.post("/batch", (req, res) => {
  const body = z.object({ paths: z.array(z.string().min(1)).min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] required" });
  try {
    res.json({ ok: true, data: { results: compressBatch(body.data.paths) } });
  } catch (e) {
    log.error("compress", `compressBatch failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
