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
  type FileRowPatch,
  mediaKindForName,
  isPdfName,
} from "@lfb/shared";
import type { ComputerUnitConfig, PlacementChoice, StorageType } from "@lfb/shared";
import type { RepoOwner } from "@lfb/shared";
import { compressInfo } from "../fs/badges.js";
import { resolveRepoOwner, checkIgnoreVerboseAsyncDetailed, type IgnoreRule } from "../git/git.service.js";
// storage.service <-> units.service form a static import cycle used ONLY inside functions (getStorageRow is
// called from ownerForRepoConfig, never at module-eval), which is safe under NodeNext ESM — same pattern the
// storage.service <-> storage-settings.service pair documents.
import { getStorageRow, listStorageIds } from "../storage/storage.service.js";
// Peer device LABELS for a remote-only row (devices.mdx §6.9) — the id/name → nice-name index. Same
// function-body-only usage as getStorageRow above, so the storage.service cycle stays safe.
import { deviceLabelIndex, resolveDeviceLabel } from "../storage/devices.service.js";
import { foreignPinPathSetFor } from "../ipfs/foreign-pin.service.js";
import { analysisOutputs, storageIndexDroppedFiles } from "../storage/tracking.service.js";
import { resolveStorageType } from "../storage/storage-type.service.js";
// Leaf modules only — the read path must not pull tracking-sync.service (and its storage.service edge) in.
import { repoStateDir } from "../storage/tracking-root.service.js";
import { mergeManifests } from "../storage/manifest-merge.js";
import { normalizeManifestPaths } from "../pin/manifest-normalize.js";
import { pinsetHasContent } from "../pin/cid-equivalence.service.js";
import { joinRel, healPathKeyedMap, healWindowsPath } from "../../shared/rel-path.js";
import { readYaml, updateYaml, writeYaml } from "../../shared/store/yaml-store.js";
import { bumpTopics, repoTopic, REPOS_TOPIC } from "../events/state-events.service.js";
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
import { foldedDecisionsForUnitPath } from "../storage/decision.repo.js";
import { flagsResolver, getAppConfig, computerLabel } from "./config.service.js";
import { isDirAt, statOrNull } from "../../shared/fs-probe.js";
import { log } from "../../shared/logging.js";
// A CID this computer PROVED wrong must not survive any fold, including this read-side one
// (manifest-merge.ts). Leaf module: it reads one local YAML and `canonicalCid`, so no cycle.
import { supersededCid } from "../pin/superseded-cids.service.js";
import { expandHome } from "../../shared/home-path.js";
// The Postgres half of `folderForRepoId` (database.mdx §9 slice 4). Leaf modules: `db.ts` is the pool +
// helpers, `unit.repo.ts` is SQL only — neither reaches back into this file, so no cycle.
import { dbEnabled, tryDb } from "../../shared/persistence/db.js";
import { pinFolderForRepoId } from "./unit.repo.js";
// The Postgres half of the UNIT manifest write (database.mdx §9 slice 7, migration 0007). `manifest.repo.ts`
// is SQL-only and imports nothing from this file, so the same no-cycle argument as `unit.repo.ts` applies.
import { projectManifest } from "../pin/manifest.repo.js";
import { canonicalCid } from "../ipfs/ipfs.service.js";
// The Postgres half of the SCAN CENSUS (database.mdx §9 slice 5) — the row set `composeFileRows` iterates.
// Same leaf-module reasoning as above: `file.repo.ts` is SQL only and never reaches back into this file.
import { readCandidateCensus, unitIdForPinFolder } from "./file.repo.js";
// The git-ignore axis cache (database.mdx §9 slice 9, migration 0009). `file-detail.repo.ts` is SQL only
// and imports nothing from this file, so the same no-cycle argument as `unit.repo.ts` applies.
import {
  ensureFileRows,
  unitIdForRoot,
  upsertFileGitignore,
  type FileGitignoreRow,
} from "./file-detail.repo.js";
// The maintained rollup (database.mdx §9 slice 11, migration 0003/0011). `rollup.service.ts` is SQL plus
// the freshness policy and imports nothing from this file — deliberately, because the arithmetic it stores
// is `repoRowStats` BELOW and there must be exactly one implementation of it. The dependency therefore runs
// one way only, and the same no-cycle argument as `unit.repo.ts` applies.
import {
  markUnitRollupPartial,
  publishUnitRollup,
  readFreshRollupForPinFolder,
  refreshRollupCategoryCounts,
  type RollupStats,
} from "./rollup.service.js";

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
  const cfg = readYaml(unitConfigPath(repoUnitDir(folder)), RepoUnitConfigSchema);
  // `decisions` is keyed by the repo-relative path, so it obeys §6.1 like the manifest does. A Windows
  // build (or a peer-seeded decision) spelled those keys with `\`, and every lookup in this file is
  // `cfg.decisions[cand.path]` against a POSIX candidate — so the decision silently read as Undecided and
  // the pin pass skipped the file. An already-POSIX key wins any collision: it is this computer's own.
  const decisions = healPathKeyedMap(cfg.decisions, (posix) => posix);
  return decisions === cfg.decisions ? cfg : { ...cfg, decisions };
}
/**
 * The UNIT manifest — healed on read like every other manifest reader (repo__list_syns.mdx §6.1).
 *
 * This reader was the §6.1 hole. `manifest.service.ts` heals the committed/tracking copies, but the unit
 * manifest is read straight out of the state store, so a `\` entry that reached it before the heal existed
 * stayed there forever: `mergeManifests` keys by exact path, so the `\` and `/` spellings never folded, and
 * `remoteOnlyRows` then emitted a SECOND red pull-down row for the same file — a `\` path can never match the
 * working tree, so `fs.existsSync` said "not here" every time. That is the duplicate-row defect.
 *
 * THIS READ HAS NOT CUT OVER (R3 / database.mdx §9 slice 7). `lfb.manifest_entry` is a projection written
 * behind `writeRepoManifest` below; the state file is still the truth. It matters more here than for the
 * tracking copy: this reader is one of the two operands `mergeManifests` folds (pin.service.ts:770,
 * reconciler.service.ts:401), and swapping ONE operand for a Postgres read while the other still came from
 * disk would make the merge's two inputs answer from two different clocks.
 */
export function getRepoManifest(folder: string): Manifest {
  const file = unitManifestPath(repoUnitDir(folder));
  return normalizeManifestPaths(readYaml(file, ManifestSchema), file);
}
export function getRepoStatus(folder: string): UnitStatus {
  return readYaml(unitStatusPath(repoUnitDir(folder)), UnitStatusSchema);
}
export async function updateRepoConfig(
  folder: string,
  mutate: (c: RepoUnitConfig) => RepoUnitConfig,
): Promise<RepoUnitConfig> {
  const out = await updateYaml(unitConfigPath(repoUnitDir(folder)), RepoUnitConfigSchema, mutate);
  // Every decision this product records lands here (decisions.service.ts:546 is the single writer of the
  // `decisions:` map), and a decision moves `n_pinned` / `n_undecided` / `n_ignored`. See
  // {@link invalidateRollup} for why the invalidation lives at the YAML writers rather than at each caller.
  invalidateRollup(folder);
  return out;
}

/**
 * MARK THIS REPO'S ROLLUP PROVISIONAL — mechanism 1 of the freshness contract (rollup.service.ts header).
 *
 * WHY HERE AND NOT AT EACH CALL SITE. Three functions in this file are the funnel every mutation that can
 * move a rollup number passes through: `updateRepoConfig` (decisions, pins, bookmarks, settings),
 * `writeRepoStatus` (the scan census and the pin pass's status) and `writeRepoManifest` (pin claims and
 * CIDs). They are already the place this file bumps the repo's live-refresh topics, on the stated grounds
 * that "a change here is exactly the moment an open page has gone stale" — the rollup goes stale at the
 * same instant and for the same reason, so it is invalidated at the same seam. A per-caller invalidation
 * would be one `await` somebody forgets, and a forgotten one shows the user a confidently wrong number.
 *
 * FIRE-AND-FORGET, AND IT CANNOT THROW. All three callers are synchronous (`writeManifest:` at
 * pin.service.ts:789 is a lambda inside a spec object), and R2 forbids a Postgres fault reaching a write
 * path that worked before Postgres existed. A failed invalidation costs a stale rollup for one repo until
 * the timestamp guard in `readFreshRollupForPinFolder` catches it — which is exactly what that backstop is
 * for.
 */
function invalidateRollup(folder: string): void {
  if (!dbEnabled()) return;
  void tryDb(
    async () => {
      const unitId = await unitIdForPinFolder(folder);
      if (unitId === null) return 0; // area 2 has not adopted this unit — there is no rollup to invalidate
      return markUnitRollupPartial(unitId);
    },
    0,
    "units.invalidateRollup",
  );
}
/**
 * The topics a write to `folder` invalidates (storage_company.mdx §8.9).
 *
 * TWO repo topics are emitted on purpose, because a repo has TWO names and the two sides of the stream know
 * different ones. The server thinks in `folder` (the state-root directory, e.g. `charlie-kirk`); the browser
 * only ever holds `repoId` (sha1 of the absolute path — it is what is in the URL). Publishing only the
 * server's name would mean no client could ever match a bump, and the stream would be a perfectly healthy
 * pipe that delivers nothing — the same class of silent break as the path-vs-remote key in §8.4.1.
 *
 * Resolving the id is best-effort: a repo whose config is unreadable still bumps its folder topic and the
 * list topic, so a notification is degraded, never lost.
 */
