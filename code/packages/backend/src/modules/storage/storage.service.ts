// The Storages backend (storages.mdx). Discovers the directory-based storages (repo / personal /
// company / community) by their `storage.yaml` descriptor and by the `*_large_files_bridge` naming
// convention, reads/writes the descriptor, and assembles the Storages tab/page payload. Local storage
// (settings/config, the DB replacement) is represented as a single row, not discovered. Node fs only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import type {
  StorageDescriptor,
  StorageRow,
  StoragesPageData,
  StorageDetail,
  StorageType,
  StorageClones,
  BookmarksResult,
} from "@lfb/shared";
import { BookmarksSchema } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { listRepoFolders } from "../store-model/units.service.js";
import { expandHome } from "../fs/badges.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { readYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { readStorageIndex, countStorageIndex, indexStorageFiles, LFBRIDGE_DIR } from "./tracking.service.js";
import { analyzeFile } from "./analysis.service.js";
// Lazy import cycles with storage-settings.service (ensureBackingLocations) and devices.service
// (writeSelfDevice) — used only inside functions, never at module-eval time — safe under NodeNext ESM.
import { readStorageSettings, writeStorageSettings } from "./storage-settings.service.js";
import { writeSelfDevice } from "./devices.service.js";
// Lazy import cycle with repo-storage.service (it imports storageSid from here) — used only inside
// functions, never at module-eval time — safe under NodeNext ESM, same pattern as the imports above.
import { ensureRepoStorageDoc } from "./repo-storage.service.js";
import { log } from "../../shared/logging.js";

const STORAGE_YAML = "storage.yaml";
const CONVENTION_SUFFIX = "_large_files_bridge";
const EMPTY_CLONES: StorageClones = { googleDrive: null, dropbox: null };
const DISCOVER_DEPTH = 3; // how deep under each scanner root we look for storages.

