// The Git backbone engine (git_backbone.mdx). When a storage's dedicated-Git-repo backing location is ON,
// LFB is granted permission to run REAL git — fetch, merge (automatic), add/commit, push — against THAT
// ONE repo every backbone cycle, so the SDL's small YAML travels between the user's computers while IPFS
// carries the bytes. All git work flows through `simple-git`, a thin wrapper over the SYSTEM git binary,
// so the MERGE is done by real git (the ort strategy) — the reason simple-git was chosen over
// isomorphic-git (partial merge) and nodegit (fragile native libgit2). See git_backbone.mdx §2.
//
// Two remote shapes (git_backbone.mdx §3): a LOCAL FILE PATH to a checkout already on this box (used in
// place), or an HTTP(S)/SSH URL with no local checkout (cloned into a machine-local cache under the
// state root, `pin/s/<id>/git/`, and managed there). Both converge on one working directory.
//
// The engine never force-pushes and never touches a repo the user did not configure as a backbone
// (git_backbone.mdx §7). An unresolvable merge or an auth failure is SURFACED (returned as a problem), never
// clobbered — the caller keeps pinning over IPFS regardless. Node fs + simple-git only (charter).
import type { RepoOwner, PersonalAccount } from "@lfb/shared";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { simpleGit, type SimpleGit } from "simple-git";
import { storageUnitDir } from "../../shared/store/scopes.js";
import { expandHome } from "../fs/badges.js";
import { isGitWorkingTree } from "../store-model/units.service.js";
import { LFBRIDGE_DIR } from "../storage/storage-type.service.js";
import { log } from "../../shared/logging.js";

/** The shared, append-mostly SDL lists that must union-merge instead of conflicting (git_backbone.mdx §4.2).
 *  Both SHAPES are listed: the SDL root (current — an SDL has no `.lfbridge/`, artifact_placement_policy.mdx
 *  §0) and the legacy `.lfbridge/` (an SDL not yet migrated by migrate-sdl-lfbridge.ts). A pattern for a
 *  layout that isn't present is inert, so carrying both is free and keeps a mid-migration repo protected. */
const UNION_MERGE_PATHS = [
  "LargeFilesBridge_SyncList.yaml",
  "manifest.yaml",
  "decisions.yaml", // the shared per-file decision ledger (decisions.mdx §4/§5) — union-merged
  ".lfbridge/manifest.yaml", // legacy pre-migration shape
  ".lfbridge/decisions.yaml", // legacy pre-migration shape
  "owner_map.yaml", // company ownership assertions at the sync-repo root (repo_owner_propagation.mdx §2) — union-merged
];

/** The SDL's travelling payload at its ROOT (artifact_placement_policy.mdx §0.1). Ignoring any of these is
 *  the post-migration shape of the git_backbone.mdx §4.2.1 defect — it would stop the device registry (and
 *  the rest of the SDL text) from ever reaching the user's other computers. */
const SDL_ROOT_PAYLOAD: ReadonlySet<string> = new Set([
  "storage.yaml",
  "mapped_dirs.yaml",
  "files.yaml",
  "manifest.yaml",
  "bookmarks.yaml",
  "decisions.yaml",
  "devices",
  "analysis",
]);

/** True for any `repo_storage.yaml` path a Git-backed working tree might carry — the top-level legacy shape
 *  (`.lfbridge/repo_storage.yaml`, pre-redesign) and the current sync-repo mirror
 *  (`repos/<repoKey>/repo_storage.yaml`, repo_tracking_scheme.mdx §1.1) alike. Both are machine-generated
 *  Category-B tracking state whose authoritative copy is always Local Storage, so a merge conflict on either
 *  shape is safe to auto-resolve by dropping the file (see `autoResolveRepoStorageConflicts`). */
function isRepoStorageYamlPath(p: string): boolean {
  return /(^|\/)repo_storage\.yaml$/.test(p);
}

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
  /** Conflicted paths when git could not auto-merge (git_backbone.mdx §4.3). */
  conflicts?: string[];
}

