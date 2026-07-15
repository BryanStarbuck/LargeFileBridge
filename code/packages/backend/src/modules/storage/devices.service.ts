// The device registry + the graft (devices.mdx). Each computer records ITSELF as one self-owned file in
// a storage's Syncable Data Location: `<storageRoot>/.lfbridge/devices/<sanitized-name>.yaml` (devices.mdx
// §2–§3). The registry travels with the SDL so every computer sees the full set; a device writes only its
// own file and treats the others as claims (same trust model as the `LargeFilesBridge_SyncList.yaml`). The GRAFT (§4) maps the
// storage's machine-independent mapped-dir keys onto THIS computer's absolute local paths. Node fs only.
import fs from "node:fs";
import path from "node:path";
import {
  DeviceFileSchema,
  disambiguateDevices,
  type DeviceFile,
  type DeviceRecord,
  type DeviceGraftEntry,
  type DeviceHardware,
  type DeviceHardwareDoc,
  type DeviceRow,
} from "@lfb/shared";
import { readYaml, writeYaml } from "../../shared/store/yaml-store.js";
import { repoFolderKey } from "../../shared/store/sanitize.js";
import { getAppConfig } from "../store-model/config.service.js";
import { peerRows } from "../store-model/peers.service.js";
// Lazy import cycle with storage-settings.service (used only inside functions, never at module-eval time)
// — safe under NodeNext ESM, same pattern as storage.service <-> storage-settings.service.
import { readMappedDirsForRoot } from "./storage-settings.service.js";
import { trackingBaseDir, legacyTrackingBaseDir } from "./storage-type.service.js";
import { expandHome } from "../fs/badges.js";
import { log } from "../../shared/logging.js";

const DEVICES_DIR = "devices";

/** The travelling device registry for one storage — under the storage's TRACKING BASE (§0):
 *  `<sdlRoot>/devices/` for an SDL (which has no `.lfbridge/`), `<repoRoot>/.lfbridge/devices/` for a working
 *  repo. In practice the registry only ever lives in an SDL, since that is what a Git backbone runs on. */
export function devicesDir(storageRoot: string): string {
  return path.join(trackingBaseDir(storageRoot), DEVICES_DIR);
}

/** The pre-migration registry location for an SDL — `<root>/.lfbridge/devices/` — or null when there is none
 *  (§0.3). READ-ONLY fallback: until `migrateSdlLfbridge()` runs, a sibling computer's device file may still
 *  be sitting here, and failing to read it would make the user's two computers invisible to each other — the
 *  exact defect git_backbone.mdx §4.2.1 records. Never a write target. */
export function legacyDevicesDir(storageRoot: string): string | null {
  const legacy = legacyTrackingBaseDir(storageRoot);
  return legacy ? path.join(legacy, DEVICES_DIR) : null;
}

/** The device file path for a nice name, sanitized the same way repo/user folder keys are (devices.mdx §2). */
function deviceFilePath(storageRoot: string, deviceName: string): string {
  return path.join(devicesDir(storageRoot), `${repoFolderKey(deviceName)}.yaml`);
}

/** The nice name this computer is known by (config.yaml→computer.label; OS default until the user sets one). */
function selfName(): string {
  return getAppConfig().computer.label || "this-computer";
}

/** THIS computer's unique device nice-name — the key for `history/<device>.txt` and the `on_device` stamp
 *  on sidecar events / repo_storage provenance (repo_tracking_scheme.mdx §3–§4). Exported reuse of the
 *  private `selfName()` so those writers never re-derive the name. */
export function selfDeviceName(): string {
  return selfName();
}

/** Map the on-disk (snake_case) hardware fingerprint to the camelCase UI mirror (devices.mdx §7). */
function hwDocToCamel(h: DeviceHardwareDoc): DeviceHardware {
  return {
    platform: h.platform,
    kind: h.kind,
    hostname: h.hostname,
    username: h.username,
    homeDir: h.home_dir,
    modelIdentifier: h.model_identifier,
    modelName: h.model_name,
    marketingName: h.marketing_name,
    year: h.year,
    chip: h.chip,
    arch: h.arch,
    cpuCores: h.cpu_cores,
    ramGb: h.ram_gb,
    diskTotalGb: h.disk_total_gb,
    screenInches: h.screen_inches,
    screenCount: h.screen_count,
  };
}

