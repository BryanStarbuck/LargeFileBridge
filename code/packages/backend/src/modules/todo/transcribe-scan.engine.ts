// The What-Can-Be-Transcribed Calc Engine (transcribe_calc_engine.mdx). ON-DEMAND only (the "Show what
// could be transcribed" link / POST /api/todo/transcribe-scan) — never part of the scheduled scan. It
// walks each storage's fingerprint index for VIDEO/AUDIO files that have no transcription yet and writes
// one transcribe batch per storage. It transcribes nothing; Apply on the resulting slug does that.
import fs from "node:fs";
import path from "node:path";
import { mediaKindForName, type TodoBatchDoc, type TodoBatchItem } from "@lfb/shared";
import { listRepoFolders, getRepoConfig, repoIdFromPath } from "../store-model/units.service.js";
import { listStorageIds, getStorageRow } from "../storage/storage.service.js";
import { readStorageIndex } from "../storage/tracking.service.js";
import { log } from "../../shared/logging.js";
import { batchFileName, slugify, writeBatch } from "./todo-batches.store.js";

function resolveRoot(p: string | undefined | null): string | null {
  if (!p) return null;
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/** Transcribable-and-not-yet-transcribed items under one storage root (transcribe_calc_engine.mdx §2). */
function transcribeItems(root: string): TodoBatchItem[] {
  const items: TodoBatchItem[] = [];
  let rows: ReturnType<typeof readStorageIndex>;
  try {
    rows = readStorageIndex(root);
  } catch {
    return items;
  }
  for (const row of rows) {
    const kind = mediaKindForName(path.basename(row.path));
    if (kind !== "video" && kind !== "audio") continue; // images are never transcribable
    if (row.analysis?.includes("transcript")) continue; // already has a .transcription sidecar
    items.push({
      path: row.path,
      sizeBytes: row.sizeBytes,
      category: kind === "video" ? "transcribe_video" : "transcribe_audio",
      recommend: {},
    });
  }
  return items;
}

function buildTranscribeDoc(
  scope: TodoBatchDoc["scope"],
  name: string,
  root: string,
  items: TodoBatchItem[],
  repoId?: string,
): TodoBatchDoc | null {
  if (items.length === 0) return null;
  const totals: Record<string, { count: number }> = {};
  for (const it of items) (totals[it.category] ??= { count: 0 }).count += 1;
  return {
    schema_version: 1,
    id: `${scope}:${slugify(name)}:transcribe`,
    scope,
    storageName: name,
    storageRoot: root,
    kind: "transcribe",
    pattern: "transcribe",
    repoId,
    totals,
    items,
    dismissed: false,
    dismissedAt: null,
    computedAt: new Date().toISOString(),
  };
}

/** Scan every storage (or a single one) for transcribable-not-transcribed media and write the transcribe
 *  batches. Returns {batches, candidates}. Best-effort — never throws. */
export function scanAll(): { batches: number; candidates: number } {
  let batches = 0;
  let candidates = 0;
  const emit = (doc: TodoBatchDoc | null): void => {
    if (!doc) return;
    writeBatch(doc, batchFileName(doc.scope, doc.storageName, "transcribe"));
    batches += 1;
    candidates += doc.items.length;
  };

  try {
    for (const folder of listRepoFolders()) {
      const cfg = getRepoConfig(folder);
      const root = resolveRoot(cfg.repo.path);
      if (!root || !fs.existsSync(root)) continue;
      emit(buildTranscribeDoc("repo", cfg.repo.name || path.basename(root), root, transcribeItems(root), repoIdFromPath(root)));
    }
    for (const id of listStorageIds()) {
      const row = getStorageRow(id);
      if (!row || row.type === "local" || row.type === "repo" || !row.root) continue;
      const scope: TodoBatchDoc["scope"] =
        row.type === "personal" ? "personal" : row.type === "company" ? "company" : "community";
      emit(buildTranscribeDoc(scope, row.name, row.root, transcribeItems(row.root)));
    }
  } catch (e) {
    log.warn("todo", `transcribe scan failed: ${(e as Error).message}`);
  }
  log.info("todo", `transcribe scan complete — ${batches} batch(es), ${candidates} candidate(s)`);
  return { batches, candidates };
}
