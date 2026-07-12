// The TO DO Batch Calc Engine (to_do_batch_calc_engine.mdx). Runs as the recalc stage of a scan: for
// each storage it decides the recommended action per file across the categories (pull_down · pin ·
// compress_video · compress_image), assigns each to its owning storage's batch, and
// recalculates-and-replaces that storage's `_2_do.yaml`. It RECOMMENDS ONLY — it never writes a
// decision or moves bytes; that happens when the user Applies a batch.
import fs from "node:fs";
import path from "node:path";
import type { TodoBatchDoc, TodoBatchItem, TodoCategory } from "@lfb/shared";
import { health } from "../ipfs/ipfs.service.js";
import { listRepoFolders, getRepoConfig, computeRepoDetail, repoIdFromPath } from "../store-model/units.service.js";
import { missingPinnedFromPeers } from "../pin/pin.service.js";
import { listStorageIds, getStorageRow } from "../storage/storage.service.js";
import { readStorageIndex } from "../storage/tracking.service.js";
import { getAppConfig } from "../store-model/config.service.js";
import { log } from "../../shared/logging.js";
import {
  batchFileName,
  slugify,
  writeBatch,
  readPreviousBatch,
  removeStaleTodoBatches,
} from "./todo-batches.store.js";

function resolveRoot(p: string | undefined | null): string | null {
  if (!p) return null;
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/** Roll items up into totals + a pattern, and stamp the batch. Returns null when there is no work. */
function buildDoc(
  scope: TodoBatchDoc["scope"],
  name: string,
  root: string,
  items: TodoBatchItem[],
  opts: { kind: "todo" | "transcribe"; repoId?: string },
): TodoBatchDoc | null {
  if (items.length === 0) return null;

  const totals: Record<string, { count: number; reclaimableBytes?: number }> = {};
  for (const it of items) {
    const t = (totals[it.category] ??= { count: 0 });
    t.count += 1;
    if (it.category === "compress_video" || it.category === "compress_image") {
      t.reclaimableBytes = (t.reclaimableBytes ?? 0) + it.sizeBytes;
    }
  }

  const slug = slugify(name);
  const id = opts.kind === "transcribe" ? `${scope}:${slug}:transcribe` : `${scope}:${slug}`;

  // Preserve a prior dismissal only while the batch's contents haven't materially changed (to_do_batches.mdx §3.3).
  // "Materially changed" = the SET of file paths differs (a new file appearing, or one applied and one added,
  // keeps the same count but is a real change) — so compare the path sets, not just the count.
  const prev = readPreviousBatch(scope, name, opts.kind);
  const prevPaths = prev ? new Set(prev.items.map((i) => i.path)) : null;
  const samePaths = !!prevPaths && prevPaths.size === items.length && items.every((i) => prevPaths.has(i.path));
  const dismissed = !!(prev?.dismissed && samePaths);

  return {
    schema_version: 1,
    id,
    scope,
    storageName: name,
    storageRoot: root,
    kind: opts.kind,
    pattern: choosePattern(Object.keys(totals) as TodoCategory[], opts.kind),
    repoId: opts.repoId,
    totals,
    items,
    dismissed,
    dismissedAt: dismissed ? (prev?.dismissedAt ?? null) : null,
    computedAt: new Date().toISOString(),
  };
}

/** The slug-template hint (to_do_batches.mdx §3.2): one logical category → its pattern, else "mixed". */
function choosePattern(cats: TodoCategory[], kind: "todo" | "transcribe"): TodoBatchDoc["pattern"] {
  if (kind === "transcribe") return "transcribe";
  const groups = new Set<string>();
  for (const c of cats) {
    if (c === "compress_video" || c === "compress_image") groups.add("compress");
    else if (c === "git_ignore") groups.add("git_ignore");
    else if (c === "pull_down") groups.add("pull_down");
    else if (c === "pin") groups.add("pin");
  }
  if (groups.size === 1) return [...groups][0] as TodoBatchDoc["pattern"];
  return "mixed";
}

/** Build the compress-category items from a storage's fingerprint index (which already knows what
 *  "looks uncompressed"). Works for both repos and directory-based storages. */
function compressItems(root: string): TodoBatchItem[] {
  const items: TodoBatchItem[] = [];
  let rows: ReturnType<typeof readStorageIndex>;
  try {
    rows = readStorageIndex(root);
  } catch {
    return items;
  }
  for (const row of rows) {
    if (row.compressible === "video")
      items.push({ path: row.path, sizeBytes: row.sizeBytes, category: "compress_video", recommend: { compress: true } });
    else if (row.compressible === "image")
      items.push({ path: row.path, sizeBytes: row.sizeBytes, category: "compress_image", recommend: { compress: true } });
  }
  return items;
}

/** Recompute one repo's batch (the richest — all categories that apply to a repo). */
export async function recalcRepo(folder: string): Promise<TodoBatchDoc | null> {
  const cfg = getRepoConfig(folder);
  const root = resolveRoot(cfg.repo.path);
  if (!root || !fs.existsSync(root)) return null;

  const items: TodoBatchItem[] = [];
  const seen = new Set<string>();

  // pull_down — files pinned on a peer device but absent here (pin.service does the join). Highest value.
  try {
    for (const m of await missingPinnedFromPeers(root)) {
      items.push({
        path: m.path,
        sizeBytes: m.sizeBytes,
        category: "pull_down",
        cid: m.cid,
        pinnedOn: m.addedByDevice ? [m.addedByDevice] : [],
        recommend: { ipfs: true, gitignore: true },
      });
      seen.add(m.path);
    }
  } catch (e) {
    log.warn("todo", `${root}: pull_down scan failed: ${(e as Error).message}`);
  }

  // pin — big, Undecided, not Never-IPFS (and not already a pull_down candidate).
  try {
    const threshold = getAppConfig().big_file.threshold_bytes;
    const detail = computeRepoDetail(folder, await health());
    for (const f of detail.files) {
      if (seen.has(f.path)) continue;
      if (f.decision === "undecided" && f.sizeBytes >= threshold && !f.neverIpfs) {
        items.push({ path: f.path, sizeBytes: f.sizeBytes, category: "pin", recommend: { ipfs: true, gitignore: true } });
        seen.add(f.path);
      }
    }
  } catch (e) {
    log.warn("todo", `${root}: pin scan failed: ${(e as Error).message}`);
  }

  // compress — from the fingerprint index.
  for (const it of compressItems(root)) {
    if (seen.has(it.path)) continue;
    items.push(it);
    seen.add(it.path);
  }

  return buildDoc("repo", cfg.repo.name || path.basename(root), root, items, {
    kind: "todo",
    repoId: repoIdFromPath(root),
  });
}

/** Recompute one directory-based storage's batch (Personal / Company / Community). Compress-only in this
 *  cut — pull_down/pin are repo-scoped (they need a per-repo manifest). */
export function recalcStorage(id: string): TodoBatchDoc | null {
  const row = getStorageRow(id);
  if (!row || row.type === "local" || row.type === "repo" || !row.root) return null;
  const scope: TodoBatchDoc["scope"] =
    row.type === "personal" ? "personal" : row.type === "company" ? "company" : "community";
  return buildDoc(scope, row.name, row.root, compressItems(row.root), { kind: "todo" });
}

let recalcInFlight: Promise<number> | null = null;

/** The recalc stage of a scan (to_do_batch_calc_engine.mdx §1): rebuild every storage's TODO batch and
 *  recalculate-and-replace its file. Single-flighted so overlapping scans/watcher events coalesce.
 *  Returns how many batches have work. Best-effort — never throws. */
export function recalcAll(): Promise<number> {
  if (recalcInFlight) return recalcInFlight;
  recalcInFlight = (async () => {
    const written = new Set<string>();
    let withWork = 0;
    try {
      for (const folder of listRepoFolders()) {
        try {
          const doc = await recalcRepo(folder);
          if (doc) {
            const file = batchFileName(doc.scope, doc.storageName, "todo");
            writeBatch(doc, file);
            written.add(file);
            withWork += 1;
          }
        } catch (e) {
          log.warn("todo", `recalc repo ${folder} failed: ${(e as Error).message}`);
        }
      }
      for (const id of listStorageIds()) {
        try {
          const doc = recalcStorage(id);
          if (doc) {
            const file = batchFileName(doc.scope, doc.storageName, "todo");
            writeBatch(doc, file);
            written.add(file);
            withWork += 1;
          }
        } catch (e) {
          log.warn("todo", `recalc storage ${id} failed: ${(e as Error).message}`);
        }
      }
      removeStaleTodoBatches(written);
      log.info("todo", `TO DO recalc complete — ${withWork} batch(es) with work`);
    } catch (e) {
      log.warn("todo", `TO DO recalc failed: ${(e as Error).message}`);
    } finally {
      recalcInFlight = null;
    }
    return withWork;
  })();
  return recalcInFlight;
}

/** Importance score for slug ordering (to_do.mdx §4.1): not-backed-up risk first, then compress. */
export function importanceScore(doc: Pick<TodoBatchDoc, "totals">): number {
  const t = doc.totals;
  const n = (k: TodoCategory) => t[k]?.count ?? 0;
  return (
    (n("pull_down") + n("pin")) * 1_000_000 +
    n("git_ignore") * 10_000 +
    (n("compress_video") + n("compress_image")) * 100 +
    (n("transcribe_video") + n("transcribe_audio"))
  );
}
