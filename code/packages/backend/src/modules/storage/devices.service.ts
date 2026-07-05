// The device registry + the graft (devices.mdx). Each computer records ITSELF as one self-owned file in
// a storage's Syncable Data Location: `<storageRoot>/.lfbridge/devices/<sanitized-name>.yaml` (devices.mdx
// §2–§3). The registry travels with the SDL so every computer sees the full set; a device writes only its
// own file and treats the others as claims (same trust model as the Sync List). The GRAFT (§4) maps the
// storage's machine-independent mapped-dir keys onto THIS computer's absolute local paths. Node fs only.
import fs from "node:fs";
import path from "node:path";
import { DeviceFileSchema, type DeviceFile, type DeviceRecord } from "@lfb/shared";
import { readYaml, writeYaml } from "../../shared/store/yaml-store.js";
import { repoFolderKey } from "../../shared/store/sanitize.js";
import { getAppConfig } from "../store-model/config.service.js";
// Lazy import cycle with storage-settings.service (used only inside functions, never at module-eval time)
// — safe under NodeNext ESM, same pattern as storage.service <-> storage-settings.service.
import { readMappedDirsForRoot } from "./storage-settings.service.js";
import { LFBRIDGE_DIR } from "./tracking.service.js";
import { expandHome } from "../fs/badges.js";
import { log } from "../../shared/logging.js";

const DEVICES_DIR = "devices";

/** `<storageRoot>/.lfbridge/devices/` — the travelling device registry for one storage. */
export function devicesDir(storageRoot: string): string {
  return path.join(storageRoot, LFBRIDGE_DIR, DEVICES_DIR);
}

/** The device file path for a nice name, sanitized the same way repo/user folder keys are (devices.mdx §2). */
function deviceFilePath(storageRoot: string, deviceName: string): string {
  return path.join(devicesDir(storageRoot), `${repoFolderKey(deviceName)}.yaml`);
}

/** The nice name this computer is known by (config.yaml→computer.label; OS default until the user sets one). */
function selfName(): string {
  return getAppConfig().computer.label || "this-computer";
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

/** Read the whole device registry for a storage (every `devices/*.yaml`). Tolerates a missing dir (→ []). */
export function readDevices(storageRoot: string): DeviceRecord[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devicesDir(storageRoot), { withFileTypes: true });
  } catch {
    return []; // no devices/ dir yet → empty registry
  }
  const out: DeviceRecord[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".yaml")) continue;
    try {
      out.push(toRecord(readYaml(path.join(devicesDir(storageRoot), ent.name), DeviceFileSchema)));
    } catch (e) {
      // A malformed peer device file is a claim we simply skip — never fatal (devices.mdx §2.1).
      log.warn("storage", `skipping unreadable device file ${ent.name}: ${(e as Error).message}`);
    }
  }
  return out;
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
