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
import { execFileSync, execFile } from "node:child_process";
import { simpleGit, type SimpleGit } from "simple-git";
import { storageUnitDir } from "../../shared/store/scopes.js";
import { expandHome } from "../fs/badges.js";
import { isGitWorkingTree } from "../store-model/units.service.js";
import { LFBRIDGE_DIR } from "../storage/storage-type.service.js";
import { stableGitBin } from "./git-bin.js";
// The working-tree gate: no outside writer may dirty a working copy while git is mid-cycle in it
// (worktree-gate.ts). A leaf module, so importing it here creates no cycle.
import { withWorktreeBusy } from "./worktree-gate.js";
// The durable "did this computer's state actually reach the shared repo?" record + its jittered re-arm
// (push-health.service.ts, bug #16). A leaf module — it lazy-imports pin.service, so no cycle here.
import { recordPushSuccess, recordPushFailure, armUnpushedRetry } from "./push-health.service.js";
import { resolveStateDir } from "../../config/state-dir.js";
// The remote parser lives in a LEAF module so tracking-root.service.ts can derive a repo's shared identity
// (repoUid) without importing this heavy module — one parser, no cycle (storage_company.mdx §8.4.1).
import { parseRemoteOwner } from "../storage/repo-identity.js";
export { parseRemoteOwner, normalizeRemoteKey, sameRemoteKey } from "../storage/repo-identity.js";
import { log } from "../../shared/logging.js";
// "The machine was offline" is its own class of remote failure — recoverable, retried on reconnect, and
// deliberately NOT written into the durable fault trail (net-transient.ts, bug #15).
import { isTransientNetworkError } from "../../shared/net-transient.js";

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
  // The mirrored per-repo tracking payload now rides in every company/Personal SDL under
  // `repos/<repoUid>/` (storage_company.mdx §8.4.1). These entries are BARE FILENAMES with no slash, so git
  // matches them at ANY depth — the mirror needs no pattern of its own. `history/<device>.txt` is a
  // per-device append-only log; the `files/<rel>.yaml` sidecars are append-only event lists. Both union
  // cleanly, and both would otherwise abort a company repo's whole backbone (storage_company.mdx §11.1).
  "**/history/*.txt", // history/<device>.txt — append-only, per device, at any depth
  "**/files/**/*.yaml", // the per-file sidecars — append-only event lists
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
  // COMPANY-SIDE PAYLOAD — the set above was written from the personal SDL's shape and stopped there, so the
  // two names that carry a company storage's actual content were unprotected:
  //   • `repos/` — the mirrored per-repo tracking subtrees (`repos/<repoUid>/repo_storage.yaml`, the
  //     per-file sidecars, the per-repo manifest). On the reference machine this is the ENTIRE travelling
  //     payload of the company SDL — its root holds nothing else but `devices/`, `manifest.yaml` and
  //     `storage.yaml` — while the personal SDL has no `repos/` at all. A `repos/` line in that repo's
  //     `.gitignore` would therefore silently sever cross-computer sync for the company and be healed for
  //     nobody, since this is the list that does the healing.
  //   • `owner_map.yaml` — the travelling company-ownership assertion (repo_owner_propagation.mdx §2), which
  //     by definition exists only in a company SDL.
  "repos",
  "owner_map.yaml",
]);

/** True when a `.gitignore` line would swallow the SDL's travelling payload — the legacy `.lfbridge/`
 *  directory or one of the root names it moved to. Anchored (`/x`) and bare (`x`) forms both count; blanks,
 *  comments and negations never do. Exported as a pure predicate so the payload set can be regression-tested
 *  without a git working copy. */
