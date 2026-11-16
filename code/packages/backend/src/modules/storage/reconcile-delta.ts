// INCREMENTAL RECONCILE — "which paths of the mirrored subtree could have changed since the last pass?"
// (performance.mdx P-64, 2026-11-16).
//
// THE INCIDENT. `reconcileFromSyncRepo` folds a repo's mirror subtree (`<syncRepo>/repos/<slug>-<uid>/`) back
// into Local Storage. Its last leg, `copyTreeGen`, WALKED THE WHOLE SUBTREE on every call: a readdir per
// directory, a case-index readdir per destination directory, an existsSync and two bigint stats per file. For
// ~/BGit/all that subtree is 32,753 files in 12,564 directories, and the reconcile runs on every backbone pull
// (all ~105 repos), on every pin pass, and on every device pass. loop-watch measured one call on ~/BGit/all at
// 857,237 ms of on-thread time (2026-11-16, a loaded tower), and 224 reconcile calls in a single minute. The
// memos (P-45) had made each look cheap; nothing made the walk itself proportional to what changed.
//
// THE FIX. The mirror subtree lives inside the sync repo's git working copy, and git already knows exactly
// what changed in it:
//   * `git rev-parse HEAD:./` in the subtree is the TREE id of the committed subtree — one O(1) lookup. If it
//     equals the tree we last reconciled, nothing a peer pushed has changed under it.
//   * `git diff-tree -r --name-only <lastTree> <tree>` lists exactly the files that changed between the two.
//   Both read only the object database: neither stats the working tree nor touches index.lock, so they cost
//   milliseconds however big the subtree is, and never collide with (or wait on) a git cycle running in the same
//   sync repo. (`git status` was tried first and rejected: it lstat()s every file under the pathspec — measured
//   1 min 54 s on this subtree on the loaded tower, i.e. the very walk we are removing, done by git instead.)
//
// WHY UNCOMMITTED EDITS NEED NO SCAN. Everything a PEER sends arrives by a git merge, i.e. as a change of the
// committed tree, so it is in the diff. The other writers of the working tree are this computer's own: the
// mirror leg (Local Storage → mirror: either the same bytes, or a union with mirror content that itself came in
// a tree change and is therefore in some diff) and the duplicate-spelling fold (which lands in the tree, and so
// in the diff, the moment the backbone commits it). The periodic full walk below is the backstop for anything
// that reasoning misses.
// Only those paths are re-examined, through the SAME per-file merge (`copyTrackedFile`) the full walk uses, so
// what ends up in Local Storage is identical; only the paths we look at shrink.
//
// SAFETY NETS (correctness beats speed here — a missed file never reaches the user's other computer):
//   * anything we cannot answer (subtree not in a git repo, git failing, the old tree object missing) ⇒ a FULL
//     walk, exactly the old behaviour;
//   * no memo for this (src, dst) pair yet (first pass after install, a new repo) ⇒ a FULL walk;
//   * a full walk at least every LFB_RECONCILE_FULL_WALK_MS (default 24 h) regardless;
//   * a pass in which any leaf copy failed does NOT advance the memo, so the same diff is retried next time.
//
// The memo is persisted (`reconcile-delta.json` in the state dir) because `tsx watch` restarts the backend on
// every code edit, and a restart that forgets it would re-walk every repo — the storm this file exists to end.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import { stableGitBin } from "../git/git-bin.js";
import { blocking } from "../../shared/blocking.js";
import { log } from "../../shared/logging.js";

export type ReconcilePlan =
  /** Walk everything (the pre-P-64 behaviour). `reason` is for the log. */
  | { kind: "full"; reason: string }
  /** Nothing in the subtree moved since the last completed pass. */
  | { kind: "none" }
  /** Re-examine exactly these paths (POSIX, relative to the subtree root). */
  | { kind: "paths"; paths: string[] };

export interface ReconcileDelta {
  plan: ReconcilePlan;
  /** Record the pass as complete. Call ONLY when every leaf landed — a skipped commit means "retry this diff". */
  commit: () => void;
}

interface MemoEntry {
  /** Tree id of the committed subtree at the last completed pass. */
  tree: string;
  /** When the last FULL walk completed (ms epoch). */
  fullAt: number;
}

const MEMO_SCHEMA = 1;
const memo = new Map<string, MemoEntry>();
let memoLoaded = false;
let saveTimer: NodeJS.Timeout | null = null;

