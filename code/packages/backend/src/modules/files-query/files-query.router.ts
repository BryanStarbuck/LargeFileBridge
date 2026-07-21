// REST for the CLI's "get file list" family (cli.mdx §4.5): GET /api/files/list.
// Read-only. Auth is the standard gate — the CLI reaches it via the loopback X-LFB-Api-Key channel
// (identify.ts apiKeyUser), a browser via its normal session; requireAllowListed treats both alike.
import { Router } from "express";
import { z } from "zod";
import type { FilesListCategoryKey } from "@lfb/shared";
import { requireAllowListed } from "../auth/identify.js";
import { listFilesByCategory, listEverything, FILES_LIST_CATEGORY_KEYS } from "./files-query.service.js";
import { log } from "../../shared/logging.js";

const QuerySchema = z.object({
  // "all" (every tracked root, the CLI's --all) or an absolute path — recursive always (cli.mdx §4.1).
  scope: z.string().min(1),
  // Comma-separated category keys; absent/empty = ALL categories (the no-flag default, cli.mdx §4.2).
  categories: z.string().optional(),
  // "everything" = the bare-`lfb` / --everything full recursive listing (cli.mdx §4.0/§4.2);
  // absent/"categories" = the category query. everything rejects a categories parameter.
  mode: z.enum(["categories", "everything"]).optional(),
});

export const filesQueryRouter = Router();

filesQueryRouter.get("/list", requireAllowListed, async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "bad query" });
    return;
  }
  const { scope, categories, mode } = parsed.data;
  if (scope !== "all" && !scope.startsWith("/") && !scope.startsWith("~")) {
    res.status(400).json({ ok: false, error: `scope must be "all" or an absolute path, got: ${scope}` });
    return;
  }
  if (mode === "everything") {
    if (categories) {
      res.status(400).json({ ok: false, error: "mode=everything does not take categories (cli.mdx §4.2)" });
      return;
    }
    try {
      res.json({ ok: true, data: await listEverything(scope) });
    } catch (e) {
      log.warn("files-query", `everything walk failed for scope ${scope}: ${(e as Error).message}`);
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
    return;
  }
  const keys = (categories ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as FilesListCategoryKey[];
  const unknown = keys.filter((k) => !FILES_LIST_CATEGORY_KEYS.includes(k));
  if (unknown.length) {
    res.status(400).json({
      ok: false,
      error: `unknown categories: ${unknown.join(", ")} (valid: ${FILES_LIST_CATEGORY_KEYS.join(", ")})`,
    });
    return;
  }
  try {
    const result = await listFilesByCategory(scope, keys);
    res.json({ ok: true, data: result });
  } catch (e) {
    log.warn("files-query", `list failed for scope ${scope}: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
