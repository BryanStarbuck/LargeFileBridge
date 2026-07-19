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
  isPdfName,
} from "@lfb/shared";
import type { ComputerUnitConfig, PlacementChoice, StorageType } from "@lfb/shared";
import type { RepoOwner } from "@lfb/shared";
import { compressInfo } from "../fs/badges.js";
import { resolveRepoOwner, checkIgnoreVerbose, type IgnoreRule } from "../git/git.service.js";
// storage.service <-> units.service form a static import cycle used ONLY inside functions (getStorageRow is
// called from ownerForRepoConfig, never at module-eval), which is safe under NodeNext ESM — same pattern the
// storage.service <-> storage-settings.service pair documents.
import { getStorageRow } from "../storage/storage.service.js";
import { canonicalCid } from "../ipfs/ipfs.service.js";
import { analysisOutputs } from "../storage/tracking.service.js";
import { resolveStorageType } from "../storage/storage-type.service.js";
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
import { effectiveFlags, getAppConfig } from "./config.service.js";
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

/** The per-repo placement choice for its transcripts / AI descriptions / OCR text (repo_settings.mdx §4-5,
 *  ocr.mdx §5.3). Resolved from the repo unit config keyed by the artifact's owning root; defaults to
 *  "lfbridge" when the root isn't a registered repo or on any read failure. Consumed by transcribe.service /
 *  describe.service / ocr.service to decide WHERE the artifact is written (via artifactPathForPlacement). */
export function repoArtifactPlacement(root: string, which: "transcription" | "aiDescription" | "ocr"): PlacementChoice {
  try {
    const folder = folderForRepoId(repoIdFromPath(root));
    if (!folder) return "lfbridge";
    const a = getRepoConfig(folder).artifacts;
    if (which === "transcription") return a.transcription_placement;
    if (which === "aiDescription") return a.ai_description_placement;
    return a.ocr_placement;
  } catch {
    return "lfbridge";
  }
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

/**
 * The effective owner for a repo unit config: honor the local `owner_override` (manual) else derive from the
 * git remote (auto) — {@link resolveRepoOwner} — then, for a MANUAL company override, enrich the displayName
 * with the company storage's friendly name (repo_company_mapping.mdx §5/§6; storage_company.mdx §6). The
 * enrichment is best-effort: an unknown/failed company lookup keeps the resolver's slug fallback. This is the
 * single owner-composition seam used by computeRepoRow/computeRepoDetail and the repo-settings row.
 */
export function ownerForRepoConfig(cfg: RepoUnitConfig): RepoOwner {
  // Thread the user's own forge accounts (repo_company_mapping.mdx §4) so a repo whose remote owner is one of
  // them derives to Personal, not a company. Empty list ⇒ every known-forge owner still derives to a company.
  const owner = resolveRepoOwner(cfg, getAppConfig().personal_accounts);
  if (owner.kind === "company" && owner.source === "manual" && owner.companyId) {
    try {
      const row = getStorageRow(owner.companyId);
      if (row) owner.displayName = row.companyName || row.name || owner.displayName;
    } catch {
      /* best-effort: keep the slug/id fallback from resolveRepoOwner */
    }
  }
  return owner;
}

/**
 * Persist (or clear) a repo's local grouping override in its `config.yaml` (repo_company_mapping.mdx §5.2).
 * `null` clears it → the owner auto-derives again (source:"auto"). Machine-local, sticky across rescans, and
 * never overwritten by a teammate — exactly like `bookmarked`. The travelling company-ownership assertion is
 * written separately by owner-propagation.service (repo_owner_propagation.mdx §2).
 */
export async function setRepoOwnerOverride(
  folder: string,
  override: { kind: "personal" | "company"; company_id: string | null } | null,
): Promise<RepoUnitConfig> {
  return updateRepoConfig(folder, (c) => ({ ...c, owner_override: override }));
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
    // Company/personal owner: honor the local owner_override (manual) else derive from the git remote (auto)
    // (repo_company_mapping.mdx §5.2). ownerForRepoConfig threads the user's personal-accounts list so an
    // owner that IS a personal account derives to Personal instead of a company (§4).
    owner: ownerForRepoConfig(cfg),
  };
}

