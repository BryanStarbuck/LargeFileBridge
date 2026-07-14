// The ADDITIVE company/Personal SYNC-REPO mirror for a repo's Category-B tracking state
// (artifact_placement_policy.mdx §4-§5). Category B (`repo_storage.yaml`, `files/<rel>.yaml` sidecars,
// `history/<device>.txt`, `decisions.yaml`, `manifest.yaml`, compression records) is ALWAYS written to Local
// Storage `~/T/_large_files_bridge/repos/<repoKey>/` first (the authoritative working copy). When the owning
// company/Personal storage has a sync repo configured AND the per-repo toggle is on, that subtree is ALSO
// mirrored to `<syncRepo>/repos/<repoKey>/` so it travels between the user's computers — in addition to Local
// Storage, not instead of it. The storage's git backbone (backbone_resilience.mdx) commits + pushes the sync
// repo; this module only copies files into its working tree. Default OFF: absent the marker, every call here
// is a best-effort no-op. LOGS (launcher.log / log.log / error.err) live only in the state root and are NEVER
// under `repos/<repoKey>/`, so they are never mirrored (artifact_placement_policy.mdx §8).
import fs from "node:fs";
import path from "node:path";
import { repoStateDir, resolveStateSyncRepo, syncRepoMarkerPath } from "./tracking-root.service.js";
import { log } from "../../shared/logging.js";

// Machine-local files under `repos/<repoKey>/` that must NOT travel to the sync repo.
const LOCAL_ONLY = new Set([".sync-repo", ".durable-artifact"]);

/** Turn the per-repo sync-repo mirror ON (write the marker with the owning storage's sync-repo absolute path)
 *  or OFF (remove the marker). Called from the per-repo settings PATCH when the toggle flips
 *  (repo_settings.mdx). Best-effort; a marker write failure just leaves the repo Local-Storage-only. */
export function setSyncRepoMarker(repoRoot: string, syncRepoRoot: string | null): void {
  const marker = syncRepoMarkerPath(repoRoot);
  try {
    if (syncRepoRoot && syncRepoRoot.trim()) {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${path.resolve(syncRepoRoot.trim())}\n`);
    } else {
      fs.rmSync(marker, { force: true });
    }
  } catch (e) {
    log.warn("storage", `setSyncRepoMarker(${repoRoot}) failed: ${(e as Error).message}`);
  }
}

/** Recursively copy `src` → `dst`, skipping the machine-local files at the top level. Best-effort. */
function copyTree(src: string, dst: string, top = true): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    if (top && LOCAL_ONLY.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    try {
      if (e.isDirectory()) copyTree(s, d, false);
      else if (e.isFile()) fs.copyFileSync(s, d);
    } catch (err) {
      // Skip an unreadable/unwritable leaf; never fail the whole mirror — BUT make it observable. A file
      // that silently stops copying between the user's computers is the exact failure this module exists to
      // prevent, so a per-leaf copy failure must reach error.err (the top-level caller still returns true).
      log.warn("storage", `copyTree: failed to copy ${s} -> ${d}: ${(err as Error).message}`);
    }
  }
}

/**
 * Mirror this repo's Local-Storage Category-B subtree into the owning storage's sync repo at
 * `<syncRepo>/repos/<repoKey>/`, so it travels. No-op (returns false) when no sync repo is configured for the
 * repo, or when the sync-repo path is missing/unwritable (artifact_placement_policy.mdx §7.1: skip the mirror,
 * WARN, keep Local Storage authoritative — never fall back to the working repo). Called best-effort after a
 * Category-B write (e.g. from `writeRepoStorage`) and on demand.
 */
export function mirrorToSyncRepo(repoRoot: string): boolean {
  const dst = resolveStateSyncRepo(repoRoot);
  if (!dst) return false;
  try {
    copyTree(repoStateDir(repoRoot), dst);
    return true;
  } catch (e) {
    log.warn("storage", `mirrorToSyncRepo(${repoRoot}) failed (path missing/unwritable): ${(e as Error).message}`);
    return false;
  }
}

/**
 * Reconcile a pulled sync-repo subtree back into Local Storage (artifact_placement_policy.mdx §5): copy the
 * sync repo's `repos/<repoKey>/` files into this machine's Local-Storage state dir. Append-only sidecars /
 * history and union-mergeable decisions/manifest tolerate a last-writer copy for the common case; a richer
 * per-file merge is a later refinement. Best-effort; no-op when no sync repo is configured.
 */
export function reconcileFromSyncRepo(repoRoot: string): boolean {
  const src = resolveStateSyncRepo(repoRoot);
  if (!src) return false;
  try {
    copyTree(src, repoStateDir(repoRoot));
    return true;
  } catch (e) {
    log.warn("storage", `reconcileFromSyncRepo(${repoRoot}) failed: ${(e as Error).message}`);
    return false;
  }
}
