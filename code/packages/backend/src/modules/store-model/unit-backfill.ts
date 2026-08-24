// BACKFILL AREAS 1 AND 2 — devices/people, and units (database_migration.mdx §4.3).
//
// These two are first for a structural reason and not an arbitrary one: `lfb.unit.unit_id` is the ONLY FK
// target in the schema (0003) and `device_id` / `person_id` are the only dimensions a unit points at, so
// every later area — candidates, decisions, manifests, sidecars, artifacts, history — is waiting on the rows
// these two produce.
//
// Both go through `readRawYaml` and never `readYaml()` (R6 / §4.2), both write only their own columns
// (R5), and both compute every hash in TypeScript and insert it as a literal (R7). Neither one touches a
// YAML writer: this is a pure ADD behind writers that are unchanged and still running (R1).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  DeviceFileSchema,
  ManifestSchema,
  RepoStorageDocSchema,
  RepoUnitConfigSchema,
  StorageUnitConfigSchema,
} from "@lfb/shared";
import { registerBackfill, type BackfillArea, type BackfillContext, type BackfillScope } from "../../shared/persistence/backfill.js";
import { readRawYaml, readRawYamlIfPresent } from "../../shared/persistence/raw-yaml.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { isDirForKey } from "../../shared/store/keyed-dir.js";
import { repoFolderKey } from "../../shared/store/sanitize.js";
import { expandHome } from "../../shared/home-path.js";
import { log } from "../../shared/logging.js";
import { repoKeyFor } from "../storage/tracking-root.service.js";
import { repoSlugFor, repoUidFor } from "../storage/repo-identity.js";
import { storageSid } from "../storage/storage.service.js";
import { repoIdFromPath } from "./units.service.js";
import {
  countDevices,
  countPeople,
  countSelfDevices,
  countUnits,
  deviceIdsByLabel,
  personIdsByEmail,
  readUnitsForVerify,
  syncRepoIdsByPath,
  upsertDevices,
  upsertPeople,
  upsertStorageUnit,
  upsertSyncRepos,
  upsertUnit,
  upsertUnitScanLastScan,
  upsertUnitSettings,
  type DeviceUpsert,
} from "./unit.repo.js";

// ── shared path helpers (state-root layout, storage.mdx §2/§15) ─────────────────────────────────────────

const stateRoot = (): string => resolveStateDir();
const pinReposRoot = (): string => path.join(stateRoot(), "pin", "r");
const pinStoragesRoot = (): string => path.join(stateRoot(), "pin", "s");
const pinComputerDir = (): string => path.join(stateRoot(), "pin", "computer");
const trackingReposRoot = (): string => path.join(stateRoot(), "repos");

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return []; // a state root with no repos yet is normal, not an error
  }
}

function listFiles(dir: string, suffix: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(suffix))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The Local-Storage tracking dir for a repo, WITHOUT `repoStateDir()`'s `mkdir`.
 *
 * `repoStateDir()` creates the directory as a side effect (`resolveRepoStateDir` → `ensureDir`). A read-only
 * migration must not plant empty directories for repos it is only looking at, so this resolves the same
 * `<slug>-<key>` / legacy-bare-`<key>` name by the same suffix rule (`keyed-dir.ts isDirForKey`) and simply
 * returns null when nothing is there.
 */
function trackingDirFor(repoKey: string): string | null {
  for (const name of listDirs(trackingReposRoot())) {
    if (isDirForKey(name, repoKey)) return path.join(trackingReposRoot(), name);
  }
  return null;
}

/** THIS computer's label, read raw — `computerLabel()` would go through `readYaml` (R6). */
function selfLabel(): { label: string; peerId: string | null } {
  try {
    const doc = YAML.parse(fs.readFileSync(path.join(stateRoot(), "config.yaml"), "utf8")) as
      | { computer?: { label?: string; ipfs_peer_id?: string } }
      | null;
    return {
      label: doc?.computer?.label?.trim() || "this-computer",
      peerId: doc?.computer?.ipfs_peer_id?.trim() || null,
    };
  } catch {
    return { label: "this-computer", peerId: null };
  }
}

/** The SDL roots whose `devices/` registries and `repos/` mirror subtrees this machine can see. */
function sdlRoots(): string[] {
  const roots = new Set<string>();
  for (const dir of listDirs(trackingReposRoot())) {
    const marker = readMarker(path.join(trackingReposRoot(), dir));
    if (marker) roots.add(marker.syncRepo);
  }
  for (const id of listDirs(pinStoragesRoot())) {
    try {
      const cfg = readRawYaml(path.join(pinStoragesRoot(), id, "config.yaml"), StorageUnitConfigSchema);
      const root = cfg.storage.root.trim();
      if (root) roots.add(path.resolve(expandHome(root)));
    } catch {
      // A storage unit whose config is unreadable simply contributes no SDL root; area 2 rejects it by name.
    }
  }
  return [...roots].sort();
}