export function ignoresSdlPayloadLine(line: string): boolean {
  const t = line.trim().replace(/^\//, "").replace(/\/$/, "");
  if (!t || t.startsWith("#") || t.startsWith("!")) return false; // blank / comment / negation
  return t === LFBRIDGE_DIR || SDL_ROOT_PAYLOAD.has(t);
}

/** True for any `repo_storage.yaml` path a Git-backed working tree might carry — the top-level legacy shape
 *  (`.lfbridge/repo_storage.yaml`, pre-redesign) and the current sync-repo mirror
 *  (`repos/<repoKey>/repo_storage.yaml`, repo_tracking_scheme.mdx §1.1) alike. Both are machine-generated
 *  Category-B tracking state whose authoritative copy is always Local Storage, so a merge conflict on either
 *  shape is safe to auto-resolve by dropping the file (see `autoResolveRepoStorageConflicts`). */
function isRepoStorageYamlPath(p: string): boolean {
  return /(^|\/)repo_storage\.yaml$/.test(p);
}

/**
 * How a conflicted path is resolved AUTOMATICALLY (storage_company.mdx §11.1).
 *
 * The rule that matters: *waiting for the customer to resolve a conflict means it never gets resolved.* A
 * tracking repo stuck pending a human has stopped syncing, and a sync product that has stopped syncing is
 * indistinguishable from one that was never installed. So every file LFB owns here has a defined automatic
 * resolution, and a conflict in one file never blocks another.
 *
 *   • "regenerate" — a machine-generated CACHE whose authoritative copy is Local Storage. Neither side is
 *     worth keeping, so drop it from the merge and let the next pass rebuild it.
 *   • "ours" — a SELF-OWNED file (this device's own registry entry). Our copy wins; other devices' files are
 *     untouched because they are different paths.
 *   • "union" — an append-only list that should have union-merged via .gitattributes. Reaching a conflict
 *     means the attribute was missing when the merge ran (a fresh clone, a mid-migration tree), so we
 *     concatenate both sides rather than abort; the readers fold duplicates anyway (§8.4.3).
 *   • null — no rule. Quarantined, never a reason to stop the backbone.
 */
export type ConflictResolution = "regenerate" | "ours" | "union" | null;

/**
 * Is this path a file LFB ITSELF generated inside a storage's own git working copy?
 *
 * This is the ownership line that makes the pre-merge checkpoint safe (`checkpointOwnWrites`) and the
 * blocked-merge clean-up honest (`clearBlockingOwnFiles`): LFB commits — and may regenerate — only what LFB
 * wrote. Anything else is the user's, and the user's uncommitted work is never committed, reset, or moved.
 *
 * Ours, by shape: every path with an automatic conflict resolution (`resolutionFor`), the SDL's root payload
 * names (`storage.yaml`, `devices/`, `analysis/`, `repos/`, …), the two git control files LFB maintains for
 * the backbone (`.gitattributes` via `ensureMergeAttributes`, `.gitignore` via `ensureSdlCommittable`), the
 * legacy `.lfbridge/` quarantine, and the analysis sidecars.
 */
export function isLfbOwnedSdlPath(p: string): boolean {
  const rel = p.replace(/^\.\//, "").replace(/^\//, "");
  if (!rel) return false;
  if (resolutionFor(rel) !== null) return true;
  const base = rel.split("/").pop() ?? rel;
  if (base === ".gitattributes" || base === ".gitignore") return true;
  const top = rel.split("/")[0]!;
  if (SDL_ROOT_PAYLOAD.has(top)) return true;
  if (top === LFBRIDGE_DIR) return true;
  if (/\.(ai_description|ai_description_rejected|transcription|ocr)$/.test(rel)) return true;
  return false;
}

/**
 * The working-tree paths git named when it REFUSED a merge before starting it — the `Your local changes to
 * the following files would be overwritten by merge:` / `The following untracked working tree files would be
 * overwritten by merge:` blocks. In this state `git status` reports NO conflicted paths (no merge is in
 * progress), so the error text is the only place the blockers are named. Exported for test.
 */
export function parseBlockedPaths(message: string): string[] {
  const out: string[] = [];
  let collecting = false;
  for (const raw of (message ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/would be overwritten by (merge|checkout):\s*$/.test(line.trim())) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    const t = line.trim();
    // The blocked paths are the tab-indented lines; the block ends at git's advice/verdict lines.
    if (!t || /^(Please|Aborting|error:|fatal:|hint:|warning:)/.test(t)) {
      collecting = false;
      continue;
    }
    out.push(t);
  }
  return [...new Set(out)];
}

export function resolutionFor(p: string): ConflictResolution {
  const base = p.split("/").pop() ?? p;
  // Regenerable caches — rebuilt from Local Storage on the next pass.
  if (isRepoStorageYamlPath(p)) return "regenerate";
  if (base === "files.yaml") return "regenerate";
  // Self-owned: a device file is written only by the device it names.
  if (/(^|\/)devices\/[^/]+\.yaml$/.test(p)) return "ours";
  // Append-only lists (the .gitattributes union should have handled these; do it by hand if it didn't).
  if (base === "manifest.yaml" || base === "decisions.yaml" || base === "owner_map.yaml") return "union";
  if (base === "LargeFilesBridge_SyncList.yaml") return "union";
  if (/(^|\/)files\/.+\.yaml$/.test(p)) return "union"; // per-file sidecars: event lists
  if (/(^|\/)history\/[^/]+\.txt$/.test(p)) return "union";
  return null;
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
  /**
   * TRUE when the ONLY thing that went wrong was that this computer had no network/DNS at the moment
   * (bug #15). The cycle is not failed — it is POSTPONED: the caller logs it below the durable fault trail
   * (`error.err` is WARN+ only, and a laptop changing wifi is not a fault) and retries when connectivity
   * returns instead of losing the cycle until the next 15-minute tick.
   */
  offline?: boolean;
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
    binary: stableGitBin(), // absolute path — immune to a thin background PATH (git-bin.ts)
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
  /** The storage this working copy belongs to — carried so a failed push can be re-armed BY STORAGE
   *  (push-health.service.ts) rather than merely logged against a directory path. */
  readonly storageId: string;

  private constructor(dir: string, storageId: string) {
    this.dir = dir;
    this.storageId = storageId;
    this.git = openRepo(dir);
  }

  /** Build a backbone from a storage's configured remote, or null if no working copy resolves (git_backbone.mdx §3). */
  static async resolve(storageId: string, remote: string): Promise<GitBackbone | null> {
    const dir = await resolveWorkingCopy(storageId, remote);
    return dir ? new GitBackbone(dir, storageId) : null;
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
    return ignoresSdlPayloadLine(line);
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
    return withWorktreeBusy(this.dir, () => this.pullInner(result));
  }

  private async pullInner(result: GitCycleResult): Promise<void> {
    // Write the union-merge `.gitattributes` BEFORE the merge (not only in commitAndPush, which runs
    // after): git reads `.gitattributes` from the working tree at merge time, so the shared SDL lists
    // (SyncList, manifest, decisions ledger) only fold conflict-free once this file is present. On a fresh
    // backbone the first merge would otherwise happen before any `.gitattributes` existed (git_backbone.mdx §4.2).
    this.ensureMergeAttributes();
    // …and the `.gitignore` heal, which ALSO edits the working tree. Both edits used to sit UNCOMMITTED
    // across the merge, so an incoming change to either file made git refuse the whole merge.
    this.ensureSdlCommittable();
    // COMMIT OUR OWN WRITES BEFORE WE MERGE (the bug this whole path exists to kill). Everything LFB writes
    // into an SDL working tree — the mirrored `repos/<repoUid>/` subtree, the device file, the manifest,
    // `.gitattributes`/`.gitignore` — is machine-generated text this process owns. Leaving it dirty and then
    // merging is what produced "Your local changes to the following files would be overwritten by merge:
    // repos/…/repo_storage.yaml / Aborting" dozens of times a day: the merge never ran, so the storage never
    // converged. A checkpoint commit costs one commit and makes the merge always legal.
    await this.checkpointOwnWrites();
    const branch = await this.branch();
    try {
      await this.git.fetch("origin", branch);
      result.fetched = true;
    } catch (e) {
      const failure = classifyRemoteFailure(e as Error);
      result.problem = failure.problem;
      // A fetch that failed because there is no network is a POSTPONED cycle, not a failed one (bug #15) —
      // the caller logs it quietly and retries on reconnect rather than burning the cycle.
      if (failure.kind === "offline") result.offline = true;
      return;
    }
    let attempt = await this.tryMerge(branch);
    if (attempt.error) {
      // The merge was REFUSED BEFORE IT STARTED — git named the working-tree paths in its way ("local
      // changes … would be overwritten", "untracked working tree files would be overwritten"). There are no
      // conflicted paths to resolve in this state, so the old code fell straight through to `merge --abort`
      // and gave up for the cycle. The untracked case is self-inflicted and LOOPS: the "regenerate"
      // resolution `git rm`s `repo_storage.yaml`, the next scan's mirror re-writes it as an UNTRACKED file,
      // and the following merge is blocked by it — forever. Clear the ones LFB owns, then merge for real.
      const blocked = parseBlockedPaths(attempt.error.message);
      if (blocked.length > 0) {
        const { cleared, foreign } = await this.clearBlockingOwnFiles(blocked);
        if (foreign.length > 0) {
          // NOT ours — never touched. Say exactly whose files stopped the merge instead of a generic abort.
          log.warn(
            "git",
            `${this.dir}: merge blocked by ${foreign.length} file(s) LFB does not own (${foreign.join(", ")}) — ` +
              `leaving them exactly as they are; commit or stash them and the next cycle will merge.`,
          );
        } else if (cleared.length > 0) {
          log.info("git", `${this.dir}: cleared ${cleared.length} LFB-generated file(s) blocking the merge (${cleared.join(", ")}) — retrying`);
          attempt = await this.tryMerge(branch);
        }
      }
    }
    if (!attempt.error) {
      result.merged = attempt.merged;
      return;
    }
    {
      const e = attempt.error;
      // A merge conflict git could not auto-resolve. LFB resolves it ITSELF, per file — it never hands the
      // user homework (storage_company.mdx §11.1). Before this, one unresolvable path aborted the merge and
      // `commitAndPush` then refused to run, so a single conflicted file froze the storage's ENTIRE backbone
      // forever: nothing merged, nothing committed, nothing pushed, every cycle repeating the same abort
      // until a human ran git by hand. And because only `repo_storage.yaml` had a rule — applied solely when
      // EVERY conflicted path was one — a lone sidecar in the same merge took the resolvable files down with
      // it. The mirrored `repos/<repoUid>/` payload made that the common case rather than the rare one.
      const conflicts = await this.conflictedPaths();
      if (conflicts.length > 0) {
        const { resolved, unresolved } = await this.resolveConflicts(conflicts);
        if (unresolved.length === 0) {
          try {
            await this.git.commit(`LFB: auto-resolved ${resolved.length} merge conflict(s)`);
            result.merged = true;
            log.warn("git", `${this.dir}: auto-resolved merge conflict on ${resolved.join(", ")}`);
            return;
          } catch (e2) {
            log.warn("git", `${this.dir}: failed to finalize auto-resolved conflict: ${(e2 as Error).message}`);
          }
        } else {
          log.error(
            "git",
            `${this.dir}: ${unresolved.length} conflicted path(s) have no automatic resolution ` +
              `(${unresolved.join(", ")}) — aborting this merge and surfacing them. Every OTHER file in this ` +
              `repo keeps syncing on the next cycle.`,
          );
        }
      }
      await this.git.merge(["--abort"]).catch(() => {});
      result.conflicts = conflicts;
      result.problem = `Git merge conflict on ${conflicts.length || "several"} file(s) — resolve with your Git tools. (${(e as Error).message})`;
    }
  }

  /** One merge attempt. Never throws — the error is RETURNED so the caller can decide between "the tree was
   *  in the way" (clear it and retry) and "git hit a real conflict" (the per-file resolution ladder). */
  private async tryMerge(branch: string): Promise<{ merged: boolean; error?: Error }> {
    try {
      const before = await this.git.revparse(["HEAD"]).catch(() => "");
      await this.git.merge(["--no-edit", `origin/${branch}`]);
      const after = await this.git.revparse(["HEAD"]).catch(() => "");
      return { merged: before !== after };
    } catch (e) {
      return { merged: false, error: e as Error };
    }
  }

  /**
   * Stage + commit every DIRTY path in this working copy that LFB itself generated, so the tree is clean of
   * OUR writes before a merge (git_backbone.mdx §4; the "local changes would be overwritten by merge" abort).
   *
   * Ownership is decided per path by {@link isLfbOwnedSdlPath} and the commit carries an EXPLICIT PATHSPEC:
   * a file the user happens to keep in this repo is never swept into an LFB commit, and a working repo is
   * never touched by this code path at all (a GitBackbone only ever exists for a storage's own dedicated
   * repo — `resolveWorkingCopy`). Returns the committed paths. Never throws; a checkpoint that fails just
   * leaves the merge to fail the way it used to, which is strictly no worse.
   */
  private async checkpointOwnWrites(): Promise<string[]> {
    let status: Awaited<ReturnType<SimpleGit["status"]>>;
    try {
      status = await this.git.status();
    } catch (e) {
      log.warn("git", `${this.dir}: pre-merge status failed: ${(e as Error).message}`);
      return [];
    }
    const dirty = new Set<string>([
      ...status.modified,
      ...status.not_added,
      ...status.created,
      ...status.deleted,
      ...status.renamed.map((r) => r.to),
    ]);
    const ours = [...dirty].filter((p) => isLfbOwnedSdlPath(p));
    if (ours.length === 0) return [];
    try {
      await this.git.add(["--", ...ours]);
      await this.git.commit(`LFB: checkpoint ${ours.length} generated file(s) before merge`, ours);
      log.info("git", `${this.dir}: checkpointed ${ours.length} LFB-generated file(s) before the merge`);
      return ours;
    } catch (e) {
      log.warn("git", `${this.dir}: pre-merge checkpoint commit failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Get LFB-GENERATED files out of a refused merge's way — deterministically and without data loss.
   *
   * Every path is copied into a timestamped quarantine under the state root first
   * (`<state>/merge-quarantine/<repo>/<stamp>/<rel>`), then: an UNTRACKED file is deleted (the merge will
   * write the incoming copy), a TRACKED-but-dirty file is restored from HEAD. Both are safe because these
   * files are Category-B caches whose authoritative copy is Local Storage — the next pass regenerates them.
   *
   * A path LFB does NOT own is returned in `foreign` and left untouched, always. That is the charter line:
   * we never destroy a user's uncommitted work, so the merge stays refused and we say why.
   */
  private async clearBlockingOwnFiles(paths: string[]): Promise<{ cleared: string[]; foreign: string[] }> {
    const cleared: string[] = [];
    const foreign: string[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const rel of paths) {
      if (!isLfbOwnedSdlPath(rel)) {
        foreign.push(rel);
        continue;
      }
      const abs = path.join(this.dir, rel);
      try {
        const quarantine = path.join(resolveStateDir(), "merge-quarantine", path.basename(this.dir), stamp, rel);
        fs.mkdirSync(path.dirname(quarantine), { recursive: true });
        if (fs.existsSync(abs)) fs.copyFileSync(abs, quarantine);
      } catch (e) {
        log.warn("git", `${this.dir}: could not quarantine ${rel} before clearing it: ${(e as Error).message}`);
      }
      let tracked = false;
      try {
        await this.git.raw(["ls-files", "--error-unmatch", "--", rel]);
        tracked = true;
      } catch {
        tracked = false; // untracked — `ls-files --error-unmatch` exits non-zero
      }
      try {
        if (tracked) await this.git.raw(["checkout", "--", rel]);
        else fs.rmSync(abs, { force: true });
        cleared.push(rel);
      } catch (e) {
        log.warn("git", `${this.dir}: could not clear ${rel} out of the merge's way: ${(e as Error).message}`);
      }
    }
    return { cleared, foreign };
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
   * Resolve conflicted paths AUTOMATICALLY, one file at a time (storage_company.mdx §11.1).
   *
   * Each path is handled by what the file IS (`resolutionFor`), never by what else is in the same merge —
   * that per-merge coupling is what used to let one unhandled sidecar discard the resolution of every other
   * file. Returns both lists so the caller can finish the merge when nothing is left over, and name exactly
   * what it could not handle when something is.
   *
   * Every action here is additive or regenerative. Nothing is force-reset, and no remote content is
   * discarded except for caches this computer can rebuild from Local Storage (git_backbone.mdx §1).
   */
  private async resolveConflicts(conflicted: string[]): Promise<{ resolved: string[]; unresolved: string[] }> {
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const p of conflicted) {
      const how = resolutionFor(p);
      try {
        if (how === "regenerate") {
          // A machine-generated cache — drop it from the merge; the next pass rebuilds it from Local Storage.
          await this.git.rm(p);
        } else if (how === "ours") {
          // Self-owned (this device's own file): keep our copy verbatim.
          await this.git.raw(["checkout", "--ours", "--", p]);
          await this.git.add(p);
        } else if (how === "union") {
          // Append-only list whose union attribute did not apply (fresh clone / mid-migration tree). Do the
          // union by hand: concatenate both sides with the conflict markers stripped. Readers fold
          // duplicates, so a superset is always safe and losing a line never is.
          if (!(await this.unionMergeFile(p))) {
            unresolved.push(p);
            continue;
          }
        } else {
          unresolved.push(p);
          continue;
        }
        resolved.push(p);
      } catch (e) {
        log.warn("git", `${this.dir}: failed to auto-resolve conflict on ${p}: ${(e as Error).message}`);
        unresolved.push(p);
      }
    }
    return { resolved, unresolved };
  }

  /**
   * Union two conflicted sides of an append-only file by stripping git's conflict markers and keeping BOTH
   * bodies. Deduplicates identical lines so a repeated merge does not grow the file without bound. Returns
   * false when the file cannot be read/written, so the caller can report it rather than assume success.
   */
  private async unionMergeFile(rel: string): Promise<boolean> {
    const abs = path.join(this.dir, rel);
    try {
      const raw = fs.readFileSync(abs, "utf8");
      const kept: string[] = [];
      const seen = new Set<string>();
      for (const line of raw.split("\n")) {
        if (/^(<{7}|={7}|>{7}|\|{7})/.test(line)) continue; // drop the markers, keep every side's content
        // Keep blank lines and comments as-is; dedupe only meaningful, repeated content lines.
        if (line.trim() === "" || !seen.has(line)) {
          if (line.trim() !== "") seen.add(line);
          kept.push(line);
        }
      }
      fs.writeFileSync(abs, kept.join("\n"), "utf8");
      await this.git.add(rel);
      return true;
    } catch (e) {
      log.warn("git", `${this.dir}: union merge of ${rel} failed: ${(e as Error).message}`);
      return false;
    }
  }

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
    return withWorktreeBusy(this.dir, () => this.commitAndPushInner(result));
  }

  private async commitAndPushInner(result: GitCycleResult): Promise<void> {
    this.ensureSdlCommittable(); // the SDL text is the payload for a Git backbone — never let .gitignore hide it
    this.ensureMergeAttributes();
    try {
      await this.git.add(["-A"]); // .gitignore keeps the big bytes out; only SDL text is staged
      const staged = await this.git.status();
      const hasStaged =
        staged.staged.length > 0 || staged.created.length > 0 || staged.renamed.length > 0 || staged.deleted.length > 0;
      if (hasStaged) {
        await this.git.commit(composeCommitMessage(staged)); // -m message → no editor invoked
        result.committed = true;
      }
    } catch (e) {
      result.problem = result.problem ?? `Git commit failed: ${(e as Error).message}`;
      return;
    }
    if (!(await this.hasOrigin())) {
      // NO REMOTE — the highest-value silent fault in the backbone (storage_company.mdx §11.2). This used to
      // `return` with no problem set and nothing logged, so a `git init`ed tracking repo committed forever
      // and never pushed, and its cycle result was INDISTINGUISHABLE from a healthy repo with nothing to do.
      // The user believes their computers are in sync while nothing has ever left this machine. Say it.
      result.problem =
        "This tracking repo has no git remote, so nothing is reaching your other computers. " +
        "Add a remote in the storage's settings.";
      log.warn(
        "git",
        `${this.dir}: committed locally but there is NO ORIGIN — nothing will reach the user's other ` +
          `computers until a remote is configured for this storage.`,
      );
      return;
    }
    const branch = await this.branch();
    // Deliver whatever the branch is ahead by — our fresh commit AND/OR a commit that was already local
    // and unpushed (foreign auto-commit, merge commit, or an earlier failed push). Never rely on our own
    // commit being the only reason to push (git_backbone.mdx §6.1).
    if (!result.committed && (await this.aheadCount(branch)) === 0) {
      return; // truly nothing to send — not committed and not ahead
    }
    // THREE attempts with backoff (storage_personal.mdx §17.4.3, storage_company.mdx §11.4). A single retry
    // loses to any peer that pushes twice while we are working — and on a shared company repo with several
    // members that is an ordinary Tuesday, not an edge case. Each retry re-pulls first, so we are always
    // pushing on top of the newest remote state; we never force.
    //
    // THE BACKOFF IS JITTERED (bug #16). It used to be the fixed ladder [0, 2000, 8000] — the same ladder
    // running on EVERY one of the user's computers, against the same remote, over a window that a slow
    // re-pull stretches to minutes. Two machines that collide once then retry in lockstep and collide
    // again; the observed "attempt 3/3; giving up this cycle" lines are that lockstep. Randomizing each
    // wait breaks the phase lock, which is the only thing that can break it — no local lock can exclude
    // another COMPUTER's push (see push-health.service.ts).
    const ATTEMPTS = 3;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const wait = attempt === 0 ? 0 : pushRetryDelayMs(attempt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        await this.git.push("origin", branch);
        result.pushed = true;
        result.problem = undefined; // a later success clears an earlier attempt's complaint
        // This computer IS sharing its state — stamp it and clear any outstanding "hasn't pushed" record
        // (and any re-arm it left pending).
        recordPushSuccess(this.storageId, this.dir);
        return;
      } catch (e) {
        const failure = classifyRemoteFailure(e as Error);
        const why = failure.problem;
        const last = attempt === ATTEMPTS - 1;
        // OFFLINE ⇒ STOP RETRYING IMMEDIATELY (bug #15). Three attempts 8 seconds apart cannot conjure a
        // network, and each one costs a full DNS timeout; the caller retries the whole cycle on reconnect.
        // Logged at INFO because a closed lid is not a fault (`error.err` is the durable fault trail).
        if (failure.kind === "offline") {
          log.info(
            "git",
            `${this.dir}: push postponed — this computer is offline (${(e as Error).message.split("\n")[0]}); retrying when the network returns`,
          );
          result.problem = why;
          result.offline = true;
          return;
        }
        // AN AUTH FAILURE IS NOT A RACE. Re-pulling and pushing again cannot produce a credential, so the
        // remaining attempts only widen the window in which OTHER cycles pile up behind this storage's
        // lock. Record it (so the user is told) and stop.
        if (failure.kind === "auth") {
          log.warn("git", `${this.dir}: push rejected (${why}) — authentication will not fix itself by retrying; recorded for the user.`);
          result.problem = why;
          await this.noteUnpushed(why);
          return;
        }
        // LOG THE CAUSE (storage_personal.mdx §16.2(g)): previously this error was captured and never read,
        // so an auth failure and a routine non-fast-forward race were indistinguishable in the log — and if
        // a retry then succeeded, the fact that anything went wrong vanished entirely.
        log.warn(
          "git",
          `${this.dir}: push rejected (${why}) — attempt ${attempt + 1}/${ATTEMPTS}` +
            (last ? "; giving up this cycle" : "; re-pulling and retrying"),
        );
        result.problem = why;
        // GIVING UP THIS CYCLE MUST NOT MEAN GIVING UP (bug #16). The commits are still here and the other
        // computers still cannot see them, so the fact is recorded durably, re-armed on a jittered backoff,
        // and surfaced on the Scans page until a push actually lands.
        if (last) {
          await this.noteUnpushed(why);
          return;
        }
        // Re-pull before the next attempt. A conflict here is already auto-resolved per file by pull();
        // if something truly unresolvable remains, stop and surface it rather than pushing blindly.
        const retry: GitCycleResult = { ran: true };
        await this.pull(retry);
        if (retry.offline) {
          // The network dropped between the push and the re-pull — postponed, not failed.
          result.problem = retry.problem;
          result.offline = true;
          return;
        }
        if (retry.conflicts?.length) {
          result.conflicts = retry.conflicts;
          result.problem = retry.problem;
          // Still unpushed, for a reason the user may have to act on — same durable record, same re-arm.
          await this.noteUnpushed(retry.problem ?? why);
          return;
        }
      }
    }
  }

  /**
   * Record that this computer's storage state did NOT reach the shared repo, and re-arm the push.
   *
   * This is the difference between "we gave up this cycle" (a log line nobody reads) and "the work is
   * queued, will be retried, and the user can see it" — a machine that has silently stopped sharing its
   * state is the worst outcome this product has. Never throws: health bookkeeping must not fail a cycle.
   */
  private async noteUnpushed(problem: string): Promise<void> {
    try {
      const ahead = await this.aheadCount(await this.branch());
      const consecutive = recordPushFailure(this.storageId, this.dir, problem, ahead);
      armUnpushedRetry(this.storageId, consecutive);
    } catch (e) {
      log.debug("git", `${this.dir}: recording the unpushed state failed: ${(e as Error).message}`);
    }
  }
}

