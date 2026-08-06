// The machine-local per-storage settings (storage_settings.mdx). Reads/writes the local "settings file"
// `pin/s/<storage_id>/config.yaml` under the state root — distinct from the SHARED `storage.yaml` — via
// the atomic yaml-store. Holds THIS computer's choices: keep `.lfbridge/` + where, and which backing
// locations (dedicated repo / Google Drive / Dropbox) are ON + their local paths. Also resolves the
// PROPOSED default directory per backing type and whether the connected drive is present here (§4).
// Node fs only (charter).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StorageUnitConfigSchema, MappedDirsSchema, UnitStatusSchema, type StorageUnitConfig, type UnitStatus } from "@lfb/shared";
import type { StorageSettings, StorageBackingLocation, StorageSettingsPatch, StorageRow, MappedDir, MappedDirList, MappedDirsView, MappedDirRow, OwnedRepoRow, RepoOwner } from "@lfb/shared";
import { readYaml, writeYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { storageUnitDir, unitConfigPath, unitStatusPath } from "../../shared/store/scopes.js";
import { expandHome } from "../fs/badges.js";
import { trackingBaseDir, legacyTrackingBaseDir, RESERVED_SDL_ROOT_NAMES, usesLfbridgeDir, resolveStorageType } from "./storage-type.service.js";
// storage.service <-> storage-settings.service form a lazy import cycle (used only inside functions,
// never at module-eval time), which is safe under NodeNext ESM.
import { getStorageRow, readDescriptor, writeDescriptor } from "./storage.service.js";
import { bumpTopic, STORAGES_TOPIC } from "../events/state-events.service.js";
// units.service is imported the same way (called only inside getOwnedRepos, never at module-eval) — the
// storage.service ↔ units.service ↔ storage-settings.service cycle is already established (owner-propagation
// .service imports both). Reuses ownerForRepoConfig so a manual company owner carries its friendly name.
import { listRepoFolders, getRepoConfig, ownerForRepoConfig, repoIdFromPath } from "../store-model/units.service.js";
import { log } from "../../shared/logging.js";
import { isDirAt } from "../../shared/fs-probe.js";

const CONVENTION_SUFFIX = "_large_files_bridge";
const LFB_MIRROR_DIR = "LFB";

function storageConfigPath(storageId: string): string {
  return unitConfigPath(storageUnitDir(storageId));
}

// ── drive detection (best-effort, local only) ───────────────────────────────
/** The connected Google Drive base ("<mount>/My Drive"), or null if Drive isn't linked here. */
function detectGoogleDriveBase(): string | null {
  const cloud = path.join(os.homedir(), "Library", "CloudStorage");
  try {
    const mount = fs
      .readdirSync(cloud, { withFileTypes: true })
      .find((d) => d.isDirectory() && d.name.startsWith("GoogleDrive-"));
    if (!mount) return null;
    const myDrive = path.join(cloud, mount.name, "My Drive");
    return fs.existsSync(myDrive) ? myDrive : path.join(cloud, mount.name);
  } catch {
    return null;
  }
}

/**
 * The connected Dropbox base, or null if Dropbox isn't present here. Resolution order follows
 * dropbox.mdx §3: (1) `~/.dropbox/info.json` — Dropbox's OWN authoritative record of each linked
 * account's real root (`personal`/`business` → `path`), which correctly handles `~/Dropbox (Personal)`,
 * `~/Dropbox (Company)`, and Business paths; then (2) the common hard-coded fallbacks.
 */
function detectDropboxBase(): string | null {
  // (1) Authoritative: Dropbox writes each account's real root path into ~/.dropbox/info.json.
  try {
    const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".dropbox", "info.json"), "utf8")) as Record<
      string,
      { path?: string }
    >;
    for (const acct of ["personal", "business"] as const) {
      const p = info[acct]?.path;
      // Non-throwing (shared/fs-probe) — recorded-but-not-present is the expected miss.
      if (p && isDirAt(p)) return p;
    }
  } catch {
    /* no info.json (Dropbox not installed / not linked) — fall through to the candidates */
  }
  // (2) Fallbacks for the common default layouts.
  const candidates = [
    path.join(os.homedir(), "Dropbox"),
    path.join(os.homedir(), "Dropbox (Personal)"),
    path.join(os.homedir(), "Library", "CloudStorage", "Dropbox"),
  ];
  for (const c of candidates) {
    if (isDirAt(c)) return c; // non-throwing — most candidates legitimately don't exist
  }
  return null;
}

