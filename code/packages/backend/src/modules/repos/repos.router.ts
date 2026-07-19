// REST for the Repos + One-repo + per-repo settings screens (repos.mdx, one_repo.mdx, repo_settings.mdx).
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { RepoRow, RepoSettings, Decision, RepoDetail, MissingPinnedFile } from "@lfb/shared";
import {
  listRepoFolders,
  computeRepoRow,
  computeRepoDetail,
  registerRepo,
  unregisterRepo,
  folderForRepoId,
  getRepoConfig,
  updateRepoConfig,
  ownerForRepoConfig,
  setRepoOwnerOverride,
} from "../store-model/units.service.js";
import { startScan, getScanJob, maybeTriggerStaleScan } from "../scanner/scan-job.js";
import { pinRepoFolder, pinAll, missingPinnedFromPeers, pullMissing } from "../pin/pin.service.js";
import {
  recordDecision,
  readDecisionPolicy,
  setDecisionPolicy,
  shareStatus,
} from "../storage/decisions.service.js";
import { effectiveFlags } from "../store-model/config.service.js";
import { setSyncRepoMarker } from "../storage/tracking-sync.service.js";
import { resolveOwnerDedicatedRepo } from "../storage/artifact-placement.service.js";
import { getStorageRow } from "../storage/storage.service.js";
import { assertCompanyOwnership, withdrawCompanyOwnership } from "../storage/owner-propagation.service.js";
import { track } from "../progress/progress.registry.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { log } from "../../shared/logging.js";

/**
 * Absolute working-tree root for a state-root folder key — the same derivation the decisions service uses
 * (decisions.service.ts `repoRootFor`): the config `repo.path` with a leading `~` home-expanded. Needed to
 * drive the pin-service helpers (which take a repoRoot) and the Never-IPFS flag lookup (keyed by abs path).
 */