// `pinset` (optional) is THIS node's live pinset as CANONICAL CIDv1-base32 strings (ipfs.canonicalPinnedSet()),
// fetched ONCE by the router and threaded through so each decided row can be marked pinnedHere without any
// per-file hashing (one_repo.mdx §4.9 / knowledge/ipfs.mdx §5.1). Omitted (undefined) when IPFS is down or the
// caller didn't fetch it → rows carry no pinnedHere and the pin icon falls back to intent-only (no red).
export function computeRepoDetail(folder: string, ipfs: IpfsHealth, pinset?: Set<string>): RepoDetail {
  const cfg = getRepoConfig(folder);
  const status = getRepoStatus(folder);
  const manifest = getRepoManifest(folder);
  const files = composeFileRows(folder, cfg, status, manifest, pinset);
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
    lastScanAt: status.last_scan_at,
    ipfs,
    counts,
    files,
    taskMetrics: computeTaskMetrics(files),
    owner: ownerForRepoConfig(cfg),
  };
}

// One FileRow per discovered big-file candidate, joined with its decision + manifest CID.
function composeFileRows(
  _folder: string,
  cfg: RepoUnitConfig,
  status: UnitStatus,
  manifest: Manifest,
  pinset?: Set<string>,
): FileRow[] {
  const manifestByPath = new Map(manifest.files.map((f) => [f.path, f]));
  // Fold the shared decision ledger ONCE per repo for provenance (decisions.mdx §10; one_repo.mdx §4.8):
  // who decided each file and when. Cheap read+fold, wrapped so a bad/locked/conflicted ledger never
  // breaks row composition — rows still render with decidedBy/decidedAt null (→ Undecided in the UI).
  const foldedByPath = foldLedgerForRepo(cfg);
  const repoRootAbs = cfg.repo.path
    ? path.resolve(cfg.repo.path.replace(/^~(?=\/|$)/, process.env.HOME || "~"))
    : null;
  // The git-ignore AXIS IS READ FROM GIT, NOT FROM THE LEDGER. The ledger only records files WE
  // git-ignored through our own toggle; a rule the user wrote by hand (or any pattern rule, e.g.
  // `**/videos/**`) has no ledger event, so a ledger-sourced flag reported "not ignored" for files git
  // genuinely ignores. `git check-ignore` is the source of truth for "is this file ignored" — one
  // batched call per repo. The VERBOSE form also gives us the OWNING RULE, which tells the UI whether the
  // toggle can be turned off (our exact anchored line) or is locked by a rule we must not rewrite
  // (git_ignore.mdx §5.5). Never let it break row composition; on failure nothing is reported ignored.
  const ignoreRules = repoRootAbs
    ? checkIgnoreVerbose(
        repoRootAbs,
        status.candidates.map((c) => path.join(repoRootAbs, c.path)),
      )
    : new Map<string, IgnoreRule>();
  // Resolve the storage KIND ONCE per repo (it's memoized, but this also lets us hand the known type to
  // analysisOutputs so it never re-resolves per file). The analysis-artifact probe below is the same
  // value for all three task axes, so it is computed once per row and shared (see the task-status helpers).
  const storageType = repoRootAbs ? resolveStorageType(repoRootAbs) : undefined;
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
      // Live pin reality for the three-state icon (one_repo.mdx §4.9). Only meaningful for a decided file
      // that has a recorded CID; the pinset is CANONICAL so a `Qm…`-encoded pin of a `bafy…` manifest CID
      // (same block) still counts (knowledge/ipfs.mdx §5.1). Undefined when we have no pinset (IPFS down /
      // not fetched) or no CID → icon shows intent only, never a false red. NO per-file hashing here.
      pinnedHere:
        pinset && decision === "sync" && m?.cid ? pinset.has(canonicalCid(m.cid)) : undefined,
      changedAt: cand.modified_at ?? status.last_scan_at ?? new Date(0).toISOString(),
      decidedBy: prov?.decidedBy ?? null,
      decidedAt: prov?.decidedAt ?? null,
      neverIpfs,
      // The git-ignore axis as GIT ACTUALLY SEES IT (decisions.mdx §1) — drives the inline
      // Add-to-git-ignore (⊘) toggle independently of the IPFS-axis `decision`. Reality, not intent:
      // `prov.gitignore` is the recorded DECISION and is kept for provenance only.
      ...gitIgnoreAxis(repoRootAbs, cand.path, ignoreRules),
      // The Compress / Transcribe / Describe / OCR task-tab status (task_tabs.mdx §4.4/§5/§6). Compress is
      // cheap name-only. The other three all key off the SAME analysis-artifact probe, so it is done at
      // most ONCE per row (only when the file could carry an artifact) and shared across the three, instead
      // of each helper re-running ~a dozen statSyncs (the View-One-Repo hot-path cost this collapses).
      compress: compressStatusFor(cand.path),
      ...(() => {
        const outputs =
          repoRootAbs && couldHaveAnalysisArtifact(path.basename(cand.path))
            ? safeAnalysisOutputs(repoRootAbs, cand.path, storageType)
            : null;
        return {
          transcribe: transcribeStatusFor(cand.path, outputs),
          describe: describeStatusFor(cand.path, outputs),
          ocr: ocrStatusFor(cand.path, outputs),
        };
      })(),
      // Small analysis-only media (scan.mdx §4.1 rule 5) — the "Large files only" toggle hides these by
      // default and the decision/space counts exclude them (tables.mdx §2.9, one_repo.mdx §4.1).
      analysisOnly: cand.analysisOnly === true,
    };
  });
}

