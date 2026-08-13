// The device registry + the graft (devices.mdx). Each computer records ITSELF as one self-owned file in
// a storage's Syncable Data Location: `<storageRoot>/.lfbridge/devices/<sanitized-name>.yaml` (devices.mdx
// §2–§3). The registry travels with the SDL so every computer sees the full set; a device writes only its
// own file and treats the others as claims (same trust model as the `LargeFilesBridge_SyncList.yaml`). The GRAFT (§4) maps the
// storage's machine-independent mapped-dir keys onto THIS computer's absolute local paths. Node fs only.
import fs from "node:fs";
import path from "node:path";
import {
  APP_BUILD,
  DeviceFileSchema,
  disambiguateDevices,
  type DeviceFile,
  type DeviceRecord,
  type DeviceGraftEntry,
  type DeviceHardware,
  type DeviceHardwareDoc,
  type DeviceRow,
} from "@lfb/shared";
import { readYaml, writeYaml, writeYamlIfChanged } from "../../shared/store/yaml-store.js";
import { repoFolderKey } from "../../shared/store/sanitize.js";
import { getAppConfig } from "../store-model/config.service.js";
import { peerRows } from "../store-model/peers.service.js";
// Lazy import cycle with storage-settings.service (used only inside functions, never at module-eval time)
// — safe under NodeNext ESM, same pattern as storage.service <-> storage-settings.service.
import { readMappedDirsForRoot } from "./storage-settings.service.js";
import { trackingBaseDir, legacyTrackingBaseDir } from "./storage-type.service.js";
import { freshVolatileHardware } from "./hardware.service.js";
import { expandHome } from "../fs/badges.js";
import { joinRelConfined } from "../../shared/rel-path.js";
import { log } from "../../shared/logging.js";
// The heartbeat floor, shared with the git backbone's quiet gate — see the module for why it is a leaf.
import { HEARTBEAT_MAX_AGE_MS, heartbeatIsStale } from "../../shared/heartbeat.js";

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
    homeUser: h.home_user,
    gitUserName: h.git_user_name,
    gitUserEmail: h.git_user_email,
    primaryIp: h.primary_ip,
    ipAddresses: h.ip_addresses,
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
      appBuild: doc.device.app_build,
      appBuildLabel: doc.device.app_build_label,
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
export function writeSelfDevice(
  storageRoot: string,
  opts?: {
    owner?: string | null;
    /** Wrapper CIDs this computer has DISPROVED (superseded-cids.service.ts), published for the fleet.
     *  INJECTED rather than imported so this module stays free of the pin layer — and OMITTED means "leave
     *  what is already published alone", never "clear it": most callers here have nothing to say about
     *  CIDs, and a caller's silence must not retract a proof the last pass wrote. */
    supersededCids?: Record<string, string>;
  },
): DeviceRecord {
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
    //
    // The VOLATILE fields (IP addresses, git identity, home user) are overlaid FRESH here rather than
    // taken from config.yaml: that copy is seeded once on first run, so a laptop that has since joined a
    // different network — or a user who fixed their `git config user.email` — would otherwise keep
    // publishing the stale value to every other computer forever (devices.mdx §7.1).
    hardware: { ...cfg.computer.hardware, ...freshVolatileHardware() },
    // Publish which build this computer runs (devices.mdx §7.2). This is SUBSTANTIVE — it moves only when
    // the user upgrades, so the one commit it costs is real news ("this computer now has the fix"), not
    // churn. It is deliberately not the git sha, which would move every few minutes on this auto-committed
    // repo and re-create the flood §6.6 removed.
    app_build: APP_BUILD.number,
    app_build_label: APP_BUILD.label,
  };
  if (!existed) {
    // A fresh device file: the default schedule matches the 15-min background pass (devices.mdx §3).
    current.schedule = { enabled: true, interval_minutes: 15, windows: [] };
  }

  // Seed the graft from the shared mapped-directory list — one entry per mapped key not already grafted
  // here (never clobber a user's existing graft edits — self-owned). canonical is the WRITER's path, so on
  // the writing machine it is a reasonable initial local_path; other computers re-root it themselves.
  if (opts?.supersededCids) current.superseded_cids = { ...opts.supersededCids };

  const mapped = readMappedDirsForRoot(storageRoot).mapped;
  for (const m of mapped) {
    if (current.graft[m.key]) continue;
    current.graft[m.key] = m.canonical
      ? { local_path: expandHome(m.canonical), wanted: true }
      : { local_path: null, wanted: false };
  }

  // ONLY write when something other than the timestamp moved (yaml-store.ts `writeYamlIfChanged`). This
  // function runs on every device pass, every pin pass and every artifact sync, for every storage — an
  // unconditional write made each of those a commit whose whole diff was `updated_at`, which is what kept
  // the backbone in a permanent conflict/retry loop and cost cycles their push.
  //
  // THE NETWORK ADDRESSES DO NOT GET A VOTE (git_backbone.mdx §6.6). `primary_ip`/`ip_addresses` are the
  // one part of the fingerprint that moves on its own: a laptop grows and drops `fe80::` link-local
  // addresses as interfaces, VPNs and AirDrop come and go, and a DHCP lease rotates on its own schedule.
  // Left in the change test they replace the `updated_at` churn with a 25-line churn — measured live in
  // the personal repo. They are still WRITTEN (they ride along on the next substantive write, so the
  // Devices table is never stale for long); they simply never justify a commit by themselves.
  let wrote = writeYamlIfChanged(file, current as unknown as Record<string, unknown>, {
    volatile: ["device.hardware.primary_ip", "device.hardware.ip_addresses"],
  });
  // THE HEARTBEAT FLOOR (shared/heartbeat.ts). The suppression above is right, and on its own it is also
  // what silenced this computer: `updated_at` is not only churn, it is the ONLY thing telling the user's
  // other computers this machine is alive (`deviceRows()` reads `lastSeen` straight off it). With nothing
  // substantive to say, this file was never rewritten at all — so the stamp froze on the last day
  // something changed, and every peer read that as "offline since then". Measured 2026-08-10: this Mac
  // Pro's record was stamped Aug 3 and pull-downs failed with "looks offline" about a computer that was
  // running the whole time.
  //
  // So once the stamp on disk has aged past the floor, write it anyway. The git backbone's quiet gate
  // holds the SAME floor (it would otherwise revert this as volatile-only), which is why the constant
  // lives in a leaf module both layers import: fixing either one alone changes nothing.
  if (!wrote && heartbeatIsStale(readYaml(file, DeviceFileSchema) as unknown as Record<string, unknown>)) {
    writeYaml(file, current as unknown as Record<string, unknown>);
    wrote = true;
    log.info(
      "storage",
      `device "${name}" heartbeat re-stamped at ${storageRoot} — the published one had aged past ` +
        `${Math.round(HEARTBEAT_MAX_AGE_MS / 3_600_000)}h, which reads as "offline" on your other computers`,
    );
  }
  if (wrote) {
    log.info("storage", `wrote self device "${name}" (${(current.device.id || "?").slice(0, 8)}) at ${storageRoot}`);
  }
  return toRecord(readYaml(file, DeviceFileSchema));
}

