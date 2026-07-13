// The two pin units (storage.mdx §5–§9). Composes RepoRow / RepoDetail for the UI.
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
  type TaskStatus,
  type TaskMetrics,
  mediaKindForName,
} from "@lfb/shared";
import type { ComputerUnitConfig } from "@lfb/shared";
import { compressInfo } from "../fs/badges.js";
import { analysisOutputs } from "../storage/tracking.service.js";
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
import { readLedger, foldLedger, type FoldedDecision } from "../storage/decisions.service.js";
import { effectiveFlags } from "./config.service.js";
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

// ── Computer unit reads/writes (storage.mdx §8; pin_process.mdx §2 — part of every full pass) ──
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
    pinned: false, // discovered but off until the user opts in (storage.mdx §7)
  }));
  const status = UnitStatusSchema.parse({});
  status.folder_name = folder;
  writeRepoStatus(folder, status);
  log.info("units", `Registered repo ${name} -> pin/r/${folder}`);
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
    log.error("units", `Unregister repo unit pin/r/${folder} failed: ${(e as Error).message}`);
    throw e;
  }
  log.info("units", `Unregistered repo unit pin/r/${folder} (local files untouched)`);
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
    lastPinAt: status.last_pin_at,
    status: rollupStatus(cfg.pinned, counts, status, files),
    pinned: cfg.pinned,
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
    pinned: cfg.pinned,
    status: rollupStatus(cfg.pinned, counts, status, files),
    peerCount: peerCountForFiles(files),
    lastPinAt: status.last_pin_at,
    ipfs,
    counts,
    files,
    taskMetrics: computeTaskMetrics(files),
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
  // Fold the shared decision ledger ONCE per repo for provenance (decisions.mdx §10; one_repo.mdx §4.8):
  // who decided each file and when. Cheap read+fold, wrapped so a bad/locked/conflicted ledger never
  // breaks row composition — rows still render with decidedBy/decidedAt null (→ Undecided in the UI).
  const foldedByPath = foldLedgerForRepo(cfg);
  const repoRootAbs = cfg.repo.path
    ? path.resolve(cfg.repo.path.replace(/^~(?=\/|$)/, process.env.HOME || "~"))
    : null;
  return status.candidates.map((cand) => {
    const decision: Decision = cfg.decisions[cand.path] ?? "undecided";
    const m = manifestByPath.get(cand.path);
    const peers = m?.pinned_by ?? [];
    const prov = foldedByPath.get(cand.path);
    // Sticky Never-IPFS flag (decisions.mdx §17) — surfaced so the UI can disable the Add-to-IPFS axis.
    // Cheap per-row config read; never let a flag lookup break row composition.
    let neverIpfs = false;
    try {
      if (repoRootAbs) neverIpfs = effectiveFlags(path.join(repoRootAbs, cand.path)).neverIpfs;
    } catch {
      /* flags unavailable → default false */
    }
    return {
      fileId: `${repoIdFromPath(cfg.repo.path || "")}:${cand.path}`,
      path: cand.path,
      sizeBytes: cand.size,
      cid: decision === "sync" ? (m?.cid ?? null) : null,
      decision,
      transfer: transferFor(decision, m?.cid ?? null, peers),
      peers,
      changedAt: cand.modified_at ?? status.last_scan_at ?? new Date(0).toISOString(),
      decidedBy: prov?.decidedBy ?? null,
      decidedAt: prov?.decidedAt ?? null,
      neverIpfs,
      // The git-ignore axis, folded from the shared ledger (decisions.mdx §1) — drives the inline
      // Add-to-git-ignore (⊘) toggle independently of the IPFS-axis `decision`.
      gitignore: prov?.gitignore ?? false,
      // The Compress / Transcribe task-tab status for this file (task_tabs.mdx §4.4/§5/§6). Cheap,
      // name-only for compress; transcribe needs one sidecar existence check per media file.
      compress: compressStatusFor(cand.path),
      transcribe: transcribeStatusFor(cand.path, repoRootAbs),
    };
  });
}

// Compress task status (task_tabs.mdx §6). Reuses the single-source-of-truth extension verdict
// compressInfo(name): "could" = a video/image that looks uncompressed; "done" = already compressed;
// "na" = not a compressible media kind (audio is never compressible — charter).
function compressStatusFor(relPath: string): TaskStatus {
  const ci = compressInfo(path.basename(relPath));
  if (ci.compressible === null) return "na";
  return ci.compressState === "done" ? "done" : "could";
}