interface SyncRepoMarker {
  syncRepo: string;
  repoUid: string | null;
  repoSlug: string | null;
  /** The marker file's own path, so a reject can name it. */
  file: string;
}

/**
 * The three-line `.sync-repo` marker, read exactly the way `readSyncRepoMarker` reads it
 * (tracking-root.service.ts) — line 1 the SDL abs path, line 2 the `repoUid`, line 3 the `repoSlug`.
 *
 * A marker with a blank line 2 is a LEGACY ONE-LINE MARKER: it names a sync repo but no shared identity, so
 * it cannot name a subtree and `resolveStateSyncRepo` already returns null for it. Area 2 records it in the
 * reject table rather than accepting it silently — accepting it would mean writing `sync_repo_id` for a repo
 * whose mirror can never be located.
 */
function readMarker(trackingDir: string): SyncRepoMarker | null {
  const file = path.join(trackingDir, ".sync-repo");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null; // no marker → Local-Storage only, which is the default and not an error
  }
  const [syncRepo, repoUid, repoSlug] = raw.split("\n").map((l) => l.trim());
  if (!syncRepo) return null;
  return { syncRepo: path.resolve(syncRepo), repoUid: repoUid || null, repoSlug: repoSlug || null, file };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// AREA 1 — adopt_devices
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE TRANSFORM THAT IS EASY TO GET BACKWARDS (database_migration.mdx §4.4).
 *
 * `history/<device>.txt` filenames are `repoFolderKey`-SANITIZED. `pinned_by` labels are NOT. They are the
 * SAME COMPUTER under two spellings, and if they are turned into `device_id`s independently one computer
 * gets two rows — after which `pinned_here` is wrong for it forever, because half its pin claims are filed
 * under a device that is not this one and half under a device that does not exist.
 *
 * The SDL device registry is the thing that resolves them, because it holds the computer's OWN declaration
 * of its name (`devices/<sanitized>.yaml` → `device.name`, the unsanitized spelling). So the registry is
 * read FIRST and indexed BOTH ways — by the sanitized filename spelling and by the lower-cased name — and
 * every token from either source is canonicalized through it before any id is assigned.
 *
 * Measured on this machine: 12 distinct `pinned_by` labels, 9 distinct history filenames, 10 device files in
 * the act3 SDL. `nayan-neo.txt` (a history filename) resolves through the registry to the device named
 * `nayan-neo`; nothing in the registry links it to the `pinned_by` label `nayan-desktop-tqau7t7`, so those
 * stay two rows — which is the honest answer. The registry is the authority on what is one computer; we do
 * not guess beyond it.
 */
export interface DeviceRegistry {
  bySanitized: Map<string, { name: string; peerId: string | null }>;
  byLower: Map<string, { name: string; peerId: string | null }>;
}

/** One device file as the registry cares about it: its FILENAME stem and its DECLARED name. */
export interface DeviceRegistryEntry {
  fileStem: string;
  name: string;
  peerId: string | null;
}

/**
 * Index the registry BOTH ways — by the lower-cased declared name and by the sanitized filename spelling —
 * so a token from either source resolves. Split out from the reader so the resolution rule can be tested
 * without a filesystem; the reader below is the only caller in the app.
 */
export function indexDeviceRegistry(entries: DeviceRegistryEntry[]): DeviceRegistry {
  const bySanitized = new Map<string, { name: string; peerId: string | null }>();
  const byLower = new Map<string, { name: string; peerId: string | null }>();
  for (const e of entries) {
    const name = e.name.trim();
    if (!name) continue;
    const value = { name, peerId: e.peerId };
    // First registry wins, so the current dir beats the legacy copy (same rule as `readDevices`).
    if (!bySanitized.has(repoFolderKey(name))) bySanitized.set(repoFolderKey(name), value);
    if (!byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), value);
    // The FILENAME is also a spelling this fleet uses (it is what `history/<device>.txt` is named after), so
    // index it even when it disagrees with `device.name`.
    if (!bySanitized.has(e.fileStem)) bySanitized.set(e.fileStem, value);
  }
  return { bySanitized, byLower };
}