/**
 * How long to wait before push retry number `attempt` (1-based: attempt 0 fires immediately).
 *
 * Exponential (2s, 8s) with ±40% JITTER. The jitter is the point: the old fixed ladder made every one of
 * the user's computers retry a lost push at the same offsets, so machines that collided once collided
 * again on the next attempt and the cycle exhausted its attempts against a peer that was never going to
 * yield. Exported for test.
 */
export function pushRetryDelayMs(attempt: number, rnd: () => number = Math.random): number {
  const base = 2000 * 4 ** (Math.max(1, attempt) - 1); // 2s, 8s, 32s …
  return Math.round(base * (0.6 + rnd() * 0.8));
}

// ── git-ignore helpers (the canonical impls; directories.mdx §3.4a, git_ignore.mdx §5) ──────────

/**
 * The nearest ancestor directory (INCLUSIVE) that is a git working-tree root — i.e. has a `.git`
 * (directories.mdx §3.4a). Walks up to the filesystem root; returns null if the path is in no repo.
 * The single canonical impl (badges.ts re-exports this) so "which repo owns this path" is answered
 * one way everywhere.
 */
/**
 * Compose an HONEST commit message from what is actually staged (storage_personal.mdx §17.4.2 / AC-26).
 *
 * Every LFB commit used to be titled "LFB: backbone device state" — including the ones that were almost
 * entirely the user's work. Proven live on 2026-07-16: a HEAD commit of `13 files changed` = 12
 * `.ai_description` files (2,385 lines) + one `devices/*.yaml`, all labelled "device state" (§16.2(c)).
 * 1,900+ such commits made the history unreadable and unauditable. The blanket title stays legal ONLY when
 * device state is genuinely all that changed.
 *
 * Format: `LFB: <comma-separated counted categories>` — categories derived from the staged paths by the same
 * classification the spec's §21 inventory uses.
 */
