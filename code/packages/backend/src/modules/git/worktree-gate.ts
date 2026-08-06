// The WORKING-TREE GATE — "nobody writes into a git working copy while git is mid-cycle in it".
//
// The per-storage lock in git-lock.ts serializes the git CYCLES against each other, but it never covered the
// OTHER writer: `mirrorToSyncRepo()` (tracking-sync.service.ts) copies a repo's Category-B tracking subtree
// into `<syncRepo>/repos/<repoUid>/` from the SCAN path, synchronously, with no lock at all. When that copy
// landed while a cycle was between its fetch and its merge, git refused the whole merge —
//
//     error: Your local changes to the following files would be overwritten by merge:
//     	repos/83e62afc2c80/repo_storage.yaml
//     Aborting
//
// — and the storage stopped converging between the user's computers, which is the entire product promise.
//
// The gate is deliberately NOT a lock: the mirror is synchronous top to bottom (`writeRepoStorage` →
// `mirrorToSyncRepo`) and cannot await anything. Instead a writer asks "is this path inside a working tree
// that is mid-cycle right now?" and, if so, DEFERS its own work by key; the cycle runs every deferred job
// when it releases. Deferring by key coalesces — ten scans of one repo during one cycle mirror ONCE at the
// end, which is exactly as correct (the mirror is a reconciliation to current state, not a work item).
import { log } from "../../shared/logging.js";
import path from "node:path";

/**
 * A git cycle in flight over one working copy.
 *
 * THIS IS A MUTEX, NOT JUST A FLAG — and the difference is load-bearing. The gate began as a re-entrancy
 * COUNTER, which made outside writers defer but did nothing to stop a SECOND cycle running git in the same
 * directory at the same time. That is reachable in ordinary configuration: `withStorageGitLock` keys on the
 * STORAGE id, while two storages can resolve to ONE working copy (an explicit `backing.dedicated_repo`
 * pointing at a root another SDL auto-adopts, or two storages configured to the same path). The device pass
 * runs storages through `runPool(ids, cores − 2, …)`, so both cycles ran `add`/`commit`/`push` in one
 * directory concurrently — an index race. `warnOnDuplicateBackbones` names that arrangement but only warns
 * about the PUSH races; the local index race had nothing guarding it, and git-lock.ts's own header claimed
 * a guarantee ("at most one pass touches a given storage's repo at a time") it could not give.
 *
 * `owner` is what keeps it re-entrant WITHOUT deadlocking the one legitimate nesting: `commitAndPushInner`
 * calls `pull()` on its non-fast-forward retry, and both take this gate on the same `GitBackbone`. Same
 * owner ⇒ pass straight through; a different owner ⇒ wait for the holder to finish.
 */
interface BusyState {
  /** The logical cycle holding this working copy — a `GitBackbone` instance, in practice. */
  owner: unknown;
  /** Nesting depth for THIS owner; the root is released when it returns to zero. */
  depth: number;
  /** Resolves when the holder releases — what a waiting cycle awaits. */
  done: Promise<void>;
  release: () => void;
}
const busy = new Map<string, BusyState>();

interface DeferredJob {
  /** Absolute path the job wants to write — it waits while any busy root contains it. */
  target: string;
  key: string;
  run: () => void;
}
const deferred = new Map<string, DeferredJob>();

// WINDOWS PATHS ARE CASE-INSENSITIVE, and this gate is pure string comparison. `path.resolve` normalizes
// separators but never case, so `C:\Users\bryan\BGit\repo` (config) and `c:\users\bryan\bgit\repo` (an
// mtime-driven scan hit) resolve to two strings that are the SAME directory and do not match. The gate
// would then answer "nothing is mid-cycle over this path", the mirror would write into a tree between its
// fetch and its merge, and git would refuse the merge with "Your local changes … would be overwritten" —
// exactly the failure this whole module was written to prevent, reintroduced by the platform.
//
// Scoped to Windows on purpose. A default APFS/HFS+ volume is case-insensitive too, so the same hole is
// open on macOS — but changing comparison semantics on the primary platform is its own decision, not a
// side effect of a Windows fix.
const CASE_INSENSITIVE_FS = process.platform === "win32";

function norm(p: string): string {
  const abs = path.resolve(p);
  return CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs;
}

/** True when `abs` sits inside `root` (or IS `root`). Path-segment aware, so `/a/bc` is not inside `/a/b`.
 *  Both sides come from `norm`, so the case folding above is already applied. */
function contains(root: string, abs: string): boolean {
  if (abs === root) return true;
  return abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** The busy working-copy root that currently owns `abs`, or null when nothing is mid-cycle over it. */
export function busyRootFor(abs: string): string | null {
  const target = norm(abs);
  for (const root of busy.keys()) if (contains(root, target)) return root;
  return null;
}

/**
 * Run `fn` with EXCLUSIVE use of `dir`. Every git step that MUTATES a working copy (fetch+merge,
 * add/commit/push) must run inside this, so (a) an outside writer defers instead of dirtying the tree under
 * git's feet, and (b) a second cycle over the same working copy WAITS rather than racing it in the index.
 *
 * `owner` marks the logical cycle. Re-entering with the same owner passes through (depth++); a different
 * owner queues behind the holder. Callers that pass nothing get a fresh identity, i.e. full exclusion.
 *
 * Holds are bounded on purpose: the unbounded IPFS work of a pin pass happens BETWEEN the pull and the
 * commit, outside this span, so waiting here is always waiting on git alone. Deferred outside writes drain
 * once the outermost span ends.
 */
export async function withWorktreeBusy<T>(dir: string, fn: () => Promise<T>, owner: unknown = {}): Promise<T> {
  const root = norm(dir);
  for (;;) {
    const held = busy.get(root);
    if (!held) break;
    if (held.owner === owner) {
      // The legitimate nesting (commitAndPush → pull on a non-fast-forward retry). Re-enter; the OUTERMOST
      // span owns the release and the drain.
      held.depth++;
      try {
        return await fn();
      } finally {
        held.depth--;
      }
    }
    // Another cycle owns this working copy. Wait for it — never run git beside it.
    await held.done;
  }
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const state: BusyState = { owner, depth: 1, done, release };
  busy.set(root, state);
  try {
    return await fn();
  } finally {
    state.depth--;
    if (state.depth <= 0 && busy.get(root) === state) busy.delete(root);
    // Wake every waiter BEFORE draining, so a queued cycle is not stuck behind an outside writer's work.
    release();
    drain();
  }
}

/**
 * Ask to write into `targetPath` right now. Returns true when the write was DEFERRED (a git cycle owns that
 * tree) — the caller must not write; `run` fires as soon as the cycle releases. Returns false when the
 * caller may proceed immediately. `key` coalesces repeated requests: a second request with the same key
 * while one is pending REPLACES it rather than queueing another pass.
 */
export function deferWhileBusy(targetPath: string, key: string, run: () => void): boolean {
  const root = busyRootFor(targetPath);
  if (!root) return false;
  deferred.set(key, { target: norm(targetPath), key, run });
  return true;
}

/** Fire every deferred job whose target is no longer inside a busy working copy. Never throws. */
function drain(): void {
  if (deferred.size === 0) return;
  for (const job of [...deferred.values()]) {
    if (busyRootFor(job.target)) continue; // still owned by another in-flight cycle
    deferred.delete(job.key);
    try {
      job.run();
    } catch (e) {
      log.warn("git", `deferred working-tree write ${job.key} failed: ${(e as Error).message}`);
    }
  }
}

/** TEST-ONLY: how many writes are waiting on a busy working copy. */
export function deferredCount(): number {
  return deferred.size;
}