function repoTopicsFor(folder: string): string[] {
  const topics = [repoTopic(folder), REPOS_TOPIC];
  try {
    const p = getRepoConfig(folder).repo.path;
    if (p) topics.push(repoTopic(repoIdFromPath(expandHome(p))));
  } catch {
    // Unreadable config — the folder topic above still fires. Never fail a write over a notification.
  }
  return topics;
}

// Both writers BUMP the repo's topics after the write lands (storage_company.mdx §8.9): these two files are
// what the One-Repo page's rows and metrics are composed from, so a change here is exactly the moment an
// open page has gone stale. The bump is fire-and-forget and cannot throw (state-events swallows subscriber
// faults), so it can never fail the write that just succeeded.
export function writeRepoStatus(folder: string, status: UnitStatus): void {
  writeYaml(unitStatusPath(repoUnitDir(folder)), { ...status });
  bumpTopics(repoTopicsFor(folder));
  invalidateRollup(folder); // the census moved → every count derived from it is provisional
}
export function writeRepoManifest(folder: string, manifest: Manifest): void {
  const file = unitManifestPath(repoUnitDir(folder));
  // Heal on the way OUT as well, so the state file itself stops carrying `\` rather than being re-healed on
  // every read forever. Idempotent: a clean manifest is returned untouched.
  const healed = normalizeManifestPaths(manifest, file);
  writeYaml(file, { ...healed });
  bumpTopics(repoTopicsFor(folder));
  // R1 DUAL-WRITE — stage='unit'. The YAML write above is untouched and still authoritative; this is a pure
  // ADD behind it, fire-and-forget because every caller is synchronous (`writeManifest:` at
  // pin.service.ts:789 is a lambda inside a spec object) and `projectManifest` cannot throw (R2).
  //
  // THE HEALED DOCUMENT, not the caller's: the file on disk carries POSIX keys after the line above, and
  // `manifest_entry.rel_posix` is generated by the same `\`→`/` replacement — projecting the unhealed copy
  // would put a `\` spelling in `rel_path` that no reader of the file would ever produce again.
  projectManifest({ stage: "unit", label: `unit:${folder}`, unitId: () => unitIdForPinFolder(folder) }, healed, {
    canonicalCid,
    selfLabel: computerLabel(),
  });
  invalidateRollup(folder); // pin claims and CIDs moved → pinned/pending/peers/notBackedUp are provisional
}
/** Exported so other write paths (the reconcile fold) publish the SAME topic set — one repo, one answer. */
export function repoBumpTopics(folder: string): string[] {
  return repoTopicsFor(folder);
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

/**
 * Resolve a repoId (from the UI) to its state-root folder name — BY LINEAR SCAN.
 *
 * This is the original implementation, and it stays for two jobs (R3 / database.mdx §9 slice 4):
 *   1. the FALLBACK whenever Postgres is absent, unreachable, or simply has no row yet — which is the
 *      default posture of this app and the state of every machine before the backfill has run;
 *   2. the VERIFICATION ORACLE. A read that cuts over needs something to be checked against, and the thing
 *      it is checked against has to be the code that was correct before the cutover, not a second opinion
 *      written at the same time as the new path.
 *
 * The cost is what makes the cutover worth doing: 105 `pin/r/<folder>/config.yaml` parsed on EVERY
 * `/api/repos/:repoId*` request — 413 KB of YAML, and `YAML.parse` already owned ~40% of `GET /api/repos`
 * before it was cached (`yaml-store.ts:15-19`).
 */
export function folderForRepoIdByScan(repoId: string): string | null {
  for (const folder of listRepoFolders()) {
    const cfg = getRepoConfig(folder);
    if (cfg.repo.path && repoIdFromPath(cfg.repo.path) === repoId) return folder;
  }
  return null;
}

/**
 * Resolve a repoId to its state-root folder name — ONE UNIQUE-INDEX LOOKUP (`unit_repo_id_uq`, 0003).
 *
 * THE ONE READ THIS SLICE CUTS OVER. `repo_id` is `sha1(resolve(abs_path))[0:16]`, computed in TypeScript
 * and stored as a literal on the unit row (R7), so the index answers the exact question the scan answered —
 * with one row instead of 105 documents.
 *
 * IT FALLS BACK IN EVERY UNHAPPY CASE, and that is deliberate rather than defensive: `dbEnabled()` false
 * (no Postgres — the default on a fresh machine), a query error, or a MISSING ROW (the backfill has not run
 * yet, or this repo was registered since it did) all land on `folderForRepoIdByScan`. A repo that Postgres
 * has never heard of must still be findable, or registering a repo would break the page that registered it.
 */
export async function folderForRepoId(repoId: string): Promise<string | null> {
  if (!dbEnabled()) return folderForRepoIdByScan(repoId);
  return tryDb(
    async () => (await pinFolderForRepoId(repoId)) ?? folderForRepoIdByScan(repoId),
    () => folderForRepoIdByScan(repoId),
    "units.folderForRepoId",
  );
}

/** The per-repo placement choice for its transcripts / AI descriptions / OCR text (repo_settings.mdx §4-5,
 *  ocr.mdx §5.3). Resolved from the repo unit config keyed by the artifact's owning root; defaults to
 *  "lfbridge" when the root isn't a registered repo or on any read failure. Consumed by transcribe.service /
 *  describe.service / ocr.service to decide WHERE the artifact is written (via artifactPathForPlacement). */
export function repoArtifactPlacement(root: string, which: "transcription" | "aiDescription" | "ocr"): PlacementChoice {
  try {
    // DELIBERATELY THE SCAN, not the indexed lookup. This function is SYNCHRONOUS and is called from inside
    // the artifact writers (transcribe / describe / ocr), several of which have no `await` to give. Making it
    // async would cascade through those write paths for no measured gain: this is a once-per-artifact
    // resolution, not the per-request one the cutover exists for. Kept honest here rather than fixed with a
    // cache that could disagree with the row.
    const folder = folderForRepoIdByScan(repoIdFromPath(root));
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
  const resolved = path.resolve(expandHome(absPath));
  if (!isGitWorkingTree(resolved)) {
    throw new Error("Not a git working tree");
  }
  const repoId = repoIdFromPath(resolved);
  const existing = await folderForRepoId(repoId);
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
  // Resolve the topic set BEFORE the delete — repoTopicsFor reads the unit config, which is about to
  // be removed (afterwards only the degraded folder+list topics would fire, missing the repoId topic
  // an open One-Repo page watches).
  const topics = repoTopicsFor(folder);
  try {
    fs.rmSync(repoUnitDir(folder), { recursive: true, force: true });
  } catch (e) {
    // force:true already tolerates absence — a throw here means the tracking state couldn't be
    // removed (e.g. permissions). Surface it before it propagates to the caller.
    log.error("units", `Unregister repo unit pin/r/${folder} failed: ${(e as Error).message}`);
    throw e;
  }
  // A removed repo is a list change with NO status/manifest write to ride — bump explicitly, or every
  // other open tab keeps showing the deleted row (performance.mdx Aspect 6b).
  bumpTopics(topics);
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
//
// EVERYTHING BELOW THAT WALKS A REPO'S FILES IS ASYNC AND COOPERATIVELY YIELDING (performance.mdx P-37).
// Composition is O(files) of synchronous disk work — a `stat` storm for the four task axes, a `git
// check-ignore` per repo, an `existsSync` per manifest entry — and it used to run to completion without
// once handing the event loop back. On a machine where each of those calls is slow (a cloud mount, a
// network home directory, a virus scanner in the path) that is seconds during which the single Node thread
// serves NOTHING: not the other page the user just clicked, not the progress poll, not `/health`. This is
// the same T3 rule the scanner walk (scan.mdx §10) and the flat listing (P-04) already follow; these two
// paths were the last request-serving walks that did not.
//
// The yield interval is per-ROW, not per-repo: a single repo with thousands of candidates is exactly the
// case a per-repo yield fails to cover.
const ROW_YIELD_EVERY = 200;
const rowYield = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** How the caller receives rows AS they are composed, and how it stops a composition it no longer wants. */
export interface RowStreamOpts {
  /** Called with each chunk of freshly composed rows. Chunk size is {@link ROW_BATCH}. */
  onFileBatch?: (files: FileRow[]) => void;
  /**
   * Called at each chunk boundary with a FULLY ASSEMBLED RepoDetail over the rows composed so far
   * (`partial: true`). It exists so a streaming reader's metric tiles COUNT UP with the rows instead of
   * sitting at a false zero until the walk ends — and it is produced by the same assembly step that
   * produces the final detail, so a running subtotal can never be computed differently from the total.
   */
  onSnapshot?: (detail: RepoDetail) => void;
  /**
   * Called ONCE with the fields that could not be ready when their rows were (the git-ignore axis and the
   * decision provenance), keyed by repo-relative path. A streaming reader forwards it as an `enrich` event;
   * a buffered caller can ignore it, because the same values were already written onto the rows it gets.
   */
  onEnrich?: (patch: Record<string, FileRowPatch>) => void;
  /** Abort (client disconnected / page navigated away) — the walk stops at the next batch boundary. */
  signal?: AbortSignal;
  /**
   * WHICH One-Repo TAB IS ASKING — the id the census read cutover is scoped behind (R3 / database.mdx §9:
   * "reads cut over one surface at a time, behind the tab or endpoint id, so a regression is scoped to one
   * tab").
   *
   * Only `"all"` takes the Postgres census today. Every other tab id — and the ABSENT value, which is what
   * every caller in the app passes right now — keeps composing from `status.candidates` exactly as before.
   * That is the point of naming the tab rather than flipping a global switch: a regression in the new
   * source cannot reach a caller that did not ask for it.
   */
  censusTab?: CensusTabId;
}

/**
 * The One-Repo task tabs, by id — mirrors `taskTabs.config.ts TaskTabId`, which is a frontend module the
 * backend must not import. Kept as a union rather than a bare string so a typo is a compile error and the
 * set of tabs that could be cut over next is visible from here.
 */
export type CensusTabId = "all" | "ipfs" | "compress" | "transcribe" | "ai-descriptions" | "ocr";

/** The four facts `composeFileRows` needs about a candidate — the same shape `status.candidates` carries. */
interface CensusCandidate {
  path: string;
  size: number;
  modified_at?: string;
  analysisOnly?: boolean;
}

/**
 * THE READ THIS SLICE CUTS OVER — the source of the One-Repo row set (database.mdx §9 slice 5).
 *
 * `status.candidates` is a document that has to be parsed in full to be read at all; the largest one on
 * this machine is 820,891 bytes. `lfb.file` answers the same question from `file_tab_all` (0004), whose
 * INCLUDE list makes it an index-only scan.
 *
 * WHAT IS AND IS NOT CUT OVER, precisely. Only the CENSUS moves: which paths are in this unit's row set,
 * their size, their mtime and the analysis-only flag. Every other fact on a `FileRow` — the decision, the
 * manifest CID, the pin reality, the four task verdicts, the git-ignore axis, the provenance — is still
 * composed in TypeScript from exactly the sources it was composed from before. Narrowing the cutover to
 * the row set is what makes it verifiable by a single comparison instead of six.
 *
 * THE OLD PATH IS THE ORACLE (R3), and it is consulted on EVERY call rather than in CI alone: the YAML
 * census is already in hand (`computeRepoDetail` reads `status.yaml` for a dozen other fields and
 * `yaml-store` caches it), so comparing the two counts is free. They must agree — the primary key
 * `(unit_id, rel_posix)` collapses separator variants, and measured on this machine no candidate path
 * contains a backslash, so equality is the correct expectation. A disagreement means the census is stale
 * (a scan since the last publish, a backfill that has not run) and we take the YAML answer, which is never
 * stale by construction.
 *
 * Falls back silently for: a tab other than "All", no database, no `unit` row yet, a query error, and a
 * count that does not match. All five are ordinary states of this app, not faults (R2).
 */
async function censusForTab(
  folder: string,
  status: UnitStatus,
  tab: CensusTabId | undefined,
): Promise<CensusCandidate[]> {
  if (tab !== "all" || !folder || !dbEnabled()) return status.candidates;
  return tryDb(
    async () => {
      const unitId = await unitIdForPinFolder(folder);
      if (unitId === null) return status.candidates;
      const rows = await readCandidateCensus(unitId);
      if (rows.length !== status.candidates.length) {
        log.debug(
          "units",
          `${folder}: Postgres census has ${rows.length} row(s), status.yaml has ${status.candidates.length} — ` +
            `using status.yaml (the oracle) for this read`,
        );
        return status.candidates;
      }
      // `changed_at DESC` is the "All" tab's own default sort (taskTabs.config.ts `all.defaultSort`), so
      // the rows arrive already in the order the tab wants rather than in walk order.
      return rows.map((r) => ({
        path: r.rel_path,
        size: Number(r.size_bytes),
        modified_at: r.modified_at ? r.modified_at.toISOString() : undefined,
        analysisOnly: r.analysis_only,
      }));
    },
    () => status.candidates,
    "units.composeFileRows.census",
  );
}

/** Rows per streamed chunk — the same order of magnitude as the flat listing's FLAT_BATCH (250). */
const ROW_BATCH = 250;

export async function computeRepoRow(folder: string): Promise<RepoRow> {
  const cfg = getRepoConfig(folder);
  const status = getRepoStatus(folder);
  const manifest = getRepoManifest(folder);
  const { counts, peerCount, transferring, notBackedUp, missingHere, bytes } = await repoRowStatsCached(
    folder,
    cfg,
    status,
    manifest,
  );
  return {
    repoId: repoIdFromPath(cfg.repo.path || folder),
    bookmarked: cfg.bookmarked,
    name: cfg.repo.name || folder,
    path: cfg.repo.path || "",
    counts,
    peerCount,
    notBackedUp,
    missingHere,
    bytes,
    lastPinAt: status.last_pin_at,
    lastScanAt: status.last_scan_at,
    status: rollupStatus(counts, status, transferring),
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
/**
 * The repo's manifest as the FILE ROWS should see it — the pin-unit manifest folded with the Local-Storage
 * tracking manifest (storage_company.mdx §8.6).
 *
 * Two manifests exist for one repo: the unit manifest the pin pass maintains, and the tracking manifest that
 * the sync-repo reconcile writes and that the `Pull down` metric is computed from. Reading only the first
 * meant a peer's entries reached the rows solely via a pin pass on a repo whose Pin toggle was ON — so a
 * laptop could show a non-zero Pull-down count with an empty table, the precise "a number no row explains"
 * failure §8.6 exists to prevent.
 *
 * Read-path only and non-throwing: a missing or half-merged tracking manifest yields the unit manifest
 * unchanged, so the page always renders.
 */
function mergeRepoManifests(folder: string, cfg: RepoUnitConfig): Manifest {
  const unit = getRepoManifest(folder);
  const root = cfg.repo.path;
  if (!root) return unit;
  try {
    const abs = path.resolve(expandHome(root));
    const trackingFile = path.join(repoStateDir(abs), "manifest.yaml");
    // Healed BEFORE the merge (§6.1): mergeManifests keys by exact path, so folding two manifests that
    // still disagree about separators just carries both spellings through into the rows.
    const tracking = normalizeManifestPaths(readYaml(trackingFile, ManifestSchema), trackingFile);
    // The tracking manifest is the copy the sync repo lands in, so it is the wire: the rows must read this
    // computer's pin claim from the UNIT manifest the pin pass derives, never from a claim about us that
    // travelled back. Self-claim-only (ipfs.mdx §1.1), enforced at the merge.
    // `supersededCid` on this read fold too: the rows render the CID, and the unit copy is the one document
    // no wire merge corrects, so without it a row keeps showing a wrapper CID nothing can fetch.
    return mergeManifests(unit, tracking, computerLabel(), { supersededCid });
  } catch (e) {
    log.debug("units", `tracking manifest fold skipped for ${folder}: ${(e as Error).message}`);
    return unit;
  }
}

export async function computeRepoDetail(
  folder: string,
  ipfs: IpfsHealth,
  pinset?: Set<string>,
  opts?: RowStreamOpts,
): Promise<RepoDetail> {
  const cfg = getRepoConfig(folder);
  const status = getRepoStatus(folder);
  // Cheap head-read of this repo's fingerprint index (never a parse) — see tracking.service
  // storageIndexDroppedFiles(). Non-throwing: a repo with no path or no index reads as complete.
  const indexDropped = cfg.repo.path
    ? storageIndexDroppedFiles(path.resolve(expandHome(cfg.repo.path)))
    : 0;

  /**
   * THE ONE assembly step. It is a closure rather than straight-line code at the end because a streaming
   * caller needs the very same shape for a partial row set (see `onSnapshot`) — two assemblies would be two
   * chances for a running subtotal and the final total to be computed differently.
   */
  const assemble = (files: FileRow[], partial: boolean): RepoDetail => {
    const counts = countDecisions(files);
    return {
      repoId: repoIdFromPath(cfg.repo.path || folder),
      name: cfg.repo.name || folder,
      path: cfg.repo.path || "",
      remote: cfg.repo.remote,
      pinned: cfg.pinned,
      status: rollupStatus(
        counts,
        status,
        files.some((f) => f.transfer === "fetching" || f.transfer === "pushing"),
      ),
      peerCount: peerCountForFiles(files),
      lastPinAt: status.last_pin_at,
      lastScanAt: status.last_scan_at,
      // Surface scan truncation (scan.mdx §4.5): >0 means the last scan's hard candidate cap dropped
      // exactly this many candidates, so `files` below is NOT the complete census. Absent when complete.
      ...(status.scan_dropped_candidates ? { scanDroppedCandidates: status.scan_dropped_candidates } : {}),
      // Surface tracking-index truncation the same way (storages.mdx §4.1a): >0 means the last index build hit
      // its backstop, so exactly this many large files are unfingerprinted — and therefore never pinned, never
      // synced, and missing from every rollup this page shows. Absent when the index is complete (the norm).
      ...(indexDropped > 0 ? { indexDroppedFiles: indexDropped } : {}),
      ipfs,
      counts,
      files,
      taskMetrics: computeTaskMetrics(files),
      owner: ownerForRepoConfig(cfg),
      ...(partial ? { partial: true } : {}),
    };
  };

  // A streaming caller wants the header BEFORE any row exists — that is the whole point: the page paints
  // its title, path and controls while the walk is still going. Emitted here, ahead of the manifest fold
  // below, because that fold parses two YAML documents that on a heavily-tracked repo carry thousands of
  // entries — real work, and none of it is anything the header needs.
  opts?.onSnapshot?.(assemble([], true));

  // BOTH manifests, folded (storage_company.mdx §8.6). The unit manifest is what the pin pass maintains;
  // the Local-Storage tracking manifest is where a peer's entries land when the sync repo is reconciled —
  // and it is also what the `Pull down` metric is computed from. Reading only the unit manifest here made
  // the tile and the table disagree: on a computer whose Pin toggle is off, the count could be non-zero
  // while the list showed nothing, because nothing had ever folded the two together.
  const manifest = mergeRepoManifests(folder, cfg);

  // Only build the running-snapshot machinery when someone is actually listening; the buffered callers
  // (files-query, the TO DO recalc, the debug export) must not pay for it.
  const composeOpts: RowStreamOpts | undefined = opts?.onSnapshot
    ? (() => {
        const seen: FileRow[] = [];
        return {
          signal: opts.signal,
          onEnrich: opts.onEnrich,
          // Forwarded explicitly: this object is REBUILT rather than spread, so a field added to
          // RowStreamOpts and not listed here is silently dropped on the streaming path only — which would
          // make the buffered route and the stream compose from two different censuses.
          censusTab: opts.censusTab,
          onFileBatch: (batch: FileRow[]) => {
            for (const r of batch) seen.push(r);
            opts.onFileBatch?.(batch);
            opts.onSnapshot?.(assemble(seen, true));
          },
        };
      })()
    : opts;

  const files = await composeFileRows(folder, cfg, status, manifest, pinset, composeOpts);
  // An ABORTED composition stops mid-walk, so what it returns is a subset — and `partial` is precisely the
  // word for "this is not the complete census". Reporting it as complete would let a future caller treat a
  // truncated row set as authoritative, which is the one thing the whole streaming design must never do.
  return assemble(files, opts?.signal?.aborted === true);
}

// One FileRow per discovered big-file candidate, joined with its decision + manifest CID.
async function composeFileRows(
  folder: string,
  cfg: RepoUnitConfig,
  status: UnitStatus,
  manifest: Manifest,
  pinset?: Set<string>,
  opts?: RowStreamOpts,
): Promise<FileRow[]> {
  // THE CENSUS, resolved before anything else consumes it — `ignoreP` below hands git the candidate paths,
  // so the row set has to be settled first or the git-ignore axis would be computed for a different set of
  // files than the rows it is patched onto. Only the "All" tab reads this from Postgres (see
  // `censusForTab`); every other tab, and every caller that names no tab, gets `status.candidates`.
  const census = await censusForTab(folder, status, opts?.censusTab);
  const manifestByPath = new Map(manifest.files.map((f) => [f.path, f]));
  const repoRootAbs = cfg.repo.path
    ? path.resolve(expandHome(cfg.repo.path))
    : null;
  // The git-ignore AXIS IS READ FROM GIT, NOT FROM THE LEDGER. The ledger only records files WE
  // git-ignored through our own toggle; a rule the user wrote by hand (or any pattern rule, e.g.
  // `**/videos/**`) has no ledger event, so a ledger-sourced flag reported "not ignored" for files git
  // genuinely ignores. `git check-ignore` is the source of truth for "is this file ignored" — one
  // batched call per repo. The VERBOSE form also gives us the OWNING RULE, which tells the UI whether the
  // toggle can be turned off (our exact anchored line) or is locked by a rule we must not rewrite
  // (git_ignore.mdx §5.5). Never let it break row composition. A path git could NOT answer for comes back
  // in `unknown` and the row's git-ignore axis is left UNDECIDED (`gitignore` undefined) — reporting it as
  // "not ignored" would mis-file the file into the big-files-to-ignore nudge on nothing but a spawn failure.
  //
  // STARTED HERE, AWAITED AFTER THE ROWS (performance.mdx P-37). It is BY FAR the most expensive input a
  // row has — measured at 2.3 s for 1,875 paths on a real repo, and that is git's own evaluation, not
  // process startup (29 ms) or batching (one spawn and eight cost the same). It is also needed by exactly
  // ONE column. Awaiting it up front is what kept a large repo's table blank for seconds while every fact
  // needed to draw the rows was already in hand; the axis is patched onto the rows the moment git answers.
  const ignoreP: Promise<{ rules: Map<string, IgnoreRule>; unknown: Set<string> }> = repoRootAbs
    ? checkIgnoreVerboseAsyncDetailed(
        repoRootAbs,
        census.map((c) => joinRel(repoRootAbs, c.path)),
      )
    : Promise.resolve({ rules: new Map<string, IgnoreRule>(), unknown: new Set<string>() });
  // Resolve the storage KIND ONCE per repo (it's memoized, but this also lets us hand the known type to
  // analysisOutputs so it never re-resolves per file). The analysis-artifact probe below is the same
  // value for all three task axes, so it is computed once per row and shared (see the task-status helpers).
  const storageType = repoRootAbs ? resolveStorageType(repoRootAbs) : undefined;
  // THIS device's pinned_by identity, resolved once per repo — pin truth is self-claim-only (ipfs.mdx §1.1).
  const selfLabel = computerLabel();
  // The sticky-flag map, snapshotted ONCE per repo instead of re-read and re-resolved per row
  // (config.service `flagsResolver`) — the per-row form was O(rows × flags) of repeated work.
  const flagsFor = flagsResolver();
  // Foreign-pin discoveries as a SET, built ONCE per repo — the per-row `foreignPinByAbsPath` it replaces
  // was a linear scan of the whole global index for every candidate (foreign-pin.service). Scoped to THIS
  // repo's root since slice 8: on Postgres that is one indexed read of the rows this walk can actually ask
  // about, instead of rebuilding a 2,825-entry Set of every discovery on the computer, once per repo.
  const foreignPins = await foreignPinPathSetFor(repoRootAbs);
  const local: FileRow[] = [];
  let batch: FileRow[] = [];
  let sinceYield = 0;
  for (const cand of census) {
    if (opts?.signal?.aborted) break;
    const decision: Decision = cfg.decisions[cand.path] ?? "undecided";
    const m = manifestByPath.get(cand.path);
    const peers = m?.pinned_by ?? [];
    // Sticky Never-IPFS flag (decisions.mdx §17) — surfaced so the UI can disable the Add-to-IPFS axis.
    // Cheap per-row lookup against the snapshot above; never let a flag lookup break row composition.
    let neverIpfs = false;
    try {
      if (repoRootAbs) neverIpfs = flagsFor(joinRel(repoRootAbs, cand.path)).neverIpfs;
    } catch {
      /* flags unavailable → default false */
    }
    const row: FileRow = {
      fileId: `${repoIdFromPath(cfg.repo.path || "")}:${cand.path}`,
      path: cand.path,
      sizeBytes: cand.size,
      cid: decision === "sync" ? (m?.cid ?? null) : null,
      decision,
      transfer: transferFor(decision, m?.cid ?? null, peers, selfLabel),
      peers,
      // Live pin reality for the three-state icon (one_repo.mdx §4.9). Only meaningful for a decided file
      // that has a recorded CID. Tested by CONTENT: `canonicalCid` bridges bases but not add PROFILES, so a
      // peer's `Qm…` beside our `bafk…` for the same bytes read as "not pinned here" and painted a red icon
      // on a file this computer holds (knowledge/ipfs.mdx §5.1). Undefined when we have no pinset (IPFS
      // down / not fetched) or no CID → icon shows intent only, never a false red. NO hashing here — the
      // equivalence map is a cached lookup.
      pinnedHere:
        pinset && decision === "sync" && m?.cid ? pinsetHasContent(pinset, m.cid) : undefined,
      // Node REALITY for an UNDECIDED file: a background pass discovered its bytes pinned OUTSIDE us under a
      // foreign CID (foreign_pin_discovery.mdx §6). Cheap read of the recorded global index — NO hashing on
      // this hot path. Only meaningful when the file isn't already surfacing as a decided/sync pin.
      pinnedForeign:
        repoRootAbs && decision !== "sync"
          ? foreignPins.has(joinRel(repoRootAbs, cand.path))
          : undefined,
      changedAt: cand.modified_at ?? status.last_scan_at ?? new Date(0).toISOString(),
      // Provenance and the git-ignore axis are BOTH patched in below, once their expensive sources land.
      // Until then `decidedBy`/`decidedAt` are null (the UI's "no recorded decision" state) and `gitignore`
      // is ABSENT — undetermined, which the UI must render as such and never as "not ignored".
      decidedBy: null,
      decidedAt: null,
      neverIpfs,
      // The Compress / Transcribe / Describe / OCR task-tab status (task_tabs.mdx §4.4/§5/§6). All four key
      // off the SAME analysis-artifact probe, so it is done at most ONCE per row (only when the file could
      // carry an artifact) and shared, instead of each helper re-running ~a dozen statSyncs (the
      // View-One-Repo hot-path cost this collapses). Compress reads the probe's travelling
      // compression-record signal (compress.mdx §8.2) on top of its cheap name-only verdict.
      ...(() => {
        const outputs =
          repoRootAbs && couldHaveAnalysisArtifact(path.basename(cand.path))
            ? safeAnalysisOutputs(repoRootAbs, cand.path, storageType)
            : null;
        return {
          compress: compressStatusFor(cand.path, outputs),
          transcribe: transcribeStatusFor(cand.path, outputs),
          describe: describeStatusFor(cand.path, outputs),
          ocr: ocrStatusFor(cand.path, outputs),
        };
      })(),
      // Small analysis-only media (scan.mdx §4.1 rule 5) — the "Large files only" toggle hides these by
      // default and the decision/space counts exclude them (tables.mdx §2.9, one_repo.mdx §4.1).
      analysisOnly: cand.analysisOnly === true,
      presence: "local" as const,
    };
    local.push(row);
    batch.push(row);
    // Ship the chunk, THEN breathe. Flushing before the yield is what makes the browser paint these rows
    // during the pause rather than after the whole walk (performance.mdx P-37).
    if (batch.length >= ROW_BATCH) {
      opts?.onFileBatch?.(batch);
      batch = [];
    }
    if ((sinceYield += 1) >= ROW_YIELD_EVERY) {
      sinceYield = 0;
      await rowYield();
    }
  }
  if (batch.length) opts?.onFileBatch?.(batch);

  const remote = await remoteOnlyRows(cfg, manifest, local, repoRootAbs, selfLabel, opts?.signal);
  for (let i = 0; i < remote.length; i += ROW_BATCH) {
    opts?.onFileBatch?.(remote.slice(i, i + ROW_BATCH));
  }

  // ── The two expensive per-row inputs, applied now that the rows are out ──────────────────────────────
  //
  // Order matters for wall-clock: the ledger fold is SYNCHRONOUS, so doing it while git is still running
  // overlaps the two — the whole composition ends no later than it did when both gated the rows, and the
  // first row left ~2 seconds earlier. Both are best-effort by contract; neither may break composition.
  //
  // Only LOCAL rows are enriched. A remote-only row has no bytes here, so git has nothing to answer about
  // it and it already carries its own `gitignore: false` (storage_company.mdx §8.5).
  const patch: Record<string, FileRowPatch> = {};

  // Fold the shared decision ledger for provenance (decisions.mdx §10; one_repo.mdx §4.8): who decided each
  // file and when. Wrapped so a bad/locked/conflicted ledger never breaks row composition — rows simply
  // keep the null provenance they were built with.
  const foldedByPath = await foldLedgerForRepo(cfg);
  if (foldedByPath.size > 0) {
    for (const r of local) {
      const prov = foldedByPath.get(r.path);
      if (!prov) continue;
      r.decidedBy = prov.decidedBy ?? null;
      r.decidedAt = prov.decidedAt ?? null;
      patch[r.path] = { ...patch[r.path], decidedBy: r.decidedBy, decidedAt: r.decidedAt };
    }
  }

  const { rules: ignoreRules, unknown: ignoreUnknown } = await ignoreP;
  const gitignoreRows: FileGitignoreRow[] = [];
  for (const r of local) {
    // The SAME derivation the rows used to be built with — one function, so the patched row and a
    // buffered row cannot disagree about what git said.
    const axis = gitIgnoreAxis(repoRootAbs, r.path, ignoreRules, ignoreUnknown);
    if (Object.keys(axis).length === 0) continue; // git could not answer → leave it undetermined
    Object.assign(r, axis);
    patch[r.path] = { ...patch[r.path], ...axis };
    // DUAL-WRITE of the git-ignore axis (database.mdx §9 slice 9, migration 0009). The verdict we just
    // spent a subprocess on is cached WITH its own `checked_at`, because the source is `git check-ignore`
    // — measured at 2.3 s for 1,875 paths, which is git's own evaluation and survives the migration in
    // full (database.mdx §8.3). Only rows git actually ANSWERED for get written: the `continue` above
    // already dropped the undetermined ones, and the ABSENCE of a row is what "undetermined" means in this
    // table (performance.mdx P-37 fix 4) — writing `ignored = false` for a path git could not evaluate
    // would mis-file it into the big-files-to-ignore nudge on nothing but a spawn failure.
    gitignoreRows.push({
      unitId: 0, // filled below, once — `unitIdForRoot` is one lookup per page, not one per row
      relPosix: healWindowsPath(r.path),
      ignored: axis.gitignore === true,
      locked: axis.gitignoreLocked === true,
      ruleSource: axis.gitignoreRule?.source ?? null,
      ruleLine: axis.gitignoreRule?.line ?? null,
      rulePattern: axis.gitignoreRule?.pattern ?? null,
    });
  }
  if (repoRootAbs && gitignoreRows.length && dbEnabled()) {
    // Started, not awaited: the rows are already assembled and the caller is waiting to render them. A
    // cache of a subprocess verdict is worth exactly nothing if writing it delays the page it belongs to.
    void tryDb(
      async () => {
        const unitId = await unitIdForRoot(repoRootAbs);
        if (unitId === null) return 0;
        for (const row of gitignoreRows) row.unitId = unitId;
        // The FK (0009): `file_gitignore` references `lfb.file`, so the parent rows land first. This is the
        // FOURTH writer of `lfb.file` (R5) and it claims NO column on it — a git-ignore verdict proves a
        // path exists and says nothing about the file's size, media kind or decision.
        await ensureFileRows(gitignoreRows.map((g) => ({ unitId, relPath: g.relPosix })));
        return upsertFileGitignore(gitignoreRows);
      },
      0,
      "units.composeFileRows.gitignore",
    );
  }

  if (Object.keys(patch).length > 0) opts?.onEnrich?.(patch);
  return [...local, ...remote];
}

/**
 * The rows for files ANOTHER of the user's computers has and this one does not (storage_company.mdx §8.5).
 *
 * Every row above came from the scanner's disk walk, so a file that is not here could never appear — and on a
 * second computer that is precisely the file the user needs to see. These rows are built from the reconciled
 * manifest instead: name, size, CID and peers all come from the manifest entry, because there is nothing to
 * `stat`.
 *
 * FOUR conditions, all required (§8.5): a CID, a claim by at least one device that is NOT this one, no
 * scanned candidate, and no file on this disk. The peer-claim condition is what stops a stale self-only
 * entry — a file this computer deleted on purpose — from resurrecting as a row that offers to pull bytes
 * nobody has.
 *
 * The `addedByDevice` label goes through the travelling device registry (devices.mdx §6.9): the manifest's
 * `pinned_by` token is a JOIN key, and the user must read a NAME. The registry is resolved ONCE per repo and
 * only when this repo actually produced a remote-only row — never per row, because this is a hot path.
 */
export async function remoteOnlyRows(
  cfg: RepoUnitConfig,
  manifest: Manifest,
  // Only the PATHS of the already-scanned rows matter here, so the parameter asks for exactly that much.
  // It keeps every existing caller (which passes real `FileRow[]`) working while letting the cheap
  // Repos-table path (`repoRowStats`) hand over raw scan candidates without composing rows first.
  local: ReadonlyArray<Pick<FileRow, "path">>,
  repoRootAbs: string | null,
  selfLabel: string,
  signal?: AbortSignal,
): Promise<FileRow[]> {
  if (!repoRootAbs) return [];
  const scanned = new Set(local.map((r) => r.path));
  const out: FileRow[] = [];
  // One `existsSync` per manifest entry the scan did not already account for. A repo whose peers hold far
  // more than this computer does makes that loop long, so it yields on the same interval as the row walk
  // above — otherwise it would hand back a thread the row walk had just been careful to share.
  let sinceYield = 0;
  for (const m of manifest.files) {
    if (signal?.aborted) break;
    if ((sinceYield += 1) >= ROW_YIELD_EVERY) {
      sinceYield = 0;
      await rowYield();
    }
    if (!m.cid) continue; // no CID → nothing to pull
    if (scanned.has(m.path)) continue; // the scan already produced a row for it
    const peers = (m.pinned_by ?? []).filter((d) => d && d !== selfLabel);
    if (peers.length === 0) continue; // only WE ever claimed it → not a peer's file, just a stale entry
    try {
      if (fs.existsSync(joinRel(repoRootAbs, m.path))) continue; // present here → not remote-only
    } catch {
      continue; // can't tell → don't invent a row
    }
    out.push({
      fileId: `${repoIdFromPath(cfg.repo.path || "")}:${m.path}`,
      path: m.path,
      sizeBytes: m.size ?? 0,
      cid: m.cid,
      decision: cfg.decisions[m.path] ?? "undecided",
      transfer: "pending",
      peers: m.pinned_by ?? [],
      // The bytes are demonstrably not on this node — that IS the point of the row.
      pinnedHere: false,
      pinnedForeign: false,
      // Unknown, not epoch-zero: the manifest may carry no mtime, and rendering "20654d ago" is a
      // fabricated fact (tables.mdx §4e). An empty string renders as "—" and sorts last.
      changedAt: m.modified_at ?? "",
      decidedBy: null,
      decidedAt: null,
      neverIpfs: false,
      // Git-ignore is not a question we can answer or act on for a file that is not here, and offering to
      // ignore a path with no bytes behind it is noise.
      gitignore: false,
      // Analysis on absent bytes would queue work that cannot run (§8.5), so all four task axes are "na".
      // This is also what keeps these rows off the Transcribe / Describe / OCR tabs without a special case:
      // those tabs filter on "could"/"done" (task_tabs.mdx §4.8).
      compress: "na",
      transcribe: "na",
      describe: "na",
      ocr: "na",
      analysisOnly: false,
      presence: "remote-only",
      // The RAW join token for now — resolved to the user-facing nice name below, once for the whole repo.
      addedByDevice: peers[0] ?? null,
    });
  }
  if (out.length === 0) return out; // no remote-only row → never pay for the registry read at all
  // Name the peer (devices.mdx §6.9). A token the registry can't name and that is ID-SHAPED resolves to null,
  // and the UI then says "another of your computers" — honest, still healthy, never a hex string in the
  // user's face. Non-throwing: if the storages can't be listed, every row simply keeps its raw token.
  let labels: Map<string, string>;
  try {
    labels = deviceLabelIndex(storageRootsForDeviceLabels());
  } catch (e) {
    log.warn("units", `remoteOnlyRows: device label index failed: ${(e as Error).message}`);
    return out;
  }
  return out.map((r) => ({ ...r, addedByDevice: resolveDeviceLabel(r.addedByDevice, labels) }));
}

/** The storage roots whose travelling `devices/` registries can name a peer (devices.mdx §2). Only synced
 *  storages carry a registry — a `local` storage never travels, so it can never hold another computer's
 *  device file. Best-effort: an unreadable storage list yields no roots, not an exception. */
function storageRootsForDeviceLabels(): string[] {
  const roots: string[] = [];
  for (const id of listStorageIds()) {
    const row = getStorageRow(id);
    if (row && row.type !== "local") roots.push(row.root);
  }
  return roots;
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
  unknown?: Set<string>,
): Pick<FileRow, "gitignore" | "gitignoreLocked" | "gitignoreRule"> {
  if (!repoRootAbs) return { gitignore: false };
  const abs = joinRel(repoRootAbs, relPath);
  // git could not answer for this path (repo gone, not a repo, or check-ignore genuinely failed on it).
  // Leave `gitignore` UNDEFINED — "not determined" — so the ⊘ column, the bigNotIgnored metric and the
  // `ignore` category all skip it instead of asserting a verdict git never gave (git_ignore.mdx §5.4).
  if (unknown?.has(abs)) return {};
  const rule = rules.get(abs);
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
// SECOND signal (compress.mdx §8.2): the shared `analysisOutputs` probe reports "compression" when the
// travelling compression record (`analysis/<rel>/compression.yaml`, committed with the repo) says this
// exact file was already re-encoded in place — an in-place video compress keeps its filename, so without
// the record the name heuristic would count it "compressible" forever, on every one of the user's computers.
function compressStatusFor(relPath: string, outputs: string[] | null): TaskStatus {
  const ci = compressInfo(path.basename(relPath));
  if (ci.compressible === null) return "na";
  if (ci.compressState === "done") return "done";
  return outputs?.includes("compression") ? "done" : "could";
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
  const selfLabel = computerLabel();
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
    // A REMOTE-ONLY row (storage_company.mdx §8.5) counts toward the decision question — "shall I bring this
    // here and pin it?" — and nothing else. There are no local bytes to reclaim, compress, or git-ignore, so
    // it must not inflate a space metric; its own tile is `Pull down` (router-computed from missingPinned).
    if (f.presence === "remote-only") {
      if (f.decision === "undecided") m.undecided++;
      continue;
    }
    // Foreign-pinned rows (pinnedForeign, the green state of one_repo.mdx §4.9) are excluded: the
    // Undecided tile asks "pin these?", and their bytes are already pinned on this node.
    if (f.decision === "undecided" && !f.pinnedForeign) m.undecided++;
    if (f.decision === "sync" && f.transfer === "pending") m.pending++;
    // "Lives only on this computer" — pinned HERE and claimed by no other machine (isSingleCopy), OR
    // pinned here by another tool and never published to the fleet (isUnpublishedForeignPin). Both are
    // one disk away from gone; the second used to be invisible because its transfer is "na".
    if (
      isSingleCopy(f.transfer, f.peers, selfLabel) ||
      // `false`: a remote-only row already `continue`d above, so it cannot reach here — TypeScript narrows
      // `f.presence` to "local" | undefined and rejects the comparison outright. The tally() twin has no
      // such early exit and passes its real `remoteOnly`.
      isUnpublishedForeignPin(f.decision, !!f.pinnedForeign, f.peers, selfLabel, false)
    )
      m.notBackedUp++;
    if (f.compress === "could") {
      if (compressInfo(path.basename(f.path)).compressible === "image") m.compressibleImages++;
      else m.compressibleVideos++;
    }
    if (f.compress === "done") m.alreadyCompressed++;
    // `gitignore === false` is git's OWN verdict. `undefined` means check-ignore could not answer for this
    // path (git_ignore.mdx §5.4) — an undetermined row is not a nudge, so it must not inflate this count.
    if (f.gitignore === false && f.sizeBytes >= bigFileMetricThreshold) m.bigNotIgnored++;
  }
  return m;
}

// Read + fold the repo's shared decision ledger ONCE, keyed by repo-relative path. The repo root is the
// same value decisions.service.ts derives (getRepoConfig().repo.path resolved with `~` expansion). Any
// failure (no repo path, missing/locked/merge-conflicted ledger) yields an empty map so provenance is null.
//
// THIS IS THE ORACLE, AND IT STAYS (R3 / database_migration.mdx §4.5). `foldLedgerForRepo` below prefers the
// maintained `lfb.file_decision` table, but this function is unchanged, is still what runs with no database,
// and is what the equality gate compares Postgres against for every unit.
function foldLedgerForRepoByRead(repoRoot: string): Map<string, FoldedDecision> {
  try {
    return foldLedger(readLedger(repoRoot));
  } catch (e) {
    log.warn("units", `decision provenance unavailable (using null): ${(e as Error).message}`);
    return new Map();
  }
}

/**
 * THE READ THIS SLICE CUTS OVER (R3, and the headline measurement of the whole workstream).
 *
 * Folding the raw ledger is a DISTINCT-ON-by-hand over an append log with 5.2× write amplification, and it
 * runs on every composition of the One-Repo table. 0006's header records what that costs on the largest unit
 * here — 11,423 events, 3.1 MB of YAML, 96.0 ms — against 0.23 ms to read the maintained fold.
 *
 * `null` from the repo layer means "Postgres does not know this repo", which is NOT the same as "this repo
 * has no decisions": a repo enlisted since the last `adopt_units` / `backfill_decisions` pass has a full
 * ledger and no rows. Both cases fall back to the oracle, so a repo the migration has not reached yet keeps
 * exactly the behaviour it had before Postgres existed — which is the whole of R2 at one call site.
 */
async function foldLedgerForRepo(cfg: RepoUnitConfig): Promise<Map<string, FoldedDecision>> {
  const p = cfg.repo.path;
  if (!p) return new Map();
  const repoRoot = path.resolve(expandHome(p));
  if (dbEnabled()) {
    const folded = await tryDb(() => foldedDecisionsForUnitPath(repoRoot), null, "units.foldLedgerForRepo");
    if (folded) return folded;
  }
  return foldLedgerForRepoByRead(repoRoot);
}

/** "Pinned" means pinned on THIS computer (ipfs.mdx §1.1): only OUR OWN `pinned_by` claim — the one the
 *  pin pass verifies against the real local pinset every cycle — counts. A file claimed only by peer
 *  devices is NOT pinned here; it reads `pending` so the pin pass pulls it down and pins it locally. */
export function transferFor(
  decision: Decision,
  cid: string | null,
  peers: string[],
  selfLabel: string,
): TransferStatus {
  if (decision !== "sync") return "na";
  if (!cid) return "pending";
  return peers.includes(selfLabel) ? "pinned" : "pending";
}

/**
 * Does this file live ONLY on this computer? — the "Not backed up" test (repos.mdx §3.2 col 12,
 * task_tabs.mdx §2). ONE function, because three surfaces ask it: the Repos-list column, the One-repo
 * metric tile, and the recommendations export. They each had their own copy, and the copies disagreed.
 *
 * Both halves are load-bearing:
 *
 * - `transfer === "pinned"` means THIS computer holds it — {@link transferFor} returns "pinned" only for
 *   a `sync` file that has a CID **and** carries our own `pinned_by` claim. The old test asked
 *   `decision === "sync" && cid != null` instead, which is NOT the same: a file with a CID that NOBODY
 *   claims (a peer dropped its pin, or ours was never recorded) passed it. That file is **Pending** — we
 *   want it and do not have it — so counting it here labelled a file we do not hold as "lives only on
 *   this computer", and offered the one fix that cannot work for it: "open Large File Bridge on another
 *   computer so it can pull them." There is nothing for a peer to pull. It also made the count exceed
 *   `counts.pinned`, breaking the subset relation repos.mdx §4.1a states.
 *
 * - `!peers.some(p => p !== selfLabel)` means no OTHER computer claims it. Our own claim is local pin
 *   truth, not a backup (ipfs.mdx §1.1), so it must not silence this — the same self-exclusion §4.3
 *   applies to `peerCount`.
 *
 * A remote-only row can never satisfy this (its transfer is always "pending"), which is correct: bytes
 * another computer holds are by definition not a single copy here.
 */
export function isSingleCopy(transfer: TransferStatus, peers: string[], selfLabel: string): boolean {
  return transfer === "pinned" && !peers.some((p) => p !== selfLabel);
}

/**
 * "Pinned here by some other tool, and published to nobody" — the OTHER way a file ends up as a single
 * copy on one disk (foreign_pin_discovery.mdx §5/§6).
 *
 * A foreign pin is REALITY on THIS node and nothing more: the file has no manifest entry, so no other
 * computer of the user's can see its CID, and none can fetch it. {@link isSingleCopy} cannot see this
 * state at all — it requires `transfer === "pinned"`, and an undecided row's transfer is "na" — so every
 * durability surface read these files as fine. Measured on charlie-kirk (2026-08-19): 49 videos, 2.0 GB,
 * pinned on exactly one disk, with `Not backed up anywhere` reporting 0.
 *
 * Deliberately does NOT touch the decision axis. Discovery drives reality, the decision drives intent
 * (foreign_pin_discovery.mdx §6, LOCKED) — this only stops us CLAIMING a file is safe when it is not.
 */
export function isUnpublishedForeignPin(
  decision: Decision,
  pinnedForeign: boolean,
  peers: string[],
  selfLabel: string,
  remoteOnly: boolean,
): boolean {
  // `remoteOnly` guards the one shape that looks like this but is not it: a row composed from a peer's
  // manifest with no bytes on this disk at all. There is nothing here to be a single copy OF, and leaving
  // it in made the cheap Repos-table path and the composed One-repo path disagree — caught by
  // repo-row-drift.spec.ts, which exists precisely to stop those two arithmetics drifting.
  if (remoteOnly) return false;
  // UNDECIDED specifically, not `!== "sync"`. An `ignore` decision is the user saying "do not replicate
  // this" — raising a durability alarm on it nags about a choice they already made. Undecided is the state
  // where they have said nothing AND the green pin (one_repo.mdx §4.9) actively reads as "handled", which
  // is what makes the silence dangerous. It also keeps this metric a strict subset of `counts.pinnedForeign`,
  // the bucket that counts exactly these rows.
  return decision === "undecided" && pinnedForeign && !peers.some((p) => p !== selfLabel);
}

function countDecisions(files: FileRow[]): RepoCounts {
  const counts: RepoCounts = { pinned: 0, pending: 0, undecided: 0, ignored: 0, pinnedForeign: 0 };
  for (const f of files) {
    // Small analysis-only media (scan.mdx §4.1 rule 5) is not a large-file decision the user owes — a
    // folder of thumbnails must not read as hundreds of Undecided (one_repo.mdx §4.1 / repos.mdx §4.1).
    if (f.analysisOnly) continue;
    if (f.decision === "ignore") counts.ignored++;
    else if (f.decision === "undecided") {
      // Already pinned on this node under a foreign CID (green state, one_repo.mdx §4.9) → not a pin
      // nag. Counted apart so the Undecided ask stays honest and the file still shows in the totals.
      if (f.pinnedForeign) counts.pinnedForeign++;
      else counts.undecided++;
    }
    else if (f.decision === "sync") {
      if (f.transfer === "pinned") counts.pinned++;
      else counts.pending++;
    }
  }
  return counts;
}

/** How many OTHER of your computers claim at least one of these files. `FileRow.peers` is the manifest's
 *  raw `pinned_by` list and INCLUDES this computer's own claim (pin truth is self-claim-only, ipfs.mdx
 *  §1.1) — counting it made every repo this machine pinned read >= 1 peer, so the "Peers = 0 → nothing is
 *  backing this up" alarm (repos.mdx §4.1) could never fire for the single-copy case it exists to catch. */
function peerCountForFiles(files: FileRow[]): number {
  const selfLabel = computerLabel();
  const set = new Set<string>();
  for (const f of files) for (const p of f.peers) if (p !== selfLabel) set.add(p);
  return set.size;
}

/**
 * The three aggregates one Repos-table row needs — decision counts, distinct peer count, and whether a
 * transfer is in flight — computed WITHOUT composing full FileRows (repos.mdx §4.1/§4.2).
 *
 * WHY THIS EXISTS. `computeRepoRow` used to build the complete `FileRow[]` for a repo purely to count it,
 * and a FileRow is expensive ON PURPOSE: it carries the git-ignore axis (one `git check-ignore` spawn per
 * repo) and the four task axes (a sidecar/artifact probe per file). None of that reaches the Repos table —
 * the row needs five fields per file, all of which are already in the config, the scan status and the
 * manifest. Paying the full price once per repo made `GET /api/repos` an ~11-second SYNCHRONOUS handler on
 * a 179-repo machine, which pinned the event loop for its whole duration: every other request — notably
 * the One-repo detail a row click issues — queued behind it, so clicking a repo looked like it did nothing.
 *
 * The five fields are read the SAME way `composeFileRows` reads them (decision from the config, transfer
 * from {@link transferFor}, peers from the manifest, `analysisOnly` from the candidate, `pinnedForeign`
 * from the cached foreign-pin index), and the remote-only rows come from the SAME {@link remoteOnlyRows}
 * composer, so the counts here and the counts on the One-repo page cannot drift apart.
 */
interface RepoRowStats {
  counts: RepoCounts;
  peerCount: number; // OTHER computers only — never this one (ipfs.mdx §1.1)
  transferring: boolean;
  notBackedUp: number;
  missingHere: number;
  bytes: { total: number; pinned: number };
}

async function repoRowStats(
  cfg: RepoUnitConfig,
  status: UnitStatus,
  manifest: Manifest,
): Promise<RepoRowStats> {
  const manifestByPath = new Map(manifest.files.map((f) => [f.path, f]));
  const repoRootAbs = cfg.repo.path
    ? path.resolve(expandHome(cfg.repo.path))
    : null;
  const selfLabel = computerLabel();
  // Built ONCE per repo — the `foreignPinByAbsPath` this replaces was a linear scan of the whole global
  // discovery index, run per candidate, on the very path this function exists to keep cheap.
  const foreignPins = await foreignPinPathSetFor(repoRootAbs);

  const counts: RepoCounts = { pinned: 0, pending: 0, undecided: 0, ignored: 0, pinnedForeign: 0 };
  const peerSet = new Set<string>();
  const bytes = { total: 0, pinned: 0 };
  let transferring = false;
  let notBackedUp = 0;
  let missingHere = 0;

  // One file's contribution — the exact arithmetic countDecisions()/peerCountForFiles()/computeTaskMetrics()
  // /rollupStatus() perform over a composed FileRow, applied to the raw fields instead.
  const tally = (
    decision: Decision,
    transfer: TransferStatus,
    peers: string[],
    analysisOnly: boolean,
    pinnedForeign: boolean,
    size: number,
    remoteOnly: boolean,
  ): void => {
    // Peers are OTHER computers. Pin truth is a self-claim (ipfs.mdx §1.1), so counting our own label
    // here made every locally-pinned repo read >= 1 peer and silenced the "nothing is backing this up"
    // alarm exactly where it matters. Same test computeTaskMetrics() already used per file.
    for (const p of peers) if (p !== selfLabel) peerSet.add(p);
    if (transfer === "fetching" || transfer === "pushing") transferring = true;
    if (analysisOnly) return; // small analysis-only media is not a decision the user owes (scan.mdx §4.1 rule 5)
    bytes.total += size;
    if (remoteOnly) missingHere++;
    if (decision === "ignore") counts.ignored++;
    else if (decision === "undecided") {
      if (pinnedForeign) counts.pinnedForeign++;
      else counts.undecided++;
    } else if (decision === "sync") {
      if (transfer === "pinned") {
        counts.pinned++;
        bytes.pinned += size;
      } else counts.pending++;
      if (isSingleCopy(transfer, peers, selfLabel)) notBackedUp++;
    }
    // Same arithmetic computeTaskMetrics() performs: a foreign pin nobody else claims is a single copy,
    // whatever the decision axis says. Outside the branches above because it is not a decision state.
    if (isUnpublishedForeignPin(decision, pinnedForeign, peers, selfLabel, remoteOnly)) notBackedUp++;
  };

  // Yielding on the same interval as the row walk: this loop is cheap PER candidate but a repo can hold
  // tens of thousands of them, and the Repos list runs it once per repo (performance.mdx P-37).
  let sinceYield = 0;
  for (const cand of status.candidates) {
    if ((sinceYield += 1) >= ROW_YIELD_EVERY) {
      sinceYield = 0;
      await rowYield();
    }
    const decision: Decision = cfg.decisions[cand.path] ?? "undecided";
    const m = manifestByPath.get(cand.path);
    const peers = m?.pinned_by ?? [];
    tally(
      decision,
      transferFor(decision, m?.cid ?? null, peers, selfLabel),
      peers,
      cand.analysisOnly === true,
      !!(repoRootAbs && decision !== "sync" && foreignPins.has(joinRel(repoRootAbs, cand.path))),
      cand.size,
      false,
    );
  }
  // Files only another of the user's computers holds (storage_company.mdx §8.5). Composed, not
  // re-derived: the four conditions that admit one of these rows live in exactly one place.
  for (const r of await remoteOnlyRows(cfg, manifest, status.candidates, repoRootAbs, selfLabel)) {
    tally(r.decision, r.transfer, r.peers, !!r.analysisOnly, !!r.pinnedForeign, r.sizeBytes, true);
  }

  return { counts, peerCount: peerSet.size, transferring, notBackedUp, missingHere, bytes };
}

/**
 * THE READ THIS SLICE CUTS OVER (R3, database.mdx §9 slice 11) — the Repos list's per-repo aggregates.
 *
 * `repoRowStats` above is unchanged, still runs with no database, and remains the ORACLE: it is the one
 * implementation of the arithmetic, and it is also what PRODUCES the numbers this cache stores. Nothing is
 * computed twice and nothing is computed two ways.
 *
 * THE PATH, and why each branch is where it is:
 *
 *   * A fresh, non-partial `unit_rollup` row → use it. That is one indexed lookup instead of parsing this
 *     repo's status + manifest + config, building its foreign-pin path set and walking every candidate.
 *     `readFreshRollupForPinFolder` refuses anything provisional or older than the last scan / pin pass /
 *     settings change, so "fresh" is a claim the query itself checks rather than one this function assumes.
 *   * Anything else — no database, no unit row, no rollup row yet, a partial row, a stale row, a query
 *     error — composes exactly as before and PUBLISHES the result on the way past, so the next read is the
 *     cheap one. Every one of those is an ordinary state of this app, not a fault (R2).
 *
 * `transferring` IS NOT STORED, and this is a measured statement rather than an omission: `unit_rollup` has
 * no column for it, and nothing in this codebase ever produces `transfer === 'fetching' | 'pushing'` —
 * `transferFor` returns only `na` / `pending` / `pinned`, and `remoteOnlyRows` hard-codes `pending`. So the
 * composed value is `false` for every repo on every machine today, and reading `false` from the cache
 * cannot differ from computing it. The day a live-transfer state does land, it will need a column here and
 * this comment is the reason to add one rather than to quietly keep answering `false`.
 */
async function repoRowStatsCached(
  folder: string,
  cfg: RepoUnitConfig,
  status: UnitStatus,
  manifest: Manifest,
): Promise<RepoRowStats> {
  if (dbEnabled()) {
    const cached = await tryDb(() => readFreshRollupForPinFolder(folder), null, "units.repoRowStats.read");
    if (cached) {
      return {
        counts: { ...cached.counts },
        peerCount: cached.peerCount,
        transferring: false, // see the note above — never composed as anything else on this code
        notBackedUp: cached.notBackedUp,
        missingHere: cached.missingHere,
        bytes: { ...cached.bytes },
      };
    }
  }
  const stats = await repoRowStats(cfg, status, manifest);
  // NOT awaited on the read path: the caller already has its answer, and making 105 Repos-list rows each
  // wait on a write would trade the latency this cutover exists to remove for a write nobody is reading yet.
  void publishRepoRowStats(folder, status, stats);
  return stats;
}

/**
 * Store what `repoRowStats` just computed, so the next reader does not have to compute it again.
 *
 * `fileCount` is the census size the tally actually ran over — `status.candidates` — not `big_file_count`,
 * because the counts beside it were derived from exactly these rows and a row count that disagrees with
 * them would be a third number nobody can reconcile.
 *
 * BOTH PLANES, ALWAYS, AND IN THIS ORDER. `unit_rollup` holds two independent groups of columns — the
 * decision/byte/peer plane composed above, and the charter's category plane computed by one SQL aggregate
 * (rollup.service.ts `refreshRollupCategoryCounts`). `publishUnitRollup` is the ONLY thing that clears
 * `partial`, so it must never run on a row whose category half has not been computed: a `partial = false`
 * row with four zeroes in it does not read as "not computed yet", it reads as "this repo has nothing to
 * compress", which is a number the UI would render. Categories first, publish second.
 *
 * THE ONE RACE, AND WHY IT CANNOT PRODUCE THE FAILURE THIS SLICE IS ABOUT. A Repos-list read can land
 * while a scan is mid-way through re-stating that unit's census, and this function would then clear
 * `partial` on a category count taken from a half-written `lfb.file`. That is real, and it is bounded in
 * the one direction that matters: during the upsert loop the previous generation's rows STILL carry
 * `is_candidate`, and the generation sweep that retires them is the LAST thing `publishCensus` does before
 * calling `refreshRepoRollup`. So the mid-scan census is always a SUPERSET of the settled one — a category
 * count can briefly read HIGH and then settle, and can never read low. "A count that is merely incomplete
 * getting read as a count that went DOWN" is structurally excluded, and the scan's own final publish
 * restates the true numbers within the same pass. The decision plane is unaffected either way: it is
 * composed from status/manifest/config, all of which are written atomically.
 *
 * Unable to throw, for the same reason `invalidateRollup` cannot: this is a read path, it worked before
 * Postgres existed, and it must keep working when Postgres is down (R2). It returns its promise so the
 * scan-end caller can ORDER itself after the invalidation `writeRepoStatus` just fired; the read path
 * deliberately does not wait, so the extra aggregate costs the reader nothing — MEASURED at 11-18 ms for
 * the largest repo on this machine (2,741 census rows), behind a response that has already been sent.
 */
async function publishRepoRowStats(folder: string, status: UnitStatus, stats: RepoRowStats): Promise<void> {
  if (!dbEnabled()) return;
  const payload: RollupStats = {
    fileCount: status.candidates.length,
    counts: stats.counts,
    peerCount: stats.peerCount,
    notBackedUp: stats.notBackedUp,
    missingHere: stats.missingHere,
    bytes: stats.bytes,
  };
  await tryDb(
    async () => {
      const unitId = await unitIdForPinFolder(folder);
      if (unitId === null) return 0;
      // The CHECKED-IN threshold, not the 100 MB payload one — the same value `computeTaskMetrics` counts
      // the git-ignore nudge at, so the rollup and the One-Repo tile can never disagree.
      await refreshRollupCategoryCounts(unitId, checkedInThresholdBytes());
      return publishUnitRollup(unitId, payload);
    },
    0,
    "units.repoRowStats.publish",
  );
}

/**
 * Compose this repo's aggregates from YAML and publish them — the scan-end entry point.
 *
 * The scanner calls this AFTER its pass over the unit has completed and its census is on disk, which is the
 * only moment `partial = false` is a true statement about the numbers. Exported rather than inlined into
 * the scanner because the arithmetic lives here and must not be re-implemented there.
 */
export async function refreshRepoRollup(folder: string): Promise<void> {
  if (!dbEnabled()) return;
  const cfg = getRepoConfig(folder);
  const status = getRepoStatus(folder);
  const manifest = getRepoManifest(folder);
  const stats = await repoRowStats(cfg, status, manifest);
  await publishRepoRowStats(folder, status, stats);
}

/**
 * Rolled-up status with the LOCKED precedence (repos.mdx §4.2):
 * `error` > `pinning` > `behind` > `needs_review` > `up_to_date` > `never`.
 *
 * `never` is LAST for a reason, and the old order got it backwards: it returned `never` for any repo with
 * no `last_pin_at`, ahead of `up_to_date`. So a repo whose files were all pinned and all on a peer — the
 * healthiest state the product has — reported "Repo added but never pinned" purely because this computer's
 * own pin PASS had not stamped a completion here (the bytes can arrive by import, by a pull, or by a pass
 * whose stamp predates the state root). That is what put a grey `never` pill on a row reading 114 Pinned /
 * 0 Pending / 0 Undecided.
 *
 * `never` now means what §4.2 says: nothing has been pinned here, ever. A repo LFB has never pinned AND
 * that has nothing to pin (no large files at all) is also `never` — there is no work and no verdict to
 * give, and calling that "Up to date" would be a green tick over an empty census.
 */
function rollupStatus(counts: RepoCounts, status: UnitStatus, transferring: boolean): RepoStatus {
  if (status.last_error || status.repo_state === "missing") return "error";
  if (transferring) return "pinning";
  if (counts.pending > 0) return "behind";
  if (counts.undecided > 0) return "needs_review";
  if (counts.pinned > 0 || status.last_pin_at) return "up_to_date";
  return "never";
}

// ── git helpers (no shell for scanning; git metadata read from files) ───────
export function isGitWorkingTree(dir: string): boolean {
  try {
    const gitPath = path.join(dir, ".git");
    // Non-throwing (shared/fs-probe): this is asked of EVERY directory walked, and the overwhelming
    // majority have no `.git` at all — so the not-found case is the common case, not the exception.
    const st = statOrNull(gitPath);
    if (!st) return false;
    if (st.isDirectory()) return true;
    // A .git FILE is a worktree/submodule pointer ("gitdir: <path>"). When the pointed-at gitdir no
    // longer exists (the parent repo moved, or `git worktree prune` never ran — the stale
    // .claude/worktrees/* case), every git command in this dir fatals "not a git repository: (null)".
    // That is not a usable working tree, so require the target to actually exist.
    const target = resolveGitdir(gitPath);
    // The gitdir target is always a DIRECTORY when healthy; resolveGitdir's ".git" fallback on a
    // malformed pointer file resolves back to the pointer file itself, which isDirectory() rejects.
    return isDirAt(path.isAbsolute(target) ? target : path.join(dir, target));
  } catch {
    return false;
  }
}

export function readGitRemote(dir: string): string | null {
  try {
    const gitPath = path.join(dir, ".git");
    const st = statOrNull(gitPath); // non-throwing — no `.git` is the common case (shared/fs-probe)
    if (!st) return null;
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