/**
 * The git-ignore axis fields for ONE row, derived from git's verbose verdict (git_ignore.mdx §5.5).
 *
 * `gitignoreLocked` answers "can the user turn this OFF here?". It is true when git ignores the file via a
 * rule we must NOT rewrite — a broad/pattern rule, or one sourced outside the repo's root `.gitignore`.
 * The UI then renders the toggle ON but non-interactive and names the rule, instead of offering a click
 * that would silently do nothing. The test MUST mirror `unignorePaths()`'s accept condition, or the UI
 * would offer a removal the engine then refuses.
 */
function gitIgnoreAxis(
  repoRootAbs: string | null,
  relPath: string,
  rules: Map<string, IgnoreRule>,
): Pick<FileRow, "gitignore" | "gitignoreLocked" | "gitignoreRule"> {
  if (!repoRootAbs) return { gitignore: false };
  const rule = rules.get(path.join(repoRootAbs, relPath));
  if (!rule) return { gitignore: false };
  const ownRootIgnore = path.resolve(repoRootAbs, rule.source) === path.join(repoRootAbs, ".gitignore");
  const exact = `/${relPath.split(path.sep).join("/")}`;
  const removable = ownRootIgnore && rule.pattern.trim() === exact;
  return {
    gitignore: true,
    gitignoreLocked: !removable,
    gitignoreRule: { source: path.basename(rule.source), line: rule.line, pattern: rule.pattern },
  };
}

// Compress task status (task_tabs.mdx §6). Reuses the single-source-of-truth extension verdict
// compressInfo(name): "could" = a video/image that looks uncompressed; "done" = already compressed;
// "na" = not a compressible media kind (audio is never compressible — charter).
function compressStatusFor(relPath: string): TaskStatus {
  const ci = compressInfo(path.basename(relPath));
  if (ci.compressible === null) return "na";
  return ci.compressState === "done" ? "done" : "could";
}

// The three per-file analysis-task statuses (Transcribe / Describe / OCR) all read from ONE shared
// `analysisOutputs(...)` probe computed once per row (see composeFileRows). Recomputing it inside each
// helper was the View-One-Repo hot-path cost: analysisOutputs does ~a dozen `statSync`s across every
// artifact layout, and a single VIDEO hit all three helpers → ~3× the stats per file (image → 2×). On a
// cloud-mounted repo each statSync can block, so a large repo multiplied that into a multi-second load.
// `outputs` is null when the probe was skipped/failed (non-media file, no repo root, unreadable) → the
// task degrades to "could" so a candidate file is never wrongly hidden.

// Transcribe task status (task_tabs.mdx §5). "na" unless the file is audio/video; then "done" iff a
// `.transcription` artifact already exists, else "could".
function transcribeStatusFor(relPath: string, outputs: string[] | null): TaskStatus {
  const kind = mediaKindForName(path.basename(relPath));
  if (kind !== "video" && kind !== "audio") return "na";
  return outputs?.includes("transcript") ? "done" : "could";
}

// AI-description task status (ai_description.mdx §11) — the OTHER media axis: "na" unless the file is IMAGE
// or VIDEO (audio is covered by transcription); then "done" iff a `.ai_description` artifact exists, else
// "could".
function describeStatusFor(relPath: string, outputs: string[] | null): TaskStatus {
  const kind = mediaKindForName(path.basename(relPath));
  if (kind !== "image" && kind !== "video") return "na";
  return outputs?.includes("description") ? "done" : "could";
}

