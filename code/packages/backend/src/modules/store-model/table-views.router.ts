// REST for per-user, per-table view state (tables.mdx — remembered sort/filters/columns per logged-in
// user). GET returns the whole map (the frontend loads it once and distributes per table id); PUT
// persists one table's view. Best-effort: a view-state hiccup must never break the page, so reads fall
// back to "no saved views" and writes swallow errors — this is a background nicety, not a 500.
import { Router } from "express";
import { z } from "zod";
import { loadTableViews, saveTableView } from "./table-views.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { log } from "../../shared/logging.js";

export const tableViewsRouter = Router();
tableViewsRouter.use(requireAllowListed);

// GET /api/table-views — every table view the user has saved, keyed by table id. A fresh user reads
// back {} so every table just falls back to its defaults.
tableViewsRouter.get("/", (req, res) => {
  const email = currentUser(req).email;
  if (!email) return res.json({ ok: true, data: {} });
  try {
    res.json({ ok: true, data: loadTableViews(email) });
  } catch (e) {
    log.warn("table-views", `load failed for ${email}: ${(e as Error).message}`);
    res.json({ ok: true, data: {} });
  }
});

// PUT /api/table-views/:tableId — persist one table's view (debounced by the browser on every
// sort / filter / search / column-visibility change). The body is validated + defaulted server-side.
const viewBody = z.object({
  sort: z.array(z.object({ col: z.string(), dir: z.enum(["asc", "desc"]) })).default([]),
  filters: z.record(z.string(), z.string()).default({}),
  search: z.string().default(""),
  hidden_columns: z.array(z.string()).default([]),
  large_only: z.boolean().optional(),
  hidden_types: z.array(z.string()).optional(),
});
tableViewsRouter.put("/:tableId", async (req, res) => {
  const email = currentUser(req).email;
  if (!email) return res.json({ ok: true, data: null });
  const tableId = req.params.tableId;
  if (!tableId) return res.status(400).json({ ok: false, error: "tableId required" });
  const body = viewBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "invalid view state" });
  try {
    const saved = await saveTableView(email, tableId, body.data, new Date().toISOString());
    res.json({ ok: true, data: saved });
  } catch (e) {
    log.warn("table-views", `save failed for ${email}/${tableId}: ${(e as Error).message}`);
    res.json({ ok: true, data: null });
  }
});
