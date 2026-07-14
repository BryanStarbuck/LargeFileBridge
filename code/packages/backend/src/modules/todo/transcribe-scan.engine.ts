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
import { hasAudioStream } from "../../tools/transcribe/audio-prep.js";
import { log } from "../../shared/logging.js";
import { batchFileName, slugify, writeBatch, removeStaleTranscribeBatches, removeBatchFile } from "./todo-batches.store.js";

function resolveRoot(p: string | undefined | null): string | null {
  if (!p) return null;
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/** Transcribable-and-not-yet-transcribed items under one storage root (transcribe_calc_engine.mdx §2). A
 *  candidate must actually be transcribable: audio always is, but a VIDEO with no audio track (a silent screen
 *  recording) is NOT (transcribe_calc_engine.mdx §2.1), so we probe videos and skip the silent ones — otherwise
 *  counts inflate and Apply runs a no-audio placeholder. When ffprobe is absent `hasAudioStream` returns true,
 *  so we keep the video and let the engine try (never a false drop). */
async function transcribeItems(root: string): Promise<TodoBatchItem[]> {
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
    if (kind === "video") {
      // Index rows store the storage-relative path; probe needs the absolute file.
      const abs = path.isAbsolute(row.path) ? row.path : path.join(root, row.path);
      try {
        if (!(await hasAudioStream(abs))) continue; // silent video → not transcribable
      } catch {
        /* probe failure → keep the candidate (best-effort, never silently drop a real one) */
      }
    }
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

/** The scope enum for a storage row (repo rows are handled separately). */
function scopeForRow(type: string): TodoBatchDoc["scope"] {
  return type === "personal" ? "personal" : type === "company" ? "company" : "community";
}

/** Scan every storage for transcribable-not-transcribed media and write the transcribe batches
 *  (transcribe_calc_engine.mdx §1 — the all-storages trigger). Returns {batches, candidates}. Best-effort —
 *  never throws. */
export async function scanAll(): Promise<{ batches: number; candidates: number }> {
  let batches = 0;
  let candidates = 0;
  const written = new Set<string>(); // transcribe files re-written this run — everything else is stale
  const emit = (doc: TodoBatchDoc | null): void => {
    if (!doc) return;
    const file = batchFileName(doc.scope, doc.storageName, "transcribe");
    writeBatch(doc, file);
    written.add(file);
    batches += 1;
    candidates += doc.items.length;
  };

  try {
    for (const folder of listRepoFolders()) {
      const cfg = getRepoConfig(folder);
      const root = resolveRoot(cfg.repo.path);
      if (!root || !fs.existsSync(root)) continue;
      emit(buildTranscribeDoc("repo", cfg.repo.name || path.basename(root), root, await transcribeItems(root), repoIdFromPath(root)));
    }
    for (const id of listStorageIds()) {
      const row = getStorageRow(id);
      if (!row || row.type === "local" || row.type === "repo" || !row.root) continue;
      emit(buildTranscribeDoc(scopeForRow(row.type), row.name, row.root, await transcribeItems(row.root)));
    }
  } catch (e) {
    log.warn("todo", `transcribe scan failed: ${(e as Error).message}`);
  }
  // Recalculate-and-replace: drop any transcribe batch not re-written this run, so a storage that no
  // longer has transcribable files stops surfacing a phantom transcribe slug (transcribe_calc_engine §5).
  removeStaleTranscribeBatches(written);
  log.info("todo", `transcribe scan complete — ${batches} batch(es), ${candidates} candidate(s)`);
  return { batches, candidates };
}

/** Scan ONE storage or repo by scope id for transcribable-not-transcribed media and (re)write just its
 *  transcribe batch (transcribe_calc_engine.mdx §1 — the scoped `?scope=<id>` trigger from a storage-detail
 *  page). `scopeId` is a storage id or a repo id. Unlike {@link scanAll} it does NOT recalc-and-replace other
 *  scopes' batches (it only ever touches the one scope). When the scope has no candidates any stale batch for
 *  it is removed so a phantom slug never lingers. Best-effort — never throws. */
export async function scanStorage(scopeId: string): Promise<{ batches: number; candidates: number }> {
  let batches = 0;
  let candidates = 0;
  const emitOrClear = (
    scope: TodoBatchDoc["scope"],
    name: string,
    doc: TodoBatchDoc | null,
  ): void => {
    const file = batchFileName(scope, name, "transcribe");
    if (doc) {
      writeBatch(doc, file);
      batches += 1;
      candidates += doc.items.length;
    } else {
      // No candidates → drop only THIS scope's previously-written batch (never other scopes').
      removeBatchFile(file);
    }
  };
  try {
    const row = getStorageRow(scopeId);
    if (row && row.root && row.type !== "local" && row.type !== "repo") {
      const scope = scopeForRow(row.type);
      emitOrClear(scope, row.name, buildTranscribeDoc(scope, row.name, row.root, await transcribeItems(row.root)));
    } else {
      for (const folder of listRepoFolders()) {
        const cfg = getRepoConfig(folder);
        const root = resolveRoot(cfg.repo.path);
        if (!root || !fs.existsSync(root) || repoIdFromPath(root) !== scopeId) continue;
        const name = cfg.repo.name || path.basename(root);
        emitOrClear("repo", name, buildTranscribeDoc("repo", name, root, await transcribeItems(root), repoIdFromPath(root)));
        break;
      }
    }
  } catch (e) {
    log.warn("todo", `transcribe scan (scope=${scopeId}) failed: ${(e as Error).message}`);
  }
  log.info("todo", `transcribe scan (scope=${scopeId}) — ${batches} batch(es), ${candidates} candidate(s)`);
  return { batches, candidates };
}
