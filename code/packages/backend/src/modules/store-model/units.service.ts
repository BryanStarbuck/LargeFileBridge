// The two sync units (storage.mdx §5–§9). Composes RepoRow / RepoDetail for the UI.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  RepoUnitConfigSchema,
  ComputerUnitConfigSchema,
  ManifestSchema,
  UnitStatusSchema,
  type RepoUnitConfig,
  type Manifest,
  type UnitStatus,
  type RepoRow,
  type RepoDetail,
  type FileRow,
  type RepoCounts,
  type RepoStatus,
  type TransferStatus,
  type Decision,
  type IpfsHealth,
} from "@lfb/shared";
import type { ComputerUnitConfig } from "@lfb/shared";
import { readYaml, updateYaml, writeYaml } from "../../shared/store/yaml-store.js";
import {
  reposRoot,
  repoUnitDir,
  computerUnitDir,
  unitConfigPath,
  unitManifestPath,
  unitStatusPath,
  repoFolderKey,
} from "../../shared/store/scopes.js";
import { ensureDir } from "../../config/state-dir.js";
import { getPeers } from "./peers.service.js";
import { log } from "../../shared/logging.js";

export function repoIdFromPath(absPath: string): string {
  return crypto.createHash("sha1").update(path.resolve(absPath)).digest("hex").slice(0, 16);
}

export function listRepoFolders(): string[] {
  try {
    return fs
      .readdirSync(reposRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    // A missing repos root is normal before the first repo is registered — stay quiet on ENOENT.
    // Anything else (permissions, corrupt state root) is a real fault worth the trail.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("units", `listRepoFolders failed: ${(e as Error).message}`);
    }
    return [];
  }
}

// ── Repo unit reads/writes ──────────────────────────────────────────────────
export function getRepoConfig(folder: string): RepoUnitConfig {
  return readYaml(unitConfigPath(repoUnitDir(folder)), RepoUnitConfigSchema);
}
export function getRepoManifest(folder: string): Manifest {
  return readYaml(unitManifestPath(repoUnitDir(folder)), ManifestSchema);
}
export function getRepoStatus(folder: string): UnitStatus {
  return readYaml(unitStatusPath(repoUnitDir(folder)), UnitStatusSchema);
}
export async function updateRepoConfig(
  folder: string,
  mutate: (c: RepoUnitConfig) => RepoUnitConfig,
): Promise<RepoUnitConfig> {
  return updateYaml(unitConfigPath(repoUnitDir(folder)), RepoUnitConfigSchema, mutate);
}
export function writeRepoStatus(folder: string, status: UnitStatus): void {
  writeYaml(unitStatusPath(repoUnitDir(folder)), { ...status });
}
export function writeRepoManifest(folder: string, manifest: Manifest): void {
  writeYaml(unitManifestPath(repoUnitDir(folder)), { ...manifest });
}

// ── Computer unit reads/writes (storage.mdx §8; sync_process.mdx §2 — part of every full pass) ──
export function getComputerConfig(): ComputerUnitConfig {
  return readYaml(unitConfigPath(computerUnitDir()), ComputerUnitConfigSchema);
}
export function getComputerManifest(): Manifest {
  return readYaml(unitManifestPath(computerUnitDir()), ManifestSchema);
}
export function getComputerStatus(): UnitStatus {
  return readYaml(unitStatusPath(computerUnitDir()), UnitStatusSchema);
}
export async function updateComputerConfig(
  mutate: (c: ComputerUnitConfig) => ComputerUnitConfig,
): Promise<ComputerUnitConfig> {
  return updateYaml(unitConfigPath(computerUnitDir()), ComputerUnitConfigSchema, mutate);
}
export function writeComputerStatus(status: UnitStatus): void {
  writeYaml(unitStatusPath(computerUnitDir()), { ...status });
}
export function writeComputerManifest(manifest: Manifest): void {
  writeYaml(unitManifestPath(computerUnitDir()), { ...manifest });
}

/** Resolve a repoId (from the UI) to its state-root folder name. */
export function folderForRepoId(repoId: string): string | null {
  for (const folder of listRepoFolders()) {
    const cfg = getRepoConfig(folder);
    if (cfg.repo.path && repoIdFromPath(cfg.repo.path) === repoId) return folder;
  }
  return null;
}