// ── default-directory proposals (§4) ────────────────────────────────────────
function slugForStorage(row: StorageRow): string {
  const base = path.basename(row.root).replace(new RegExp(`${CONVENTION_SUFFIX}$`), "");
  const fromBase = base.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (fromBase) return fromBase;
  const fromName = (row.name || "storage").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)[0];
  return fromName || "storage";
}

/** `~/BGit/Bryan_git/<slug>_large_files_bridge/` — or, for a repo storage, the repo root itself (§4.1). */
function defaultRepoPath(row: StorageRow): string {
  if (row.type === "repo") return row.root;
  return path.join(os.homedir(), "BGit", "Bryan_git", `${slugForStorage(row)}${CONVENTION_SUFFIX}`);
}

/** `<Drive>/LFB/<Name>/` when Drive is linked here; else the canonical relative `My Drive/LFB/<Name>`. */
function defaultDrivePath(row: StorageRow, driveBase: string | null): string {
  if (driveBase) return path.join(driveBase, LFB_MIRROR_DIR, row.name);
  return path.join("My Drive", LFB_MIRROR_DIR, row.name);
}

/** `<Dropbox>/Apps/LFB/<Name>/` when Dropbox is present; else the canonical relative `Apps/LFB/<Name>`. */
function defaultDropboxPath(row: StorageRow, dropboxBase: string | null): string {
  if (dropboxBase) return path.join(dropboxBase, "Apps", LFB_MIRROR_DIR, row.name);
  return path.join("Apps", LFB_MIRROR_DIR, row.name);
}

function backingLocation(
  cfg: { enabled: boolean; path: string | null },
  proposedDefault: string,
  available: boolean,
  readOnly = false,
): StorageBackingLocation {
  return { enabled: cfg.enabled, path: cfg.path, proposedDefault, available, readOnly };
}

function buildBacking(row: StorageRow, cfg: StorageUnitConfig): StorageSettings["backing"] {
  const driveBase = detectGoogleDriveBase();
  const dropboxBase = detectDropboxBase();
  return {
    dedicatedRepo: backingLocation(cfg.backing.dedicated_repo, defaultRepoPath(row), true, row.type === "repo"),
    googleDrive: backingLocation(cfg.backing.google_drive, defaultDrivePath(row, driveBase), driveBase !== null),
    dropbox: backingLocation(cfg.backing.dropbox, defaultDropboxPath(row, dropboxBase), dropboxBase !== null),
  };
}

function requireRow(storageId: string): StorageRow {
  const row = getStorageRow(storageId);
  if (!row) throw new Error(`unknown storage: ${storageId}`);
  if (row.type === "local") throw new Error(`storage "local" has no per-storage settings`);
  return row;
}

// ── public API ──────────────────────────────────────────────────────────────
/**
 * The effective backing locations for a storage: each type's machine-local enable flag + chosen path,
 * plus the PROPOSED default directory and whether the connected drive is reachable here (§4).
 */
export function resolveBackingLocations(storageId: string): StorageSettings["backing"] {
  const row = requireRow(storageId);
  const cfg = readYaml(storageConfigPath(storageId), StorageUnitConfigSchema);
  return buildBacking(row, cfg);
}

/** Read the machine-local per-storage settings joined with proposed defaults + identity (§5). */
export function readStorageSettings(storageId: string): StorageSettings {
  const row = requireRow(storageId);
  const cfg = readYaml(storageConfigPath(storageId), StorageUnitConfigSchema);
  return {
    storageId: row.id,
    name: row.name,
    type: row.type,
    root: row.root,
    pinned: cfg.pinned,
    autoSyncIn: cfg.auto_sync_in.enabled,
    ownerSlugs: ownerSlugsForRow(row),
    lfbridge: {
      enabled: cfg.lfbridge.enabled,
      path: cfg.lfbridge.path,
      // The kind-correct default (§0): `<root>/.lfbridge` for a working repo, `<root>` for an SDL — which
      // has none. Showing an SDL user a `.lfbridge` path here would name a folder they will never find.
      defaultPath: trackingBaseDir(row.root, row.type),
    },
    backing: buildBacking(row, cfg),
  };
}

