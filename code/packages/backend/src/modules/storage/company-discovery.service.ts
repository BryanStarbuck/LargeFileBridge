// Org → company discovery (storage_company.mdx §10, LOCKED): "a company IS a forge organization".
//
// The premise this module rests on is that the user has ALREADY told us which company each repo belongs to
// — they just told us in git rather than in our UI. Every repo's remote carries the org as a path level
// (`https://github.com/**ACT3ai**/charlie-kirk.git`), so grouping the registered repos by that level yields
// the company map with no configuration step, no mapping screen, and (§10.1) **no network** — the org is a
// string in `.git/config`, and LFB never calls a forge API to ask who owns what.
//
// The hard part is not finding the orgs; it is finding the orgs that are YOURS. §10.2 measured a real
// developer machine: 32 distinct orgs, 28 of them clones of other people's projects (`KDE`, `OpenShot`,
// `xai-org`, `twitter`, …). Proposing a company storage per org would have made 31 directories and 31
// Storages rows for organizations the user has no membership in — which is the difference between a useful
// feature and an unusable one. Hence the LOCKED membership test:
//
//     an org becomes a company only when the user's own git identity has authored at least one commit
//     in one of that org's repos ON THIS COMPUTER.
//
// Cloning is passive; committing is membership. `git log --author=<you>` answers it from the local object
// store — no network, no credentials — and on the measured machine it cut 32 orgs to 4, all 4 correct.
//
// Two consequences the code must honour and does:
//   • The test is a PROPOSAL filter, never a lock (§10.2). Everything it rejects is still RETURNED (as
//     `skipped`) so the Storages page can say "28 organizations you've only cloned from were ignored" with
//     a way to see them. A silent filter and a bug look identical (warnings.mdx).
//   • Nothing here touches the disk on its own (§10.3). Discovery reads; `createCompanyStorage()` runs only
//     from an explicit click, because creating a storage means `mkdir` + `git init` on the user's machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  OrganizationCandidate,
  OrganizationDiscovery,
  CompanyCreateResult,
  PersonalAccount,
  StorageRow,
} from "@lfb/shared";
import { CompanyDiscoveryStateSchema } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { listRepoFolders, getRepoConfig } from "../store-model/units.service.js";
import { parseRemoteOwner } from "./repo-identity.js";
import { isPersonalAccount } from "../git/git.service.js";
import { ensureCompanyForOwner, ensureStorage, listStoragesPage, getStorageRow } from "./storage.service.js";
import { clearPlacementCache } from "./artifact-placement.service.js";
import { expandHome } from "../fs/badges.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { readYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { mapLimit, responsiveBudget } from "../../shared/concurrency.js";
import { log } from "../../shared/logging.js";

const run = promisify(execFile);

const CONVENTION_SUFFIX = "_large_files_bridge";
/** A `false` membership answer is re-tested after this long — §10.2's "not-yet-committed is not never". */
const MEMBERSHIP_FALSE_TTL_MS = 12 * 60 * 60 * 1000;
/** Per-repo git call budget. A hung/huge repo must not hold the whole discovery hostage. */
const GIT_TIMEOUT_MS = 10_000;

function stateFile(): string {
  return path.join(resolveStateDir(), "company_discovery.yaml");
}

/** The dedupe key for an org: case- and punctuation-insensitive, matching storage.service's own slug rule
 *  so an org that resolves here resolves the same way in `ensureCompanyForOwner()`. */