function repoRootFor(folder: string): string {
  const p = getRepoConfig(folder).repo.path;
  if (!p) throw new Error(`repo ${folder} has no path`);
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/**
 * Best-effort list of peer-pinned files this computer is missing (warnings.mdx §10.8.12). Wrapped so a slow
 * or erroring IPFS node never blocks / fails the repo-detail page — a fault yields [] and the warning simply
 * doesn't show. Augmented onto the RepoDetail at the router (computeRepoDetail stays sync + shared).
 */
async function missingPinnedSafe(repoRoot: string): Promise<MissingPinnedFile[]> {
  try {
    return await missingPinnedFromPeers(repoRoot);
  } catch (e) {
    log.warn("repos", `missingPinned lookup failed for ${repoRoot}: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Compute the One-repo detail with the LIVE pin reality folded in. Fetches this node's pinset ONCE (canonical,
 * knowledge/ipfs.mdx §5.1) and threads it into composeFileRows so every decided row carries `pinnedHere` — the
 * signal behind the three-state pin icon (one_repo.mdx §4.9: blue = decided & pinned here, red = decided but
 * this machine doesn't hold it yet). Best-effort: a down/slow node yields an undefined pinset (never blocks the
 * page), and the icon simply falls back to intent-only. This is the ONE choke point every RepoDetail-returning
 * handler uses, so a pin toggle's response reflects reality the same way the initial GET does.
 */
async function repoDetailWithPins(folder: string): Promise<RepoDetail> {
  const health = await ipfs.health();
  let pinset: Set<string> | undefined;
  try {
    pinset = await ipfs.canonicalPinnedSet();
  } catch (e) {
    log.debug("repos", `pinset fetch skipped for ${folder} (node unreachable?): ${(e as Error).message}`);
  }
  return computeRepoDetail(folder, health, pinset);
}

/** Repo-relative paths that carry the sticky Never-IPFS flag (decisions.mdx §17) — the IPFS axis is rejected
 *  for these at the write path. The flag is path-scoped (own entry OR any ancestor dir), read via the SAME
 *  accessor the policy engine uses (config.service `effectiveFlags`). */
function neverIpfsPaths(repoRoot: string, relPaths: string[]): string[] {
  return relPaths.filter((rel) => effectiveFlags(path.join(repoRoot, rel)).neverIpfs);
}

export const reposRouter = Router();
reposRouter.use(requireAllowListed);

// GET /api/repos — the Repos table.
reposRouter.get("/", (_req, res) => {
  try {
    // Freshness self-heal: if we haven't scanned the filesystem in >4h, kick a background scan now so the
    // next poll reflects current disk state. Non-blocking + single-flight (scan-job.ts) — never delays this
    // response and no-ops when a scan is already running or recent.
    maybeTriggerStaleScan("Repos list loaded");
    const rows: RepoRow[] = listRepoFolders().map(computeRepoRow);
    res.json({ ok: true, data: rows });
  } catch (e) {
    log.error("repos", `list failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos — add a repo by folder path.
reposRouter.post("/", async (req, res) => {
  const body = z.object({ path: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    const { repoId } = await registerRepo(body.data.path);
    // Kick a background scan to populate the new repo's status; do NOT block the response on the walk.
    // If a scan is already running, startScan coalesces this into a queued follow-up pass so the new
    // repo is still covered (scan-job.ts single-flight).
    startScan("manual");
    res.json({ ok: true, data: { repoId } });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos/rescan — trigger the discovery scan on demand. Returns IMMEDIATELY; the walk runs as
// a detached server-side job (scan-job.ts) so navigating away or a request timeout never cancels it.
reposRouter.post("/rescan", (_req, res) => {
  const result = startScan("manual");
  res.json({ ok: true, data: result });
});

// GET /api/repos/scan-status — live progress of the current/last discovery scan (scan.mdx §10). The
// progress bar polls this so it can re-attach after the user navigates away and back.
reposRouter.get("/scan-status", (_req, res) => {
  res.json({ ok: true, data: getScanJob() });
});

// POST /api/repos/:repoId/bookmark — toggle the favorite (repos.mdx §8). Persists to config.yaml;
// idempotent. Returns the updated RepoRow so the table can reconcile its optimistic flip.
reposRouter.post("/:repoId/bookmark", async (req, res) => {
  const body = z.object({ bookmarked: z.boolean() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "bookmarked (boolean) required" });
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    await updateRepoConfig(folder, (c) => ({ ...c, bookmarked: body.data.bookmarked }));
    log.info("repos", `${folder}: bookmarked -> ${body.data.bookmarked}`);
    res.json({ ok: true, data: computeRepoRow(folder) });
  } catch (e) {
    log.error("repos", `${folder}: bookmark update failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos/:repoId/owner — reassign a repo's owner (repo_company_mapping.mdx §5). Writes/clears the
// local `owner_override` in the repo's config.yaml (source becomes "manual"; a reset returns it to auto). When
// the NEW owner is a company that has a sync repo configured, ALSO records the travelling ownership assertion
// into that company's owner_map.yaml (repo_owner_propagation.mdx §2); when reassigning AWAY from a company that
// had it, tombstones that assertion. Idempotent. Unknown repoId → 404; company kind with an unknown companyId
// → 400 (repo_company_mapping.mdx §9).
const OwnerReassignBody = z.union([
  z.object({ reset: z.literal(true) }),
  z.object({ kind: z.enum(["personal", "company"]), companyId: z.string().optional() }),
]);
reposRouter.post("/:repoId/owner", async (req, res) => {
  const body = OwnerReassignBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "reset:true or { kind, companyId? } required" });
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });

  // The NEW override to persist (null clears → auto). A company kind requires a KNOWN company storage id.
  let next: { kind: "personal" | "company"; company_id: string | null } | null;
  if ("reset" in body.data) {
    next = null;
  } else if (body.data.kind === "personal") {
    next = { kind: "personal", company_id: null };
  } else {
    const companyId = body.data.companyId;
    if (!companyId) return res.status(400).json({ ok: false, error: "companyId required for a company owner" });
    const company = getStorageRow(companyId);
    if (!company || company.type !== "company") {
      return res.status(400).json({ ok: false, error: `unknown company: ${companyId}` });
    }
    next = { kind: "company", company_id: companyId };
  }

  try {
    // Capture the PRIOR company (if any) so a move away can tombstone its assertion (§6).
    const prev = getRepoConfig(folder).owner_override;
    const prevCompanyId = prev?.kind === "company" ? prev.company_id : null;
    const remote = getRepoConfig(folder).repo.remote;

    await setRepoOwnerOverride(folder, next);

    // Assertion side effects (repo_owner_propagation.mdx §2/§6) — best-effort; never fail the reassign on git.
    const nextCompanyId = next?.kind === "company" ? next.company_id : null;
    if (prevCompanyId && prevCompanyId !== nextCompanyId) {
      await withdrawCompanyOwnership(remote, prevCompanyId);
    }
    if (nextCompanyId) {
      await assertCompanyOwnership(remote, nextCompanyId, currentUser(req).email);
    }

    log.info("repos", `${folder}: owner reassigned -> ${next ? next.kind + (nextCompanyId ? `:${nextCompanyId}` : "") : "auto"}`);
    res.json({ ok: true, data: computeRepoRow(folder) });
  } catch (e) {
    log.error("repos", `${folder}: owner reassign failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// DELETE /api/repos/:repoId — remove repo (unregister, menus.mdx §5.1). Unregisters from LFB ONLY;
// never deletes the folder or any local file on disk (menus.mdx §6.2). Idempotent.
reposRouter.delete("/:repoId", (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    unregisterRepo(folder);
    res.json({ ok: true, data: { removed: true } });
  } catch (e) {
    log.error("repos", `${folder}: unregister failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/repos/:repoId — the One-repo detail (header + status strip + files).
reposRouter.get("/:repoId", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    // Freshness self-heal on page load (>4h stale → background scan). Non-blocking + single-flight, so it
    // never delays the detail response and coalesces harmlessly if a scan is already running.
    maybeTriggerStaleScan(`One-repo detail loaded (${folder})`);
    const detail: RepoDetail = await repoDetailWithPins(folder);
    // Augment with the peer-pinned-but-missing set so the §10.8.12 "pull them down" warning has data.
    // Best-effort at the router (computeRepoDetail is sync + shared): a down/slow IPFS never blocks the page.
    detail.missingPinned = await missingPinnedSafe(repoRootFor(folder));
    res.json({ ok: true, data: detail });
  } catch (e) {
    log.error("repos", `${folder}: detail failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/repos/:repoId/files — just the file rows.
reposRouter.get("/:repoId/files", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    const detail = await repoDetailWithPins(folder);
    res.json({ ok: true, data: detail.files });
  } catch (e) {
    log.error("repos", `${folder}: files failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/repos/:repoId/files — record a decision on one or many files (bulk). Two accepted bodies,
// both funneling through the shared decision ledger (decisions.mdx §8):
//   • TWO-AXIS (the checkbox popup):  { paths, ipfs?, gitignore? }  — the full decision, both axes.
//   • LEGACY single-axis (per-row / bulk IPFS control): { paths, decision: sync|ignore|undecided }
//     — mapped onto the IPFS axis (sync→ipfs:true, ignore→ipfs:false, undecided→un-decide/tombstone).
reposRouter.patch("/:repoId/files", async (req, res) => {
  const body = z
    .object({
      paths: z.array(z.string()).min(1),
      // Two-axis form (either box may be omitted; both-off is a valid decision — decisions.mdx §1).
      ipfs: z.boolean().optional(),
      gitignore: z.boolean().optional(),
      // Legacy single-axis form.
      decision: z.enum(["sync", "ignore", "undecided"]).optional(),
    })
    .safeParse(req.body);
  if (!body.success || (body.data.decision === undefined && body.data.ipfs === undefined && body.data.gitignore === undefined)) {
    return res.status(400).json({ ok: false, error: "paths + (ipfs/gitignore) or decision required" });
  }
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });

  const decidedBy = currentUser(req).email; // who decided — from the authenticated session (decisions.mdx §3.3)
  const paths = body.data.paths;

  // NEVER-IPFS GUARD (decisions.mdx §17/§20): a decision that turns the IPFS axis ON is REJECTED at the write
  // path for any target carrying the sticky Never-IPFS flag. This covers both the two-axis form (ipfs===true)
  // and the legacy single-axis form (decision==="sync" → ipfs:true). The git-ignore axis is unaffected, so a
  // both-off write, a gitignore-only write, or an ipfs:false/"ignore" write are all still allowed.
  const settingIpfsOn = body.data.decision === "sync" || body.data.ipfs === true;
  if (settingIpfsOn) {
    let blocked: string[];
    try {
      blocked = neverIpfsPaths(repoRootFor(folder), paths);
    } catch (e) {
      log.error("repos", `${folder}: never-ipfs check failed: ${(e as Error).message}`);
      return res.status(500).json({ ok: false, error: (e as Error).message });
    }
    if (blocked.length > 0) {
      log.info("repos", `${folder}: rejected IPFS decision — ${blocked.length} Never-IPFS file(s)`);
      return res.status(409).json({
        ok: false,
        error: `Cannot add to IPFS: ${blocked.length} file(s) are flagged Never IPFS: ${blocked.join(", ")}`,
        data: { neverIpfs: blocked },
      });
    }
  }

  try {
    if (body.data.decision !== undefined) {
      // Legacy single-axis → IPFS axis. "undecided" removes the record (returns to triage).
      const decision = body.data.decision as Decision;
      if (decision === "undecided") {
        await recordDecision(folder, paths, {}, decidedBy, { asked: false });
      } else {
        await recordDecision(folder, paths, { ipfs: decision === "sync" }, decidedBy);
      }
      log.info("repos", `${folder}: set ${paths.length} file(s) -> ${decision} (ledger)`);
    } else {
      // Two-axis decision from the checkbox popup — both axes as chosen (either may be undefined).
      // `unignore: true` — this is THE user-facing click, the only path allowed to remove a `.gitignore`
      // line (git_ignore.mdx §5.5). It still only ever removes an exact anchored single-file line.
      await recordDecision(folder, paths, { ipfs: body.data.ipfs, gitignore: body.data.gitignore }, decidedBy, {
        unignore: true,
      });
      log.info(
        "repos",
        `${folder}: decided ${paths.length} file(s) ipfs=${!!body.data.ipfs} gitignore=${!!body.data.gitignore} by ${decidedBy ?? "?"}`,
      );
    }
    const detail: RepoDetail = await repoDetailWithPins(folder);
    detail.missingPinned = await missingPinnedSafe(repoRootFor(folder));
    res.json({ ok: true, data: detail });
  } catch (e) {
    log.error("repos", `${folder}: file decision update failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos/:repoId/pull — pull peer-pinned files this computer is missing DOWN over IPFS
// (warnings.mdx §10.8.12 C). Body: { paths: string[] (repo-relative, >=1), compress?: boolean }. Pinning the
// manifest CID fetches the bytes (no re-add / new CID) and materializes them into the working tree; with
// compress set, each pulled media file is queued for background compression. NON-destructive (only ADDS local
// copies) — no red confirm. Returns the recomputed repo detail (same shape as PATCH /files) so the UI
// re-renders and the "pull them down" warning leaves the page once the bytes are here.
reposRouter.post("/:repoId/pull", async (req, res) => {
  const body = z
    .object({ paths: z.array(z.string()).min(1), compress: z.boolean().optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths (>=1) required" });
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const by = currentUser(req).email;
  try {
    const repoRoot = repoRootFor(folder);
    const counts = await pullMissing(repoRoot, body.data.paths, { compress: !!body.data.compress, by });
    log.info(
      "repos",
      `${folder}: pulled ${counts.pulled} file(s), ${counts.failed} failed (compress=${!!body.data.compress}) by ${by ?? "?"}`,
    );
    const detail: RepoDetail = await repoDetailWithPins(folder);
    detail.missingPinned = await missingPinnedSafe(repoRoot);
    res.json({ ok: true, data: detail });
  } catch (e) {
    log.error("repos", `${folder}: pull failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos/:repoId/pin — Pin now (whole repo or selected files).
reposRouter.post("/:repoId/pin", async (req, res) => {
  const body = z.object({ paths: z.array(z.string()).optional() }).safeParse(req.body ?? {});
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const only = body.success && body.data.paths ? new Set(body.data.paths) : undefined;
  try {
    // Pin THIS repo first as the priority unit (manual = explicit opt-in), then answer immediately so
    // the button feels instant. A manual Pin now is still a FULL PASS: after responding we run the
    // pass over every OTHER known unit in the background so it never blocks the response
    // (pin_process.mdx §2/§3). `priorityDone` stops the pass re-pinning the repo we just did.
    // Register the manual pin in the progress registry so the dock shows a live card — including for
    // a poll from another tab (webapp.mdx §12 source B). track() always ends the job, success or error.
    const repoName = getRepoConfig(folder).repo.name || folder;
    // Report what the run ACTUALLY did (counts), never a fixed "complete" string (pin_process.mdx §6).
    const counts = await track("pin", repoName, () => pinRepoFolder(folder, only, { manual: true }));
    const detail = await repoDetailWithPins(folder);
    res.json({ ok: true, data: { detail, counts } });
    void pinAll({ priorityDone: folder }).catch((e) =>
      log.error("repos", `full pass after manual pin of ${folder} failed: ${(e as Error).message}`),
    );
  } catch (e) {
    log.error("repos", `${folder}: pin failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/repos/:repoId/settings — per-repo settings (repo_settings.mdx).
reposRouter.get("/:repoId/settings", (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    res.json({ ok: true, data: toRepoSettings(req.params.repoId, folder) });
  } catch (e) {
    log.error("repos", `${folder}: read settings failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/repos/:repoId/settings
reposRouter.patch("/:repoId/settings", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const patch = RepoSettingsPatch.safeParse(req.body);
  if (!patch.success) return res.status(400).json({ ok: false, error: patch.error.message });
  const p = patch.data;
  try {
    await updateRepoConfig(folder, (c) => {
    if (p.pinned !== undefined) c.pinned = p.pinned;
    if (p.bigFileOverride) c.big_file_override = { ...c.big_file_override, ...p.bigFileOverride };
    if (p.largeFiles)
      c.large_files = {
        follow_gitignore: p.largeFiles.followGitignore ?? c.large_files.follow_gitignore,
        include_globs: p.largeFiles.includeGlobs ?? c.large_files.include_globs,
        exclude_globs: p.largeFiles.excludeGlobs ?? c.large_files.exclude_globs,
      };
    if (p.pin)
      c.pin = {
        pin_locally: p.pin.pinLocally ?? c.pin.pin_locally,
        fetch_missing: p.pin.fetchMissing ?? c.pin.fetch_missing,
        publish_manifest: p.pin.publishManifest ?? c.pin.publish_manifest,
      };
    if (p.access)
      c.access = {
        shared: p.access.shared ?? c.access.shared,
        participants: p.access.participants ?? c.access.participants,
      };
    if (p.transcription?.placement) c.artifacts = { ...c.artifacts, transcription_placement: p.transcription.placement };
    if (p.aiDescription?.placement) c.artifacts = { ...c.artifacts, ai_description_placement: p.aiDescription.placement };
    if (p.syncRepo?.enabled !== undefined) c.sync_repo = { ...c.sync_repo, enabled: p.syncRepo.enabled };
    return c;
  });
    // Reflect the sync-repo toggle onto the Local-Storage marker that resolveStateSyncRepo/mirrorToSyncRepo
    // read: ON → point it at the owning storage's dedicated sync repo (null if none configured, which leaves
    // it Local-Storage-only); OFF → remove the marker (artifact_placement_policy.mdx §4).
    if (p.syncRepo?.enabled !== undefined) {
      const repoPath = getRepoConfig(folder).repo.path;
      if (repoPath) {
        setSyncRepoMarker(repoPath, p.syncRepo.enabled ? resolveOwnerDedicatedRepo(repoPath) : null);
      }
    }
    res.json({ ok: true, data: toRepoSettings(req.params.repoId, folder) });
  } catch (e) {
    log.error("repos", `${folder}: update settings failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/repos/:repoId/decision-policy — the SHARED per-repo default-decision + attribution policy plus
// whether decisions made here actually reach a team (decisions.mdx §9/§14/§15, repo_settings.mdx §2.7/§2.8).
reposRouter.get("/:repoId/decision-policy", (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    res.json({
      ok: true,
      data: { policy: readDecisionPolicy(folder), shareStatus: shareStatus(folder) },
    });
  } catch (e) {
    log.error("repos", `${folder}: read decision-policy failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/repos/:repoId/decision-policy — merge a partial policy into the shared doc (decisions.mdx §9).
// Changing the policy is itself an audited decision: stamp who set it (set_by) from the authenticated session
// so a later auto-decide can attribute `policy:<set_by>`. Returns the updated policy.
reposRouter.patch("/:repoId/decision-policy", (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const patch = DecisionPolicyPatch.safeParse(req.body);
  if (!patch.success) return res.status(400).json({ ok: false, error: patch.error.message });
  try {
    const setBy = currentUser(req).email;
    const updated = setDecisionPolicy(folder, { ...patch.data, set_by: patch.data.set_by ?? setBy });
    log.info("repos", `${folder}: decision-policy updated by ${setBy ?? "?"}`);
    res.json({ ok: true, data: updated });
  } catch (e) {
    log.error("repos", `${folder}: update decision-policy failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// A validated PARTIAL of the decision policy doc (decisions.mdx §9/§14). attribution accepts the three modes
// or null (auto: resolve from the remote). media/other are the full kind-policy shape { mode, ipfs, gitignore }.
const DecisionKindPolicyPatch = z.object({
  mode: z.enum(["auto", "ask"]),
  ipfs: z.boolean(),
  gitignore: z.boolean(),
});
const DecisionPolicyPatch = z.object({
  attribution: z.enum(["email", "handle", "anonymous"]).nullable().optional(),
  media: DecisionKindPolicyPatch.optional(),
  other: DecisionKindPolicyPatch.optional(),
  set_by: z.string().nullable().optional(),
});

const RepoSettingsPatch = z.object({
  pinned: z.boolean().optional(),
  bigFileOverride: z
    .object({ enabled: z.boolean(), value: z.number(), unit: z.enum(["MB", "GB", "TB"]) })
    .partial()
    .optional(),
  largeFiles: z
    .object({
      followGitignore: z.boolean(),
      includeGlobs: z.array(z.string()),
      excludeGlobs: z.array(z.string()),
    })
    .partial()
    .optional(),
  pin: z
    .object({ pinLocally: z.boolean(), fetchMissing: z.boolean(), publishManifest: z.boolean() })
    .partial()
    .optional(),
  access: z
    .object({ shared: z.boolean(), participants: z.array(z.string()) })
    .partial()
    .optional(),
  // Transcription / AI-description placement radios (repo_settings.mdx §4-5, placement_radios.mdx).
  transcription: z.object({ placement: z.enum(["lfbridge", "beside", "sync_repo"]) }).partial().optional(),
  aiDescription: z.object({ placement: z.enum(["lfbridge", "beside", "sync_repo"]) }).partial().optional(),
  // Sync-tracking-state-to-the-company-sync-repo toggle (repo_settings.mdx §2.9).
  syncRepo: z.object({ enabled: z.boolean() }).partial().optional(),
});

function toRepoSettings(repoId: string, folder: string): RepoSettings {
  const c = getRepoConfig(folder);
  return {
    repoId,
    name: c.repo.name || folder,
    path: c.repo.path,
    remote: c.repo.remote,
    pinned: c.pinned,
    bigFileOverride: {
      enabled: c.big_file_override.enabled,
      value: c.big_file_override.value,
      unit: c.big_file_override.unit,
    },
    largeFiles: {
      followGitignore: c.large_files.follow_gitignore,
      includeGlobs: c.large_files.include_globs,
      excludeGlobs: c.large_files.exclude_globs,
    },
    pin: {
      pinLocally: c.pin.pin_locally,
      fetchMissing: c.pin.fetch_missing,
      publishManifest: c.pin.publish_manifest,
    },
    access: { shared: c.access.shared, participants: c.access.participants },
    // Company/personal owner: local owner_override (manual) else derived from the git remote (auto)
    // (repo_settings.mdx §6 / repo_company_mapping.mdx §5.2).
    owner: ownerForRepoConfig(c),
    // Transcription / AI-description placement (repo_settings.mdx §4-5, placement_radios.mdx).
    transcription: { placement: c.artifacts.transcription_placement },
    aiDescription: { placement: c.artifacts.ai_description_placement },
    // Whether this repo mirrors its tracking state to the owner's sync repo (repo_settings.mdx §2.9).
    syncRepo: { enabled: c.sync_repo.enabled },
  };
}