/**
 * Apply a partial update to the machine-local config (§5). Drive/Dropbox path edits ALSO write the
 * canonical RELATIVE path into the shared `storage.yaml → clones` so every machine agrees on WHERE the
 * mirror lives relative to the drive; the enable flag + local absolute path stay machine-local.
 */
export async function writeStorageSettings(storageId: string, patch: StorageSettingsPatch): Promise<StorageSettings> {
  const row = requireRow(storageId);

  await updateYaml(storageConfigPath(storageId), StorageUnitConfigSchema, (c) => {
    // Identity mirror is written from the live row (read-only on the page — §5).
    c.storage = { id: row.id, name: row.name, type: row.type, root: row.root };
    if (patch.pinned !== undefined) c.pinned = patch.pinned; // the IPFS-pinning opt-in (the pin pass gates byte work on it)
    // The auto-sync-in radio (storage_company.mdx §14.1) — company-only, machine-local, default OFF.
    if (patch.autoSyncIn !== undefined) {
      if (row.type !== "company") throw new Error("auto-sync-in is a company-storage setting");
      c.auto_sync_in.enabled = patch.autoSyncIn;
    }
    if (patch.lfbridge) {
      if (patch.lfbridge.enabled !== undefined) c.lfbridge.enabled = patch.lfbridge.enabled;
      if (patch.lfbridge.path !== undefined) c.lfbridge.path = patch.lfbridge.path;
    }
    if (patch.backing) {
      applyBacking(c.backing.dedicated_repo, patch.backing.dedicatedRepo);
      applyBacking(c.backing.google_drive, patch.backing.googleDrive);
      applyBacking(c.backing.dropbox, patch.backing.dropbox);
    }
    return c;
  });

  // Canonical Drive/Dropbox relative paths go to the SHARED descriptor (§5). Only possible once the
  // storage has a storage.yaml — a not-yet-initialized candidate has no descriptor to update.
  const drivePath = patch.backing?.googleDrive?.path;
  const dropboxPath = patch.backing?.dropbox?.path;
  if (drivePath !== undefined || dropboxPath !== undefined) {
    const desc = readDescriptor(row.root);
    if (desc) {
      if (drivePath !== undefined) desc.clones.googleDrive = drivePath;
      if (dropboxPath !== undefined) desc.clones.dropbox = dropboxPath;
      writeDescriptor(row.root, desc);
    } else {
      log.warn("storage-settings", `${storageId}: no storage.yaml yet — clones not written (initialize the storage first)`);
    }
  }

  bumpTopic(STORAGES_TOPIC);
  return readStorageSettings(storageId);
}

function applyBacking(
  target: { enabled: boolean; path: string | null },
  patch: { enabled?: boolean; path?: string | null } | undefined,
): void {
  if (!patch) return;
  if (patch.enabled !== undefined) target.enabled = patch.enabled;
  if (patch.path !== undefined) target.path = patch.path;
}

/** Home-expanded absolute path a backing location resolves to on this computer (proposed default when unset). */
export function resolveBackingAbsPath(loc: StorageBackingLocation): string {
  return expandHome(loc.path ?? loc.proposedDefault);
}

/**
 * This computer's per-storage IPFS-pinning opt-in (the machine-local `pinned` flag, default OFF). The pin
 * pass gates a storage's mapped-dir byte work on this, mirroring the repo/computer-unit `pinned` opt-in
 * (pin_process.mdx §1). Reading a not-yet-configured storage returns the schema default (false).
 */
/** The forge org slug(s) a company storage claims (`company.owner_slugs`, storage_company.mdx §8.4.4/§14.4). */
function ownerSlugsForRow(row: StorageRow): string[] {
  if (row.type !== "company") return [];
  const raw = readDescriptor(row.root)?.company?.owner_slugs;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
}