/** Map the on-disk (snake_case) device doc to the camelCase API record. */
function toRecord(doc: DeviceFile): DeviceRecord {
  return {
    schemaVersion: doc.schema_version,
    updatedAt: doc.updated_at ?? null,
    device: {
      id: doc.device.id,
      name: doc.device.name,
      owner: doc.device.owner,
      ipfsPeerId: doc.device.ipfs_peer_id,
      hardware: hwDocToCamel(doc.device.hardware),
    },
    schedule: {
      enabled: doc.schedule.enabled,
      intervalMinutes: doc.schedule.interval_minutes,
      windows: doc.schedule.windows.map((w) => ({ days: w.days, from: w.from, to: w.to })),
    },
    graft: Object.fromEntries(
      Object.entries(doc.graft).map(([k, v]) => [k, { localPath: v.local_path, wanted: v.wanted }]),
    ),
  };
}

/**
 * Write THIS computer's own device file into a storage's SDL (self-owned write — devices.mdx §2.1). Refreshes
 * identity (id/name/owner/peer id) from config.yaml→computer, preserves this device's existing schedule and
 * graft edits, and seeds a graft entry for every mapped dir not yet grafted here (from mapped_dirs.yaml's
 * canonical path, or absent when there is none). Only ever writes this device's own file.
 */
export function writeSelfDevice(storageRoot: string, opts?: { owner?: string | null }): DeviceRecord {
  const cfg = getAppConfig();
  const name = selfName();
  const file = deviceFilePath(storageRoot, name);
  fs.mkdirSync(devicesDir(storageRoot), { recursive: true });

  const existed = fs.existsSync(file);
  const current = readYaml(file, DeviceFileSchema); // defaults-on-absence

  current.device = {
    id: cfg.computer.id ?? "",
    name,
    owner: opts?.owner ?? current.device.owner ?? null,
    ipfs_peer_id: cfg.computer.ipfs_peer_id ?? null,
    // Copy THIS machine's fingerprint into the travelling registry so other computers can identify &
    // disambiguate it (devices.mdx §7). Self-owned — only ever this device's own file.
    hardware: cfg.computer.hardware,
  };
  if (!existed) {
    // A fresh device file: the default schedule matches the 15-min background pass (devices.mdx §3).
    current.schedule = { enabled: true, interval_minutes: 15, windows: [] };
  }

  // Seed the graft from the shared mapped-directory list — one entry per mapped key not already grafted
  // here (never clobber a user's existing graft edits — self-owned). canonical is the WRITER's path, so on
  // the writing machine it is a reasonable initial local_path; other computers re-root it themselves.
  const mapped = readMappedDirsForRoot(storageRoot).mapped;
  for (const m of mapped) {
    if (current.graft[m.key]) continue;
    current.graft[m.key] = m.canonical
      ? { local_path: expandHome(m.canonical), wanted: true }
      : { local_path: null, wanted: false };
  }

  writeYaml(file, current as unknown as Record<string, unknown>);
  log.info("storage", `wrote self device "${name}" (${(current.device.id || "?").slice(0, 8)}) at ${storageRoot}`);
  return toRecord(readYaml(file, DeviceFileSchema));
}

/** Read the whole device registry for a storage (every `devices/*.yaml`). Tolerates a missing dir (→ []).
 *  Reads the current registry AND, for a not-yet-migrated SDL, the legacy `.lfbridge/devices/` one (§0.3) —
 *  a sibling computer running an older build still writes there, and dropping it would make the user's
 *  computers invisible to each other. A device id present in both is taken from the CURRENT dir. */