// ── helpers ──────────────────────────────────────────────────────────────────
function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}
function shortHash(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/**
 * The Storage ID (SID) for a storage rooted at `root` — mirrors buildRow()'s id derivation so a repo's
 * SID matches its Storages-tab identity. Used to stamp the SID on every decision record (decisions.mdx
 * §3.1), including for a `repo` storage (which buildRow filters out of the Storages list but still has a
 * stable id).
 */
export function storageSid(root: string): string {
  const resolved = path.resolve(root);
  const desc = readDescriptor(resolved);
  const type: StorageType = desc?.type ?? classifyByConvention(resolved) ?? "repo";
  if (type === "personal") return "personal";
  if (type === "community") return desc?.community?.id ?? shortHash(resolved);
  return shortHash(resolved);
}
function prettyName(base: string): string {
  return base
    .replace(new RegExp(`${CONVENTION_SUFFIX}$`), "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || base;
}

// ── descriptor read / write (storages.mdx §3) ─────────────────────────────────
/** Prefer `<root>/storage.yaml`; fall back to `<root>/.lfbridge/storage.yaml`. */
function descriptorPath(root: string): string {
  const atRoot = path.join(root, STORAGE_YAML);
  if (exists(atRoot)) return atRoot;
  const inHidden = path.join(root, LFBRIDGE_DIR, STORAGE_YAML);
  if (exists(inHidden)) return inHidden;
  return atRoot; // default write location
}

export function readDescriptor(root: string): StorageDescriptor | null {
  const p = descriptorPath(root);
  if (!exists(p)) return null;
  try {
    const raw = (YAML.parse(fs.readFileSync(p, "utf8")) as Record<string, any>) ?? {};
    return normalizeDescriptor(raw);
  } catch (e) {
    log.warn("storage", `readDescriptor failed for ${root}: ${(e as Error).message}`);
    return null;
  }
}

function normalizeDescriptor(raw: Record<string, any>): StorageDescriptor {
  const type = (raw.type as StorageType) ?? "personal";
  const clones: StorageClones = raw.clones
    ? {
        googleDrive: raw.clones.google_drive ?? raw.clones.googleDrive ?? null,
        dropbox: raw.clones.dropbox ?? null,
      }
    : { ...EMPTY_CLONES };
  return {
    name: raw.name ?? "",
    type,
    created: raw.created ?? null,
    company: raw.company ? { companyName: raw.company.company_name ?? raw.company.companyName ?? "", ...raw.company } : null,
    community: raw.community
      ? { id: raw.community.id ?? "", role: raw.community.role ?? "download", ...raw.community }
      : null,
    personal: raw.personal ?? (type === "personal" ? {} : null),
    repo: raw.repo ? { repoRoot: raw.repo.repo_root ?? raw.repo.repoRoot ?? "" } : null,
    clones,
  };
}

export function writeDescriptor(root: string, desc: StorageDescriptor): void {
  const out: Record<string, unknown> = {
    name: desc.name,
    type: desc.type,
    created: desc.created ?? new Date().toISOString(),
  };
  if (desc.repo) out.repo = { repo_root: desc.repo.repoRoot };
  if (desc.company) out.company = { company_name: desc.company.companyName, ...omit(desc.company, ["companyName"]) };
  if (desc.community) out.community = { id: desc.community.id, role: desc.community.role, ...omit(desc.community, ["id", "role"]) };
  if (desc.personal) out.personal = desc.personal;
  out.clones = { google_drive: desc.clones.googleDrive, dropbox: desc.clones.dropbox };
  fs.writeFileSync(path.join(root, STORAGE_YAML), YAML.stringify(out), "utf8");
}

function omit(o: Record<string, any>, keys: string[]): Record<string, unknown> {
  const r: Record<string, unknown> = { ...o };
  for (const k of keys) delete r[k];
  return r;
}

// ── initialize a storage (storages.mdx §3–§4) ─────────────────────────────────
export function ensureStorage(root: string, type: StorageType, extras?: Partial<StorageDescriptor>): StorageDescriptor {
  if (!safeIsDir(root)) throw new Error(`not a directory: ${root}`);
  fs.mkdirSync(path.join(root, LFBRIDGE_DIR), { recursive: true });
  // A repo storage ignores .lfbridge/; an SDL repo (personal/company/community) must COMMIT it so the
  // device registry travels between computers (storage_personal.mdx §1).
  if (exists(path.join(root, ".git"))) reconcileLfbridgeIgnore(root, type);
  // Record THIS computer in the storage's travelling device registry (devices.mdx §2). Self-owned write,
  // best-effort — a device-file failure must never block initializing the storage.
  try {
    writeSelfDevice(root);
  } catch (e) {
    log.warn("storage", `writeSelfDevice at ${root} failed: ${(e as Error).message}`);
  }
  const existing = readDescriptor(root);
  if (existing) return existing;
  const base = path.basename(root);
  const desc: StorageDescriptor = {
    name: extras?.name ?? prettyName(base),
    type,
    created: new Date().toISOString(),
    company: extras?.company ?? (type === "company" ? { companyName: prettyName(base) } : null),
    community: extras?.community ?? null,
    personal: extras?.personal ?? (type === "personal" ? {} : null),
    repo: extras?.repo ?? (type === "repo" ? { repoRoot: root } : null),
    clones: extras?.clones ?? { ...EMPTY_CLONES },
  };
  writeDescriptor(root, desc);
  log.info("storage", `initialized ${type} storage at ${root}`);
  return desc;
}

/**
 * Register a Git repo as a repo storage (storage_repo.mdx §2): place `storage.yaml` (name = repo folder
 * name, type: repo, repo_root) and the hidden `.lfbridge/` at the repo root, and add `.lfbridge/` to the
 * repo's `.gitignore` so tracking never bloats commits. Idempotent — an existing descriptor is returned
 * unchanged. Thin, repo-typed wrapper over `ensureStorage`; the entry point the repos module calls when a
 * repo is registered/discovered.
 */
export function ensureRepoStorage(repoRoot: string): StorageDescriptor {
  const desc = ensureStorage(repoRoot, "repo", { repo: { repoRoot } });
  // repo_tracking_scheme.mdx §1/§2: on enlist also seed the repo-WIDE `repo_storage.yaml` and create the
  // `history/` + `files/` subdirs (`.lfbridge/` itself is created by ensureStorage and added to .gitignore
  // by reconcileLfbridgeIgnore above). All gated on the keep-`.lfbridge/` consent, best-effort so a seeding
  // failure never blocks enlisting the repo. Lazy require to avoid a module-eval cycle (repo-storage.service
  // imports storageSid from here) — same pattern as the storage-settings / devices imports above.
  try {
    if (keepsLfbridgeFor(repoRoot)) {
      fs.mkdirSync(path.join(repoRoot, LFBRIDGE_DIR, "history"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, LFBRIDGE_DIR, "files"), { recursive: true });
      ensureRepoStorageDoc(repoRoot);
    }
  } catch (e) {
    log.warn("storage", `seed repo_storage artifacts at ${repoRoot} failed: ${(e as Error).message}`);
  }
  return desc;
}

/** Whether THIS computer keeps `.lfbridge/` for this repo (decisions.mdx §6 consent). Default ON. */
function keepsLfbridgeFor(repoRoot: string): boolean {
  try {
    return readStorageSettings(storageSid(repoRoot)).lfbridge.enabled;
  } catch {
    return true;
  }
}

// A REPO storage is the user's own *code* repo — keep the `.lfbridge/` tracking area OUT of their commits
// (storage_repo.mdx §2). This is the ONLY storage type that ignores `.lfbridge/`.
function ignoreLfbridge(root: string): void {
  const gi = path.join(root, ".gitignore");
  let body = "";
  try {
    body = fs.readFileSync(gi, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  if (/^\.lfbridge\/?\s*$/m.test(body)) return;
  const prefix = body && !body.endsWith("\n") ? `${body}\n` : body;
  fs.writeFileSync(gi, `${prefix}.lfbridge/\n`, "utf8");
}

// For an SDL-repo storage (personal / company / community backed by a dedicated Git repo), the `.lfbridge/`
// text — the device registry, the manifest — IS the payload that must travel between the user's computers
// (storage_personal.mdx §1). It must NOT be git-ignored. Heal a repo that a prior build (or the user)
// wrongly ignored by REMOVING a bare `.lfbridge/` line from `.gitignore`, so device files can be committed
// and pushed. Without this, two computers never see each other's device YAML. Idempotent; leaves the
// big-file byte ignores untouched (and those bytes live outside the SDL repo anyway).
function unignoreLfbridge(root: string): void {
  const gi = path.join(root, ".gitignore");
  let body: string;
  try {
    body = fs.readFileSync(gi, "utf8");
  } catch {
    return; // no .gitignore → nothing ignoring the SDL
  }
  const lines = body.split("\n");
  const kept = lines.filter((l) => !/^\s*\.lfbridge\/?\s*$/.test(l));
  if (kept.length === lines.length) return; // no bare `.lfbridge/` rule present
  fs.writeFileSync(gi, kept.join("\n"), "utf8");
  log.info("storage", `removed '.lfbridge/' from .gitignore at ${root} — SDL text must be committed for a Git backbone`);
}

// Keep a git-backed storage's `.gitignore` correct for its type: a plain code repo ignores `.lfbridge/`;
// an SDL repo (personal/company/community) must commit it so the device registry travels.
function reconcileLfbridgeIgnore(root: string, type: StorageType): void {
  if (type === "repo") ignoreLfbridge(root);
  else unignoreLfbridge(root);
}

// ── discovery ─────────────────────────────────────────────────────────────────
/** Classify a directory as a storage type by its `storage.yaml` or naming convention, else null. */
function classifyByConvention(root: string): StorageType | null {
  const base = path.basename(root);
  if (base === `personal${CONVENTION_SUFFIX}`) return "personal";
  if (base.endsWith(CONVENTION_SUFFIX)) return "company";
  return null;
}

/** Walk each scanner root (bounded depth) collecting storage roots: those with a descriptor OR the name convention. */
function discoverRoots(): string[] {
  const roots = new Set<string>();
  const scanRoots = getAppConfig().scanner.roots.map(expandHome).filter(safeIsDir);
  // Always probe the canonical personal path even if it's outside the scanner roots.
  const personal = path.join(os.homedir(), "BGit", "Bryan_git", `personal${CONVENTION_SUFFIX}`);
  if (safeIsDir(personal)) roots.add(personal);

  const visit = (dir: string, depth: number): void => {
    if (readDescriptor(dir) || classifyByConvention(dir)) roots.add(dir);
    if (depth <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (name === LFBRIDGE_DIR || name === ".git" || name === "node_modules" || name.startsWith(".")) continue;
      visit(path.join(dir, name), depth - 1);
    }
  };
  for (const r of scanRoots) visit(r, DISCOVER_DEPTH);
  return [...roots];
}

function buildRow(root: string): StorageRow {
  const desc = readDescriptor(root);
  const base = path.basename(root);
  const type: StorageType = desc?.type ?? classifyByConvention(root) ?? "personal";
  const companyName = desc?.company?.companyName ?? (type === "company" ? prettyName(base) : null);
  const communityId = desc?.community?.id ?? null;
  const id =
    type === "personal" ? "personal" : type === "community" ? communityId ?? shortHash(root) : shortHash(root);
  return {
    id,
    name: desc?.name ?? prettyName(base),
    type,
    root,
    companyName,
    communityId,
    initialized: !!desc,
    hasLfbridge: safeIsDir(path.join(root, LFBRIDGE_DIR)),
    fileCount: countStorageIndex(root),
    clones: desc?.clones ?? { ...EMPTY_CLONES },
    route: type === "personal" ? "/storages/personal" : `/storages/${id}`,
  };
}

function localRow(): StorageRow {
  return {
    id: "local",
    name: "This computer (local)",
    type: "local",
    root: resolveStateDir(),
    companyName: null,
    communityId: null,
    initialized: true,
    hasLfbridge: false,
    fileCount: null,
    clones: { ...EMPTY_CLONES },
    route: "/settings",
  };
}

/** All non-repo directory-based storages as rows (repos are represented by a link, not listed). */
function discoverRows(): StorageRow[] {
  return discoverRoots()
    .map(buildRow)
    .filter((r) => r.type !== "repo");
}

// ── public API (the router calls these) ────────────────────────────────────────
export function listStoragesPage(): StoragesPageData {
  const rows = discoverRows();
  return {
    local: localRow(),
    personal: rows.find((r) => r.type === "personal") ?? null,
    companies: rows.filter((r) => r.type === "company"),
    communities: rows.filter((r) => r.type === "community"),
    repos: { count: listRepoFolders().length, route: "/" },
  };
}

function findRowById(id: string): StorageRow | null {
  if (id === "local") return localRow();
  return discoverRows().find((r) => r.id === id) ?? null;
}

/** Ids of every discovered directory-based storage (excludes repos + local) — the pin pass iterates these. */
export function listStorageIds(): string[] {
  return discoverRows().map((r) => r.id);
}

/** Resolve a storage row by its id (used by the per-storage settings service, storage_settings.mdx §5). */
export function getStorageRow(id: string): StorageRow | null {
  return findRowById(id);
}

export function getStorageDetail(id: string): StorageDetail {
  const storage = findRowById(id);
  if (!storage) throw new Error(`unknown storage: ${id}`);
  return {
    storage,
    descriptor: storage.type === "local" ? null : readDescriptor(storage.root),
    files: storage.type === "local" ? [] : readStorageIndex(storage.root),
  };
}

export function initStorageById(id: string): StorageDetail {
  const storage = findRowById(id);
  if (!storage || storage.type === "local") throw new Error(`cannot initialize storage: ${id}`);
  ensureStorage(storage.root, storage.type, {
    name: storage.name,
    company: storage.companyName ? { companyName: storage.companyName } : undefined,
  });
  return getStorageDetail(id);
}

/**
 * Create the ONE Personal storage from scratch — the first-time setup wizard's commit step (Transcribe.mdx
 * §3.5, storage_personal.mdx §3b). Personal always roots at the canonical
 * `~/BGit/Bryan_git/personal_large_files_bridge/` (storage_personal.mdx §1); the user's only choice is
 * whether it is a **dedicated Git repo** (versioned + pinned, artifacts tracked) or a **plain folder**.
 * Idempotent: an existing Personal storage is returned as-is.
 *
 *   • Always: create the root dir, `ensureStorage(root, "personal")` (writes storage.yaml + .lfbridge/).
 *   • dedicatedRepo: `git init` the root if needed AND enable the dedicated-repo backing (so derived
 *     artifacts route INTO the repo, not git-ignored — placement rule B).
 */
export async function createPersonalStorage(opts: { dedicatedRepo?: boolean }): Promise<StorageDetail> {
  const root = path.join(os.homedir(), "BGit", "Bryan_git", `personal${CONVENTION_SUFFIX}`);
  fs.mkdirSync(root, { recursive: true });
  if (opts.dedicatedRepo && !exists(path.join(root, ".git"))) {
    const r = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    if (r.status === 0) log.info("storage", `git init personal dedicated repo at ${root}`);
    else log.warn("storage", `git init at ${root} failed: ${(r.stderr || r.error?.message || "unknown").trim()}`);
  }
  ensureStorage(root, "personal", { name: "My Personal Files" });
  if (opts.dedicatedRepo) {
    // Turn ON the dedicated-repo backing pointing at the storage root itself, so loose personal files route
    // their transcripts/descriptions INTO this repo (not git-ignored) per Transcribe.mdx §3.4 rule B.
    await writeStorageSettings("personal", { backing: { dedicatedRepo: { enabled: true, path: root } } });
  }
  return getStorageDetail("personal");
}

export async function indexStorageById(id: string): Promise<{ indexed: number }> {
  const storage = findRowById(id);
  if (!storage || storage.type === "local") throw new Error(`cannot index storage: ${id}`);
  return { indexed: await indexStorageFiles(storage.root) };
}

export function analyzeStorageFile(id: string, rel: string): { path: string; outputs: string[] } {
  const storage = findRowById(id);
  if (!storage || storage.type === "local") throw new Error(`cannot analyze in storage: ${id}`);
  return { path: rel, outputs: analyzeFile(storage.root, rel) };
}

// ── nearest-storage lookup (for callers that only have an absolute file path) ─────────────────────────
/**
 * Walk up from an absolute path to the nearest ancestor directory that owns a `.lfbridge/` — that dir is
 * the storage root the file belongs to (syncable_data_location.mdx §1), or null when the file is under no
 * storage. Used by the compressor to attach a travelling compression record to the right SDL.
 */
export function findStorageRootForPath(absPath: string): string | null {
  let cur = path.resolve(absPath);
  try {
    if (fs.statSync(cur).isFile()) cur = path.dirname(cur);
  } catch {
    cur = path.dirname(cur);
  }
  for (;;) {
    if (safeIsDir(path.join(cur, LFBRIDGE_DIR))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// ── bookmarks (syncable_data_location.mdx §4.4) — travel with the storage ─────────────────────────────
// Starred files are a property of the STORAGE, not the computer, so they live in the SDL
// (`<root>/.lfbridge/bookmarks.yaml`) and come across in the YAML to every machine that carries it.
function bookmarksPath(root: string): string {
  return path.join(root, LFBRIDGE_DIR, "bookmarks.yaml");
}

/** Read a storage's bookmarked relpaths (defaults-on-absence). */
export function readBookmarks(storageId: string): BookmarksResult {
  const row = findRowById(storageId);
  if (!row || row.type === "local") throw new Error(`no bookmarks for storage: ${storageId}`);
  const doc = readYaml(bookmarksPath(row.root), BookmarksSchema);
  return { storageId: row.id, bookmarked: doc.bookmarked };
}

/** Add or remove one bookmark (idempotent). Returns the fresh list. */
export async function setBookmark(storageId: string, relPath: string, on: boolean): Promise<BookmarksResult> {
  const row = findRowById(storageId);
  if (!row || row.type === "local") throw new Error(`no bookmarks for storage: ${storageId}`);
  const rel = relPath.trim();
  if (!rel) throw new Error("path required");
  const next = await updateYaml(bookmarksPath(row.root), BookmarksSchema, (b) => {
    const set = new Set(b.bookmarked);
    if (on) set.add(rel);
    else set.delete(rel);
    b.bookmarked = [...set];
    return b;
  });
  return { storageId: row.id, bookmarked: next.bookmarked };
}

// ── backing locations — materialize enabled mirrors on a pin pass (storage_settings.mdx §6) ──────────
// For each ENABLED backing location (dedicated repo / Google Drive / Dropbox): create the directory if
// missing (git init a dedicated repo), ensure its hidden `.lfbridge/` (git-ignored inside a repo), and
// leave it ready for the mirror update. A DISABLED location is left untouched — never created, never
// deleted (charter: surface and offer, never act on files unasked). Called per storage from the pass.
function ensureLfbridgeAt(dir: string, type: StorageType): void {
  try {
    fs.mkdirSync(path.join(dir, LFBRIDGE_DIR), { recursive: true });
    if (exists(path.join(dir, ".git"))) reconcileLfbridgeIgnore(dir, type);
  } catch (e) {
    log.warn("storage", `ensure .lfbridge at ${dir} failed: ${(e as Error).message}`);
  }
}

export function ensureBackingLocations(id: string): void {
  const storage = findRowById(id);
  if (!storage || storage.type === "local") return;

  const settings = readStorageSettings(id);

  // The storage's own hidden tracking area at its configured (possibly relocated) location (§3).
  if (settings.lfbridge.enabled) {
    const lfDir = settings.lfbridge.path ? expandHome(settings.lfbridge.path) : path.join(storage.root, LFBRIDGE_DIR);
    try {
      fs.mkdirSync(lfDir, { recursive: true });
    } catch (e) {
      log.warn("storage", `ensure .lfbridge for ${id} at ${lfDir} failed: ${(e as Error).message}`);
    }
    if (exists(path.join(storage.root, ".git"))) reconcileLfbridgeIgnore(storage.root, storage.type);
  }

  // The backing mirrors (§4/§6). Enabled + reachable only.
  const locations: Array<{ key: string; loc: (typeof settings.backing)[keyof typeof settings.backing]; isRepo: boolean }> = [
    { key: "dedicated repo", loc: settings.backing.dedicatedRepo, isRepo: true },
    { key: "Google Drive", loc: settings.backing.googleDrive, isRepo: false },
    { key: "Dropbox", loc: settings.backing.dropbox, isRepo: false },
  ];
  for (const { key, loc, isRepo } of locations) {
    if (!loc.enabled) continue;
    if (!loc.available) {
      log.info("storage", `${id}: ${key} enabled but not reachable on this computer — skipping.`);
      continue;
    }
    const abs = expandHome(loc.path ?? loc.proposedDefault);
    try {
      fs.mkdirSync(abs, { recursive: true }); // create-if-missing (§6.1)
    } catch (e) {
      log.warn("storage", `${id}: create ${key} dir ${abs} failed: ${(e as Error).message}`);
      continue;
    }
    // A dedicated repo gets `git init`ed if it isn't a working tree yet (§6.1). The repo storage's own
    // repo is already one, so this is a no-op there.
    if (isRepo && !exists(path.join(abs, ".git"))) {
      const r = spawnSync("git", ["init"], { cwd: abs, encoding: "utf8" });
      if (r.status === 0) log.info("storage", `${id}: git init dedicated repo at ${abs}`);
      else log.warn("storage", `${id}: git init at ${abs} failed: ${(r.stderr || r.error?.message || "unknown").trim()}`);
    }
    ensureLfbridgeAt(abs, storage.type); // §6.2
  }
}
