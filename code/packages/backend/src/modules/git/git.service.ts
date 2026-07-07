// The Git backbone engine (git_sync.mdx). When a storage's dedicated-Git-repo backing location is ON,
// LFB is granted permission to run REAL git — fetch, merge (automatic), add/commit, push — against THAT
// ONE repo every sync pass, so the SDL's small YAML travels between the user's computers while IPFS
// carries the bytes. All git work flows through `simple-git`, a thin wrapper over the SYSTEM git binary,
// so the MERGE is done by real git (the ort strategy) — the reason simple-git was chosen over
// isomorphic-git (partial merge) and nodegit (fragile native libgit2). See git_sync.mdx §2.
//
// Two remote shapes (git_sync.mdx §3): a LOCAL FILE PATH to a checkout already on this box (used in
// place), or an HTTP(S)/SSH URL with no local checkout (cloned into a machine-local cache under the
// state root, `sync/s/<id>/git/`, and managed there). Both converge on one working directory.
//
// The engine never force-pushes and never touches a repo the user did not configure as a backbone
// (git_sync.mdx §7). An unresolvable merge or an auth failure is SURFACED (returned as a problem), never
// clobbered — the caller keeps syncing over IPFS regardless. Node fs + simple-git only (charter).
import fs from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { storageUnitDir } from "../../shared/store/scopes.js";
import { expandHome } from "../fs/badges.js";
import { log } from "../../shared/logging.js";

/** The shared, append-mostly SDL lists that must union-merge instead of conflicting (git_sync.mdx §4.2). */
const UNION_MERGE_PATHS = ["LargeFilesBridge_SyncList.yaml", ".lfbridge/manifest.yaml"];

export type RemoteKind = "local" | "url";

/** The outcome of one Git cycle — enough for the caller to surface a problem or report what happened. */
export interface GitCycleResult {
  ran: boolean; // false = no backbone resolved (e.g. a local path that isn't a checkout yet)
  fetched?: boolean;
  merged?: boolean;
  committed?: boolean;
  pushed?: boolean;
  /** A human-readable problem to surface on the storage (merge conflict / auth / remote error). */
  problem?: string;
  /** Conflicted paths when git could not auto-merge (git_sync.mdx §4.3). */
  conflicts?: string[];
}