function readDeviceRegistry(roots: string[], reject: (p: string, r: string) => void): DeviceRegistry {
  const entries: DeviceRegistryEntry[] = [];
  for (const root of roots) {
    // `<root>/devices/` is the current home; `<root>/.lfbridge/devices/` is the pre-migration one a sibling
    // computer on an older build may still be writing (devices.service.ts §0.3). Reading both is what keeps
    // the user's computers visible to each other mid-upgrade.
    for (const dir of [path.join(root, "devices"), path.join(root, ".lfbridge", "devices")]) {
      for (const name of listFiles(dir, ".yaml")) {
        const file = path.join(dir, name);
        try {
          const doc = readRawYaml(file, DeviceFileSchema);
          entries.push({
            fileStem: name.slice(0, -".yaml".length),
            name: doc.device.name.trim(),
            peerId: doc.device.ipfs_peer_id?.trim() || null,
          });
        } catch (e) {
          reject(file, `device file unreadable: ${(e as Error).message}`);
        }
      }
    }
  }
  return indexDeviceRegistry(entries);
}

/** Resolve one token — a `pinned_by` label or a history filename — to the ONE name it belongs to. */
export function canonicalDeviceLabel(token: string, reg: DeviceRegistry): { label: string; peerId: string | null } {
  const t = token.trim();
  const hit = reg.byLower.get(t.toLowerCase()) ?? reg.bySanitized.get(repoFolderKey(t));
  return hit ? { label: hit.name, peerId: hit.peerId } : { label: t, peerId: null };
}

/** Every manifest on this machine — the tracking copies AND the unit copies; `pinned_by` lives in both. */
function manifestFiles(): string[] {
  const out: string[] = [];
  for (const d of listDirs(trackingReposRoot())) out.push(path.join(trackingReposRoot(), d, "manifest.yaml"));
  for (const d of listDirs(pinReposRoot())) out.push(path.join(pinReposRoot(), d, "manifest.yaml"));
  return out.filter((f) => fs.existsSync(f));
}

function historyFiles(): string[] {
  const out: string[] = [];
  for (const d of listDirs(trackingReposRoot())) {
    const dir = path.join(trackingReposRoot(), d, "history");
    for (const f of listFiles(dir, ".txt")) out.push(path.join(dir, f));
  }
  return out;
}

function deviceRegistryFiles(): string[] {
  const out: string[] = [];
  for (const root of sdlRoots()) {
    for (const dir of [path.join(root, "devices"), path.join(root, ".lfbridge", "devices")]) {
      for (const f of listFiles(dir, ".yaml")) out.push(path.join(dir, f));
    }
  }
  return out;
}