/**
 * The wrapper-CID corrections the user's OTHER computers have published in this storage (devices.mdx §7.3).
 *
 * Read straight off the device files rather than through `DeviceRecord`, because this is not registry
 * information a page renders — it is evidence one machine gathered and the others cannot gather themselves
 * (superseded-cids.service.ts `adoptSupersededCids` explains why it has to travel). Our own file is skipped:
 * re-adopting what we published would be a no-op at best and, if our local map has since been corrected, a
 * way to resurrect the very pair we dropped.
 */
export function readPeerSupersededCids(storageRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  const self = `${repoFolderKey(selfName())}.yaml`;
  const seen = new Set<string>();
  const legacy = legacyDevicesDir(storageRoot);
  for (const dir of [devicesDir(storageRoot), ...(legacy ? [legacy] : [])]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".yaml") || ent.name === self) continue;
      if (seen.has(ent.name)) continue; // current dir wins over the legacy copy
      seen.add(ent.name);
      try {
        for (const [k, v] of Object.entries(readYaml(path.join(dir, ent.name), DeviceFileSchema).superseded_cids)) {
          if (k && v && !out[k]) out[k] = v;
        }
      } catch (e) {
        log.warn("storage", `skipping unreadable device file ${ent.name}: ${(e as Error).message}`);
      }
    }
  }
  return out;
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