/**
 * This computer's per-company auto-sync-in opt-in (storage_company.mdx §14.1, default OFF). Gates the
 * hourly pass that automatically pulls down teammates' pinned+decided files. Machine-local on purpose.
 */
export function getStorageAutoSyncIn(storageId: string): boolean {
  try {
    return readYaml(storageConfigPath(storageId), StorageUnitConfigSchema).auto_sync_in.enabled;
  } catch {
    return false;
  }
}

/** The auto-sync-in pass's cursor: the company backbone HEAD it last FULLY processed (§14.3), or null. */
export function readAutoSyncCursor(storageId: string): string | null {
  try {
    return readYaml(storageConfigPath(storageId), StorageUnitConfigSchema).auto_sync_in.last_seen_sha;
  } catch {
    return null;
  }
}

/** Record an auto-sync-in run: always stamps `last_run_at`; advances the cursor only when `sha` is given. */
export async function writeAutoSyncCursor(storageId: string, sha: string | null): Promise<void> {
  await updateYaml(storageConfigPath(storageId), StorageUnitConfigSchema, (c) => {
    c.auto_sync_in.last_run_at = new Date().toISOString();
    if (sha !== null) c.auto_sync_in.last_seen_sha = sha;
    return c;
  });
}

export function getStoragePinned(storageId: string): boolean {
  try {
    return readYaml(storageConfigPath(storageId), StorageUnitConfigSchema).pinned;
  } catch {
    return false;
  }
}

// ── the per-storage unit STATUS (pin/s/<id>/status.yaml) ─────────────────────
// Machine-local, alongside this storage's `config.yaml`, and never committed — the same shape repo and
// computer units have always had (`unitStatusPath`).
//
// It exists because the storage pin pass ran with `status: UnitStatusSchema.parse({})` and a no-op
// `writeStatus`, which quietly disabled the deleted-file rule for every SDL. `classifyAbsent` carries the
// grace period in `status.orphans`, so with nothing persisted every pass re-stamped a deleted file as
// "first seen absent just now": the 24h grace could never lapse, the decision never returned to Undecided,
// and this computer kept pinning bytes for a file the user deleted — indefinitely. `markUnitError` wrote
// nowhere for the same reason.

/** This storage's machine-local unit status file. */
function storageStatusPath(storageId: string): string {
  return unitStatusPath(storageUnitDir(storageId));
}

/** Read a storage's unit status (defaults-on-absence, like every other unit). */
export function getStorageUnitStatus(storageId: string): UnitStatus {
  return readYaml(storageStatusPath(storageId), UnitStatusSchema);
}

/** Write a storage's unit status. Deliberately does NOT bump a UI topic: the pin pass rewrites this every
 *  cycle and it drives no rendered surface today, so a bump would be pure refresh churn. */
export function writeStorageUnitStatus(storageId: string, status: UnitStatus): void {
  writeYaml(storageStatusPath(storageId), { ...status });
}

/**
 * This storage's Git backbone remote when its dedicated-repo backing is ON (git_backbone.mdx §1/§3). Returns
 * `{ remote }` where `remote` is either a LOCAL PATH to a checkout or an HTTP(S)/SSH URL — the git engine
 * classifies + resolves it. Returns null when the backbone is OFF or no remote is set (no git this pass).
 */
export function getDedicatedRepoRemote(storageId: string): { remote: string } | null {
  try {
    const dr = readYaml(storageConfigPath(storageId), StorageUnitConfigSchema).backing.dedicated_repo;
    if (!dr.enabled || !dr.path) return null;
    return { remote: dr.path };
  } catch {
    return null;
  }
}

