// The TRAVEL + CONSENT layer over the repo→company owner mapping (repo_owner_propagation.mdx). Assigning a repo
// to a company is more than a local grouping tweak — it is an ASSERTION ("this repo, by its git remote, belongs
// to company Y") that changes WHERE the member's Category-B tracking flows (into the SHARED company sync repo).
// So the decision must TRAVEL to other members, yet be APPLIED on their machines only through explicit consent.
//
// This module owns:
//   • assertCompanyOwnership / withdrawCompanyOwnership — write/tombstone the keyed entry in the company sync
//     repo's root `owner_map.yaml`, then commit + push via the existing Git backbone (repo_owner_propagation §2/§6).
//   • computePendingMappings — join the pulled assertions against THIS computer's repos by normalized remote,
//     dropping repos already owned by that company locally and repos in the machine-local declines file (§3).
//   • applyPendingMappings — for accepted rows write the local owner_override (same writer the manual reassign
//     uses); for declined rows remember the decline in the machine-local declines file (§4.3/§4.4).
//
// NEVER-THROW discipline (charter): every entry point is wrapped so a scan/HTTP caller never crashes over a git
// or fs fault — a fault WARNs and degrades (no assertion pushed / an empty pending list), keeping Local Storage
// authoritative. Node fs + the shared yaml-store + the git backbone only.
import fs from "node:fs";
import path from "node:path";
import {
  OwnerMapSchema,
  CompanyMappingDeclinesSchema,
  type PendingCompanyMapping,
  type CompanyMappingSelection,
  type CompanyMappingApplyResult,
} from "@lfb/shared";
import { readYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { storageUnitDir } from "../../shared/store/scopes.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { expandHome } from "../fs/badges.js";
import {
  GitBackbone,
  classifyRemote,
  normalizeRemoteKey,
  resolveRepoOwner,
  type GitCycleResult,
} from "../git/git.service.js";
import { getGitBackboneRemote } from "./storage-settings.service.js";
import { listStoragesPage } from "./storage.service.js";
import {
  listRepoFolders,
  getRepoConfig,
  folderForRepoId,
  setRepoOwnerOverride,
  repoIdFromPath,
} from "../store-model/units.service.js";
import { withStorageGitLock } from "../git/git-lock.js";
import { log } from "../../shared/logging.js";

const OWNER_MAP = "owner_map.yaml"; // at the company sync-repo ROOT (repo_owner_propagation.mdx §2)

/** The machine-local remembered-declines file (repo_owner_propagation.mdx §4.4) — never travels. */
function declinesFile(): string {
  return path.join(resolveStateDir(), "company_mapping_declines.yaml");
}

// Serialize git work per company on THE SAME lock the pin/device cycle uses (storage_company.mdx §11.3).
// This module used to keep its own private chain, which meant two independent locks guarded one working
// tree — and two locks over one tree are not a lock: an ownership assertion could land in the middle of a
// pin pass's merge and corrupt the index. The old comment conceded the overlap was "tolerated by git's
// non-ff retry"; it is not something to tolerate, so both paths now queue behind one lock keyed by storage id.
const withCompanyGitLock = withStorageGitLock;

// ── assertions (write side) ──────────────────────────────────────────────────

/**
 * Record (or refresh) a company-ownership assertion for `remote` in the company's sync-repo `owner_map.yaml`
 * and commit + push it (repo_owner_propagation.mdx §2). No-op when: the repo has no remote (no portable
 * identity — can't be asserted, §2), the company has no sync repo configured (stays a local-only override,
 * §6), or the sync-repo working copy can't be resolved. Best-effort — never throws.
 */
export async function assertCompanyOwnership(
  remote: string | null,
  companyId: string,
  assertedBy: string | null = null,
): Promise<void> {
  await mutateOwnerMap(remote, companyId, (doc, key) => {
    doc.assertions[key] = {
      remote: remote ?? "",
      asserted_by: assertedBy,
      asserted_at: new Date().toISOString(),
      withdrawn: false,
    };
  });
}

/**
 * Tombstone a company-ownership assertion (`withdrawn: true`) when a repo is reassigned away from the company
 * (repo_owner_propagation.mdx §6) — a tombstone, NOT a hard delete, so the withdrawal itself travels. Same
 * no-op / best-effort guarantees as {@link assertCompanyOwnership}.
 */
export async function withdrawCompanyOwnership(remote: string | null, companyId: string): Promise<void> {
  await mutateOwnerMap(remote, companyId, (doc, key) => {
    const existing = doc.assertions[key];
    doc.assertions[key] = {
      remote: existing?.remote || (remote ?? ""),
      asserted_by: existing?.asserted_by ?? null,
      asserted_at: new Date().toISOString(),
      withdrawn: true,
    };
  });
}

/** Resolve the company sync-repo working copy, pull, apply `mutate` to owner_map.yaml, then commit + push. */
async function mutateOwnerMap(
  remote: string | null,
  companyId: string,
  mutate: (doc: ReturnType<typeof OwnerMapSchema.parse>, key: string) => void,
): Promise<void> {
  const key = normalizeRemoteKey(remote);
  if (!key) {
    log.info("storage", `owner_map ${companyId}: repo has no portable remote — cannot assert (repo_owner_propagation.mdx §2)`);
    return;
  }
  const remoteCfg = getGitBackboneRemote(companyId);
  if (!remoteCfg) {
    log.info("storage", `owner_map ${companyId}: no sync repo configured — assertion stays local-only (repo_owner_propagation.mdx §6)`);
    return;
  }
  await withCompanyGitLock(companyId, async () => {
    try {
      const bb = await GitBackbone.resolve(companyId, remoteCfg.remote);
      if (!bb) {
        log.warn("storage", `owner_map ${companyId}: could not resolve sync-repo working copy — assertion skipped`);
        return;
      }
      const result: GitCycleResult = { ran: true };
      await bb.pull(result).catch((e) => {
        result.problem = `Git pull failed: ${(e as Error).message}`;
      });
      await updateYaml(path.join(bb.dir, OWNER_MAP), OwnerMapSchema, (doc) => {
        doc.company_id = companyId;
        mutate(doc, key);
        return doc;
      });
      await bb.commitAndPush(result).catch((e) => {
        result.problem = `Git push failed: ${(e as Error).message}`;
      });
      if (result.problem) log.warn("storage", `owner_map ${companyId}: ${result.problem}`);
      else log.info("storage", `owner_map ${companyId}: wrote assertion for ${key}${result.pushed ? " (pushed)" : ""}`);
    } catch (e) {
      log.warn("storage", `owner_map ${companyId}: mutate failed: ${(e as Error).message}`);
    }
  });
}

// ── pending mappings (read side) ─────────────────────────────────────────────

/** The company sync-repo working directory FOR READING (no clone / no network): the local-path checkout if it
 *  exists, else the already-present machine-local URL cache clone, else null. */
function syncRepoReadDir(companyId: string): string | null {
  const remoteCfg = getGitBackboneRemote(companyId);
  if (!remoteCfg) return null;
  const remote = remoteCfg.remote;
  if (classifyRemote(remote) === "local") {
    const dir = expandHome(remote);
    return fs.existsSync(path.join(dir, ".git")) ? dir : null;
  }
  const cache = path.join(storageUnitDir(companyId), "git");
  return fs.existsSync(path.join(cache, ".git")) ? cache : null;
}

interface LocalRepoRef {
  repoId: string;
  name: string;
  cfg: ReturnType<typeof getRepoConfig>;
}

/** Index THIS computer's repos by their normalized remote key (lowercased for case-insensitive matching). */
function indexLocalReposByRemote(): Map<string, LocalRepoRef> {
  const index = new Map<string, LocalRepoRef>();
  for (const folder of listRepoFolders()) {
    let cfg: ReturnType<typeof getRepoConfig>;
    try {
      cfg = getRepoConfig(folder);
    } catch {
      continue;
    }
    const key = normalizeRemoteKey(cfg.repo.remote);
    if (!key) continue;
    index.set(key.toLowerCase(), {
      repoId: repoIdFromPath(cfg.repo.path || folder),
      name: cfg.repo.name || folder,
      cfg,
    });
  }
  return index;
}

/** True when a (remoteKey, companyId) pair was previously declined AND that decline has not been superseded by
 *  a newer assertion (repo_owner_propagation.mdx §4.4). ISO strings compare lexicographically. */
function isDeclined(
  declines: ReturnType<typeof CompanyMappingDeclinesSchema.parse>,
  remoteKey: string,
  companyId: string,
  assertedAt: string | undefined,
): boolean {
  const d = declines.declined.find(
    (e) => e.remote_key.toLowerCase() === remoteKey.toLowerCase() && e.company_id === companyId,
  );
  if (!d) return false;
  // A fresh assertion (newer asserted_at than the decline) supersedes the decline → pending again.
  if (assertedAt && d.declined_at && assertedAt > d.declined_at) return false;
  return true;
}

/**
 * Compute this member's pending repo→company mappings (repo_owner_propagation.mdx §3): for each configured
 * company's sync repo, read `owner_map.yaml` and keep every non-withdrawn assertion whose normalized remote
 * matches a repo on THIS computer that is not already owned by that company locally and was not previously
 * declined. Recomputed fresh on each call (the GET endpoint) — no cache. Never throws (returns [] on fault).
 */
export function computePendingMappings(): PendingCompanyMapping[] {
  const out: PendingCompanyMapping[] = [];
  try {
    const companies = listStoragesPage().companies;
    if (companies.length === 0) return out;
    const localRepos = indexLocalReposByRemote();
    const declines = readYaml(declinesFile(), CompanyMappingDeclinesSchema);
    for (const company of companies) {
      const dir = syncRepoReadDir(company.id);
      if (!dir) continue; // no sync repo pulled here → nothing to review from this company
      let doc: ReturnType<typeof OwnerMapSchema.parse>;
      try {
        doc = readYaml(path.join(dir, OWNER_MAP), OwnerMapSchema);
      } catch (e) {
        log.warn("storage", `owner_map read failed for company ${company.id}: ${(e as Error).message}`);
        continue;
      }
      for (const [key, a] of Object.entries(doc.assertions)) {
        if (a.withdrawn) continue; // §3.1
        const local = localRepos.get(key.toLowerCase()); // §3.2 — this member has the repo
        if (!local) continue;
        // §3.3 — already owned by this company locally (override points at it) → in agreement, no review.
        const owner = resolveRepoOwner(local.cfg);
        if (owner.kind === "company" && owner.companyId === company.id) continue;
        // §3.4 / §4.4 — previously declined (and not superseded by a newer assertion).
        if (isDeclined(declines, key, company.id, a.asserted_at)) continue;
        out.push({
          repoId: local.repoId,
          repoName: local.name,
          remoteKey: key,
          companyId: company.id,
          companyName: company.companyName || company.name,
          assertedBy: a.asserted_by ?? "",
          assertedAt: a.asserted_at ?? "",
        });
      }
    }
  } catch (e) {
    log.warn("storage", `computePendingMappings failed: ${(e as Error).message}`);
  }
  return out;
}

/**
 * Apply the review page's batch (repo_owner_propagation.mdx §4.3): for every ACCEPTED row ("company") write the
 * repo's local `owner_override` to that company (the SAME writer the manual reassign uses — this does NOT
 * re-assert into owner_map.yaml); for every DECLINED row ("personal") remember the decline in the machine-local
 * declines file so it never re-nags (§4.4). A selection that no longer matches a current pending mapping (repo
 * gone / already resolved) is skipped. Never throws.
 */
export async function applyPendingMappings(
  selections: CompanyMappingSelection[],
): Promise<CompanyMappingApplyResult> {
  const summary: CompanyMappingApplyResult = { accepted: 0, declined: 0, skipped: 0 };
  try {
    const pending = computePendingMappings();
    const byRepo = new Map(pending.map((p) => [p.repoId, p]));
    for (const sel of selections) {
      const p = byRepo.get(sel.repoId);
      if (!p) {
        summary.skipped++;
        continue;
      }
      const folder = folderForRepoId(sel.repoId);
      if (!folder) {
        summary.skipped++;
        continue;
      }
      if (sel.decision === "company") {
        // Accept: write the local override to the company (source becomes "manual"). No re-assertion (§4.3).
        await setRepoOwnerOverride(folder, { kind: "company", company_id: p.companyId });
        summary.accepted++;
      } else {
        // Decline: remember it (keyed remote + company) so the review never re-nags (§4.4).
        await appendDecline(p.remoteKey, p.companyId);
        summary.declined++;
      }
    }
  } catch (e) {
    log.warn("storage", `applyPendingMappings failed: ${(e as Error).message}`);
  }
  return summary;
}

/** Append/refresh a remembered decline for (remoteKey, companyId) in the machine-local declines file. */
async function appendDecline(remoteKey: string, companyId: string): Promise<void> {
  await updateYaml(declinesFile(), CompanyMappingDeclinesSchema, (doc) => {
    const now = new Date().toISOString();
    const existing = doc.declined.find(
      (e) => e.remote_key.toLowerCase() === remoteKey.toLowerCase() && e.company_id === companyId,
    );
    if (existing) existing.declined_at = now;
    else doc.declined.push({ remote_key: remoteKey, company_id: companyId, declined_at: now });
    return doc;
  });
}
