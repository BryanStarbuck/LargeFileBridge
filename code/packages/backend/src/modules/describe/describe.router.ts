// REST for AI description (ai_description.mdx §7). Provider status, read an existing description, generate
// one (the external, user-initiated vision call), and read/customize/save/reset the per-kind prompt files.
// Allow-list-gated like every data route. Explicit-user-action only — generation uploads bytes to the
// chosen provider and never runs on its own.
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import { describeProviders, readDescription, describeOne, describeMany, describeTree, enqueueDescribe, getAiConfig, setAiConfig, aiCredentialsInfo } from "./describe.service.js";
import { promptView, customizePrompt, savePrompt, resetPrompt } from "./prompts.js";

export const describeRouter = Router();
describeRouter.use(requireAllowListed);

const Kind = z.enum(["image", "video"]);
const Provider = z.enum(["auto", "gemini", "grok", "openai"]);

// GET /api/describe/providers — which vision providers are configured on this machine + what each covers.
describeRouter.get("/providers", (_req, res) => {
  res.json({ ok: true, data: describeProviders() });
});

// GET /api/describe/config — the editable AI config (default provider + per-provider model + key SOURCE),
// never the raw key value (ai_description.mdx §6). Drives the global Settings AI-provider editor.
describeRouter.get("/config", (_req, res) => {
  res.json({ ok: true, data: getAiConfig() });
});

// PATCH /api/describe/config — set the default provider and/or per-provider API key + model.
const ProviderPatch = z.object({ apiKey: z.string().nullable().optional(), model: z.string().optional() });
describeRouter.patch("/config", async (req, res) => {
  const body = z
    .object({ provider: Provider.optional(), gemini: ProviderPatch.optional(), grok: ProviderPatch.optional(), openai: ProviderPatch.optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.message });
  try {
    res.json({ ok: true, data: await setAiConfig(body.data) });
  } catch (e) {
    log.error("describe", `setAiConfig failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/describe/credentials — where to put a Gemini key + in what format (ai_credentials.mdx).
// Powers the "Instructions" full page behind the credentials-missing popup. No raw key value.
describeRouter.get("/credentials", (_req, res) => {
  res.json({ ok: true, data: aiCredentialsInfo() });
});

// GET /api/describe/file?path=<abs> — the existing generated description for a media file, or null.
describeRouter.get("/file", (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  if (!p) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: readDescription(p) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/describe/file — generate (or regenerate) the description for ONE file (explicit user action).
describeRouter.post("/file", async (req, res) => {
  const body = z
    .object({ path: z.string().min(1), overwrite: z.boolean().optional(), provider: Provider.optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: await describeOne(body.data.path, { overwrite: body.data.overwrite, provider: body.data.provider }) });
  } catch (e) {
    log.error("describe", `describeOne failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/describe/batch — generate for a SELECTED set of image/video files (ai_description.mdx §5).
describeRouter.post("/batch", async (req, res) => {
  const body = z
    .object({ paths: z.array(z.string().min(1)).min(1), overwrite: z.boolean().optional(), provider: Provider.optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] required" });
  try {
    res.json({ ok: true, data: await describeMany(body.data.paths, { overwrite: body.data.overwrite, provider: body.data.provider }) });
  } catch (e) {
    log.error("describe", `describeMany failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/describe/tree — generate for ALL image/video under a directory or repo.
describeRouter.post("/tree", async (req, res) => {
  const body = z
    .object({ path: z.string().min(1), overwrite: z.boolean().optional(), provider: Provider.optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: await describeTree(body.data.path, { overwrite: body.data.overwrite, provider: body.data.provider }) });
  } catch (e) {
    log.error("describe", `describeTree failed for ${body.data.path}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/describe/enqueue — the "Create AI descriptions" PAGE ACTION (page_actions.mdx §5). Plans the
// eligible set (checked `paths`, else the recursive `root`, minus already-described), background-queues it
// (job_queue.mdx), and returns the PLAN immediately — the request never waits for the work.
describeRouter.post("/enqueue", (req, res) => {
  const body = z
    .object({ paths: z.array(z.string().min(1)).optional(), root: z.string().min(1).optional(), overwrite: z.boolean().optional(), provider: Provider.optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] or root required" });
  try {
    res.json({ ok: true, data: enqueueDescribe(body.data) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/describe/prompt?kind=image|video — the prompt text used for a kind + whether it is overridden.
describeRouter.get("/prompt", (req, res) => {
  const kind = Kind.safeParse(req.query.kind);
  if (!kind.success) return res.status(400).json({ ok: false, error: "kind must be image|video" });
  res.json({ ok: true, data: promptView(kind.data) });
});

// POST /api/describe/prompt/customize { kind } — copy the shipped default to a per-computer override.
describeRouter.post("/prompt/customize", (req, res) => {
  const kind = Kind.safeParse(req.body?.kind);
  if (!kind.success) return res.status(400).json({ ok: false, error: "kind must be image|video" });
  res.json({ ok: true, data: customizePrompt(kind.data) });
});

// PUT /api/describe/prompt { kind, text } — save edited override text.
describeRouter.put("/prompt", (req, res) => {
  const body = z.object({ kind: Kind, text: z.string() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "kind + text required" });
  res.json({ ok: true, data: savePrompt(body.data.kind, body.data.text) });
});

// DELETE /api/describe/prompt?kind=image|video — revert to the shipped default.
describeRouter.delete("/prompt", (req, res) => {
  const kind = Kind.safeParse(req.query.kind);
  if (!kind.success) return res.status(400).json({ ok: false, error: "kind must be image|video" });
  res.json({ ok: true, data: resetPrompt(kind.data) });
});