export function readDevices(storageRoot: string): DeviceRecord[] {
  const out: DeviceRecord[] = [];
  const seen = new Set<string>();
  const legacy = legacyDevicesDir(storageRoot);
  for (const dir of [devicesDir(storageRoot), ...(legacy ? [legacy] : [])]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // no devices/ dir here → nothing to add
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".yaml")) continue;
      if (seen.has(ent.name)) continue; // current dir wins over the legacy copy
      try {
        out.push(toRecord(readYaml(path.join(dir, ent.name), DeviceFileSchema)));
        seen.add(ent.name);
      } catch (e) {
        // A malformed peer device file is a claim we simply skip — never fatal (devices.mdx §2.1).
        log.warn("storage", `skipping unreadable device file ${ent.name}: ${(e as Error).message}`);
      }
    }
  }
  return out;
}

/**
 * Read THIS computer's graft for a storage (mappedKey → { localPath, wanted }). Empty when this device has
 * no device file yet. Used by the storage settings page (§4a) to show each mapped row's local path here.
 */
export function readSelfGraft(storageRoot: string): Record<string, DeviceGraftEntry> {
  const file = deviceFilePath(storageRoot, selfName());
  if (!fs.existsSync(file)) return {};
  try {
    return toRecord(readYaml(file, DeviceFileSchema)).graft;
  } catch {
    return {};
  }
}

/**
 * Set THIS device's graft local path for one mapped-dir key (devices.mdx §4, storage_settings.mdx §4a) —
 * a self-owned write into `<SDL>/.lfbridge/devices/<self>.yaml`. A non-empty path sets the local_path and
 * marks it wanted; clearing it (null/blank) leaves the key known-but-absent here (`local_path:null`,
 * `wanted:false`). Only ever writes this device's own file; other devices' grafts are untouched.
 */
export function setSelfGraftPath(storageRoot: string, mappedKey: string, localPath: string | null): DeviceRecord {
  const file = deviceFilePath(storageRoot, selfName());
  fs.mkdirSync(devicesDir(storageRoot), { recursive: true });
  const doc = readYaml(file, DeviceFileSchema); // defaults-on-absence
  // Keep this device's identity current even if the file is being created by this edit.
  const cfg = getAppConfig();
  if (!doc.device.id) doc.device.id = cfg.computer.id ?? "";
  if (!doc.device.name) doc.device.name = selfName();
  const trimmed = localPath?.trim() || null;
  doc.graft[mappedKey] = { local_path: trimmed, wanted: trimmed !== null };
  writeYaml(file, doc as unknown as Record<string, unknown>);
  log.info("storage", `graft "${mappedKey}" → ${trimmed ?? "(absent)"} for self device at ${storageRoot}`);
  return toRecord(readYaml(file, DeviceFileSchema));
}

/**
 * Resolve a tracked file's machine-independent identity (mapped-dir key + relpath) to THIS device's absolute
 * local path via its graft (devices.mdx §4). Returns null when the mapped dir is not grafted here (no graft
 * entry, `wanted:false`, or `local_path:null`) — the file is known-but-absent on this computer. Pure resolver.
 */
export function resolveGraftedPath(storageRoot: string, mappedKey: string, relPath: string): string | null {
  const file = deviceFilePath(storageRoot, selfName());
  if (!fs.existsSync(file)) return null;
  let doc: DeviceFile;
  try {
    doc = readYaml(file, DeviceFileSchema);
  } catch {
    return null;
  }
  const g = doc.graft[mappedKey];
  if (!g || !g.wanted || !g.local_path) return null;
  return path.join(expandHome(g.local_path), relPath);
}

// A mutable accumulator row before disambiguation (devices.mdx §6).
interface RowAccum {
  id: string;
  name: string;
  isSelf: boolean;
  owner: string | null;
  ipfsPeerId: string | null;
  lastSeen: string | null;
  hardware: DeviceHardware | null;
  storageCount: number;
  source: "self" | "registry" | "peer";
}

/**
 * The rows the Devices / Peers page shows (devices.mdx §6, §9). Unions three sources by device id:
 *   1. THIS computer — ALWAYS injected from config.yaml→computer + the fingerprint, so the table is
 *      NEVER empty and always tags exactly one row "This computer".
 *   2. the machine-local peers.yaml (bare rows: id/label/peer-id/owner/last-seen, no fingerprint).
 *   3. the travelling devices/ registry across EVERY storage (carries other computers' fingerprints).
 * Then applies the disambiguation labels (device-naming.ts) so similar machines are told apart. The
 * storage list is imported lazily to avoid a module-eval cycle (storage.service imports writeSelfDevice).
 */
