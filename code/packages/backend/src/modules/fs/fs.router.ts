// REST for the File System column browser (directory.mdx §1, code_plan.mdx §14).
import { Router } from "express";
import { homeDir, listDirectory, listFilesFlat } from "./fs.service.js";
import { requireAllowListed } from "../auth/identify.js";

export const fsRouter = Router();
fsRouter.use(requireAllowListed);

// GET /api/fs/home — the default root the browser opens on (the OS home directory).
fsRouter.get("/home", (_req, res) => {
  res.json({ ok: true, data: { home: homeDir() } });
});

// GET /api/fs/flat?path=<abs>&hidden=1 — the flat, recursive LARGE-file listing (full_paths.mdx).
fsRouter.get("/flat", async (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  const showHidden = req.query.hidden === "1" || req.query.hidden === "true";
  try {
    res.json({ ok: true, data: await listFilesFlat(p, showHidden) });
  } catch (e) {
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
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
