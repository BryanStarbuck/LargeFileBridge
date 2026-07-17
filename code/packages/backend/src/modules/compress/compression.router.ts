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
  enqueueCompressInside,
} from "./compression.service.js";

export const compressRouter = Router();
compressRouter.use(requireAllowListed);

// GET /api/compress/tools — which brew tools are installed (compression.mdx §2).
compressRouter.get("/tools", async (_req, res) => {
  try {
    res.json({ ok: true, data: await detectTools() });
  } catch (e) {
    log.error("compress", `detectTools failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
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
compressRouter.get("/check", async (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  if (!p) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: await checkFile(p) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/compress/file — compress ONE file (explicit user action, compression.mdx §1/§8).
compressRouter.post("/file", async (req, res) => {
  // Optional videoCodec forces the output codec — used by the viewer's "Convert for compatibility"
  // offer to always land on browser/upload-safe H.264 (codecs.mdx §5), regardless of the user's
  // default video codec preference.
  const body = z
    .object({ path: z.string().min(1), videoCodec: z.enum(["h264", "hevc", "av1"]).optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: await compressFile(body.data.path, { forceVideoCodec: body.data.videoCodec }) });
  } catch (e) {
    log.warn("compress", `compressFile failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/compress/batch — compress MANY files (checked rows / whole filter, compression.mdx §4).
compressRouter.post("/batch", async (req, res) => {
  const body = z.object({ paths: z.array(z.string().min(1)).min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] required" });
  try {
    res.json({ ok: true, data: { results: await compressBatch(body.data.paths) } });
  } catch (e) {
    log.error("compress", `compressBatch failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/compress/inside — the "Compress videos & images inside" dialog (compress_inside.mdx §5).
// Plans + background-queues a directory's compressible media; returns the PLAN immediately (never waits
// for the work). The queue drains it one file at a time with per-file transactional safety.
compressRouter.post("/inside", async (req, res) => {
  const body = z
    .object({
      root: z.string().min(1),
      images: z.boolean(),
      videos: z.boolean(),
      recursive: z.boolean(),
      deleteOriginal: z.enum(["hard", "trash"]),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "root + images/videos/recursive/deleteOriginal required" });
  if (!body.data.images && !body.data.videos) {
    return res.status(400).json({ ok: false, error: "select at least one of images / videos" });
  }
  try {
    res.json({ ok: true, data: await enqueueCompressInside(body.data) });
  } catch (e) {
    log.error("compress", `compress-inside failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