/**
 * The Git backbone remote LFB actually drives for a storage each pass (git_backbone.mdx §1/§7, devices.mdx §12).
 * Resolved in priority order:
 *   1. The EXPLICIT dedicated-repo backing (`getDedicatedRepoRemote`) — the user pointed the backbone at a
 *      path (a local checkout or a URL). Always wins.
 *   2. AUTO-ADOPT the storage's OWN root when it is a `*_large_files_bridge` **company** or **personal** SDL
 *      storage AND that root is itself a git working tree (`<root>/.git` exists). Such a repo is, by
 *      definition, a purpose-built tracking-data repo the user created for LFB (the naming convention +
 *      `storage.yaml` descriptor is the configuration) — so committing & pushing our OWN device registry
 *      into it is exactly the charter's "our own content between our own machines" (storage_company.mdx),
 *      NOT a merely-discovered code repo (those are type `repo` and get `.lfbridge/` git-ignored instead).
 *      Without this, a company tracking repo had its `devices/<self>.yaml` WRITTEN but never
 *      `git add`/`commit`/`push`ed unless the user manually flipped the dedicated-repo backing switch —
 *      the exact defect reported for the Act3 company storage.
 * Returns null when neither applies (no git this pass — the local device file still travels once a backbone
 * turns on).
 */
export function getGitBackboneRemote(storageId: string): { remote: string } | null {
  const explicit = getDedicatedRepoRemote(storageId);
  if (explicit) return explicit;
  const row = getStorageRow(storageId);
  if (!row) return null;
  if (row.type !== "company" && row.type !== "personal") return null;
  const root = expandHome(row.root);
  if (fs.existsSync(path.join(root, ".git"))) return { remote: root };
  return null;
}

// ── mapped source directories (syncable_data_location.mdx §3, storage_settings.mdx §4a) ───────────────
// The SHARED list of source hierarchies a company/personal storage covers, in the SDL's
// `<root>/mapped_dirs.yaml` — at the ROOT, since an SDL has no `.lfbridge/` (artifact_placement_policy.mdx
// §0). Everything recursive under each mapped dir is in scope. The logical list travels; each device
// re-roots each key to its own absolute path via the graft (devices.mdx §4). This is only the read/write +
// schema — the scanner integration lives elsewhere.
function mappedDirsPath(root: string): string {
  return path.join(trackingBaseDir(root), "mapped_dirs.yaml");
}

/** The pre-migration location — `<root>/.lfbridge/mapped_dirs.yaml` — or null when there is none (§0.3).
 *  READ-ONLY fallback so a not-yet-migrated SDL keeps its mapped dirs; never a write target. */
function legacyMappedDirsPath(root: string): string | null {
  const legacy = legacyTrackingBaseDir(root);
  return legacy ? path.join(legacy, "mapped_dirs.yaml") : null;
}

/** A stable key slugged from a label or path: lowercase, non-alnum → `_`, trimmed. */
function slugKey(seed: string): string {
  const base = path.basename(seed || "").trim() || seed.trim();
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "dir";
}

/** Read the shared mapped-directory list for a storage ROOT (defaults-on-absence). Used by devices too. */
export function readMappedDirsForRoot(root: string): MappedDirList {
  // Prefer the current location; fall back to the pre-migration `.lfbridge/` copy for an SDL that has not
  // been migrated yet (§0.3), so its mapped dirs are not silently lost for one pass.
  const legacy = legacyMappedDirsPath(root);
  const current = mappedDirsPath(root);
  const from = !fs.existsSync(current) && legacy && fs.existsSync(legacy) ? legacy : current;
  const doc = readYaml(from, MappedDirsSchema);
  return {
    schemaVersion: doc.schema_version,
    mapped: doc.mapped.map((m) => ({ key: m.key, label: m.label, canonical: m.canonical, recursive: m.recursive })),
  };
}

/** The shared mapped-directory list for a storage (resolved from its id). */
export function getMappedDirs(storageId: string): MappedDirList {
  const row = requireRow(storageId);
  return readMappedDirsForRoot(row.root);
}

/**
 * Reject a mapped-dir key that would SHADOW an SDL's own metadata (artifact_placement_policy.mdx §0.3,
 * storage_settings.mdx §4a.1). In an SDL the mirror hangs off the ROOT — `<sdl>/<key>/…` — so a key named
 * `devices`, `analysis`, `files.yaml`, … would collide with the SDL's own root files. Reserved only for an
 * SDL: a working repo nests its metadata safely under `.lfbridge/`, so any key is fine there.
 * Throws with a message naming the reserved word; the router surfaces it on the add/rename.
 */