/** Classify a configured remote: a URL (http/https/ssh/git@) vs. a local filesystem path (git_backbone.mdx §3). */
export function classifyRemote(remote: string): RemoteKind {
  const r = remote.trim();
  if (/^(https?|ssh|git):\/\//i.test(r) || /^[\w.-]+@[\w.-]+:/.test(r)) return "url";
  return "local";
}

/**
 * Classify a remote's likely VISIBILITY for the decision-ledger privacy default (decisions.mdx §14):
 *   • "none"    — no remote at all (null/empty) → a purely local repo.
 *   • "public"  — hosted on a well-known PUBLIC forge (github.com / gitlab.com / bitbucket.org /
 *                 codeberg.org / sr.ht). BEST-EFFORT and deliberately CONSERVATIVE: we cannot tell a
 *                 private-vs-public *repo* on those hosts without a network call, and the charter forbids
 *                 networking here — so we err toward "public" for these hosts. That makes the caller
 *                 default attribution to `handle` (opaque) and WARN before committing raw emails, the
 *                 safe direction for a possibly-public history.
 *   • "private" — anything else (self-hosted host, SSH to a private server, an on-disk path).
 *
 * NB: distinct from {@link classifyRemote}, which answers a different question (URL vs. local-path SHAPE,
 * for how to resolve a working copy). This one answers "would committing an email here likely leak it?"
 */
export function classifyRemoteVisibility(remoteUrl: string | null): "public" | "private" | "none" {
  const r = (remoteUrl ?? "").trim();
  if (!r) return "none";
  // Match the known public forge hosts across URL and scp-like SSH shapes (`git@github.com:…`).
  if (/\b(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|git\.sr\.ht)\b/i.test(r)) return "public";
  return "private";
}

// The public forge hosts we recognize for owner/organization parsing (repo_company_mapping.mdx §2). Same set
// classifyRemoteVisibility trusts. On these, a repo URL carries `<host>/<owner>/<repo>`, and `<owner>` is the
// GitHub org / GitLab group / user account.
const KNOWN_FORGES = /(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|git\.sr\.ht)/i;

/** The parsed pieces of a remote origin URL (repo_company_mapping.mdx §2), or null when it isn't a
 *  host/owner/repo URL (a bare local path, or an unparseable shape). NO NETWORKING — pure string parsing per
 *  the charter. Handles the scp-like (`git@host:owner/repo.git`), https, ssh://, and git:// shapes. */
export function parseRemoteOwner(
  remoteUrl: string | null,
): { host: string; owner: string; repo: string; knownForge: boolean } | null {
  const r = (remoteUrl ?? "").trim();
  if (!r) return null;
  // scp-like: git@github.com:Owner/Repo.git
  let m = /^[\w.-]+@([\w.-]+):([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(r);
  // url forms: https://github.com/Owner/Repo.git · ssh://git@github.com/Owner/Repo · git://…
  if (!m) m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(r);
  if (!m) return null;
  const [, host, owner, repo] = m;
  if (!host || !owner || !repo) return null;
  return { host, owner, repo, knownForge: KNOWN_FORGES.test(host) };
}

/**
 * Derive a repo's owner from its git remote (repo_company_mapping.mdx §3), conservatively toward Personal.
 * A known-forge remote whose owner is NOT one of the user's personal accounts → a COMPANY named after the
 * owner slug (the user can rename it later). No remote, an unparseable/self-hosted remote, or an owner that
 * IS a personal account → Personal (the default catch-all owner). LIMITATION (§3.1): a plain
 * `github.com/<owner>/<repo>` can't be told org-vs-user from the URL alone and we never call a forge API, so
 * this errs toward Personal and lets the user promote to a company.
 */
/** Is `owner` on `host` one of the user's own forge accounts (repo_company_mapping.mdx §4)? Case-insensitive
 *  owner match; an entry with no `host` matches any host, one with a `host` matches only that host. */
export function isPersonalAccount(accounts: PersonalAccount[], host: string, owner: string): boolean {
  const o = owner.toLowerCase();
  const h = host.toLowerCase();
  return accounts.some((a) => a.owner.toLowerCase() === o && (!a.host || a.host.toLowerCase() === h));
}

export function deriveOwnerForRemote(
  remote: string | null,
  personalAccounts: PersonalAccount[] = [],
): RepoOwner {
  const parsed = parseRemoteOwner(remote);
  const isCompany =
    !!parsed && parsed.knownForge && !isPersonalAccount(personalAccounts, parsed.host, parsed.owner);
  if (isCompany && parsed) {
    return {
      kind: "company",
      companyId: null,
      displayName: parsed.owner,
      source: "auto",
      host: parsed.host,
      ownerSlug: parsed.owner,
    };
  }
  return {
    kind: "personal",
    companyId: null,
    displayName: "Personal",
    source: "auto",
    host: parsed?.host ?? null,
    ownerSlug: null,
  };
}

/**
 * The NORMALIZED remote key `host/owner/repo` (repo_owner_propagation.mdx §2) — the identity that lets one
 * member's clone of a repo be matched to another member's clone (a repoKey is a per-machine path hash and can
 * never travel). SSH and HTTPS forms of the same remote collapse to one key because both parse to the same
 * host/owner/repo (repo_company_mapping.mdx §2). Returns null when the remote has no host/owner/repo (a bare
 * local path or an unparseable/absent remote — such a repo can't be company-asserted). Case is PRESERVED for
 * display; callers compare case-insensitively (see {@link sameRemoteKey}).
 */
export function normalizeRemoteKey(remote: string | null): string | null {
  const p = parseRemoteOwner(remote);
  if (!p) return null;
  return `${p.host}/${p.owner}/${p.repo}`;
}

/** Case-insensitive equality of two normalized remote keys (SSH/HTTPS already collapsed by normalizeRemoteKey). */
export function sameRemoteKey(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * The EFFECTIVE owner of a repo (repo_company_mapping.mdx §5.2): the local `owner_override` when present
 * (source:"manual" — the user reassigned it, sticky across rescans), else the heuristic derivation from the
 * git remote (source:"auto", {@link deriveOwnerForRemote}). Absent override = auto. For a company override the
 * `displayName` here is a best-effort fallback (the parsed owner slug, else the company id); a higher layer
 * enriches it with the company storage's friendly name (units.service `ownerForRepoConfig`, storage_company.mdx
 * §6). Structural `cfg` so this stays a low-level, storage-service-free resolver.
 */
export function resolveRepoOwner(
  cfg: {
    repo?: { remote?: string | null } | null;
    owner_override?: { kind: "personal" | "company"; company_id: string | null } | null;
  },
  personalAccounts: PersonalAccount[] = [],
): RepoOwner {
  const remote = cfg.repo?.remote ?? null;
  const override = cfg.owner_override ?? null;
  if (!override) return deriveOwnerForRemote(remote, personalAccounts);
  const parsed = parseRemoteOwner(remote);
  if (override.kind === "company") {
    return {
      kind: "company",
      companyId: override.company_id,
      displayName: parsed?.owner ?? override.company_id ?? "Company",
      source: "manual",
      host: parsed?.host ?? null,
      ownerSlug: parsed?.owner ?? null,
    };
  }
  return {
    kind: "personal",
    companyId: null,
    displayName: "Personal",
    source: "manual",
    host: parsed?.host ?? null,
    ownerSlug: parsed?.owner ?? null,
  };
}

/**
 * A `simple-git` handle on a working directory, configured NON-INTERACTIVE so a URL remote authenticates
 * through the OS git credential helper and NEVER hangs on a password prompt (git_backbone.mdx §5).
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
 * Resolve a storage's configured remote to a working directory (git_backbone.mdx §3):
 *   • LOCAL PATH  — used in place if it is a real checkout (has `.git/`); else null (nothing to drive yet —
 *                   `ensureBackingLocations` git-inits a brand-new dedicated repo elsewhere).
 *   • URL         — cloned on first use into the machine-local cache `pin/s/<id>/git/`, opened thereafter.
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
  // URL: a machine-local cache clone LFB manages (git_backbone.mdx §3.2).
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
 * backing is ON (git_backbone.mdx §1/§7) — there is no entry point that runs git against an arbitrary path.
 * Use `GitBackbone.resolve(...)` to build one from a configured remote.
 */
export class GitBackbone {
  private git: SimpleGit;
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
    this.git = openRepo(dir);
  }

  /** Build a backbone from a storage's configured remote, or null if no working copy resolves (git_backbone.mdx §3). */
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

  /**
   * The Git backbone is only ever ON for an SDL repo whose tracking text — the device registry, the manifest,
   * the mapped-dir list — is the PAYLOAD that must travel between the user's computers (storage_personal.mdx
   * §1). Ignoring that text silently blocks EVERY device file from being committed or pushed, so two
   * computers never see each other. That defect is recorded in git_backbone.mdx §4.2.1; this strips any rule
   * that would cause it. Idempotent; every other `.gitignore` rule (the big-file byte ignores) is left
   * untouched — the bytes never live in the tracking text anyway.
   *
   * The HAZARD MOVED, it did not go away (artifact_placement_policy.mdx §0). An SDL now has NO `.lfbridge/`:
   * its payload sits at the ROOT (`storage.yaml`, `mapped_dirs.yaml`, `files.yaml`, `manifest.yaml`,
   * `bookmarks.yaml`, `devices/`, `analysis/`). So we strip BOTH:
   *   • a bare `.lfbridge/` line — still needed: harmless post-migration, but essential for an SDL that has
   *     not been migrated yet, whose payload is still under `.lfbridge/`; and
   *   • a bare ignore of any SDL root payload name — the NEW shape of the same mistake.
   */
  ensureSdlCommittable(): void {
    const gi = path.join(this.dir, ".gitignore");
    let body: string;
    try {
      body = fs.readFileSync(gi, "utf8");
    } catch {
      return; // no .gitignore → nothing is ignoring the SDL
    }
    const lines = body.split("\n");
    const kept = lines.filter((l) => !this.ignoresSdlPayload(l));
    if (kept.length === lines.length) return; // no offending rule present
    fs.writeFileSync(gi, kept.join("\n"), "utf8");
    log.info("git", `${this.dir}: removed SDL-payload ignore rule(s) from .gitignore so the tracking text can be committed`);
  }

  /** True when a `.gitignore` line would swallow the SDL's travelling payload — the legacy `.lfbridge/`
   *  directory or one of the root names it moved to. Anchored (`/x`) and bare (`x`) forms both count. */
  private ignoresSdlPayload(line: string): boolean {
    const t = line.trim().replace(/^\//, "").replace(/\/$/, "");
    if (!t || t.startsWith("#") || t.startsWith("!")) return false; // blank / comment / negation
    return t === LFBRIDGE_DIR || SDL_ROOT_PAYLOAD.has(t);
  }

  /** Ensure the union-merge `.gitattributes` so shared append-mostly lists never conflict (git_backbone.mdx §4.2). */
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
   * Fetch + automatic merge (git_backbone.mdx §4). Merges `origin/<branch>` into the working copy with git's
   * ort strategy (`--no-edit`). On a genuine conflict git cannot resolve, ABORTS the merge (leaving the
   * tree clean) and returns the conflicted paths to surface — never a clobber (git_backbone.mdx §4.3).
   */
  async pull(result: GitCycleResult): Promise<void> {
    if (!(await this.hasOrigin())) return;
    // Write the union-merge `.gitattributes` BEFORE the merge (not only in commitAndPush, which runs
    // after): git reads `.gitattributes` from the working tree at merge time, so the shared SDL lists
    // (SyncList, manifest, decisions ledger) only fold conflict-free once this file is present. On a fresh
    // backbone the first merge would otherwise happen before any `.gitattributes` existed (git_backbone.mdx §4.2).
    this.ensureMergeAttributes();
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
      // A merge conflict simple-git could not auto-resolve. When EVERY conflicted path is a `repo_storage.yaml`
      // — machine-generated Category-B tracking state that must never live in a git working tree in the first
      // place (repo_tracking_scheme.mdx §1/§2: Local Storage is always the authoritative copy, which is exactly
      // why it "can never merge-conflict" once it's out of git) — auto-resolve deterministically by dropping the
      // file from the merge rather than keeping either side's stale content; Local Storage (or the next
      // mirrorToSyncRepo() pass) regenerates it. This is the "regenerate" strategy: no side's committed value is
      // worth preserving, so there is nothing to actually reconcile. Any OTHER conflicted path still aborts +
      // surfaces, never a clobber (git_backbone.mdx §4.3).
      const conflicts = await this.conflictedPaths();
      if (conflicts.length > 0 && conflicts.every(isRepoStorageYamlPath)) {
        const resolved = await this.autoResolveRepoStorageConflicts(conflicts);
        if (resolved.length === conflicts.length) {
          try {
            await this.git.commit("LFB: auto-resolved repo_storage.yaml merge conflict (regenerated from Local Storage)");
            result.merged = true;
            log.warn(
              "git",
              `${this.dir}: auto-resolved merge conflict by dropping regeneratable ${resolved.join(", ")} — Category-B tracking state never belongs in a git working tree (repo_tracking_scheme.mdx §1)`,
            );
            return;
          } catch (e2) {
            log.warn("git", `${this.dir}: failed to finalize auto-resolved repo_storage.yaml conflict: ${(e2 as Error).message}`);
            // fall through to the abort-and-surface path below
          }
        }
      }
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
   * Auto-resolve a merge conflict on one or more `repo_storage.yaml` paths (any depth — the top-level legacy
   * shape and the `repos/<repoKey>/repo_storage.yaml` sync-repo mirror alike) by dropping the file from the
   * merge (`git rm -f`) instead of keeping either side's content. Best-effort per path so one failure doesn't
   * block resolving the rest; returns the subset actually resolved so the caller can tell whether ALL
   * conflicts were handled (safe to finish the merge) or some remain (must still abort + surface).
   */
  private async autoResolveRepoStorageConflicts(conflicted: string[]): Promise<string[]> {
    const resolved: string[] = [];
    for (const p of conflicted) {
      try {
        await this.git.rm(p);
        resolved.push(p);
      } catch (e) {
        log.warn("git", `${this.dir}: failed to auto-resolve conflict on ${p}: ${(e as Error).message}`);
      }
    }
    return resolved;
  }

  /**
   * How many commits the working branch is AHEAD of its remote — `git rev-list --count origin/<branch>..HEAD`
   * (git_backbone.mdx §6.1). A missing upstream ref (fresh repo, never pushed) or any rev-list failure returns 1
   * so the caller still attempts a push to establish/repair the upstream rather than silently skipping it.
   */
  private async aheadCount(branch: string): Promise<number> {
    try {
      const out = await this.git.raw(["rev-list", "--count", `origin/${branch}..HEAD`]);
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : 1;
    } catch {
      return 1; // no upstream ref yet (or rev-list failed) — a push will establish/repair it
    }
  }

  /**
   * Stage this device's SDL changes, commit, and push (git_backbone.mdx §6 steps 5–6). Big-file bytes are
   * git-ignored, so staging the working tree only ever queues the small SDL text. On a non-fast-forward
   * reject (another computer pushed between our fetch and our push), re-pull (fetch+merge) and re-push
   * ONCE — never a force-push.
   *
   * ALWAYS-PUSH-WHEN-AHEAD (git_backbone.mdx §6.1, backbone_resilience.mdx §6): the push fires whenever the branch
   * is ahead of the remote for ANY reason — not only when THIS pass made its own commit. An earlier build
   * returned before pushing when nothing new was staged, which stranded a commit the branch already carried
   * (a machine-wide auto-commit that committed into this repo, or a prior failed push) so it never reached
   * the other computers. We now push whenever we committed OR the ahead-count is non-zero.
   */
  async commitAndPush(result: GitCycleResult): Promise<void> {
    if (result.conflicts?.length) return; // don't commit on top of an unresolved conflict
    this.ensureSdlCommittable(); // the SDL text is the payload for a Git backbone — never let .gitignore hide it
    this.ensureMergeAttributes();
    try {
      await this.git.add(["-A"]); // .gitignore keeps the big bytes out; only SDL text is staged
      const staged = await this.git.status();
      const hasStaged =
        staged.staged.length > 0 || staged.created.length > 0 || staged.renamed.length > 0 || staged.deleted.length > 0;
      if (hasStaged) {
        await this.git.commit("LFB: backbone device state"); // -m message → no editor invoked
        result.committed = true;
      }
    } catch (e) {
      result.problem = result.problem ?? `Git commit failed: ${(e as Error).message}`;
      return;
    }
    if (!(await this.hasOrigin())) return;
    const branch = await this.branch();
    // Deliver whatever the branch is ahead by — our fresh commit AND/OR a commit that was already local
    // and unpushed (foreign auto-commit, merge commit, or an earlier failed push). Never rely on our own
    // commit being the only reason to push (git_backbone.mdx §6.1).
    if (!result.committed && (await this.aheadCount(branch)) === 0) {
      return; // truly nothing to send — not committed and not ahead
    }
    try {
      await this.git.push("origin", branch);
      result.pushed = true;
    } catch (e) {
      // Likely a non-fast-forward reject: pull (fetch+merge) then push once more (git_backbone.mdx §6).
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

// ── git-ignore helpers (the canonical impls; directories.mdx §3.4a, git_ignore.mdx §5) ──────────

/**
 * The nearest ancestor directory (INCLUSIVE) that is a git working-tree root — i.e. has a `.git`
 * (directories.mdx §3.4a). Walks up to the filesystem root; returns null if the path is in no repo.
 * The single canonical impl (badges.ts re-exports this) so "which repo owns this path" is answered
 * one way everywhere.
 */
export function nearestGitAtOrAbove(dir: string): string | null {
  let cur = path.resolve(dir);
  for (;;) {
    if (isGitWorkingTree(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null; // reached the filesystem root
    cur = parent;
  }
}

/**
 * The subset of `absPaths` that git IGNORES inside `repoRoot`, computed with ONE
 * `git check-ignore --stdin` invocation (git_ignore.mdx §5.4). The paths are fed newline-joined on
 * stdin and git echoes back exactly those it ignores (as given, so the returned Set holds the same
 * absolute strings the caller passed). No shell — the git binary is exec'd directly (charter).
 *
 * Exit-code contract: 0 = one or more ignored (stdout lists them), 1 = NONE ignored (no output — NOT
 * an error), ≥128 = a real failure. So a bare exit-1 (repo with no matching rule) yields an empty Set,
 * never a throw. Any unexpected failure is logged and treated as "nothing ignored" so a listing/plan
 * never breaks over it.
 */
export function checkIgnore(repoRoot: string, absPaths: string[]): Set<string> {
  const ignored = new Set<string>();
  if (absPaths.length === 0) return ignored;
  const out = runCheckIgnore(repoRoot, absPaths, false);
  if (out === null) return ignored;
  for (const line of out.split("\n")) {
    const p = line.trim();
    if (p) ignored.add(p);
  }
  return ignored;
}

/** The one `.gitignore` rule that causes a path to be ignored, as git reports it under `-v`. */
export interface IgnoreRule {
  source: string; // the file holding the rule — usually "<repo>/.gitignore", but can be .git/info/exclude or a global
  line: number; // 1-based line number within `source`
  pattern: string; // the rule text itself, e.g. "**/videos/**" or "/videos/RT_1.mp4"
}

/**
 * Like `checkIgnore`, but also reports WHICH rule ignores each path (`git check-ignore -v`), keyed by the
 * absolute path as passed in. This is what lets the product (a) refuse to un-ignore a file whose rule is a
 * broad pattern we must not rewrite, and (b) TELL the user the rule and line that ignores it
 * (git_ignore.mdx §5.5). Paths that are not ignored are simply absent from the map.
 *
 * Same exit-code contract and same never-throw posture as `checkIgnore`: any unexpected failure is logged
 * and yields an empty map ("nothing known to be ignored"), so a listing never breaks over it.
 */
export function checkIgnoreVerbose(repoRoot: string, absPaths: string[]): Map<string, IgnoreRule> {
  const rules = new Map<string, IgnoreRule>();
  if (absPaths.length === 0) return rules;
  const out = runCheckIgnore(repoRoot, absPaths, true);
  if (out === null) return rules;
  for (const raw of out.split("\n")) {
    if (!raw.trim()) continue;
    // `-v` format: "<source>:<linenum>:<pattern>\t<pathname>". Split on the TAB first so a pattern
    // containing colons (or a path containing them) can never be mis-parsed.
    const tab = raw.indexOf("\t");
    if (tab < 0) continue;
    const left = raw.slice(0, tab);
    const pathname = raw.slice(tab + 1).trim();
    const m = /^(.+):(\d+):(.*)$/.exec(left);
    if (!m || !pathname) continue;
    rules.set(pathname, { source: m[1], line: Number(m[2]), pattern: m[3] });
  }
  return rules;
}

/** The shared `git check-ignore --stdin` invocation. Returns stdout, or null when it genuinely failed. */
function runCheckIgnore(repoRoot: string, absPaths: string[], verbose: boolean): string | null {
  const args = verbose ? ["check-ignore", "-v", "--stdin"] : ["check-ignore", "--stdin"];
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      input: absPaths.join("\n") + "\n",
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // check-ignore exits 1 when NONE of the inputs are ignored — expected, not an error. Its stdout
    // still carries whichever inputs WERE ignored (empty on a clean exit-1), so read it off the error.
    const err = e as { status?: number; stdout?: string | Buffer };
    if (err.status === 1 && err.stdout != null) return err.stdout.toString();
    log.warn("git", `check-ignore failed in ${repoRoot}: ${(e as Error).message}`);
    return null;
  }
}

/** Turn a fetch/push error into a user-facing problem, flagging auth failures for re-authentication (git_backbone.mdx §5). */
function classifyRemoteError(e: Error): string {
  const m = e.message || String(e);
  if (/auth|denied|credential|403|401|could not read Username|terminal prompts disabled/i.test(m)) {
    return `Git authentication failed for this remote — re-authenticate it (LFB keeps pinning over IPFS meanwhile). (${m.split("\n")[0]})`;
  }
  return `Git remote error — LFB keeps pinning over IPFS. (${m.split("\n")[0]})`;
}