export function composeCommitMessage(staged: {
  staged: string[];
  created: string[];
  renamed: Array<{ from: string; to: string }>;
  deleted: string[];
}): string {
  const paths = [
    ...staged.staged,
    ...staged.created,
    ...staged.deleted,
    ...staged.renamed.map((r) => r.to),
  ];
  const counts = new Map<string, number>();
  const bump = (k: string): void => void counts.set(k, (counts.get(k) ?? 0) + 1);

  for (const p of new Set(paths)) {
    if (p.endsWith(".ai_description")) bump("AI descriptions");
    else if (p.endsWith(".ai_description_rejected")) bump("AI refusals");
    else if (p.endsWith(".transcription")) bump("transcripts");
    else if (p.endsWith(".ocr")) bump("OCR texts");
    // A debug export is a named, user-initiated checkpoint — `git log -- debug/` should read as a
    // TIMELINE of exports, not as "1 other files" (debug.mdx §4.2/§10.1).
    else if (p.startsWith("debug/") || p.includes("/debug/")) bump("debug export");
    else if (p.startsWith("devices/") || p.includes("/devices/")) bump("device state");
    else if (p.endsWith("manifest.yaml")) bump("manifest");
    else if (p.endsWith("decisions.yaml")) bump("decisions");
    else if (p.endsWith("files.yaml") || p.endsWith("repo_storage.yaml")) bump("tracking");
    else if (p.startsWith("analysis/") || p.includes("/analysis/")) bump("analysis");
    else bump("other files");
  }
  if (counts.size === 0) return "LFB: backbone device state";

  // Device state is the ambient noise of every pass — name it last so the user's work leads the subject.
  const order = (k: string): number => (k === "device state" ? 1 : 0);
  const parts = [...counts.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || b[1] - a[1])
    .map(([k, n]) =>
      k === "device state" || k === "manifest" || k === "tracking" || k === "debug export" ? k : `${n} ${k}`,
    );

  return `LFB: ${parts.join(", ")}`;
}

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
 * THREE-VALUED git-ignore truth for a batch of paths: ignored / not ignored / UNKNOWN.
 *
 * `unknown` is the paths git could not answer for (the repo vanished, it is not a git repository, or the
 * `check-ignore` process genuinely failed on that path). It exists because "we could not ask git" is NOT
 * the same answer as "git does not ignore this file": folding a failure into `false` silently misclassifies
 * every file in the repo as a big-file/check-in hazard (git_ignore.mdx §5.4). Callers that drive the ⊘
 * column, the bigNotIgnored nudge, or the `ignore` category MUST leave an unknown path undecided.
 */
