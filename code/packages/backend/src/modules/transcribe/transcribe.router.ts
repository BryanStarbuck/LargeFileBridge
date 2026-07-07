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
  enqueueTranscribe,
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

// POST /api/transcribe/file — transcribe ONE file (explicit user action). The engine is async and
// non-blocking, so this request no longer freezes the server while Whisper runs (Transcribe.mdx §5.1).
transcribeRouter.post("/file", async (req, res) => {
  const body = z.object({ path: z.string().min(1), overwrite: z.boolean().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: await transcribeOne(body.data.path, body.data.overwrite ?? false) });
  } catch (e) {
    log.warn("transcribe", `transcribeOne failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/transcribe/batch — transcribe a selected set of files.
transcribeRouter.post("/batch", async (req, res) => {
  const body = z.object({ paths: z.array(z.string().min(1)).min(1), overwrite: z.boolean().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] required" });
  try {
    res.json({ ok: true, data: await transcribeMany(body.data.paths, body.data.overwrite ?? false) });
  } catch (e) {
    log.error("transcribe", `transcribeMany failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/transcribe/tree — transcribe ALL audio/video under a directory or repo.
transcribeRouter.post("/tree", async (req, res) => {
  const body = z.object({ path: z.string().min(1), overwrite: z.boolean().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: await transcribeTree(body.data.path, body.data.overwrite ?? false) });
  } catch (e) {
    log.error("transcribe", `transcribeTree failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/transcribe/enqueue — the "Create Transcriptions" PAGE ACTION (page_actions.mdx §5). Plans the
// eligible set (checked `paths`, else the recursive `root`, minus already-transcribed), background-queues it
// (job_queue.mdx), and returns the PLAN immediately — the request never waits for the work.
transcribeRouter.post("/enqueue", (req, res) => {
  const body = z
    .object({ paths: z.array(z.string().min(1)).optional(), root: z.string().min(1).optional(), overwrite: z.boolean().optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] or root required" });
  try {
    res.json({ ok: true, data: enqueueTranscribe(body.data) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/transcribe/storage/:id — transcribe ALL audio/video in a storage.
transcribeRouter.post("/storage/:id", async (req, res) => {
  const overwrite = z.object({ overwrite: z.boolean().optional() }).safeParse(req.body ?? {});
  try {
    res.json({ ok: true, data: await transcribeStorageById(req.params.id, overwrite.success ? overwrite.data.overwrite ?? false : false) });
  } catch (e) {
    res.status(404).json({ ok: false, error: (e as Error).message });
  }
});