// OCR task status (ocr.mdx §11.2) — the third sibling. "na" unless the file has text-bearing pixels: an IMAGE,
// a VIDEO, or a PDF (audio has no pixels — ocr.mdx §1.7/§1.7.1); then "done" iff a `.ocr` artifact exists,
// else "could".
//
// "done" keys on the ARTIFACT, never on the text being non-empty (ocr.mdx §2.3). A photo of a beach OCRs to
// "" and is DONE — a tree of text-free holiday photos settles at a big green 0 rather than presenting an
// eternal wall of candidates.
function ocrStatusFor(relPath: string, outputs: string[] | null): TaskStatus {
  const name = path.basename(relPath);
  const kind = mediaKindForName(name);
  const ocrable = kind === "image" || kind === "video" || isPdfName(name);
  if (!ocrable) return "na";
  return outputs?.includes("ocr") ? "done" : "could";
}

// True when a file could carry ANY analysis artifact (transcript / description / OCR) — the gate that
// decides whether the one shared `analysisOutputs` probe is worth doing for a row. A plain big file
// (e.g. a .zip) matches none of these, so we skip its probe entirely — exactly as the old kind-gated
// helpers did (they returned "na" before ever touching the filesystem).
function couldHaveAnalysisArtifact(name: string): boolean {
  const kind = mediaKindForName(name);
  return kind === "image" || kind === "video" || kind === "audio" || isPdfName(name);
}

// The one shared analysis-artifact probe, never allowed to break row composition. analysisOutputs itself
// swallows per-stat errors, but a path-join / storage-type failure could still throw — degrade to null
// (→ every task "could") so a probe failure never hides a candidate file.
function safeAnalysisOutputs(root: string, rel: string, type: StorageType | undefined): string[] | null {
  try {
    return analysisOutputs(root, rel, type);
  } catch {
    return null;
  }
}

// Roll up the per-tab "what could be done" metric counts (task_tabs.mdx §2.5) from the composed rows.
// `pullDown` is intentionally omitted — it comes from RepoDetail.missingPinned.length (router-computed).
// The git-ignore nudge counts at the CHECKED-IN threshold (50 MB default), not the 100 MB payload
// threshold — it must agree with the scan predicate that admitted these rows (scan.mdx §4.1 rule 4),
// or the file shows up in the table but is never counted in the metric that offers to fix it.
function checkedInThresholdBytes(): number {
  try {
    return getAppConfig().big_file.checked_in_threshold_bytes;
  } catch {
    return 52428800; // config unreadable → the 50 MB default; never break row composition
  }
}
function computeTaskMetrics(files: FileRow[]): TaskMetrics {
  const bigFileMetricThreshold = checkedInThresholdBytes();
  const m: TaskMetrics = {
    undecided: 0,
    pending: 0,
    notBackedUp: 0,
    compressibleVideos: 0,
    compressibleImages: 0,
    alreadyCompressed: 0,
    transcribable: 0,
    transcribed: 0,
    describable: 0,
    described: 0,
    ocrable: 0,
    ocred: 0,
    bigNotIgnored: 0,
  };
  for (const f of files) {
    // The pure-ANALYSIS metrics (OCR / describe / transcribe) count EVERY row — that is the whole point of
    // surfacing small media (scan.mdx §4.1 rule 5): a small screenshot IS an OCR candidate.
    if (f.transcribe === "could") m.transcribable++;
    if (f.transcribe === "done") m.transcribed++;
    if (f.describe === "could") m.describable++;
    if (f.describe === "done") m.described++;
    if (f.ocr === "could") m.ocrable++;
    if (f.ocr === "done") m.ocred++;
    // The large-file DECISION and SPACE metrics count only real large-file candidates. Small analysis-only
    // media (rule 5) is not a pin decision, not a space-reclaim target, and not a git-ignore nudge — so it
    // must not inflate these tiles (tables.mdx §2.9 / one_repo.mdx §4.1).
    if (f.analysisOnly) continue;
    if (f.decision === "undecided") m.undecided++;
    if (f.decision === "sync" && f.transfer === "pending") m.pending++;
    if (f.decision === "sync" && f.cid != null && f.peers.length === 0) m.notBackedUp++;
    if (f.compress === "could") {
      if (compressInfo(path.basename(f.path)).compressible === "image") m.compressibleImages++;
      else m.compressibleVideos++;
    }
    if (f.compress === "done") m.alreadyCompressed++;
    if (!f.gitignore && f.sizeBytes >= bigFileMetricThreshold) m.bigNotIgnored++;
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
    // Small analysis-only media (scan.mdx §4.1 rule 5) is not a large-file decision the user owes — a
    // folder of thumbnails must not read as hundreds of Undecided (one_repo.mdx §4.1 / repos.mdx §4.1).
    if (f.analysisOnly) continue;
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