export async function deviceRows(): Promise<DeviceRow[]> {
  const cfg = getAppConfig();
  const selfId = cfg.computer.id ?? "";
  const acc = new Map<string, RowAccum>();

  // 1. self — always present. Owner is the logged-in OS user of THIS computer (devices.mdx §6): the
  // hardware fingerprint's username, which is exactly "who is signed in here" — not an email.
  const selfHw = hwDocToCamel(cfg.computer.hardware);
  acc.set(selfId || "self", {
    id: selfId,
    name: cfg.computer.label || "this-computer",
    isSelf: true,
    owner: selfHw.username || null,
    ipfsPeerId: cfg.computer.ipfs_peer_id ?? null,
    lastSeen: new Date().toISOString(), // this computer is here right now
    hardware: selfHw,
    storageCount: 0,
    source: "self",
  });

  // 2. peers.yaml — the user's other computers (no fingerprint on these bare entries).
  try {
    for (const p of peerRows()) {
      if (p.id === selfId) continue; // self already injected
      const existing = acc.get(p.id);
      if (existing) {
        existing.owner ??= p.owner;
        existing.ipfsPeerId ??= p.ipfsPeerId;
        existing.lastSeen ??= p.lastSeen;
      } else {
        acc.set(p.id, {
          id: p.id,
          name: p.label,
          isSelf: false,
          owner: p.owner,
          ipfsPeerId: p.ipfsPeerId,
          lastSeen: p.lastSeen,
          hardware: null,
          storageCount: 0,
          source: "peer",
        });
      }
    }
  } catch (e) {
    log.warn("storage", `deviceRows: peers.yaml read failed: ${(e as Error).message}`);
  }

  // 3. the travelling registry across every (non-local) storage.
  try {
    const { listStorageIds, getStorageRow } = await import("./storage.service.js");
    for (const id of listStorageIds()) {
      const row = getStorageRow(id);
      if (!row || row.type === "local") continue;
      for (const rec of readDevices(row.root)) {
        const rid = rec.device.id || `${rec.device.name}@${id}`;
        const isSelf = !!selfId && rid === selfId;
        const existing = acc.get(isSelf ? selfId : rid);
        if (existing) {
          existing.storageCount += 1;
          // Enrich: registry carries the fingerprint peers.yaml lacks; never overwrite the self identity.
          if (!existing.hardware && rec.device.hardware.platform) existing.hardware = rec.device.hardware;
          existing.owner ??= rec.device.owner;
          existing.ipfsPeerId ??= rec.device.ipfsPeerId;
          if (!existing.isSelf && rec.device.name) existing.name = rec.device.name;
        } else {
          acc.set(rid, {
            id: rid,
            name: rec.device.name || "device",
            isSelf,
            owner: rec.device.owner,
            ipfsPeerId: rec.device.ipfsPeerId,
            lastSeen: rec.updatedAt,
            hardware: rec.device.hardware.platform ? rec.device.hardware : null,
            storageCount: 1,
            source: "registry",
          });
        }
      }
    }
  } catch (e) {
    log.warn("storage", `deviceRows: registry union failed: ${(e as Error).message}`);
  }

  // Order: self first, then by name; then disambiguate similar machines (devices.mdx §8).
  const rows = [...acc.values()].sort((a, b) =>
    a.isSelf === b.isSelf ? a.name.localeCompare(b.name) : a.isSelf ? -1 : 1,
  );
  const labels = disambiguateDevices(rows.map((r) => ({ name: r.name, hardware: r.hardware })));
  return rows.map((r, i) => ({ ...r, displayLabel: labels[i] }));
}

/**
 * One device row by its id (devices.mdx §6) — the aggregate the "View one device" page reads. Built on
 * `deviceRows()` so it sees the SAME disambiguated label + union the table shows; returns null when no
 * device carries that id (a stale link).
 */
export async function deviceRow(id: string): Promise<DeviceRow | null> {
  return (await deviceRows()).find((r) => r.id === id) ?? null;
}