// Transcribe task status (task_tabs.mdx §5). "na" unless the file is audio/video; then "done" iff a
// `.transcription` sidecar already exists (analysisOutputs — cheap fs stat), else "could". Any failure
// (no repo root, unreadable sidecar) degrades to "could" so a transcribable file is never hidden.
function transcribeStatusFor(relPath: string, repoRootAbs: string | null): TaskStatus {
  const kind = mediaKindForName(path.basename(relPath));
  if (kind !== "video" && kind !== "audio") return "na";
  try {
    if (repoRootAbs && analysisOutputs(repoRootAbs, relPath).includes("transcript")) return "done";
  } catch {
    /* sidecar check unavailable → treat as not-yet-transcribed */
  }
  return "could";
}

// Roll up the per-tab "what could be done" metric counts (task_tabs.mdx §2.5) from the composed rows.
// `pullDown` is intentionally omitted — it comes from RepoDetail.missingPinned.length (router-computed).
const BIG_FILE_METRIC_THRESHOLD = 100 * 1024 * 1024; // 100 MB — the charter big-file threshold for the git-ignore nudge count.
function computeTaskMetrics(files: FileRow[]): TaskMetrics {
  const m: TaskMetrics = {
    undecided: 0,
    pending: 0,
    notBackedUp: 0,
    compressibleVideos: 0,
    compressibleImages: 0,
    alreadyCompressed: 0,
    transcribable: 0,
    transcribed: 0,
    bigNotIgnored: 0,
  };
  for (const f of files) {
    if (f.decision === "undecided") m.undecided++;
    if (f.decision === "sync" && f.transfer === "pending") m.pending++;
    if (f.decision === "sync" && f.cid != null && f.peers.length === 0) m.notBackedUp++;
    if (f.compress === "could") {
      if (compressInfo(path.basename(f.path)).compressible === "image") m.compressibleImages++;
      else m.compressibleVideos++;
    }
    if (f.compress === "done") m.alreadyCompressed++;
    if (f.transcribe === "could") m.transcribable++;
    if (f.transcribe === "done") m.transcribed++;
    if (!f.gitignore && f.sizeBytes >= BIG_FILE_METRIC_THRESHOLD) m.bigNotIgnored++;
  }
  return m;
}

// Read + fold the repo's shared decision ledger ONCE, keyed by repo-relative path. The repo root is the
// same value decisions.service.ts derives (getRepoConfig().repo.path resolved with `~` expansion). Any
// failure (no repo path, missing/locked/merge-conflicted ledger) yields an empty map so provenance is null.
function foldLedgerForRepo(cfg: RepoUnitConfig): Map<string, FoldedDecision> {
  const p = cfg.repo.path;
  if (!p) return new Map();
  try {
    const repoRoot = path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
    return foldLedger(readLedger(repoRoot));
  } catch (e) {
    log.warn("units", `decision provenance unavailable (using null): ${(e as Error).message}`);
    return new Map();
  }
}

function transferFor(decision: Decision, cid: string | null, peers: string[]): TransferStatus {
  if (decision !== "sync") return "na";
  if (!cid) return "pending";
  return peers.length > 0 ? "pinned" : "pending";
}

function countDecisions(files: FileRow[]): RepoCounts {
  const counts: RepoCounts = { pinned: 0, pending: 0, undecided: 0, ignored: 0 };
  for (const f of files) {
    if (f.decision === "ignore") counts.ignored++;
    else if (f.decision === "undecided") counts.undecided++;
    else if (f.decision === "sync") {
      if (f.transfer === "pinned") counts.pinned++;
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
  pinned: boolean,
  counts: RepoCounts,
  status: UnitStatus,
  files: FileRow[],
): RepoStatus {
  if (status.last_error || status.repo_state === "missing") return "error";
  const transferring = files.some((f) => f.transfer === "fetching" || f.transfer === "pushing");
  if (transferring) return "pinning";
  if (counts.pending > 0) return "behind";
  if (counts.undecided > 0) return "needs_review";
  if (!status.last_pin_at) return pinned ? "never" : "never";
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