/** Register a new repo unit (repos.mdx §6). Validates it is a git working tree. */
export async function registerRepo(absPath: string): Promise<{ folder: string; repoId: string }> {
  const resolved = path.resolve(absPath.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
  if (!isGitWorkingTree(resolved)) {
    throw new Error("Not a git working tree");
  }
  const repoId = repoIdFromPath(resolved);
  const existing = folderForRepoId(repoId);
  if (existing) throw new Error("Repo already registered");

  const name = path.basename(resolved);
  let folder = repoFolderKey(name);
  const taken = new Set(listRepoFolders());
  let n = 2;
  while (taken.has(folder)) folder = `${repoFolderKey(name)}-${n++}`;

  ensureDir(repoUnitDir(folder));
  await updateRepoConfig(folder, (c) => ({
    ...c,
    repo: { name, path: resolved, remote: readGitRemote(resolved) },
    synced: false, // discovered but off until the user opts in (storage.mdx §7)
  }));
  const status = UnitStatusSchema.parse({});
  status.folder_name = folder;
  writeRepoStatus(folder, status);
  log.info("units", `Registered repo ${name} -> sync/r/${folder}`);
  return { folder, repoId };
}

/**
 * Unregister a repo unit (menus.mdx §5.1 "Remove repo"). Removes ONLY LFB's tracking state — the
 * unit directory under the state root ({@link repoUnitDir}). It NEVER touches the user's actual repo
 * folder or any local file on disk (charter / menus.mdx §6.2: local bytes are never deleted by LFB).
 */
export function unregisterRepo(folder: string): void {
  try {
    fs.rmSync(repoUnitDir(folder), { recursive: true, force: true });
  } catch (e) {
    // force:true already tolerates absence — a throw here means the tracking state couldn't be
    // removed (e.g. permissions). Surface it before it propagates to the caller.
    log.error("units", `Unregister repo unit sync/r/${folder} failed: ${(e as Error).message}`);
    throw e;
  }
  log.info("units", `Unregistered repo unit sync/r/${folder} (local files untouched)`);
}

// ── Row / detail composition ────────────────────────────────────────────────
export function computeRepoRow(folder: string): RepoRow {
  const cfg = getRepoConfig(folder);
  const status = getRepoStatus(folder);
  const manifest = getRepoManifest(folder);
  const files = composeFileRows(folder, cfg, status, manifest);
  const counts = countDecisions(files);
  const peerCount = peerCountForFiles(files);
  return {
    repoId: repoIdFromPath(cfg.repo.path || folder),
    bookmarked: cfg.bookmarked,
    name: cfg.repo.name || folder,
    path: cfg.repo.path || "",
    counts,
    peerCount,
    lastSyncAt: status.last_sync_at,
    status: rollupStatus(cfg.synced, counts, status, files),
    synced: cfg.synced,
  };
}

export function computeRepoDetail(folder: string, ipfs: IpfsHealth): RepoDetail {
  const cfg = getRepoConfig(folder);
  const status = getRepoStatus(folder);
  const manifest = getRepoManifest(folder);
  const files = composeFileRows(folder, cfg, status, manifest);
  const counts = countDecisions(files);
  return {
    repoId: repoIdFromPath(cfg.repo.path || folder),
    name: cfg.repo.name || folder,
    path: cfg.repo.path || "",
    remote: cfg.repo.remote,
    synced: cfg.synced,
    status: rollupStatus(cfg.synced, counts, status, files),
    peerCount: peerCountForFiles(files),
    lastSyncAt: status.last_sync_at,
    ipfs,
    counts,
    files,
  };
}

// One FileRow per discovered big-file candidate, joined with its decision + manifest CID.
function composeFileRows(
  _folder: string,
  cfg: RepoUnitConfig,
  status: UnitStatus,
  manifest: Manifest,
): FileRow[] {
  const manifestByPath = new Map(manifest.files.map((f) => [f.path, f]));
  return status.candidates.map((cand) => {
    const decision: Decision = cfg.decisions[cand.path] ?? "undecided";
    const m = manifestByPath.get(cand.path);
    const peers = m?.pinned_by ?? [];
    return {
      fileId: `${repoIdFromPath(cfg.repo.path || "")}:${cand.path}`,
      path: cand.path,
      sizeBytes: cand.size,
      cid: decision === "sync" ? (m?.cid ?? null) : null,
      decision,
      transfer: transferFor(decision, m?.cid ?? null, peers),
      peers,
      changedAt: cand.modified_at ?? status.last_scan_at ?? new Date(0).toISOString(),
    };
  });
}

function transferFor(decision: Decision, cid: string | null, peers: string[]): TransferStatus {
  if (decision !== "sync") return "na";
  if (!cid) return "pending";
  return peers.length > 0 ? "synced" : "pending";
}

function countDecisions(files: FileRow[]): RepoCounts {
  const counts: RepoCounts = { synced: 0, pending: 0, undecided: 0, ignored: 0 };
  for (const f of files) {
    if (f.decision === "ignore") counts.ignored++;
    else if (f.decision === "undecided") counts.undecided++;
    else if (f.decision === "sync") {
      if (f.transfer === "synced") counts.synced++;
      else counts.pending++;
    }
  }
  return counts;
}

function peerCountForFiles(files: FileRow[]): number {
  const set = new Set<string>();
  for (const f of files) for (const p of f.peers) set.add(p);
  return set.size;
}

// Rolled-up status with the LOCKED precedence (repos.mdx §4.2).
function rollupStatus(
  synced: boolean,
  counts: RepoCounts,
  status: UnitStatus,
  files: FileRow[],
): RepoStatus {
  if (status.last_error || status.repo_state === "missing") return "error";
  const transferring = files.some((f) => f.transfer === "fetching" || f.transfer === "pushing");
  if (transferring) return "syncing";
  if (counts.pending > 0) return "behind";
  if (counts.undecided > 0) return "needs_review";
  if (!status.last_sync_at) return synced ? "never" : "never";
  return "up_to_date";
}

// ── git helpers (no shell for scanning; git metadata read from files) ───────
export function isGitWorkingTree(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

export function readGitRemote(dir: string): string | null {
  try {
    const gitPath = path.join(dir, ".git");
    const st = fs.statSync(gitPath);
    const configFile = st.isDirectory()
      ? path.join(gitPath, "config")
      : path.join(dir, resolveGitdir(gitPath), "config");
    const cfg = fs.readFileSync(configFile, "utf8");
    const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/s);
    if (m) return m[1].split("\n")[0].trim();
  } catch {
    /* no remote is fine */
  }
  return null;
}

function resolveGitdir(gitFile: string): string {
  try {
    const raw = fs.readFileSync(gitFile, "utf8");
    const m = raw.match(/gitdir:\s*(.+)/);
    return m ? m[1].trim() : ".git";
  } catch {
    return ".git";
  }
}

export { ComputerUnitConfigSchema, getPeers };
