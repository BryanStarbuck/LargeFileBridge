// REST for the File System column browser (directory.mdx §1, code_plan.mdx §14).
import { Router } from "express";
import { z } from "zod";
import type { FlatStreamEvent } from "@lfb/shared";
import { homeDir, listDirectory, listFilesFlat } from "./fs.service.js";
import { walkFilesFlatStreaming } from "../fsindex/fsindex.service.js";
import { platformInfo, openInOs } from "./os-open.js";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";

export const fsRouter = Router();
fsRouter.use(requireAllowListed);

// GET /api/fs/home — the default root the browser opens on (the OS home directory).
fsRouter.get("/home", (_req, res) => {
  res.json({ ok: true, data: { home: homeDir() } });
});

// GET /api/fs/platform — the host OS family + label ("Mac"/"PC"/"Linux") and whether the OS-open
// hand-off is possible here (local mode + loopback). Drives the "Open on {label}" buttons (os_open.mdx).
fsRouter.get("/platform", (req, res) => {
  res.json({ ok: true, data: platformInfo(req) });
});

// POST /api/fs/os-open { path } — hand a local file OR folder to the host OS default handler. Localhost-
// only, confined to the allow-roots (os_open.mdx §3). Explicit user action; never runs on its own.
fsRouter.post("/os-open", (req, res) => {
  const body = z.object({ path: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    res.json({ ok: true, data: openInOs(req, body.data.path) });
  } catch (e) {
    const msg = (e as Error).message;
    const code = /only available on localhost/.test(msg) ? 403 : /not found/.test(msg) ? 404 : 400;
    log.warn("fs", `os-open rejected (${code}): ${msg}`);
    res.status(code).json({ ok: false, error: msg });
  }
});

// GET /api/fs/flat/stream?path=<abs>&hidden=1 — the flat large-file listing delivered as an NDJSON
// STREAM (performance.mdx P-22/P-23). One JSON object per line: `meta` first, then `batch` events as
// the walk finds rows, then a terminal `done` (or `error`). The Full Paths table renders progressively
// instead of waiting on one 5000-row blob, so time-to-first-row is tens of ms. A client disconnect
// aborts the walk (no orphaned walks — Aspect 7 scaling).
fsRouter.get("/flat/stream", async (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  const showHidden = req.query.hidden === "1" || req.query.hidden === "true";

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no"); // don't let a reverse proxy buffer the stream

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const write = (ev: FlatStreamEvent): void => {
    if (res.writableEnded) return;
    res.write(JSON.stringify(ev) + "\n");
    // Push each chunk out immediately when a compression/proxy layer buffers.
    (res as unknown as { flush?: () => void }).flush?.();
  };

  try {
    const summary = await walkFilesFlatStreaming(p, showHidden, {
      onMeta: (m) => write({ t: "meta", ...m }),
      onBatch: (files) => write({ t: "batch", files }),
      signal: ac.signal,
    });
    write({ t: "done", truncated: summary.truncated, total: summary.total });
  } catch (e) {
    log.error("fs", `flat stream walk failed for ${p ?? "<home>"}: ${(e as Error).message}`);
    write({ t: "error", error: (e as Error).message });
  }
  if (!res.writableEnded) res.end();
});

// GET /api/fs/flat?path=<abs>&hidden=1 — the flat, recursive LARGE-file listing (full_paths.mdx).
fsRouter.get("/flat", async (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  const showHidden = req.query.hidden === "1" || req.query.hidden === "true";
  try {
    res.json({ ok: true, data: await listFilesFlat(p, showHidden) });
  } catch (e) {
    log.warn("fs", `flat listing failed for ${p ?? "<home>"}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/fs?path=<abs>&hidden=1 — one directory level, entries carrying code badges.
fsRouter.get("/", async (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  const showHidden = req.query.hidden === "1" || req.query.hidden === "true";
  try {
    res.json({ ok: true, data: await listDirectory(p, showHidden) });
  } catch (e) {
    log.warn("fs", `directory listing failed for ${p ?? "<home>"}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