function assertMappedKeyAllowed(root: string, key: string): void {
  if (usesLfbridgeDir(resolveStorageType(root))) return; // working repo → nothing to shadow
  if (!RESERVED_SDL_ROOT_NAMES.has(key)) return;
  throw new Error(
    `"${key}" is a reserved name at the root of a Large File Bridge storage — it would overwrite the storage's own ${key}. Choose a different key for this mapped directory.`,
  );
}

/**
 * Write the shared mapped-directory list for a storage. A row without a `key` gets one slugged from its
 * label/canonical path (uniquified). Everything recursive under each mapped dir is in scope (recursive
 * defaults true). This edits only the SHARED list; per-computer paths are the device graft (devices.mdx).
 * Rejects a key that would shadow an SDL's root metadata (§0.3) BEFORE writing anything, so a bad key never
 * lands a half-written list.
 */
export function setMappedDirs(storageId: string, list: Array<Partial<MappedDir>>): MappedDirList {
  const row = requireRow(storageId);
  const seen = new Set<string>();
  const mapped: MappedDir[] = list.map((m) => {
    let key = (m.key ?? "").trim() || slugKey(m.label || m.canonical || "dir");
    assertMappedKeyAllowed(row.root, key);
    let candidate = key;
    let n = 2;
    while (seen.has(candidate)) candidate = `${key}_${n++}`;
    seen.add(candidate);
    return {
      key: candidate,
      label: m.label ?? "",
      canonical: m.canonical ?? null,
      recursive: m.recursive ?? true,
    };
  });
  writeYaml(mappedDirsPath(row.root), { schema_version: 1, mapped });
  bumpTopic(STORAGES_TOPIC);
  return readMappedDirsForRoot(row.root);
}

/**
 * The mapped-directory ROWS the settings page shows (§4a): the SHARED logical list joined with THIS
 * device's graft (each row's local path here). Editable only for company/personal storages; a repo
 * storage's single implicit mapped dir (its working tree) is shown read-only. Lazy-imports the graft
 * reader to avoid a module-eval import cycle (safe under NodeNext ESM — same pattern used elsewhere here).
 */
export async function getMappedDirsView(storageId: string): Promise<MappedDirsView> {
  const row = requireRow(storageId);
  const { readSelfGraft } = await import("./devices.service.js");
  const graft = readSelfGraft(row.root);
  const editable = row.type === "company" || row.type === "personal";
  const list = readMappedDirsForRoot(row.root).mapped;
  const rows: MappedDirRow[] = list.map((m) => {
    const g = graft[m.key];
    return {
      key: m.key,
      label: m.label,
      canonical: m.canonical,
      recursive: m.recursive,
      localPath: g?.localPath ?? null,
      wanted: g?.wanted ?? false,
    };
  });
  // A repo storage has exactly one implicit mapped dir — its working tree (the root) — shown read-only.
  if (!editable && rows.length === 0 && row.type === "repo") {
    rows.push({ key: "__repo__", label: "(repository working tree)", canonical: row.root, recursive: true, localPath: row.root, wanted: true });
  }
  return { storageId: row.id, editable, rows };
}

/**
 * Apply a mapped-dirs patch from the settings page (§4a): replace the SHARED list when `mapped` is given
 * (add/remove rows → mapped_dirs.yaml), and/or set THIS device's graft local path per key (`graft`).
 * A repo/local storage rejects list edits (its mapped dir is implicit). Returns the fresh joined view.
 */
export async function patchMappedDirs(
  storageId: string,
  patch: { mapped?: Array<Partial<MappedDir>>; graft?: Record<string, string | null> },
): Promise<MappedDirsView> {
  const row = requireRow(storageId);
  if (patch.mapped !== undefined) {
    if (row.type !== "company" && row.type !== "personal") {
      throw new Error(`storage "${row.type}" has an implicit mapped directory — its list is not editable`);
    }
    setMappedDirs(storageId, patch.mapped);
  }
  if (patch.graft) {
    const { setSelfGraftPath } = await import("./devices.service.js");
    for (const [key, localPath] of Object.entries(patch.graft)) {
      setSelfGraftPath(row.root, key, localPath);
    }
    bumpTopic(STORAGES_TOPIC);
  }
  return getMappedDirsView(storageId);
}

