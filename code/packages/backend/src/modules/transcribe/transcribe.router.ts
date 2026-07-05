// REST for transcription (Transcribe.mdx §6). Tool status, read an existing transcript, and run
// transcription over one file / a selected set / a directory-or-repo tree / a whole storage. Mirrors
// compression.router.ts. Allow-list-gated like every data route. Explicit-user-action only.
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import {
  transcribeToolStatus,
  readTranscript,
  transcribeOne,
  transcribeMany,
  transcribeTree,
  transcribeStorageById,
} from "./transcribe.service.js";

export const transcribeRouter = Router();
transcribeRouter.use(requireAllowListed);

// GET /api/transcribe/tools — are whisper + ffmpeg installed (drives the disabled state + install hint).
transcribeRouter.get("/tools", (_req, res) => {
  res.json({ ok: true, data: transcribeToolStatus() });
});

// GET /api/transcribe/file?path=<abs> — the existing transcript for a media file, or null.
transcribeRouter.get("/file", (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  if (!p) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: readTranscript(p) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/transcribe/file — transcribe ONE file (explicit user action).
transcribeRouter.post("/file", (req, res) => {
  const body = z.object({ path: z.string().min(1), overwrite: z.boolean().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: transcribeOne(body.data.path, body.data.overwrite ?? false) });
  } catch (e) {
    log.warn("transcribe", `transcribeOne failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/transcribe/batch — transcribe a selected set of files.
transcribeRouter.post("/batch", (req, res) => {
  const body = z.object({ paths: z.array(z.string().min(1)).min(1), overwrite: z.boolean().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] required" });
  try {
    res.json({ ok: true, data: transcribeMany(body.data.paths, body.data.overwrite ?? false) });
  } catch (e) {
    log.error("transcribe", `transcribeMany failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/transcribe/tree — transcribe ALL audio/video under a directory or repo.
transcribeRouter.post("/tree", (req, res) => {
  const body = z.object({ path: z.string().min(1), overwrite: z.boolean().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: transcribeTree(body.data.path, body.data.overwrite ?? false) });
  } catch (e) {
    log.error("transcribe", `transcribeTree failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/transcribe/storage/:id — transcribe ALL audio/video in a storage.
transcribeRouter.post("/storage/:id", (req, res) => {
  const overwrite = z.object({ overwrite: z.boolean().optional() }).safeParse(req.body ?? {});
  try {
    res.json({ ok: true, data: transcribeStorageById(req.params.id, overwrite.success ? overwrite.data.overwrite ?? false : false) });
  } catch (e) {
    res.status(404).json({ ok: false, error: (e as Error).message });
  }
});