/** Classify a configured remote: a URL (http/https/ssh/git@) vs. a local filesystem path (git_sync.mdx §3). */
export function classifyRemote(remote: string): RemoteKind {
  const r = remote.trim();
  if (/^(https?|ssh|git):\/\//i.test(r) || /^[\w.-]+@[\w.-]+:/.test(r)) return "url";
  return "local";
}

/**
 * A `simple-git` handle on a working directory, configured NON-INTERACTIVE so a URL remote authenticates
 * through the OS git credential helper and NEVER hangs on a password prompt (git_sync.mdx §5).
 */
export function openRepo(workingDir: string): SimpleGit {
  // Inherit the environment, but STRIP any editor vars the user's shell exported (EDITOR / VISUAL /
  // GIT_EDITOR / GIT_SEQUENCE_EDITOR): simple-git refuses to run with an editor set (a hang guard), and
  // our commits always carry a `-m` message so no editor is ever needed. GIT_TERMINAL_PROMPT=0 keeps a
  // URL remote from blocking on a password prompt (§5).
  const env = { ...process.env };
  for (const k of ["EDITOR", "VISUAL", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR"]) delete env[k];
  return simpleGit({
    baseDir: workingDir,
    binary: "git",
    maxConcurrentProcesses: 1,
    config: ["credential.interactive=false"],
  }).env({ ...env, GIT_TERMINAL_PROMPT: "0" });
}

/**
 * Resolve a storage's configured remote to a working directory (git_sync.mdx §3):
 *   • LOCAL PATH  — used in place if it is a real checkout (has `.git/`); else null (nothing to drive yet —
 *                   `ensureBackingLocations` git-inits a brand-new dedicated repo elsewhere).
 *   • URL         — cloned on first use into the machine-local cache `sync/s/<id>/git/`, opened thereafter.
 * Returns null (and logs) if a URL clone fails, so the caller falls back to IPFS-only for this pass.
 */
export async function resolveWorkingCopy(storageId: string, remote: string): Promise<string | null> {
  const kind = classifyRemote(remote);
  if (kind === "local") {
    const dir = expandHome(remote);
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    log.info("git", `storage ${storageId}: local remote ${dir} is not a checkout yet — skipping git cycle`);
    return null;
  }
  // URL: a machine-local cache clone LFB manages (git_sync.mdx §3.2).
  const cache = path.join(storageUnitDir(storageId), "git");
  if (fs.existsSync(path.join(cache, ".git"))) return cache;
  try {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    await openRepo(path.dirname(cache)).clone(remote, cache);
    log.info("git", `storage ${storageId}: cloned URL remote into ${cache}`);
    return cache;
  } catch (e) {
    log.warn("git", `storage ${storageId}: clone of ${remote} failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * The Git backbone for one storage's working copy. Constructed only from a storage whose dedicated-repo
 * backing is ON (git_sync.mdx §1/§7) — there is no entry point that runs git against an arbitrary path.
 * Use `GitBackbone.resolve(...)` to build one from a configured remote.
 */
export class GitBackbone {
  private git: SimpleGit;
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
    this.git = openRepo(dir);
  }

  /** Build a backbone from a storage's configured remote, or null if no working copy resolves (git_sync.mdx §3). */
  static async resolve(storageId: string, remote: string): Promise<GitBackbone | null> {
    const dir = await resolveWorkingCopy(storageId, remote);
    return dir ? new GitBackbone(dir) : null;
  }

  /** The current branch name (defaults to `main` if detached/unknown). */
  private async branch(): Promise<string> {
    try {
      const b = (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
      return b && b !== "HEAD" ? b : "main";
    } catch {
      return "main";
    }
  }

  /** True when this repo has an `origin` remote to fetch/push against. */
  private async hasOrigin(): Promise<boolean> {
    try {
      return (await this.git.getRemotes()).some((r) => r.name === "origin");
    } catch {
      return false;
    }
  }

  /** Ensure the union-merge `.gitattributes` so shared append-mostly lists never conflict (git_sync.mdx §4.2). */
  ensureMergeAttributes(): void {
    const file = path.join(this.dir, ".gitattributes");
    const want = UNION_MERGE_PATHS.map((p) => `${p} merge=union`);
    let existing = "";
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      /* none yet */
    }
    const lines = existing.split("\n");
    const missing = want.filter((w) => !lines.some((l) => l.trim() === w));
    if (missing.length === 0) return;
    const next = (existing.trimEnd() + "\n" + missing.join("\n") + "\n").replace(/^\n/, "");
    fs.writeFileSync(file, next);
  }

  /**
   * Fetch + automatic merge (git_sync.mdx §4). Merges `origin/<branch>` into the working copy with git's
   * ort strategy (`--no-edit`). On a genuine conflict git cannot resolve, ABORTS the merge (leaving the
   * tree clean) and returns the conflicted paths to surface — never a clobber (git_sync.mdx §4.3).
   */
  async pull(result: GitCycleResult): Promise<void> {
    if (!(await this.hasOrigin())) return;
    const branch = await this.branch();
    try {
      await this.git.fetch("origin", branch);
      result.fetched = true;
    } catch (e) {
      result.problem = classifyRemoteError(e as Error);
      return;
    }
    try {
      const before = await this.git.revparse(["HEAD"]).catch(() => "");
      await this.git.merge(["--no-edit", `origin/${branch}`]);
      const after = await this.git.revparse(["HEAD"]).catch(() => "");
      result.merged = before !== after;
    } catch (e) {
      // A merge conflict simple-git could not auto-resolve — abort and surface (never clobber).
      const conflicts = await this.conflictedPaths();
      await this.git.merge(["--abort"]).catch(() => {});
      result.conflicts = conflicts;
      result.problem = `Git merge conflict on ${conflicts.length || "several"} file(s) — resolve with your Git tools. (${(e as Error).message})`;
    }
  }

  private async conflictedPaths(): Promise<string[]> {
    try {
      const s = await this.git.status();
      return s.conflicted;
    } catch {
      return [];
    }
  }

  /**
   * Stage this device's SDL changes, commit, and push (git_sync.mdx §6 steps 5–6). Big-file bytes are
   * git-ignored, so staging the working tree only ever queues the small SDL text. On a non-fast-forward
   * reject (another computer pushed between our fetch and our push), re-pull (fetch+merge) and re-push
   * ONCE — never a force-push.
   */
  async commitAndPush(result: GitCycleResult): Promise<void> {
    if (result.conflicts?.length) return; // don't commit on top of an unresolved conflict
    this.ensureMergeAttributes();
    try {
      await this.git.add(["-A"]); // .gitignore keeps the big bytes out; only SDL text is staged
      const staged = await this.git.status();
      if (staged.staged.length === 0 && staged.created.length === 0 && staged.renamed.length === 0 && staged.deleted.length === 0) {
        return; // nothing changed here — no empty commit
      }
      await this.git.commit("LFB: sync device state"); // -m message → no editor invoked
      result.committed = true;
    } catch (e) {
      result.problem = result.problem ?? `Git commit failed: ${(e as Error).message}`;
      return;
    }
    if (!(await this.hasOrigin())) return;
    const branch = await this.branch();
    try {
      await this.git.push("origin", branch);
      result.pushed = true;
    } catch (e) {
      // Likely a non-fast-forward reject: pull (fetch+merge) then push once more (git_sync.mdx §6).
      const retry: GitCycleResult = { ran: true };
      await this.pull(retry);
      if (retry.conflicts?.length) {
        result.conflicts = retry.conflicts;
        result.problem = retry.problem;
        return;
      }
      try {
        await this.git.push("origin", branch);
        result.pushed = true;
      } catch (e2) {
        result.problem = classifyRemoteError(e2 as Error);
      }
    }
  }
}

/** Turn a fetch/push error into a user-facing problem, flagging auth failures for re-authentication (git_sync.mdx §5). */
function classifyRemoteError(e: Error): string {
  const m = e.message || String(e);
  if (/auth|denied|credential|403|401|could not read Username|terminal prompts disabled/i.test(m)) {
    return `Git authentication failed for this remote — re-authenticate it (LFB keeps syncing over IPFS meanwhile). (${m.split("\n")[0]})`;
  }
  return `Git remote error — LFB keeps syncing over IPFS. (${m.split("\n")[0]})`;
}
