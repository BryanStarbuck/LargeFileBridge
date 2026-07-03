// REST for the Repos + One-repo + per-repo settings screens (repos.mdx, one_repo.mdx, repo_settings.mdx).
import { Router } from "express";
import { z } from "zod";
import type { RepoRow, RepoSettings, Decision } from "@lfb/shared";
import {
  listRepoFolders,
  computeRepoRow,
  computeRepoDetail,
  registerRepo,
  folderForRepoId,
  getRepoConfig,
  updateRepoConfig,
} from "../store-model/units.service.js";
import { startScan, getScanJob } from "../scanner/scan-job.js";
import { syncRepoFolder } from "../sync/sync.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";

export const reposRouter = Router();
reposRouter.use(requireAllowListed);

// GET /api/repos — the Repos table.
reposRouter.get("/", (_req, res) => {
  const rows: RepoRow[] = listRepoFolders().map(computeRepoRow);
  res.json({ ok: true, data: rows });
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
  await updateRepoConfig(folder, (c) => ({ ...c, bookmarked: body.data.bookmarked }));
  log.info("repos", `${folder}: bookmarked -> ${body.data.bookmarked}`);
  res.json({ ok: true, data: computeRepoRow(folder) });
});

// GET /api/repos/:repoId — the One-repo detail (header + status strip + files).
reposRouter.get("/:repoId", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const detail = computeRepoDetail(folder, await ipfs.health());
  res.json({ ok: true, data: detail });
});

// GET /api/repos/:repoId/files — just the file rows.
reposRouter.get("/:repoId/files", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const detail = computeRepoDetail(folder, await ipfs.health());
  res.json({ ok: true, data: detail.files });
});

// PATCH /api/repos/:repoId/files — set a decision on one or many files (bulk).
reposRouter.patch("/:repoId/files", async (req, res) => {
  const body = z
    .object({
      paths: z.array(z.string()).min(1),
      decision: z.enum(["sync", "ignore", "undecided"]),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths + decision required" });
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });

  const decision = body.data.decision as Decision;
  await updateRepoConfig(folder, (c) => {
    for (const p of body.data.paths) {
      if (decision === "undecided") delete c.decisions[p];
      else c.decisions[p] = decision;
    }
    return c;
  });
  log.info("repos", `${folder}: set ${body.data.paths.length} file(s) -> ${decision}`);
  const detail = computeRepoDetail(folder, await ipfs.health());
  res.json({ ok: true, data: detail });
});

// POST /api/repos/:repoId/sync — Sync now (whole repo or selected files).
reposRouter.post("/:repoId/sync", async (req, res) => {
  const body = z.object({ paths: z.array(z.string()).optional() }).safeParse(req.body ?? {});
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const only = body.success && body.data.paths ? new Set(body.data.paths) : undefined;
  try {
    await syncRepoFolder(folder, only);
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
  const detail = computeRepoDetail(folder, await ipfs.health());
  res.json({ ok: true, data: detail });
});

// GET /api/repos/:repoId/settings — per-repo settings (repo_settings.mdx).
reposRouter.get("/:repoId/settings", (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  res.json({ ok: true, data: toRepoSettings(req.params.repoId, folder) });
});

// PATCH /api/repos/:repoId/settings
reposRouter.patch("/:repoId/settings", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const patch = RepoSettingsPatch.safeParse(req.body);
  if (!patch.success) return res.status(400).json({ ok: false, error: patch.error.message });
  const p = patch.data;
  await updateRepoConfig(folder, (c) => {
    if (p.synced !== undefined) c.synced = p.synced;
    if (p.bigFileOverride) c.big_file_override = { ...c.big_file_override, ...p.bigFileOverride };
    if (p.largeFiles)
      c.large_files = {
        follow_gitignore: p.largeFiles.followGitignore ?? c.large_files.follow_gitignore,
        include_globs: p.largeFiles.includeGlobs ?? c.large_files.include_globs,
        exclude_globs: p.largeFiles.excludeGlobs ?? c.large_files.exclude_globs,
      };
    if (p.sync)
      c.sync = {
        pin_locally: p.sync.pinLocally ?? c.sync.pin_locally,
        fetch_missing: p.sync.fetchMissing ?? c.sync.fetch_missing,
        publish_manifest: p.sync.publishManifest ?? c.sync.publish_manifest,
      };
    if (p.access)
      c.access = {
        shared: p.access.shared ?? c.access.shared,
        participants: p.access.participants ?? c.access.participants,
      };
    return c;
  });
  res.json({ ok: true, data: toRepoSettings(req.params.repoId, folder) });
});

const RepoSettingsPatch = z.object({
  synced: z.boolean().optional(),
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
  sync: z
    .object({ pinLocally: z.boolean(), fetchMissing: z.boolean(), publishManifest: z.boolean() })
    .partial()
    .optional(),
  access: z
    .object({ shared: z.boolean(), participants: z.array(z.string()) })
    .partial()
    .optional(),
});

function toRepoSettings(repoId: string, folder: string): RepoSettings {
  const c = getRepoConfig(folder);
  return {
    repoId,
    name: c.repo.name || folder,
    path: c.repo.path,
    remote: c.repo.remote,
    synced: c.synced,
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
    sync: {
      pinLocally: c.sync.pin_locally,
      fetchMissing: c.sync.fetch_missing,
      publishManifest: c.sync.publish_manifest,
    },
    access: { shared: c.access.shared, participants: c.access.participants },
  };
}
