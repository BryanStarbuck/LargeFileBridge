// REST for the Git Ignore engine (git_ignore.mdx §6), mounted under /api/git so the full paths are
// POST /api/git/ignore/plan and POST /api/git/ignore/apply. Allow-list-gated like every mutating route.
// Apply is SYNCHRONOUS (it writes a few lines of text — no background batch, git_ignore.mdx §6).
import { Router } from "express";
import { z } from "zod";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import { planGitIgnore, applyGitIgnore } from "./gitignore.service.js";

export const gitRouter = Router();
gitRouter.use(requireAllowListed);

// Body = GitIgnoreRequest: exactly one of `paths` (the checked set) / `root` (a single directory) is used;
// sending neither is a 400 (git_ignore.mdx §6). `recursive` governs the directory line shape.
const ignoreBody = z.object({
  paths: z.array(z.string().min(1)).optional(),
  root: z.string().min(1).optional(),
  recursive: z.boolean().default(false),
});

// POST /api/git/ignore/plan — compute the GitIgnorePlan the dialog previews (never writes).
gitRouter.post("/ignore/plan", (req, res) => {
  const body = ignoreBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] or root required" });
  try {
    res.json({ ok: true, data: planGitIgnore(body.data) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/git/ignore/apply — write the planned lines into each owning repo's root .gitignore and
// return the GitIgnoreResult. Re-plans on the server (authoritative), append-only + idempotent (§5.4).
gitRouter.post("/ignore/apply", (req, res) => {
  const body = ignoreBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths[] or root required" });
  try {
    res.json({ ok: true, data: applyGitIgnore(body.data) });
  } catch (e) {
    log.error("git", `git-ignore apply failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
