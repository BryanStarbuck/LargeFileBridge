// Resolve the single state root (storage.mdx §1). No DB — everything persists here.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function resolveStateDir(): string {
  const dir =
    process.env.LFB_STATE_DIR ||
    safeJoin(os.homedir(), "T", "_large_files_bridge") ||
    "/tmp/_large_files_bridge";
  ensureDir(dir);
  return dir;
}

export function resolveLogDir(): string {
  const dir = process.env.LFB_LOG_DIR || resolveStateDir();
  ensureDir(dir);
  return dir;
}

// The TO DO batches directory (to_do_batches.mdx §2): ~/T/_large_files_bridge/_do_batches/ — the
// machine-local, disposable per-storage recommendation bundles the To Do page reads. Under the state
// root so it honors LFB_STATE_DIR; created on demand.
export function resolveTodoBatchesDir(): string {
  const dir = path.join(resolveStateDir(), "_do_batches");
  ensureDir(dir);
  return dir;
}

// The machine-local per-repo tracking directory (artifact_placement_policy.mdx §3):
// ~/T/_large_files_bridge/repos/<repoKey>/ — the PRE-THRESHOLD home for a repo's noisy tracking state
// (repo_storage.yaml, sidecars, history) so a repo that has never been transcribed/described NEVER gets a
// `.lfbridge/` written into its git working tree (no churn, no stray check-ins). `repoKey` is the stable
// 12-hex hash of the repo's absolute path (see tracking-root.service.ts `repoKeyFor`). Created on demand.
export function resolveRepoStateDir(repoKey: string): string {
  const dir = path.join(resolveStateDir(), "repos", repoKey);
  ensureDir(dir);
  return dir;
}

function safeJoin(...parts: string[]): string | null {
  try {
    return path.join(...parts);
  } catch {
    return null;
  }
}

export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort: never crash because a dir couldn't be made (storage.mdx §1)
  }
}