function fullWalkEveryMs(): number {
  const v = Number(process.env.LFB_RECONCILE_FULL_WALK_MS);
  return Number.isFinite(v) && v > 0 ? v : 24 * 60 * 60 * 1000;
}

function deltaDisabled(): boolean {
  return process.env.LFB_RECONCILE_DELTA === "0";
}

const memoFile = (): string => path.join(resolveStateDir(), "reconcile-delta.json");
const keyFor = (src: string, dst: string): string => `${path.resolve(src)}\n${path.resolve(dst)}`;

function loadMemo(): void {
  if (memoLoaded) return;
  memoLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(memoFile(), "utf8")) as { schema?: number; entries?: Record<string, MemoEntry> };
    if (raw.schema !== MEMO_SCHEMA || !raw.entries) return;
    for (const [k, v] of Object.entries(raw.entries)) {
      if (v && typeof v.tree === "string" && typeof v.fullAt === "number") memo.set(k, v);
    }
  } catch {
    /* absent or corrupt — an empty memo only means the next pass per repo is a full walk, which is always correct */
  }
}

function saveMemoSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const file = memoFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema: MEMO_SCHEMA, entries: Object.fromEntries(memo) }));
      fs.renameSync(tmp, file);
    } catch (e) {
      log.warn("storage", `reconcile delta memo save failed: ${(e as Error).message}`);
    }
  }, 2000);
  saveTimer.unref?.();
}

/** TEST-ONLY: forget every remembered tree (in memory and on disk). */
export function resetReconcileDeltaMemo(): void {
  memo.clear();
  memoLoaded = false;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.rmSync(memoFile(), { force: true });
  } catch {
    /* nothing to forget */
  }
}

/** One git call in `cwd`. Null on any failure (not a repo, missing object, git absent). */
function git(cwd: string, args: string[]): string | null {
  try {
    return blocking(
      `git.${args.find((a) => !a.startsWith("-")) ?? "git"} (sync)`,
      () =>
        execFileSync(stableGitBin(), args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 256 * 1024 * 1024,
          timeout: 60_000,
          // Never prompt, never wait on a lock this read does not need.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        }),
      cwd,
    );
  } catch {
    return null;
  }
}

/** `-z` lists → entries (empty strings dropped). */
const splitZ = (s: string): string[] => s.split("\0").filter((x) => x.length > 0);

/**
 * Work out what this reconcile pass must look at. Never throws: every failure degrades to a full walk.
 *
 * `src` = the per-repo mirror subtree inside the sync repo; `dst` = this repo's Local Storage state dir.
 */
export function planReconcileDelta(src: string, dst: string, now: number = Date.now()): ReconcileDelta {
  const noop = (): void => {};
  if (deltaDisabled()) return { plan: { kind: "full", reason: "LFB_RECONCILE_DELTA=0" }, commit: noop };
  loadMemo();
  const key = keyFor(src, dst);

  // One spawn, object database only: the committed tree id of the subtree we are standing in.
  const head = git(src, ["rev-parse", "--verify", "-q", "HEAD:./"]);
  const tree = (head ?? "").trim();
  if (!head || !/^[0-9a-f]{40,64}$/.test(tree)) {
    return { plan: { kind: "full", reason: "mirror subtree is not a committed git tree" }, commit: noop };
  }

  const commitFull = (): void => {
    memo.set(key, { tree, fullAt: now });
    saveMemoSoon();
  };
  const prev = memo.get(key);
  // Local Storage for this repo was removed (or never existed): only a full walk can rebuild it.
  if (prev && !fs.existsSync(dst)) return { plan: { kind: "full", reason: "local state dir missing" }, commit: commitFull };
  if (!prev) return { plan: { kind: "full", reason: "first pass for this repo" }, commit: commitFull };
  if (now - prev.fullAt >= fullWalkEveryMs()) {
    return { plan: { kind: "full", reason: "periodic full walk" }, commit: commitFull };
  }

  const commitIncremental = (): void => {
    memo.set(key, { tree, fullAt: prev.fullAt });
    saveMemoSoon();
  };
  if (prev.tree === tree) return { plan: { kind: "none" }, commit: commitIncremental };

  // Comparing the two SUBTREE objects directly, so the names come back relative to the subtree root.
  const diff = git(src, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", prev.tree, tree]);
  if (diff === null) return { plan: { kind: "full", reason: "previous tree no longer readable" }, commit: commitFull };
  const changed = new Set<string>(splitZ(diff));
  return { plan: { kind: "paths", paths: [...changed].sort() }, commit: commitIncremental };
}
