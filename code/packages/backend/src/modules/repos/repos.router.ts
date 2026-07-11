// REST for the Repos + One-repo + per-repo settings screens (repos.mdx, one_repo.mdx, repo_settings.mdx).
import { Router } from "express";
import { z } from "zod";
import type { RepoRow, RepoSettings, Decision } from "@lfb/shared";
import {
  listRepoFolders,
  computeRepoRow,
  computeRepoDetail,
  registerRepo,
  unregisterRepo,
  folderForRepoId,
  getRepoConfig,
  updateRepoConfig,
} from "../store-model/units.service.js";
import { startScan, getScanJob } from "../scanner/scan-job.js";
import { pinRepoFolder, pinAll } from "../pin/pin.service.js";
import { track } from "../progress/progress.registry.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";

export const reposRouter = Router();
reposRouter.use(requireAllowListed);

// GET /api/repos — the Repos table.
reposRouter.get("/", (_req, res) => {
  try {
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
    const detail = computeRepoDetail(folder, await ipfs.health());
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
    const detail = computeRepoDetail(folder, await ipfs.health());
    res.json({ ok: true, data: detail.files });
  } catch (e) {
    log.error("repos", `${folder}: files failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
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
  try {
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
  } catch (e) {
    log.error("repos", `${folder}: file decision update failed: ${(e as Error).message}`);
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
    const detail = computeRepoDetail(folder, await ipfs.health());
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
    return c;
  });
    res.json({ ok: true, data: toRepoSettings(req.params.repoId, folder) });
  } catch (e) {
    log.error("repos", `${folder}: update settings failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
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
  };
}