export function orgKey(org: string): string {
  return org.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The DIRECTORY form of an org (`<dirSlug>_large_files_bridge`, §10.3). Unlike {@link orgKey} this keeps
 *  word separation, because a human reads it in Finder: `stoke-gh` stays `stoke-gh`, `ACT3ai` → `act3ai`. */
export function orgDirSlug(org: string): string {
  return org
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── where a new storage directory goes (§10.3 — "the parent directory is a SETTING") ──────────────────
/**
 * The parent directory a newly created company storage is made under.
 *
 * AC 6 forbids hardcoding one person's layout, and two hardcodes of `~/BGit/Bryan_git` already exist in the
 * codebase (storage.service.ts's canonical Personal path, storage-settings.service.ts's proposed default) —
 * this must not become a third. So: the explicit setting wins, and when it is unset we DERIVE the answer
 * from the disk, by asking where the user's existing `*_large_files_bridge` storages already live. On a
 * machine with any storage at all that derivation is exactly right and needs no configuration; on a machine
 * with none we fall back to the first scanner root, then to the home directory.
 */
export function storagesParentDir(): { dir: string; configured: boolean } {
  const cfg = getAppConfig();
  const configured = cfg.storages.parent_dir?.trim();
  if (configured) return { dir: path.resolve(expandHome(configured)), configured: true };

  // Derive: the most common parent among the storages that already exist. "Most common" rather than "first"
  // so one storage the user relocated elsewhere does not drag every future one along with it.
  const page = listStoragesPage();
  const roots = [page.personal, ...page.companies].filter((r): r is StorageRow => !!r).map((r) => r.root);
  const tally = new Map<string, number>();
  for (const root of roots) {
    const parent = path.dirname(path.resolve(root));
    tally.set(parent, (tally.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [parent, n] of tally) {
    if (n > bestN) {
      best = parent;
      bestN = n;
    }
  }
  if (best) return { dir: best, configured: false };

  const firstRoot = getAppConfig().scanner.roots.map(expandHome).find((r) => safeIsDir(r));
  return { dir: firstRoot ? path.resolve(firstRoot) : os.homedir(), configured: false };
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── the membership test (§10.2, LOCKED) ───────────────────────────────────────────────────────────────
/** The git author identities this computer commits under: the global `user.email` plus whatever each repo
 *  overrides locally. Collected once for the global value; the per-repo value is read inside the check. */
async function globalIdentities(): Promise<string[]> {
  const out = new Set<string>();
  for (const args of [
    ["config", "--global", "user.email"],
    ["config", "--system", "user.email"],
  ]) {
    try {
      const { stdout } = await run("git", args, { timeout: GIT_TIMEOUT_MS });
      const v = stdout.trim();
      if (v) out.add(v.toLowerCase());
    } catch {
      /* an unset (or absent) config level is the normal case, not a fault */
    }
  }
  return [...out];
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Has the user authored at least one commit in this repo? One `git log` bounded to a single result, so the
 * cost is "walk until the first match" rather than a full history scan; git stops at the first hit.
 *
 * The author pattern is the union of the global identities AND this repo's effective `user.email`, because a
 * developer routinely commits to a work org under a work address configured only inside those repos. Missing
 * that override would silently fail the membership test for exactly the org the user most belongs to.
 */
async function authoredHere(repoPath: string, globals: readonly string[]): Promise<boolean> {
  const emails = new Set(globals);
  try {
    const { stdout } = await run("git", ["config", "user.email"], { cwd: repoPath, timeout: GIT_TIMEOUT_MS });
    const v = stdout.trim();
    if (v) emails.add(v.toLowerCase());
  } catch {
    /* no identity resolvable in this repo — the globals (if any) still apply */
  }
  if (emails.size === 0) return false; // no identity at all ⇒ nothing here can be "yours"
  const pattern = [...emails].map(escapeForRegex).join("|");
  try {
    // `-i` is LOAD-BEARING, not tidiness. `--author` is a case-SENSITIVE regex by default, while git
    // records the email exactly as it was configured — `Bryan@thestarbucks.com`. Measured on the real
    // machine: without `-i` the test found ONE of the four orgs the user actually commits to, because the
    // configured identity reads back lowercased and every commit carries a capital B. A membership test
    // that silently answers "no" for your own repos loses the entire feature (§10.2).
    const { stdout } = await run(
      "git",
      ["log", "--all", "-i", "-E", `--author=${pattern}`, "-n", "1", "--format=%H"],
      { cwd: repoPath, timeout: GIT_TIMEOUT_MS },
    );
    return stdout.trim().length > 0;
  } catch (e) {
    // A repo with no commits exits non-zero, as does an unreadable/broken one. Both mean "no evidence of
    // membership here", which is the honest answer — and it is a `false`, so the TTL re-asks later.
    log.debug("storage", `membership check found nothing in ${repoPath}: ${(e as Error).message}`);
    return false;
  }
}

// ── the pure core, so grouping + filtering can be tested without a disk ────────────────────────────────
export interface RepoInput {
  path: string;
  remote: string | null;
}

export interface BuildCandidatesOptions {
  personalAccounts: readonly PersonalAccount[];
  /** "Did the user author a commit in this repo?" — injected so tests need no git repos. */
  authored: (repoPath: string) => boolean;
  dismissed: ReadonlySet<string>; // org keys
  /** Resolve an org to the company storage already claiming it (§10.3 adopt-before-create), or null. */
  claimedBy?: (org: string) => { id: string; name: string } | null;
  parentDir: string;
}

/**
 * Group repos by forge org and apply §10.1–§10.2. Pure: every I/O concern (git, config, storages) arrives
 * through {@link BuildCandidatesOptions}, which is what makes the grouping and the membership filter
 * testable against the measured 32-org machine without needing 200 repos on disk.
 *
 * Rules applied here, in order:
 *   • a remote that does not parse, or parses to a host we do not recognize as a forge, belongs to NO org
 *     (§10.1) — it is Personal's, and never a company candidate;
 *   • an org matching `personal_accounts` is the user's OWN account → Personal, never proposed (§10.2);
 *   • an org qualifies only when at least one of its repos here carries a commit the user authored (§10.2).
 */
export function buildCandidates(repos: readonly RepoInput[], opts: BuildCandidatesOptions): OrganizationDiscovery {
  type Group = { org: string; host: string; repos: string[]; personal: boolean };
  const groups = new Map<string, Group>();

  for (const repo of repos) {
    const parsed = parseRemoteOwner(repo.remote);
    if (!parsed || !parsed.knownForge) continue; // §10.1 — no org, therefore Personal, therefore not a candidate
    const key = orgKey(parsed.owner);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = {
        org: parsed.owner, // first sighting's casing is the display casing
        host: parsed.host,
        repos: [],
        personal: isPersonalAccount([...opts.personalAccounts], parsed.host, parsed.owner),
      };
      groups.set(key, g);
    }
    g.repos.push(repo.path);
  }

  const organizations: OrganizationCandidate[] = [];
  const skipped: OrganizationCandidate[] = [];
  let personalCount = 0;

  for (const [key, g] of groups) {
    if (g.personal) {
      personalCount++;
      continue; // the user's own account resolves to Personal and is NEVER proposed as a company (§10.2)
    }
    // Stop at the first repo of this org that carries one of the user's commits — membership is existential,
    // so there is nothing to gain from asking the other 101 repos.
    const qualifies = g.repos.some((r) => opts.authored(r));
    const claim = opts.claimedBy?.(g.org) ?? null;
    const candidate: OrganizationCandidate = {
      org: g.org,
      slug: key,
      dirSlug: orgDirSlug(g.org),
      host: g.host,
      repoCount: g.repos.length,
      repos: g.repos,
      qualifies,
      personalAccount: false,
      alreadyClaimed: !!claim,
      claimedByStorageId: claim?.id ?? null,
      claimedByStorageName: claim?.name ?? null,
      dismissed: opts.dismissed.has(key),
      proposedRoot: path.join(opts.parentDir, `${orgDirSlug(g.org)}${CONVENTION_SUFFIX}`),
    };
    (qualifies ? organizations : skipped).push(candidate);
  }

  const byName = (a: OrganizationCandidate, b: OrganizationCandidate) =>
    b.repoCount - a.repoCount || a.org.localeCompare(b.org);
  organizations.sort(byName);
  skipped.sort(byName);

  return {
    organizations,
    skipped,
    skippedCount: skipped.length,
    personalCount,
    totalOrgs: groups.size,
    parentDir: opts.parentDir,
    parentDirIsConfigured: false, // overwritten by discoverOrganizations(); pure core has no config
    identities: [],
  };
}

// ── the live discovery ────────────────────────────────────────────────────────────────────────────────
/**
 * Every forge organization on this computer, split into the ones the user belongs to and the ones they have
 * only cloned from (§10.1–§10.2).
 *
 * BOUNDED on purpose: the membership test spawns git, and there can be ~200 registered repos. Work is
 * fanned out at the RESPONSIVE budget (`cores − 2`, parallelization.mdx §1) — this runs behind a page load
 * while the user is using the app, so it must leave the HTTP loop and the IPFS node their cores — and each
 * repo's answer is CACHED in the state root, so the second page load costs a single YAML read. A `true` is
 * kept forever (a commit cannot be un-authored); a `false` expires, which is what makes §10.2's "an org
 * that fails today passes the first time the user commits to one of its repos" true without a manual rescan.
 */
export async function discoverOrganizations(): Promise<OrganizationDiscovery> {
  const cfg = getAppConfig();
  const parent = storagesParentDir();

  const repos: RepoInput[] = [];
  for (const folder of listRepoFolders()) {
    try {
      const c = getRepoConfig(folder);
      if (c.repo.path) repos.push({ path: c.repo.path, remote: c.repo.remote });
    } catch (e) {
      log.warn("storage", `company discovery: unreadable repo unit ${folder}: ${(e as Error).message}`);
    }
  }

  // Which repos actually need a git call this pass? Only those whose cached answer is absent or a stale
  // `false`. Grouping FIRST would be cheaper still, but the cache makes the difference immaterial and a
  // per-repo answer stays reusable when the org grouping changes (a new clone, a changed remote).
  const state = readYaml(stateFile(), CompanyDiscoveryStateSchema);
  const now = Date.now();
  const cached = new Map<string, boolean>();
  const toCheck: string[] = [];
  for (const r of repos) {
    const hit = state.membership[r.path];
    const fresh =
      !!hit && (hit.authored || (hit.checked_at ? now - Date.parse(hit.checked_at) < MEMBERSHIP_FALSE_TTL_MS : false));
    if (fresh && hit) cached.set(r.path, hit.authored);
    else toCheck.push(r.path);
  }

  const identities = await globalIdentities();
  if (toCheck.length) {
    const results = await mapLimit(toCheck, responsiveBudget(), async (repoPath) => ({
      repoPath,
      authored: await authoredHere(repoPath, identities),
    }));
    for (const r of results) cached.set(r.repoPath, r.authored);
    const stamp = new Date().toISOString();
    try {
      await updateYaml(stateFile(), CompanyDiscoveryStateSchema, (s) => {
        for (const r of results) s.membership[r.repoPath] = { authored: r.authored, checked_at: stamp };
        s.updated_at = stamp;
        return s;
      });
    } catch (e) {
      // A cache we could not persist costs speed, never correctness — this pass already has its answers.
      log.warn("storage", `company discovery: membership cache write failed: ${(e as Error).message}`);
    }
    log.info(
      "storage",
      `company discovery: membership tested ${toCheck.length} repo(s), ${results.filter((r) => r.authored).length} with your commits`,
    );
  }

  const dismissed = new Set(state.dismissed.map(orgKey));
  const view = buildCandidates(repos, {
    personalAccounts: cfg.personal_accounts,
    authored: (p) => cached.get(p) === true,
    dismissed,
    // Adopt-before-create (§10.3): ask the binding resolver whether some company storage already claims this
    // org. `ensureCompanyForOwner` is also what WRITES the binding back into `company.owner_slugs`, so an
    // adoption won by name match (`ACT3ai` ⇢ the storage named `Act3`) becomes an explicit, travelling fact
    // the moment it is first resolved — never a guess re-made on every pass (§8.4.4).
    claimedBy: (org) => {
      const row = ensureCompanyForOwner(org);
      return row ? { id: row.id, name: row.companyName ?? row.name } : null;
    },
    parentDir: parent.dir,
  });

  return { ...view, parentDirIsConfigured: parent.configured, identities };
}

// ── creation (§10.3) ──────────────────────────────────────────────────────────────────────────────────
/**
 * Create (or ADOPT) the company storage for one forge org. Only ever called from an explicit user action —
 * §10.3 and the charter both say LFB surfaces and offers rather than acting on the user's files.
 *
 * Adopt first, create second. If any company storage already claims the org — explicitly via
 * `company.owner_slugs`, or by a normalized name match — it is returned as-is and the binding is recorded.
 * This is precisely how `act3_large_files_bridge` (named "Act3") serves the org `ACT3ai` instead of a second,
 * near-duplicate `act3ai_large_files_bridge` appearing beside it. It also makes this endpoint IDEMPOTENT:
 * clicking Create twice yields the same one storage.
 *
 * Creation itself mirrors `createPersonalStorage()`: mkdir → `git init` → `ensureStorage(...)` → drop the
 * placement cache. The descriptor is written with `owner_slugs: [<org>]` UP FRONT, which is what makes the
 * multi-company case work at all: with three companies on disk the "a lone company adopts an unclaimed org"
 * fallback in `ensureCompanyForOwner` stops firing, so the binding has to be a recorded fact from birth.
 *
 * NO REMOTE is created — we cannot invent one — so the new storage commits locally and nothing travels until
 * the user supplies one. That is a loud, standing state, not an absence (§11.2), and `hasRemote:false` in
 * the result is what the UI says it with.
 */
export async function createCompanyStorage(org: string): Promise<CompanyCreateResult> {
  const name = org.trim();
  if (!name) throw new Error("org required");

  const existing = ensureCompanyForOwner(name);
  if (existing) {
    log.info("storage", `company for org "${name}" ADOPTED existing storage ${existing.id} at ${existing.root}`);
    return {
      org: name,
      storageId: existing.id,
      name: existing.companyName ?? existing.name,
      root: existing.root,
      adopted: true,
      hasRemote: await hasGitRemote(existing.root),
    };
  }

  const parent = storagesParentDir();
  const root = path.join(parent.dir, `${orgDirSlug(name)}${CONVENTION_SUFFIX}`);
  fs.mkdirSync(root, { recursive: true });
  if (!safeIsDir(path.join(root, ".git"))) {
    try {
      await run("git", ["init"], { cwd: root, timeout: GIT_TIMEOUT_MS });
      log.info("storage", `git init company storage at ${root}`);
    } catch (e) {
      // Every silent null becomes loud (§11.2): a storage that never became a repo can never sync, and the
      // user must not discover that months later.
      log.error("storage", `git init at ${root} failed: ${(e as Error).message}`);
    }
  }
  ensureStorage(root, "company", {
    name,
    company: { companyName: name, owner_slugs: [name] },
  });
  clearPlacementCache(); // a new storage exists — the next placement resolve must not use the stale index

  const row = findCompanyRowByRoot(root);
  log.info("storage", `created company storage for org "${name}" at ${root} (no remote yet — nothing travels until one is set)`);
  return {
    org: name,
    storageId: row?.id ?? "",
    name: row?.companyName ?? name,
    root,
    adopted: false,
    hasRemote: false, // freshly `git init`ed — §11.2's standing fault until the user supplies a remote
  };
}

/** Create/adopt several orgs at once — the single **Create company storages** button's server side (§10.3). */
export async function createCompanyStorages(orgs: readonly string[]): Promise<CompanyCreateResult[]> {
  const out: CompanyCreateResult[] = [];
  for (const org of orgs) out.push(await createCompanyStorage(org)); // serial: each one mutates the storage set
  return out;
}

function findCompanyRowByRoot(root: string): StorageRow | null {
  const target = path.resolve(root);
  return listStoragesPage().companies.find((c) => path.resolve(c.root) === target) ?? null;
}

/** Does this storage's git repo have a remote yet? `false` is §11.2's standing fault, not a detail. */
async function hasGitRemote(root: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["remote"], { cwd: root, timeout: GIT_TIMEOUT_MS });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── dismissal (§10.3 — "a dismissed org stays dismissed") ─────────────────────────────────────────────
/** Remember (or forget) that the user waved a proposed org away. Machine-local; undoable, because §10.2 is
 *  explicit that the membership test decides what to OFFER while the user decides what EXISTS. */
export async function setOrganizationDismissed(org: string, dismissed = true): Promise<{ dismissed: string[] }> {
  const key = orgKey(org);
  if (!key) throw new Error("org required");
  const next = await updateYaml(stateFile(), CompanyDiscoveryStateSchema, (s) => {
    const set = new Set(s.dismissed.map(orgKey));
    if (dismissed) set.add(key);
    else set.delete(key);
    s.dismissed = [...set];
    s.updated_at = new Date().toISOString();
    return s;
  });
  return { dismissed: next.dismissed };
}

/** Exposed for callers that only need the row (kept next to the creators so the module stays self-contained). */
export function companyStorageForOrg(org: string): StorageRow | null {
  const row = ensureCompanyForOwner(org);
  return row ? getStorageRow(row.id) : null;
}
