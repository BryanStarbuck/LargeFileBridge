// The machine-local per-storage settings (storage_settings.mdx). Reads/writes the local "settings file"
// `sync/s/<storage_id>/config.yaml` under the state root — distinct from the SHARED `storage.yaml` — via
// the atomic yaml-store. Holds THIS computer's choices: keep `.lfbridge/` + where, and which backing
// locations (dedicated repo / Google Drive / Dropbox) are ON + their local paths. Also resolves the
// PROPOSED default directory per backing type and whether the connected drive is present here (§4).
// Node fs only (charter).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StorageUnitConfigSchema, MappedDirsSchema, type StorageUnitConfig } from "@lfb/shared";
import type { StorageSettings, StorageBackingLocation, StorageSettingsPatch, StorageRow, MappedDir, MappedDirList } from "@lfb/shared";
import { readYaml, writeYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { storageUnitDir, unitConfigPath } from "../../shared/store/scopes.js";
import { expandHome } from "../fs/badges.js";
import { LFBRIDGE_DIR } from "./tracking.service.js";
// storage.service <-> storage-settings.service form a lazy import cycle (used only inside functions,
// never at module-eval time), which is safe under NodeNext ESM.
import { getStorageRow, readDescriptor, writeDescriptor } from "./storage.service.js";
import { log } from "../../shared/logging.js";

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

/** The connected Dropbox base, or null if Dropbox isn't present here. */
function detectDropboxBase(): string | null {
  const candidates = [
    path.join(os.homedir(), "Dropbox"),
    path.join(os.homedir(), "Library", "CloudStorage", "Dropbox"),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* not this one */
    }
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
    lfbridge: {
      enabled: cfg.lfbridge.enabled,
      path: cfg.lfbridge.path,
      defaultPath: path.join(row.root, LFBRIDGE_DIR),
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

// ── mapped source directories (syncable_data_location.mdx §3, storage_settings.mdx §4a) ───────────────
// The SHARED list of source hierarchies a company/personal storage covers, in the SDL's
// `<root>/.lfbridge/mapped_dirs.yaml`. Everything recursive under each mapped dir is in scope. The
// logical list travels; each device re-roots each key to its own absolute path via the graft
// (devices.mdx §4). This is only the read/write + schema — the scanner integration lives elsewhere.
function mappedDirsPath(root: string): string {
  return path.join(root, LFBRIDGE_DIR, "mapped_dirs.yaml");
}

/** A stable key slugged from a label or path: lowercase, non-alnum → `_`, trimmed. */
function slugKey(seed: string): string {
  const base = path.basename(seed || "").trim() || seed.trim();
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "dir";
}

/** Read the shared mapped-directory list for a storage ROOT (defaults-on-absence). Used by devices too. */
export function readMappedDirsForRoot(root: string): MappedDirList {
  const doc = readYaml(mappedDirsPath(root), MappedDirsSchema);
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
 * Write the shared mapped-directory list for a storage. A row without a `key` gets one slugged from its
 * label/canonical path (uniquified). Everything recursive under each mapped dir is in scope (recursive
 * defaults true). This edits only the SHARED list; per-computer paths are the device graft (devices.mdx).
 */
export function setMappedDirs(storageId: string, list: Array<Partial<MappedDir>>): MappedDirList {
  const row = requireRow(storageId);
  const seen = new Set<string>();
  const mapped: MappedDir[] = list.map((m) => {
    let key = (m.key ?? "").trim() || slugKey(m.label || m.canonical || "dir");
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
  return readMappedDirsForRoot(row.root);
}
