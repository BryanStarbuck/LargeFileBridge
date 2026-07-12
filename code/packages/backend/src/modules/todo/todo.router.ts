// REST for the To Do page (to_do.mdx). Lists the per-storage TO DO Batches with work (slug summaries),
// serves one batch's items (the popup), dismisses a batch (red trash), applies a batch's checked
// recommendations, and runs the on-demand transcribe scan. Allow-list-gated like every data route.
import { Router } from "express";
import path from "node:path";
import { z } from "zod";
import type { TodoBatchDoc, TodoBatchSummary } from "@lfb/shared";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { log } from "../../shared/logging.js";
import { readAllBatches, readBatchById, dismissBatch } from "./todo-batches.store.js";
import { recalcAll, importanceScore } from "./todo-batch.engine.js";
import { scanAll as transcribeScanAll } from "./transcribe-scan.engine.js";
import { folderForRepoId } from "../store-model/units.service.js";
import { recordDecision } from "../storage/decisions.service.js";
import { pullMissing } from "../pin/pin.service.js";
import { enqueue } from "../jobqueue/jobqueue.service.js";
import { enqueueTranscribe } from "../transcribe/transcribe.service.js";

export const todoRouter = Router();
todoRouter.use(requireAllowListed);

/** Drop `items` for the list payload — the slug reads totals only (to_do_batches.mdx §3.1). */
function toSummary(doc: TodoBatchDoc): TodoBatchSummary {
  const { items: _items, schema_version: _v, dismissedAt: _d, ...rest } = doc;
  return rest as unknown as TodoBatchSummary;
}

// Throttle the recalc-on-read so a burst of To Do page loads doesn't re-walk every repo repeatedly. The
// scan recalc is the primary writer; this just keeps a freshly-opened page from showing nothing on a
// machine that hasn't scanned yet.
let lastRecalc = 0;
async function maybeRecalc(): Promise<void> {
  const now = Date.now();
  if (now - lastRecalc < 30_000) return;
  lastRecalc = now;
  try {
    await recalcAll();
  } catch (e) {
    log.warn("todo", `recalc-on-read failed: ${(e as Error).message}`);
  }
}

// GET /api/todo/batches — every batch WITH work that isn't dismissed, as slug summaries, most-important
// first (to_do.mdx §4/§4.1).
todoRouter.get("/batches", async (_req, res) => {
  await maybeRecalc();
  const summaries = readAllBatches()
    .map((b) => b.doc)
    .filter((d) => !d.dismissed && Object.keys(d.totals).length > 0)
    .sort((a, b) => importanceScore(b) - importanceScore(a))
    .map(toSummary);
  res.json({ ok: true, data: summaries });
});

// GET /api/todo/batches/:id — one batch's full items (the popup).
todoRouter.get("/batches/:id", (req, res) => {
  const found = readBatchById(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: "batch not found" });
  res.json({ ok: true, data: found.doc });
});

// DELETE /api/todo/batches/:id — dismiss (red trash, to_do_batches.mdx §3.3). Never deletes files/bytes.
todoRouter.delete("/batches/:id", (req, res) => {
  const ok = dismissBatch(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: "batch not found" });
  res.json({ ok: true, data: { dismissed: true } });
});

// POST /api/todo/batches/:id/apply — carry out the checked recommendations. Body: { paths?: string[] }
// (repo-relative; default = all items). Writes decisions + queues effects, then returns the counts.
todoRouter.post("/batches/:id/apply", async (req, res) => {
  const found = readBatchById(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: "batch not found" });
  const doc = found.doc;
  const body = z.object({ paths: z.array(z.string()).optional() }).safeParse(req.body ?? {});
  const keep = new Set(body.success && body.data.paths ? body.data.paths : doc.items.map((i) => i.path));
  const chosen = doc.items.filter((i) => keep.has(i.path));
  const by = currentUser(req).email;
  const root = doc.storageRoot;
  const result = { applied: 0, pins: 0, gitignored: 0, compressed: 0, transcribed: 0 };

  try {
    if (doc.kind === "transcribe") {
      const abs = chosen.map((i) => path.join(root, i.path));
      if (abs.length) {
        enqueueTranscribe({ paths: abs });
        result.transcribed = abs.length;
        result.applied += abs.length;
      }
      return res.json({ ok: true, data: result });
    }

    const pullDown = chosen.filter((i) => i.category === "pull_down").map((i) => i.path);
    const pin = chosen.filter((i) => i.category === "pin").map((i) => i.path);
    const compress = chosen.filter((i) => i.category === "compress_video" || i.category === "compress_image");

    if (doc.scope === "repo" && doc.repoId) {
      const folder = folderForRepoId(doc.repoId);
      if (folder) {
        if (pin.length) {
          await recordDecision(folder, pin, { ipfs: true, gitignore: true }, by);
          result.pins += pin.length;
          result.gitignored += pin.length;
          result.applied += pin.length;
        }
        if (pullDown.length) {
          const r = await pullMissing(root, pullDown, { compress: false, by });
          result.pins += r.pulled;
          result.applied += pullDown.length;
        }
      }
    }

    if (compress.length) {
      enqueue(
        compress.map((i) => ({
          op: "compress" as const,
          path: path.join(root, i.path),
          overwrite: false,
          compress: {
            deleteOriginal: "trash" as const,
            mediaKind: (i.category === "compress_video" ? "video" : "image") as "video" | "image",
          },
        })),
      );
      result.compressed += compress.length;
      result.applied += compress.length;
    }

    res.json({ ok: true, data: result });
  } catch (e) {
    log.error("todo", `apply ${req.params.id} failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/todo/transcribe-scan — the "Show what could be transcribed" action (to_do.mdx §7). Walks the
// storages for untranscribed media and writes the transcribe batches, then returns the counts.
todoRouter.post("/transcribe-scan", (_req, res) => {
  res.json({ ok: true, data: transcribeScanAll() });
});
