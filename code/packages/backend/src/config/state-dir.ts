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

// The BATCH MANIFEST directory (to_fix.mdx §4.1): ~/T/_large_files_bridge/_batches/ — one durable,
// timestamped YAML per bulk run, written BEFORE anything is enqueued and carrying the full file list.
//
// WHY IT IS NOT the queue journal: `queue/` records TASKS, for replay by the machine. A manifest records
// INTENT, for a human — this scope, these 1,440 files, this provider, this moment. On 2026-07-15 a batch
// vanished into an OOM and nothing on disk knew what had been in it, which is why reconstructing it took
// hours. Distinct from `_do_batches` (the To Do page's disposable recommendation bundles) despite the
// similar name. Machine-local and never travels; under the state root so it honors LFB_STATE_DIR.
export function resolveBatchesDir(): string {
  const dir = path.join(resolveStateDir(), "_batches");
  ensureDir(dir);
  return dir;
}

// The BACKGROUND QUEUE journal directory (crash_recovery.mdx §3.1): ~/T/_large_files_bridge/queue/ — the
// machine-local, append-only backlog that lets a queued batch survive the process that hosts it. A backlog is
// a fact about THIS process on THIS machine: never git-tracked, never IPFS-pinned, never travels. It lives
// under the state root, not under `.lfbridge/`, because the artifact placement rules govern USER artifacts
// and a queue journal is not one. Created on demand.
export function resolveQueueDir(): string {
  const dir = path.join(resolveStateDir(), "queue");
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
