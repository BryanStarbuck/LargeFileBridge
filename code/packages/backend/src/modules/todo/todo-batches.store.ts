// The TO DO batches store (to_do_batches.mdx §2/§5). Reads/writes the machine-local, disposable
// per-storage batch YAMLs under ~/T/_large_files_bridge/_do_batches/. These are NOT committed, NOT
// team-shared, and safe to delete — the calc engine recalculates-and-replaces them each scan.
import fs from "node:fs";
import path from "node:path";
import { TodoBatchDocSchema, type TodoBatchDoc } from "@lfb/shared";
import { readYaml, writeYaml } from "../../shared/store/yaml-store.js";
import { resolveTodoBatchesDir } from "../../config/state-dir.js";
import { log } from "../../shared/logging.js";

/** Filesystem-safe slug for a storage name (to_do_batches.mdx §1). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "storage"
  );
}

/** The `_2_do.yaml` file name for a batch (to_do_batches.mdx §1). Transcribe batches get the
 *  `_transcribe_2_do.yaml` suffix so they live beside — but distinct from — the todo batch. */
export function batchFileName(scope: string, name: string, kind: "todo" | "transcribe"): string {
  const suffix = kind === "transcribe" ? "_transcribe_2_do.yaml" : "_2_do.yaml";
  return `${scope}_${slugify(name)}${suffix}`;
}

function isTranscribeFile(file: string): boolean {
  return file.endsWith("_transcribe_2_do.yaml");
}

/** Write one batch doc, atomically, to its `_do_batches/` file. */
export function writeBatch(doc: TodoBatchDoc, fileName: string): void {
  writeYaml(path.join(resolveTodoBatchesDir(), fileName), doc as unknown as Record<string, unknown>);
}

/** Every `*_2_do.yaml` file currently on disk. */
export function listBatchFiles(): string[] {
  try {
    return fs.readdirSync(resolveTodoBatchesDir()).filter((f) => f.endsWith("_2_do.yaml"));
  } catch {
    return [];
  }
}

/** Read+validate one batch file; null if it can't be read (never throws). */
function readBatchFile(fileName: string): TodoBatchDoc | null {
  try {
    return readYaml(path.join(resolveTodoBatchesDir(), fileName), TodoBatchDocSchema);
  } catch (e) {
    log.warn("todo", `skipping unreadable batch ${fileName}: ${(e as Error).message}`);
    return null;
  }
}

/** All batch docs on disk (each paired with its file name). Unreadable files are skipped. */
export function readAllBatches(): { doc: TodoBatchDoc; file: string }[] {
  const out: { doc: TodoBatchDoc; file: string }[] = [];
  for (const file of listBatchFiles()) {
    const doc = readBatchFile(file);
    if (doc && doc.id) out.push({ doc, file });
  }
  return out;
}

/** Look one batch up by its stable id. */
export function readBatchById(id: string): { doc: TodoBatchDoc; file: string } | null {
  return readAllBatches().find((b) => b.doc.id === id) ?? null;
}

/** The previously-written batch for a scope+name+kind (used to preserve the `dismissed` flag on recalc). */
export function readPreviousBatch(scope: string, name: string, kind: "todo" | "transcribe"): TodoBatchDoc | null {
  const file = batchFileName(scope, name, kind);
  if (!fs.existsSync(path.join(resolveTodoBatchesDir(), file))) return null;
  return readBatchFile(file);
}

/** Set the `dismissed` flag on a batch (the red-trash action, to_do_batches.mdx §3.3). Never deletes
 *  files or touches any bytes. Returns whether a batch was found. */
export function dismissBatch(id: string): boolean {
  const found = readBatchById(id);
  if (!found) return false;
  const next: TodoBatchDoc = { ...found.doc, dismissed: true, dismissedAt: new Date().toISOString() };
  writeBatch(next, found.file);
  return true;
}

/** Delete stale TODO batch files (kind:todo only) not written by the latest recalc — the
 *  "recalculate-and-replace" cleanup (to_do_batches.mdx §5). Transcribe batches have their own
 *  lifecycle and are left untouched. */
export function removeStaleTodoBatches(keep: Set<string>): void {
  for (const file of listBatchFiles()) {
    if (isTranscribeFile(file)) continue; // transcribe batches are managed by the other engine
    if (keep.has(file)) continue;
    try {
      fs.unlinkSync(path.join(resolveTodoBatchesDir(), file));
    } catch (e) {
      log.warn("todo", `could not remove stale batch ${file}: ${(e as Error).message}`);
    }
  }
}

/** Delete exactly ONE batch file by name if it exists (no-op when absent). Used by a SCOPED transcribe scan
 *  to drop just that scope's stale batch without touching any other scope's batches. */
export function removeBatchFile(file: string): void {
  try {
    fs.unlinkSync(path.join(resolveTodoBatchesDir(), file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("todo", `could not remove batch ${file}: ${(e as Error).message}`);
    }
  }
}

/** Delete stale TRANSCRIBE batch files (kind:transcribe only) not written by the latest transcribe scan —
 *  the transcribe engine's own "recalculate-and-replace" cleanup. Without this, a storage that drops to
 *  zero transcribable files keeps its old `_transcribe_2_do.yaml` on disk, so a phantom transcribe slug
 *  surfaces forever (transcribe_calc_engine.mdx §4/§5 AC #5). Mirrors removeStaleTodoBatches, scoped to
 *  transcribe files. */
export function removeStaleTranscribeBatches(keep: Set<string>): void {
  for (const file of listBatchFiles()) {
    if (!isTranscribeFile(file)) continue; // only transcribe batches
    if (keep.has(file)) continue;
    try {
      fs.unlinkSync(path.join(resolveTodoBatchesDir(), file));
    } catch (e) {
      log.warn("todo", `could not remove stale transcribe batch ${file}: ${(e as Error).message}`);
    }
  }
}