// ── owned repos (storage_settings.mdx §4c) ────────────────────────────────────
// The repos whose resolved owner (repo_company_mapping.mdx §5 — the local owner_override else the git-remote
// heuristic) maps to a company/Personal storage. This is the read side of the settings-page Owned-repos list;
// the reassign itself reuses POST /api/repos/:repoId/owner (never a new endpoint).

/** Normalized name for pragmatic company matching: lowercased with every non-alphanumeric char stripped. */
function normalizeCompanyName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Does a company owner map to THIS company storage row? A MANUAL override matches exactly by the company
 * storage id it points at. An AUTO-derived owner has `companyId: null` (no company-storage link is wired yet —
 * deriveOwnerForRemote, git.service), so we match it best-effort by a normalized comparison of its owner slug /
 * displayName against the company's friendly name, row name, and root-derived slug (repo_company_mapping.mdx
 * §3/§6). This mirrors how computePendingMappings treats companyId (manual) while still surfacing the auto
 * no-org repos §4c asks for.
 */
/**
 * The tracked-repo FOLDERS owned by a company storage, with each repo's working-tree root — the unit the
 * auto-sync-in pass iterates (storage_company.mdx §14.3 step 4). Same ownership join as getOwnedRepos,
 * but keyed by folder so callers can reach getRepoConfig(folder).decisions.
 */
export function getOwnedRepoFolders(storageId: string): Array<{ folder: string; repoRoot: string }> {
  const row = requireRow(storageId);
  if (row.type !== "company") return [];
  const out: Array<{ folder: string; repoRoot: string }> = [];
  for (const folder of listRepoFolders()) {
    try {
      const cfg = getRepoConfig(folder);
      if (!ownerMatchesCompany(ownerForRepoConfig(cfg), row)) continue;
      if (!cfg.repo.path) continue;
      out.push({ folder, repoRoot: expandHome(cfg.repo.path) });
    } catch {
      /* an unreadable repo config is skipped here; getOwnedRepos already logs it */
    }
  }
  return out;
}

function ownerMatchesCompany(owner: RepoOwner, row: StorageRow): boolean {
  if (owner.kind !== "company") return false;
  if (owner.companyId) return owner.companyId === row.id;
  const targets = new Set(
    [normalizeCompanyName(row.companyName), normalizeCompanyName(row.name), normalizeCompanyName(slugForStorage(row))].filter(
      Boolean,
    ),
  );
  return [normalizeCompanyName(owner.ownerSlug), normalizeCompanyName(owner.displayName)].some((c) => c && targets.has(c));
}

/**
 * The repos currently mapped to this storage (storage_settings.mdx §4c). For a COMPANY storage: repos whose
 * owner is that company (by the manual override's companyId, or a best-effort slug/name match for an auto
 * owner). For the PERSONAL storage: every repo whose owner is Personal — including the auto-defaulted no-org
 * repos. Empty for repo/local/community storages (they own no other repos). Never throws — a bad repo unit is
 * skipped so one corrupt config never blanks the whole list.
 */
export function getOwnedRepos(storageId: string): OwnedRepoRow[] {
  const row = requireRow(storageId);
  if (row.type !== "company" && row.type !== "personal") return [];
  const out: OwnedRepoRow[] = [];
  for (const folder of listRepoFolders()) {
    try {
      const cfg = getRepoConfig(folder);
      const owner = ownerForRepoConfig(cfg);
      const belongs = row.type === "personal" ? owner.kind === "personal" : ownerMatchesCompany(owner, row);
      if (!belongs) continue;
      out.push({
        repoId: repoIdFromPath(cfg.repo.path || folder),
        name: cfg.repo.name || folder,
        path: cfg.repo.path || "",
        owner,
      });
    } catch (e) {
      log.warn("storage-settings", `owned-repos ${storageId}: skipping repo ${folder}: ${(e as Error).message}`);
    }
  }
  return out;
}