export interface CheckIgnoreResult {
  ignored: Set<string>;
  unknown: Set<string>;
}

/**
 * The subset of `absPaths` that git IGNORES inside `repoRoot`, computed with batched
 * `git check-ignore --stdin` invocations (git_ignore.mdx §5.4). The paths are fed newline-joined on
 * stdin and git echoes back exactly those it ignores (as given, so the returned Set holds the same
 * absolute strings the caller passed). No shell — the git binary is exec'd directly (charter).
 *
 * Exit-code contract: 0 = one or more ignored (stdout lists them), 1 = NONE ignored (no output — NOT
 * an error), ≥128 = a real failure. So a bare exit-1 (repo with no matching rule) yields an empty Set,
 * never a throw. A genuine failure is logged and reported through `unknown` (see `CheckIgnoreResult`),
 * never as "not ignored", and never breaks a listing/plan.
 */
export function checkIgnoreDetailed(repoRoot: string, absPaths: string[]): CheckIgnoreResult {
  const ignored = new Set<string>();
  if (absPaths.length === 0) return { ignored, unknown: new Set<string>() };
  const res = runCheckIgnore(repoRoot, absPaths, false);
  for (const line of res.out.split("\n")) {
    const p = line.trim();
    if (p) ignored.add(p);
  }
  return { ignored, unknown: new Set(res.unknown) };
}