// ── Peer device LABELS: the word the rest of the product uses for "which computer has it" (§6.9) ──────
// A device's nice name is not only a row on the Devices page — it is the ENTIRE actionable content of a
// remote-only row's sentence ("On bryan-mac-pro — not on this computer yet", storage_company.mdx §8.5).
// "Somewhere else has this" is not a fix; "your Mac Tower has this" is. So a raw id must NEVER reach that
// sentence: an id is for JOINING, a name is for READING (§6.9, same posture as the truncated PeerID in §6.4).

/** How long a built label index stays warm. The registry is a handful of small YAML files, but a file table
 *  composes rows per repo and the repos list does it for every repo — re-reading every storage's `devices/`
 *  each time would turn a label lookup into a per-page fs storm. 30 s is far shorter than a rename's
 *  propagation (a backbone pass, §10), so a renamed computer still shows up promptly. */
const LABEL_INDEX_TTL_MS = 30_000;
let labelIndexCache: { at: number; key: string; map: Map<string, string> } | null = null;

/**
 * The `device id | device name` → NICE NAME index for peer-attributed UI (§6.9), built from the travelling
 * registry of the given storage roots plus the machine-local `peers.yaml`. Keys are lower-cased and BOTH the
 * id and the name are keys, because the join token a caller holds may be either: a manifest's `pinned_by`
 * carries this product's device NAMES, while a sidecar/peer record may carry the minted ID.
 * Memoized for {@link LABEL_INDEX_TTL_MS} so callers may treat it as cheap.
 */
export function deviceLabelIndex(storageRoots: string[]): Map<string, string> {
  const key = [...storageRoots].sort().join("\0");
  const now = Date.now();
  if (labelIndexCache && labelIndexCache.key === key && now - labelIndexCache.at < LABEL_INDEX_TTL_MS) {
    return labelIndexCache.map;
  }
  const map = new Map<string, string>();
  const add = (token: string | null | undefined, label: string | null | undefined) => {
    if (!token || !label) return;
    const t = token.trim().toLowerCase();
    if (t) map.set(t, label);
  };
  for (const root of storageRoots) {
    // A malformed/absent registry is a claim we simply don't have — never fatal (§2.1).
    for (const rec of readDevices(root)) {
      add(rec.device.id, rec.device.name);
      add(rec.device.name, rec.device.name);
    }
  }
  try {
    for (const p of peerRows()) {
      add(p.id, p.label);
      add(p.ipfsPeerId, p.label);
      add(p.label, p.label);
    }
  } catch (e) {
    log.warn("storage", `deviceLabelIndex: peers.yaml read failed: ${(e as Error).message}`);
  }
  labelIndexCache = { at: now, key, map };
  return map;
}

/** Tokens that are IDs, not names: a minted UUID, a long hex string, or a libp2p PeerID. A token like this
 *  must never be shown to the user (§6.9) — if the registry can't name it, the caller says "another of your
 *  computers" instead. */
function looksLikeDeviceId(token: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token) ||
    /^[0-9a-f]{16,}$/i.test(token) ||
    /^(12D3Koo|Qm)[1-9A-HJ-NP-Za-km-z]{20,}$/.test(token)
  );
}

/**
 * Resolve one `pinned_by` / `addedByDevice` token to the label a user should read (§6.9). Returns the
 * registry's nice name when it knows the token; otherwise keeps a token that already IS a plausible nice
 * name (this product writes names into `pinned_by`, and a peer whose device file hasn't arrived yet still
 * deserves to be named); and returns NULL for an id-shaped token, which is the caller's cue to say
 * "another of your computers" rather than put a hex string in the user's face.
 */
export function resolveDeviceLabel(
  token: string | null | undefined,
  index: Map<string, string>,
): string | null {
  const t = (token ?? "").trim();
  if (!t) return null;
  return index.get(t.toLowerCase()) ?? (looksLikeDeviceId(t) ? null : t);
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
  // `relPath` is a POSIX key (repo__list_syns.mdx §6.1) — joinRelConfined splits it on `/` so it lands as
  // real directories on this computer, whatever separator this OS uses, and returns null when the key would
  // escape the grafted directory. The key arrives on a SHARED manifest from another computer, and this is
  // the function that decides where its bytes are written, so "outside the graft" must read as
  // known-but-absent — the same null every other unplaceable path here returns.
  return joinRelConfined(expandHome(g.local_path), relPath);
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