export const ADOPT_DEVICES: BackfillArea = {
  name: "adopt_devices",
  version: 1,
  kind: "backfill",
  // The manifests are in the fingerprint even though they are the expensive part, because they are the ONLY
  // source of the `pinned_by` spellings: a new teammate's computer appears in this product as a new label in
  // a manifest and nowhere else. Re-running costs a parse of ~3.4 MB and 13 upserts, off the request path.
  sources: () => [...deviceRegistryFiles(), ...historyFiles(), ...manifestFiles(), path.join(stateRoot(), "config.yaml")],
  // Bounded set, single pass, no cursor (database_migration.mdx §4.3).
  scopes: () => [{ key: "all", sources: [] }],

  async run(_scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    const reg = readDeviceRegistry(sdlRoots(), ctx.reject);
    const self = selfLabel();

    // token → canonical label. A Map keyed on the canonical label so two spellings collapse to one row.
    const devices = new Map<string, DeviceUpsert>();
    const note = (token: string): void => {
      const t = token.trim();
      if (!t) return;
      const { label, peerId } = canonicalDeviceLabel(t, reg);
      const prior = devices.get(label);
      devices.set(label, {
        label,
        folderKey: repoFolderKey(label),
        ipfsPeerId: peerId ?? prior?.ipfsPeerId ?? null,
        isSelf: prior?.isSelf ?? false,
      });
    };

    for (const entry of reg.byLower.values()) note(entry.name);
    for (const file of historyFiles()) note(path.basename(file, ".txt"));
    for (const file of manifestFiles()) {
      try {
        const m = readRawYaml(file, ManifestSchema);
        for (const f of m.files) for (const label of f.pinned_by ?? []) note(label);
      } catch (e) {
        // Mechanic (c): a manifest we cannot parse costs us its labels, not the run.
        ctx.reject(file, `manifest unreadable: ${(e as Error).message}`);
      }
    }

    // Exactly one row may carry `is_self` (`device_one_self`, 0002) — and it must be the row for THIS
    // computer under its CANONICAL spelling, or every "pinned on this computer" answer is wrong for us.
    const selfCanon = canonicalDeviceLabel(self.label, reg);
    note(selfCanon.label);
    const selfRow = devices.get(selfCanon.label)!;
    selfRow.isSelf = true;
    selfRow.ipfsPeerId ??= self.peerId;

    const rows = [...devices.values()].sort((a, b) => (a.label < b.label ? -1 : 1));
    await upsertDevices(rows);
    // RECORDS ADOPTED, not `rowCount`. A re-run's `ON CONFLICT ... DO NOTHING` legs report 0 rows affected
    // even though the records are all present, so a rowCount-based total would shrink on the second pass and
    // read as data loss. "How many records does this area account for" is the number that stays true.
    const wrote = rows.length;
    ctx.checkpoint("devices", wrote);

    // PEOPLE. The only people this machine knows are the emails in `decision_handles.yaml` (the machine-local
    // email↔handle map, decisions.mdx §14) plus the two sentinels the sidecar/history writers stamp.
    // `not-lfbridge` is the one that matters: it is how a file compressed OUTSIDE this product is recorded
    // (`file-sidecar.service.ts:27`), and without a row for it every such event would have a dangling `by`.
    const people: Array<{ email: string | null; handle: string | null; sentinel: string | null }> = [
      { email: null, handle: null, sentinel: "not-lfbridge" },
      { email: null, handle: null, sentinel: "anonymous" },
    ];
    const handleFile = path.join(stateRoot(), "decision_handles.yaml");
    try {
      const doc = YAML.parse(fs.readFileSync(handleFile, "utf8")) as { handles?: Record<string, string> } | null;
      for (const [email, handle] of Object.entries(doc?.handles ?? {})) {
        if (email.trim()) people.push({ email: email.trim(), handle: handle?.trim() || null, sentinel: null });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        ctx.reject(handleFile, `handle map unreadable: ${(e as Error).message}`);
      }
    }
    await upsertPeople(people);
    ctx.checkpoint("people", wrote + people.length);
    return { rows: wrote + people.length };
  },

  async verify() {
    const mismatches: string[] = [];
    const selves = await countSelfDevices();
    if (selves !== 1) {
      // The named per-area assertion from §4.5. `device_one_self` makes >1 impossible, so this only ever
      // fires as 0 — which means we never recognised this computer and `pinned_here` is unanswerable.
      mismatches.push(`expected exactly one device with is_self, found ${selves}`);
    }
    const devices = await countDevices();
    const people = await countPeople();
    return { yamlRows: devices + people, pgRows: devices + people, mismatches };
  },
};

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// AREA 2 — adopt_units
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE TRI-STATE OPT-OUT (database_migration.mdx §4.4) — get this backwards and every repo is opted out.
 *
 * `sync_repo.enabled` is OPTIONAL, not defaulted, and `schemas.ts:541` explains why at length: the mirror is
 * ON by default and the toggle is an OPT-OUT, so ABSENT must mean "the default" and only an explicit `false`
 * means "the user turned it off". Every repo config on this machine predates the feature and carries
 * `sync_repo: {}` — all 105 of them, measured — so a mapping that read absent as `true` would write
 * `mirror_optout = true` for the entire fleet and no manifest would ever travel again.
 *
 *     absent → NULL (default ON)      false → true (opted out)      true → false (explicitly opted in)
 */
export function mirrorOptoutFor(enabled: boolean | undefined): boolean | null {
  if (enabled === undefined) return null;
  return !enabled;
}

/** Per-run caches. Reset in `scopes()`, which the harness calls exactly once per run. */
let syncRepoIdCache = new Map<string, number>();
let deviceIdCache: Map<string, number> | null = null;
let personIdCache: Map<string, number> | null = null;
let mirrorSubtreeCache = new Map<string, string[]>();

async function syncRepoIdFor(absPath: string): Promise<number | null> {
  const hit = syncRepoIdCache.get(absPath);
  if (hit !== undefined) return hit;
  await upsertSyncRepos([{ absPath, storageSid: storageSid(absPath), name: path.basename(absPath) }]);
  syncRepoIdCache = await syncRepoIdsByPath();
  return syncRepoIdCache.get(absPath) ?? null;
}

async function deviceIdFor(label: string): Promise<number | null> {
  if (!label.trim()) return null;
  deviceIdCache ??= await deviceIdsByLabel();
  return deviceIdCache.get(label.trim()) ?? null;
}

