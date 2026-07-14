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
import { scanAll as transcribeScanAll, scanStorage as transcribeScanStorage } from "./transcribe-scan.engine.js";
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

// POST /api/todo/batches/:id/apply — carry out the checked recommendations. Body:
//   { paths?: string[], perRow?: { [path]: { ipfs?, ignore?, compress? } } }
// `paths` (repo-relative) is the set of INCLUDED rows (default = all items). `perRow` carries each row's
// PER-AXIS toggles from the wide popup (warnings.mdx §4.5.1) so a user can pin-but-not-compress one file
// and compress-only another; when a row is absent from `perRow` we fall back to its stored recommendation.
todoRouter.post("/batches/:id/apply", async (req, res) => {
  const found = readBatchById(req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: "batch not found" });
  const doc = found.doc;
  const body = z
    .object({
      paths: z.array(z.string()).optional(),
      perRow: z
        .record(
          z.string(),
          z.object({ ipfs: z.boolean().optional(), ignore: z.boolean().optional(), compress: z.boolean().optional() }),
        )
        .optional(),
    })
    .safeParse(req.body ?? {});
  const perRow = body.success ? body.data.perRow : undefined;
  const keep = new Set(body.success && body.data.paths ? body.data.paths : doc.items.map((i) => i.path));
  const chosen = doc.items.filter((i) => keep.has(i.path));
  const by = currentUser(req).email;
  const root = doc.storageRoot;
  const result = { applied: 0, pins: 0, gitignored: 0, compressed: 0, transcribed: 0 };

  // The effective axes for one item: the popup's per-row toggles when supplied, else the item's stored
  // recommendation (recommend.gitignore ↔ the "ignore" axis). This is what makes the three toggles real.
  const effAxes = (i: (typeof doc.items)[number]) => {
    const o = perRow?.[i.path];
    if (o) return { ipfs: !!o.ipfs, ignore: !!o.ignore, compress: !!o.compress };
    const r = i.recommend ?? {};
    return { ipfs: !!r.ipfs, ignore: !!r.gitignore, compress: !!r.compress };
  };

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

    // Bucket the chosen rows by their EFFECTIVE axes (not just their category).
    const pullDown = chosen.filter((i) => i.category === "pull_down" && effAxes(i).ipfs).map((i) => i.path);
    const compress = chosen.filter(
      (i) => (i.category === "compress_video" || i.category === "compress_image") && effAxes(i).compress,
    );
    // Decisions (pin / git-ignore) apply only inside a repo. Group non-pull-down rows by their (ipfs,ignore)
    // combo so each combo is one recordDecision call; pull-down rows carry only their git-ignore axis here
    // (their pin/fetch is done by pullMissing below).
    const acted = new Set<string>();
    if (doc.scope === "repo" && doc.repoId) {
      const folder = folderForRepoId(doc.repoId);
      if (folder) {
        const combos = new Map<string, { ipfs: boolean; gitignore: boolean; paths: string[] }>();
        for (const i of chosen) {
          const a = effAxes(i);
          const isPull = i.category === "pull_down";
          // pull-down rows: pin is handled by pullMissing; only their ignore axis becomes a decision here.
          const wantIpfs = isPull ? false : a.ipfs;
          const wantIgnore = a.ignore;
          if (!wantIpfs && !wantIgnore) continue;
          const key = `${wantIpfs}|${wantIgnore}`;
          const g = combos.get(key) ?? { ipfs: wantIpfs, gitignore: wantIgnore, paths: [] };
          g.paths.push(i.path);
          combos.set(key, g);
          acted.add(i.path);
        }
        for (const g of combos.values()) {
          await recordDecision(folder, g.paths, { ipfs: g.ipfs, gitignore: g.gitignore }, by);
          if (g.ipfs) result.pins += g.paths.length;
          if (g.gitignore) result.gitignored += g.paths.length;
        }
        if (pullDown.length) {
          // Fire-and-forget: Apply must return immediately and never run the fetch inline in the request
          // (job_queue.mdx §4b / processing.mdx §4.2) — a large-file pull can take minutes. The pull runs
          // in the background; failures are logged. result.pins counts the QUEUED pulls (the async
          // hand-off), not the settled count.
          void pullMissing(root, pullDown, { compress: false, by }).catch((e) =>
            log.error("todo", `pull-down for ${req.params.id} failed: ${(e as Error).message}`),
          );
          result.pins += pullDown.length;
          for (const p of pullDown) acted.add(p);
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
      for (const i of compress) acted.add(i.path);
    }

    result.applied = acted.size;
    res.json({ ok: true, data: result });
  } catch (e) {
    log.error("todo", `apply ${req.params.id} failed: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/todo/transcribe-scan[?scope=<id>] — the "Show what could be transcribed" action
// (transcribe_calc_engine.mdx §1). With no `scope` it walks EVERY storage (recalc-and-replace); with a
// `scope` (a storage id or repo id, from a storage-detail page) it scans only that one storage. Writes the
// transcribe batches, then returns the counts. Async: silent-video probing (ffprobe) is awaited.
todoRouter.post("/transcribe-scan", async (req, res) => {
  const scope = typeof req.query.scope === "string" && req.query.scope.trim() ? req.query.scope.trim() : null;
  try {
    res.json({ ok: true, data: scope ? await transcribeScanStorage(scope) : await transcribeScanAll() });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});