/** `checkIgnoreDetailed` without the unknown axis — for callers that only ever ACT on a positive hit. */
export function checkIgnore(repoRoot: string, absPaths: string[]): Set<string> {
  return checkIgnoreDetailed(repoRoot, absPaths).ignored;
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
 * and the affected paths come back in `unknown` — absent from the map because their verdict is UNKNOWN,
 * which is not the same as "not ignored" (see `CheckIgnoreResult`), so a listing never breaks over it.
 */
export interface CheckIgnoreVerboseResult {
  rules: Map<string, IgnoreRule>;
  unknown: Set<string>;
}

export function checkIgnoreVerboseDetailed(repoRoot: string, absPaths: string[]): CheckIgnoreVerboseResult {
  const rules = new Map<string, IgnoreRule>();
  if (absPaths.length === 0) return { rules, unknown: new Set<string>() };
  const res = runCheckIgnore(repoRoot, absPaths, true);
  for (const raw of res.out.split("\n")) {
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
  return { rules, unknown: new Set(res.unknown) };
}

/** `checkIgnoreVerboseDetailed` without the unknown axis — callers that only act on a positive hit. */
export function checkIgnoreVerbose(repoRoot: string, absPaths: string[]): Map<string, IgnoreRule> {
  return checkIgnoreVerboseDetailed(repoRoot, absPaths).rules;
}

/**
 * `git check-ignore` aborts the WHOLE --stdin batch with this fatal when ANY candidate path lies inside
 * a submodule (or a nested worktree git sees as a gitlink) — one bad path poisons the batch and the ⊘
 * Ignore column loses git truth for the entire repo. We parse the offending pathspec + submodule out of
 * stderr, split the batch at that boundary, and retry: submodule-contained paths are evaluated against
 * the SUBMODULE's own ignore rules (it is its own git working tree — that IS git truth for a file that
 * lives there), while the remainder retries against the parent repo. Splits are bounded; a submodule
 * whose tree can't answer (stale worktree gitlink) conservatively yields "not ignored" so the
 * bigNotIgnored nudge still surfaces rather than silently hiding files.
 */
const SUBMODULE_FATAL_RE = /fatal: Pathspec '(.*)' is in submodule '(.*)'/;
const MAX_SUBMODULE_SPLITS = 16;

/** Split `absPaths` at the submodule boundary a check-ignore fatal reported. Null = stderr wasn't that fatal. */
function splitOnSubmoduleFatal(
  repoRoot: string,
  absPaths: string[],
  stderr: string | undefined,
): { inside: string[]; rest: string[]; subRoot: string } | null {
  const m = stderr ? SUBMODULE_FATAL_RE.exec(stderr) : null;
  if (!m) return null;
  const subRoot = path.join(repoRoot, m[2]);
  const prefix = subRoot + path.sep;
  const inside = absPaths.filter((p) => p.startsWith(prefix));
  const rest = absPaths.filter((p) => !p.startsWith(prefix));
  // Prefix didn't match anything (symlinked/normalized paths)? Drop at least the exact offending
  // pathspec so the retry strictly shrinks and can't loop on the same fatal forever.
  if (inside.length === 0) {
    const rest2 = absPaths.filter((p) => p !== m[1]);
    if (rest2.length === absPaths.length) return null; // can't shrink — treat as an ordinary failure
    return { inside: [m[1]], rest: rest2, subRoot };
  }
  return { inside, rest, subRoot };
}

/**
 * WHY THE `--stdin` FEED IS BATCHED (the EPIPE storm, git_ignore.mdx §5.4).
 *
 * `git check-ignore --stdin` stops reading stdin the instant it hits a fatal (classically "Pathspec … is in
 * submodule …"). When the path list we are writing is SMALL, the whole list is already sitting in the OS
 * pipe buffer, so the write completes, `spawnSync` returns a normal exit-128 result and we can read the
 * fatal off `stderr` and split the batch at the submodule boundary. When the list is LARGER THAN THE PIPE
 * BUFFER (64 KiB on macOS), the write is still in flight when git exits — the write fails with `EPIPE`, and
 * spawnSync surfaces `spawnSync git EPIPE` with the child's stderr not reliably captured. The submodule
 * split then has nothing to parse and the WHOLE repo lost its git-ignore truth (observed: a 1,799-candidate
 * repo with three submodules, ~177 KiB of stdin, failing on every scan).
 *
 * Fix: never hand one spawn more than a pipe-buffer's worth of paths. Each batch's stdin fits, so a fatal
 * always comes back as a readable exit-128 + stderr and the existing submodule split works. A batch that
 * still fails is BISECTED (below) so one poison path costs only its own verdict, not the batch's.
 */
const CHECK_IGNORE_MAX_BATCH_PATHS = 1000;
const CHECK_IGNORE_MAX_BATCH_BYTES = 32 * 1024; // half the 64 KiB pipe buffer — the write always completes
const CHECK_IGNORE_MAX_BISECT_SPAWNS = 64; // bound the recovery cost of a pathological batch

/** Outcome of a `check-ignore` run. `unknown` = paths whose verdict we could NOT obtain — NOT "not ignored". */
interface CheckIgnoreOutcome {
  out: string;
  unknown: string[];
}

/** Split the path list into stdin-sized batches (see the EPIPE note above). */
function checkIgnoreBatches(absPaths: string[]): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const p of absPaths) {
    const n = Buffer.byteLength(p, "utf8") + 1; // + the newline separator
    if (cur.length > 0 && (cur.length >= CHECK_IGNORE_MAX_BATCH_PATHS || bytes + n > CHECK_IGNORE_MAX_BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += n;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/**
 * Is `repoRoot` somewhere we can even ask git? Answers the two non-git failure modes EXPLICITLY instead of
 * letting them surface as an opaque spawn error (a vanished cwd reports as `ENOENT`, identical to a missing
 * git binary; a non-repo answers "fatal: not a git repository" and kills the batch mid-write → `EPIPE`).
 */
function checkIgnoreRepoUsable(repoRoot: string, tag: string): boolean {
  if (!fs.existsSync(repoRoot)) {
    log.warn("git", `check-ignore${tag} skipped: repo root no longer exists (moved or deleted?): ${repoRoot}`);
    return false;
  }
  if (nearestGitAtOrAbove(repoRoot) === null) {
    log.warn("git", `check-ignore${tag} skipped: not a git repository (no .git at or above): ${repoRoot}`);
    return false;
  }
  return true;
}

/** The shared `git check-ignore --stdin` invocation, batched. Paths it could not answer for land in `unknown`. */
function runCheckIgnore(repoRoot: string, absPaths: string[], verbose: boolean): CheckIgnoreOutcome {
  if (absPaths.length === 0) return { out: "", unknown: [] };
  if (!checkIgnoreRepoUsable(repoRoot, "")) return { out: "", unknown: absPaths.slice() };
  const budget = { bisects: CHECK_IGNORE_MAX_BISECT_SPAWNS };
  let out = "";
  const unknown: string[] = [];
  for (const batch of checkIgnoreBatches(absPaths)) {
    const r = runCheckIgnoreBatch(repoRoot, batch, verbose, 0, budget);
    out += r.out;
    if (r.unknown.length > 0) unknown.push(...r.unknown);
  }
  return { out, unknown };
}

/** ONE spawn over a stdin-sized batch, with submodule split and failure bisection. */
function runCheckIgnoreBatch(
  repoRoot: string,
  absPaths: string[],
  verbose: boolean,
  splits: number,
  budget: { bisects: number },
): CheckIgnoreOutcome {
  if (absPaths.length === 0) return { out: "", unknown: [] };
  const args = verbose ? ["check-ignore", "-v", "--stdin"] : ["check-ignore", "--stdin"];
  try {
    const out = execFileSync(stableGitBin(), args, {
      cwd: repoRoot,
      input: absPaths.join("\n") + "\n",
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { out, unknown: [] };
  } catch (e) {
    // check-ignore exits 1 when NONE of the inputs are ignored — expected, not an error. Its stdout
    // still carries whichever inputs WERE ignored (empty on a clean exit-1), so read it off the error.
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    if (err.status === 1 && err.stdout != null) return { out: err.stdout.toString(), unknown: [] };
    // Submodule-contained path aborted the batch — split at the boundary and retry both halves.
    const split =
      splits < MAX_SUBMODULE_SPLITS ? splitOnSubmoduleFatal(repoRoot, absPaths, err.stderr?.toString()) : null;
    if (split) {
      const inside = isGitWorkingTree(split.subRoot)
        ? runCheckIgnoreBatch(split.subRoot, split.inside, verbose, splits + 1, budget)
        : { out: "", unknown: [] }; // no usable submodule tree → conservatively "not ignored"
      const rest = runCheckIgnoreBatch(repoRoot, split.rest, verbose, splits + 1, budget);
      return { out: rest.out + inside.out, unknown: [...rest.unknown, ...inside.unknown] };
    }
    // Unattributable failure (a fatal we can't parse, or an `EPIPE` that swallowed stderr): halve the batch
    // and retry. Bisection isolates the ONE poison path — every other path in the batch still gets its real
    // verdict instead of the whole repo going blind.
    if (absPaths.length > 1 && budget.bisects > 0) {
      budget.bisects -= 2;
      const mid = absPaths.length >> 1;
      const a = runCheckIgnoreBatch(repoRoot, absPaths.slice(0, mid), verbose, splits, budget);
      const b = runCheckIgnoreBatch(repoRoot, absPaths.slice(mid), verbose, splits, budget);
      return { out: a.out + b.out, unknown: [...a.unknown, ...b.unknown] };
    }
    log.warn(
      "git",
      `check-ignore failed in ${repoRoot} — ${absPaths.length} path(s) UNKNOWN (first: ${absPaths[0]}): ${(e as Error).message}`,
    );
    return { out: "", unknown: absPaths.slice() };
  }
}

/** Async twin of `runCheckIgnore` (non-blocking spawn) for request paths that must not stall the event loop
 *  on the git process — the badge-context listing walk on a large/cloud-mounted dir (fs.service /
 *  buildEntityView). Same exit-code contract, same stdin BATCHING and failure bisection as the sync twin
 *  (see the EPIPE note above): exit-1 (none ignored) resolves to its stdout, an unanswerable path lands in
 *  `unknown` rather than being reported as "not ignored". */
async function runCheckIgnoreAsync(repoRoot: string, absPaths: string[], verbose: boolean): Promise<CheckIgnoreOutcome> {
  if (absPaths.length === 0) return { out: "", unknown: [] };
  if (!checkIgnoreRepoUsable(repoRoot, " (async)")) return { out: "", unknown: absPaths.slice() };
  const budget = { bisects: CHECK_IGNORE_MAX_BISECT_SPAWNS };
  let out = "";
  const unknown: string[] = [];
  for (const batch of checkIgnoreBatches(absPaths)) {
    const r = await runCheckIgnoreAsyncBatch(repoRoot, batch, verbose, 0, budget);
    out += r.out;
    if (r.unknown.length > 0) unknown.push(...r.unknown);
  }
  return { out, unknown };
}

/** ONE non-blocking spawn over a stdin-sized batch, with submodule split and failure bisection. */
async function runCheckIgnoreAsyncBatch(
  repoRoot: string,
  absPaths: string[],
  verbose: boolean,
  splits: number,
  budget: { bisects: number },
): Promise<CheckIgnoreOutcome> {
  if (absPaths.length === 0) return { out: "", unknown: [] };
  const args = verbose ? ["check-ignore", "-v", "--stdin"] : ["check-ignore", "--stdin"];
  const res = await new Promise<{ err: Error | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      stableGitBin(),
      args,
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => resolve({ err, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
    // git closes stdin the moment it hits a fatal, so the write can fail with EPIPE. That is NOT a reason to
    // lose the run — the exit/stderr handling below is the real verdict, so swallow the write error here.
    child.stdin?.on("error", () => {});
    child.stdin?.end(absPaths.join("\n") + "\n");
  });
  // On a non-zero exit execFile sets `err` but still hands us the captured `stdout`. Exit-1 means
  // "none ignored" (stdout carries whichever WERE ignored, empty on a clean 1) — not a failure.
  if (!res.err) return { out: res.stdout, unknown: [] };
  if ((res.err as { code?: number }).code === 1) return { out: res.stdout, unknown: [] };
  // Submodule-contained path aborted the batch — same split-and-retry as the sync twin.
  const split = splits < MAX_SUBMODULE_SPLITS ? splitOnSubmoduleFatal(repoRoot, absPaths, res.stderr) : null;
  if (split) {
    const inside = isGitWorkingTree(split.subRoot)
      ? await runCheckIgnoreAsyncBatch(split.subRoot, split.inside, verbose, splits + 1, budget)
      : { out: "", unknown: [] }; // no usable submodule tree → conservatively "not ignored"
    const rest = await runCheckIgnoreAsyncBatch(repoRoot, split.rest, verbose, splits + 1, budget);
    return { out: rest.out + inside.out, unknown: [...rest.unknown, ...inside.unknown] };
  }
  if (absPaths.length > 1 && budget.bisects > 0) {
    budget.bisects -= 2;
    const mid = absPaths.length >> 1;
    const a = await runCheckIgnoreAsyncBatch(repoRoot, absPaths.slice(0, mid), verbose, splits, budget);
    const b = await runCheckIgnoreAsyncBatch(repoRoot, absPaths.slice(mid), verbose, splits, budget);
    return { out: a.out + b.out, unknown: [...a.unknown, ...b.unknown] };
  }
  log.warn(
    "git",
    `check-ignore (async) failed in ${repoRoot} — ${absPaths.length} path(s) UNKNOWN (first: ${absPaths[0]}): ${res.err.message}`,
  );
  return { out: "", unknown: absPaths.slice() };
}

/** Async twin of `checkIgnoreDetailed` — non-blocking `git check-ignore --stdin` over `absPaths`. */
export async function checkIgnoreAsyncDetailed(repoRoot: string, absPaths: string[]): Promise<CheckIgnoreResult> {
  const ignored = new Set<string>();
  if (absPaths.length === 0) return { ignored, unknown: new Set<string>() };
  const res = await runCheckIgnoreAsync(repoRoot, absPaths, false);
  for (const line of res.out.split("\n")) {
    const p = line.trim();
    if (p) ignored.add(p);
  }
  return { ignored, unknown: new Set(res.unknown) };
}

/** Async twin of `checkIgnore` — the ignored set only, for callers that act only on a positive hit. */
export async function checkIgnoreAsync(repoRoot: string, absPaths: string[]): Promise<Set<string>> {
  return (await checkIgnoreAsyncDetailed(repoRoot, absPaths)).ignored;
}

/** What KIND of remote failure this is — the three cases behave differently (git_backbone.mdx §5).
 *  • "offline"  — no usable network/DNS at the moment we tried. Expected, self-healing, NOT a fault.
 *  • "auth"     — a credential the user must fix. A real fault.
 *  • "remote"   — anything else the remote said no to. A real fault.  */
export type RemoteErrorKind = "offline" | "auth" | "remote";

/** Classify a fetch/push failure by kind + the sentence to show the user (git_backbone.mdx §5). */
export function classifyRemoteFailure(e: Error): { kind: RemoteErrorKind; problem: string } {
  const m = e.message || String(e);
  const first = m.split("\n")[0];
  // OFFLINE FIRST — "Could not resolve host" also contains the word "host", and some transports word a DNS
  // failure in ways that brush the auth regex. A network that is not there cannot be an authentication
  // problem, so this test wins.
  if (isTransientNetworkError(m)) {
    return {
      kind: "offline",
      problem:
        `This computer is offline right now (or its DNS is briefly unavailable), so Large File Bridge could not reach ` +
        `the git remote. It will retry as soon as the network is back, and it keeps pinning over IPFS meanwhile. (${first})`,
    };
  }
  if (/auth|denied|credential|403|401|could not read Username|terminal prompts disabled/i.test(m)) {
    return {
      kind: "auth",
      problem: `Git authentication failed for this remote — re-authenticate it (Large File Bridge keeps pinning over IPFS meanwhile). (${first})`,
    };
  }
  return { kind: "remote", problem: `Git remote error — Large File Bridge keeps pinning over IPFS. (${first})` };
}