async function personIdFor(email: string | null): Promise<number | null> {
  if (!email?.trim()) return null;
  personIdCache ??= await personIdsByEmail();
  return personIdCache.get(email.trim().toLowerCase()) ?? null;
}

/**
 * MATCH A LOCAL UNIT TO ITS MIRROR SUBTREE BY `repoUid` SUFFIX, NEVER BY EXACT DIRECTORY NAME.
 *
 * `<sdl>/repos/` holds a mix of `<slug>-<uid>` directories and legacy bare `<uid>` ones — a peer computer on
 * an older build still writes the bare form, and every subtree written before the `<slug>-<uid>` rename is
 * still sitting there. `keyed-dir.ts isDirForKey` is the rule the app itself resolves them by
 * (`resolveStateSyncRepo`), and matching on the exact name instead would leave those subtrees unmatched —
 * which reads as "this repo has never mirrored" for a repo whose mirror is right there.
 *
 * The match is what `slug_shared` is taken from: whichever spelling EXISTS is the one this fleet is using,
 * so the row records that rather than the name we would have chosen.
 */
function mirrorSubtreeName(syncRepo: string, uid: string): string | null {
  let names = mirrorSubtreeCache.get(syncRepo);
  if (!names) {
    names = listDirs(path.join(syncRepo, "repos"));
    mirrorSubtreeCache.set(syncRepo, names);
  }
  return names.find((n) => isDirForKey(n, uid)) ?? null;
}

interface RepoScopeData {
  kind: "repo";
  folder: string;
  configFile: string;
  trackingDir: string | null;
}
interface StorageScopeData {
  kind: "storage";
  id: string;
  configFile: string;
}
interface ComputerScopeData {
  kind: "computer";
  statusFile: string;
}
type UnitScopeData = RepoScopeData | StorageScopeData | ComputerScopeData;

function unitScopes(): BackfillScope[] {
  const scopes: BackfillScope[] = [];
  for (const folder of listDirs(pinReposRoot())) {
    const configFile = path.join(pinReposRoot(), folder, "config.yaml");
    // The tracking dir is resolved here so `repo_storage.yaml` and `.sync-repo` are part of the scope's
    // WATERMARK: a rename or a re-scan that rewrites either one must re-do this repo, and only this repo.
    let trackingDir: string | null = null;
    try {
      const cfg = readRawYaml(configFile, RepoUnitConfigSchema);
      if (cfg.repo.path) trackingDir = trackingDirFor(repoKeyFor(path.resolve(expandHome(cfg.repo.path))));
    } catch {
      // Unreadable here means unreadable in run() too, where it becomes a reject with the parser's message.
    }
    const sources = [configFile];
    if (trackingDir) sources.push(path.join(trackingDir, "repo_storage.yaml"), path.join(trackingDir, ".sync-repo"));
    scopes.push({ key: `r/${folder}`, sources, data: { kind: "repo", folder, configFile, trackingDir } as RepoScopeData });
  }
  for (const id of listDirs(pinStoragesRoot())) {
    const configFile = path.join(pinStoragesRoot(), id, "config.yaml");
    scopes.push({ key: `s/${id}`, sources: [configFile], data: { kind: "storage", id, configFile } as StorageScopeData });
  }
  const computerStatus = path.join(pinComputerDir(), "status.yaml");
  if (fs.existsSync(computerStatus)) {
    scopes.push({ key: "computer", sources: [computerStatus], data: { kind: "computer", statusFile: computerStatus } as ComputerScopeData });
  }
  return scopes;
}

/**
 * The directory a scope claims, or null when its config cannot name one.
 *
 * Shared by `verify()` so "how many rows SHOULD there be" is answered by the same resolution the writer
 * used — a second spelling of it would be a second thing to keep in step.
 */
function absPathForScope(data: UnitScopeData): string | null {
  try {
    if (data.kind === "computer") return "";
    if (data.kind === "repo") {
      const cfg = readRawYaml(data.configFile, RepoUnitConfigSchema);
      return cfg.repo.path.trim() ? path.resolve(expandHome(cfg.repo.path)) : null;
    }
    const cfg = readRawYaml(data.configFile, StorageUnitConfigSchema);
    return cfg.storage.root.trim() ? path.resolve(expandHome(cfg.storage.root)) : null;
  } catch {
    return null; // unreadable → already in the reject table with the parser's own message
  }
}

const PLACEMENT: Record<string, string> = {
  // The config's frozen wire enum (`lfbridge | beside | sync_repo`) onto the schema's `placement` enum. The
  // `lfbridge` spelling means "the repo's TRACKING BASE", which 0003 names `tracking_base`; `legacy_lfbridge`
  // is a different thing (the pre-migration `.lfbridge/` location) and must not be reached from here.
  lfbridge: "tracking_base",
  beside: "beside",
  sync_repo: "sync_repo",
};

const UNIT_MULTIPLIER: Record<string, number> = { MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

async function runRepoScope(data: RepoScopeData, ctx: BackfillContext): Promise<number> {
  let cfg;
  try {
    cfg = readRawYaml(data.configFile, RepoUnitConfigSchema);
  } catch (e) {
    ctx.reject(data.configFile, `pin unit config unreadable: ${(e as Error).message}`);
    return 0;
  }
  if (!cfg.repo.path.trim()) {
    ctx.reject(data.configFile, "pin unit config has no repo.path — cannot key a unit");
    return 0;
  }

  // R7: every one of these is a TypeScript hash, inserted as a literal. Postgres never recomputes one.
  const absPath = path.resolve(expandHome(cfg.repo.path));
  const repoKey = repoKeyFor(absPath);
  const repoId = repoIdFromPath(absPath);
  const sid = storageSid(absPath);
  const remote = cfg.repo.remote?.trim() || null;

  const trackingDir = data.trackingDir ?? trackingDirFor(repoKey);
  const marker = trackingDir ? readMarker(trackingDir) : null;

  let repoUid: string | null = null;
  let syncRepoId: number | null = null;
  let slugShared: string | null = repoSlugFor(remote);
  if (marker) {
    if (!marker.repoUid) {
      // §4.5's named assertion: a marker with no uid is a LEGACY ONE-LINE MARKER and is recorded, not
      // silently accepted. It names a sync repo but no shared identity, so its mirror subtree can never be
      // located — `resolveStateSyncRepo` already returns null for it, and a `sync_repo_id` written anyway
      // would claim a mirror that does not exist.
      ctx.reject(marker.file, "legacy .sync-repo marker: no repoUid on line 2");
    } else {
      repoUid = marker.repoUid;
      syncRepoId = await syncRepoIdFor(marker.syncRepo);
      const matched = mirrorSubtreeName(marker.syncRepo, repoUid);
      if (matched) {
        // The matched directory's own prefix, so a subtree written under a different slug (or the bare-uid
        // legacy form, which yields '') is recorded as it actually is on disk.
        slugShared = matched === repoUid ? "" : matched.slice(0, matched.length - repoUid.length - 1);
      } else {
        slugShared = marker.repoSlug ?? repoSlugFor(remote);
      }
      const computed = repoUidFor(remote);
      if (computed && computed !== repoUid) {
        // Not a reject — the marker is what the mirror actually uses, so it wins. But a disagreement means
        // the remote changed under a repo that is already mirroring, and that is worth a line.
        log.warn(
          "migrate",
          `adopt_units: ${absPath} marker repoUid ${repoUid} != repoUidFor(remote) ${computed} — ` +
            `the marker wins (it is what resolveStateSyncRepo reads)`,
        );
      }
    }
  }

  let storageDoc = null;
  if (trackingDir) {
    const file = path.join(trackingDir, "repo_storage.yaml");
    try {
      storageDoc = readRawYamlIfPresent(file, RepoStorageDocSchema);
    } catch (e) {
      ctx.reject(file, `repo_storage unreadable: ${(e as Error).message}`);
    }
  }
  const rs = storageDoc?.repo_storage;

  const unitId = await upsertUnit({
    kind: "repo",
    absPath,
    repoKey,
    repoId,
    storageSid: sid,
    pinFolder: data.folder,
    repoUid,
    slugLocal: path.basename(absPath),
    slugShared,
    name: rs?.name || cfg.repo.name || path.basename(absPath),
    remote,
    syncRepoId,
    mirrorOptout: mirrorOptoutFor(cfg.sync_repo.enabled),
    enlistedAt: rs?.enlisted.at ? new Date(rs.enlisted.at) : null,
    enlistedBy: await personIdFor(rs?.enlisted.by ?? null),
    enlistedOnDevice: await deviceIdFor(rs?.enlisted.on_device ?? ""),
  });
  if (unitId === null) return 0;

  const overrideBytes = Math.round(cfg.big_file_override.value * (UNIT_MULTIPLIER[cfg.big_file_override.unit] ?? 1));
  await upsertUnitSettings([
    {
      unitId,
      pinned: cfg.pinned,
      bookmarked: cfg.bookmarked,
      bigFileOverrideOn: cfg.big_file_override.enabled,
      // The CHECK is `NULL OR > 0`. A configured 0 is not a threshold, it is an unset field.
      bigFileOverrideBytes: overrideBytes > 0 ? overrideBytes : null,
      followGitignore: cfg.large_files.follow_gitignore,
      includeGlobs: cfg.large_files.include_globs,
      excludeGlobs: cfg.large_files.exclude_globs,
      pinLocally: cfg.pin.pin_locally,
      fetchMissing: cfg.pin.fetch_missing,
      publishManifest: cfg.pin.publish_manifest,
      accessShared: cfg.access.shared,
      accessParticipants: cfg.access.participants,
      transcriptionPlacement: PLACEMENT[cfg.artifacts.transcription_placement] ?? "tracking_base",
      descriptionPlacement: PLACEMENT[cfg.artifacts.ai_description_placement] ?? "tracking_base",
      ocrPlacement: PLACEMENT[cfg.artifacts.ocr_placement] ?? "tracking_base",
      ownerOverrideKind: cfg.owner_override?.kind ?? null,
      ownerOverrideCompany: cfg.owner_override?.company_id ?? null,
      recommendIpfsPin: rs?.policy.recommend_ipfs_pin ?? true,
      recommendCompress: rs?.policy.recommend_compress ?? true,
      recommendTranscribe: rs?.policy.recommend_transcribe ?? false,
    },
  ]);

  if (rs?.last_scan.at) {
    await upsertUnitScanLastScan([
      {
        unitId,
        lastScanAt: new Date(rs.last_scan.at),
        lastScanDevice: await deviceIdFor(rs.last_scan.on_device),
        lastScanHeadless: rs.last_scan.headless,
      },
    ]);
  }
  return 1;
}

async function runStorageScope(data: StorageScopeData, ctx: BackfillContext): Promise<number> {
  let cfg;
  try {
    cfg = readRawYaml(data.configFile, StorageUnitConfigSchema);
  } catch (e) {
    ctx.reject(data.configFile, `storage unit config unreadable: ${(e as Error).message}`);
    return 0;
  }
  const root = cfg.storage.root.trim();
  if (!root) {
    ctx.reject(data.configFile, "storage unit config has no storage.root — cannot key a unit");
    return 0;
  }
  const absPath = path.resolve(expandHome(root));
  // `local` and `repo` storage types have no `unit_kind` of their own; they are the generic 'storage'.
  const kind = cfg.storage.type === "personal" || cfg.storage.type === "company" || cfg.storage.type === "community"
    ? cfg.storage.type
    : "storage";
  const unitId = await upsertStorageUnit({
    kind,
    absPath,
    repoKey: null,
    repoId: null,
    storageSid: cfg.storage.id || storageSid(absPath),
    pinFolder: null,
    repoUid: null,
    slugLocal: path.basename(absPath),
    slugShared: null,
    name: cfg.storage.name,
    remote: null,
    syncRepoId: null,
    mirrorOptout: null,
    enlistedAt: null,
    enlistedBy: null,
    enlistedOnDevice: null,
  });
  if (unitId === null) return 0;
  await upsertUnitSettings([
    {
      unitId,
      pinned: cfg.pinned,
      bookmarked: false,
      bigFileOverrideOn: false,
      bigFileOverrideBytes: null,
      followGitignore: true,
      includeGlobs: [],
      excludeGlobs: [],
      pinLocally: true,
      fetchMissing: true,
      publishManifest: true,
      accessShared: false,
      accessParticipants: [],
      transcriptionPlacement: "tracking_base",
      descriptionPlacement: "tracking_base",
      ocrPlacement: "tracking_base",
      ownerOverrideKind: null,
      ownerOverrideCompany: null,
      recommendIpfsPin: true,
      recommendCompress: true,
      recommendTranscribe: false,
    },
  ]);
  return 1;
}

async function runComputerScope(): Promise<number> {
  // The computer unit is the one row `unit_computer_pathless` exists for: it has no directory, because it IS
  // the machine. `storage_sid` is NOT NULL, so it takes the same literal `pin_folder` uses.
  const unitId = await upsertUnit({
    kind: "computer",
    absPath: "",
    repoKey: null,
    repoId: null,
    storageSid: "computer",
    pinFolder: "computer",
    repoUid: null,
    slugLocal: "",
    slugShared: null,
    name: "This computer",
    remote: null,
    syncRepoId: null,
    mirrorOptout: null,
    enlistedAt: null,
    enlistedBy: null,
    enlistedOnDevice: null,
  });
  return unitId === null ? 0 : 1;
}

export const ADOPT_UNITS: BackfillArea = {
  name: "adopt_units",
  version: 1,
  kind: "backfill",
  sources: () => unitScopes().flatMap((s) => s.sources),
  scopes: () => {
    // One run, one set of caches. `scopes()` is called exactly once per run by the harness, which makes it
    // the honest place to reset them — a stale `deviceIdCache` across runs would attach this run's units to
    // the previous run's device ids.
    syncRepoIdCache = new Map();
    deviceIdCache = null;
    personIdCache = null;
    mirrorSubtreeCache = new Map();
    return unitScopes();
  },

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    const data = scope.data as UnitScopeData;
    let rows = 0;
    if (data.kind === "repo") rows = await runRepoScope(data, ctx);
    else if (data.kind === "storage") rows = await runStorageScope(data, ctx);
    else rows = await runComputerScope();
    ctx.checkpoint(scope.key, rows);
    return { rows };
  },

  async verify() {
    const mismatches: string[] = [];
    const scopes = unitScopes();
    // EXPECTED ROWS IS DISTINCT DIRECTORIES, NOT SCOPES. `unit_abs_path_unique` means one directory is one
    // row, and on this machine two of the 105 tracked repos ARE the two registered storages — so 108 scopes
    // legitimately produce 106 rows. Counting scopes here would report that as a missing-row mismatch, which
    // would block the read cutover over a correct result (§4.5: a non-empty mismatch list blocks it).
    const yamlRows = new Set(scopes.map((s) => absPathForScope(s.data as UnitScopeData)).filter((p) => p !== null))
      .size;
    const rows = await readUnitsForVerify();
    const byPath = new Map(rows.map((r) => [r.abs_path, r]));

    for (const scope of scopes) {
      const data = scope.data as UnitScopeData;
      if (data.kind !== "repo") continue;
      let cfg;
      try {
        cfg = readRawYaml(data.configFile, RepoUnitConfigSchema);
      } catch {
        continue; // already in the reject table with the parser's own message
      }
      if (!cfg.repo.path.trim()) continue;
      const absPath = path.resolve(expandHome(cfg.repo.path));
      const row = byPath.get(absPath);
      if (!row) {
        mismatches.push(`${scope.key}: no unit row for ${absPath}`);
        continue;
      }
      // §4.5: every repo_key matches its Local-Storage directory suffix.
      const repoKey = repoKeyFor(absPath);
      if (row.repo_key !== repoKey) mismatches.push(`${scope.key}: repo_key ${row.repo_key} != ${repoKey}`);
      if (row.repo_id !== repoIdFromPath(absPath)) mismatches.push(`${scope.key}: repo_id disagrees`);
      const dir = trackingDirFor(repoKey);
      if (dir && !isDirForKey(path.basename(dir), row.repo_key ?? "")) {
        mismatches.push(`${scope.key}: ${path.basename(dir)} is not a directory for ${row.repo_key}`);
      }
      // §4.5: every unit with a marker that HAS a uid must carry both sync_repo_id and repo_uid.
      const marker = dir ? readMarker(dir) : null;
      if (marker?.repoUid) {
        if (row.repo_uid !== marker.repoUid) mismatches.push(`${scope.key}: repo_uid ${row.repo_uid} != ${marker.repoUid}`);
        if (row.sync_repo_id === null) mismatches.push(`${scope.key}: marker present but sync_repo_id is NULL`);
      }
      // The tri-state, asserted rather than assumed — this is the one that silently opts a fleet out.
      const expected = mirrorOptoutFor(cfg.sync_repo.enabled);
      if (row.mirror_optout !== expected) {
        mismatches.push(`${scope.key}: mirror_optout ${row.mirror_optout} != ${expected}`);
      }
    }

    const pgRows = await countUnits();
    if (pgRows < yamlRows) mismatches.push(`only ${pgRows} unit rows for ${yamlRows} distinct directories`);
    return { yamlRows, pgRows, mismatches };
  },
};

/**
 * Register areas 1 and 2, in that order — devices before units, because a unit's `enlisted_on_device` and
 * `last_scan_device` are device ids.
 *
 * Explicit rather than a module-load side effect, so importing this file for a single exported helper (the
 * specs import `mirrorOptoutFor`) does not silently mutate the global registry.
 */
export function registerUnitBackfills(): void {
  registerBackfill(ADOPT_DEVICES);
  registerBackfill(ADOPT_UNITS);
}
