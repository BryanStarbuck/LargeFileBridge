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
import { trackingBaseDir, clearStorageTypeCache } from "./storage-type.service.js";
import { analyzeFile } from "./analysis.service.js";
// Lazy import cycles with storage-settings.service (ensureBackingLocations) and devices.service
// (writeSelfDevice) — used only inside functions, never at module-eval time — safe under NodeNext ESM.
import { readStorageSettings, writeStorageSettings } from "./storage-settings.service.js";
import { writeSelfDevice } from "./devices.service.js";
// Lazy import cycle with repo-storage.service (it imports storageSid from here) — used only inside
// functions, never at module-eval time — safe under NodeNext ESM, same pattern as the imports above.
import { ensureRepoStorageDoc } from "./repo-storage.service.js";
import { log } from "../../shared/logging.js";
import { stableGitBin } from "../git/git-bin.js";

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
  // Create the KIND-CORRECT tracking area (artifact_placement_policy.mdx §0): a working repo gets its hidden
  // `.lfbridge/`; an SDL gets nothing new — its root already IS the tracking area, so creating a `.lfbridge/`
  // there would resurrect the very directory this rule removes. `trackingBaseDir` returns `root` for an SDL,
  // making the mkdir a harmless no-op on an existing dir.
  fs.mkdirSync(trackingBaseDir(root, type), { recursive: true });
  // The tracking text is NEVER git-ignored — it holds only committed content (repo: transcripts / AI
  // descriptions) or device text (SDL); the noisy tracking state moved to Local Storage. Heal any repo a
  // prior build wrongly ignored so those files can travel (artifact_placement_policy.mdx §1).
  if (exists(path.join(root, ".git"))) reconcileLfbridgeIgnore(root, type);
  // A descriptor may be about to be written (or the kind may have just changed) — drop the memoized kind so
  // the next resolve reads truth from disk rather than a stale classification.
  clearStorageTypeCache(root);
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
 * name, type: repo, repo_root) at the repo root. The repo's own `.lfbridge/` now holds ONLY the user's
 * committed CONTENT artifacts (transcripts / AI descriptions) and is NO LONGER git-ignored — LFB's noisy
 * tracking state lives in Local Storage (`repos/<repoKey>/`, artifact_placement_policy.mdx §2). Idempotent —
 * an existing descriptor is returned unchanged. Thin, repo-typed wrapper over `ensureStorage`.
 */
export function ensureRepoStorage(repoRoot: string): StorageDescriptor {
  const desc = ensureStorage(repoRoot, "repo", { repo: { repoRoot } });
  // repo_tracking_scheme.mdx §1/§2: on enlist seed the repo-WIDE `repo_storage.yaml` in LOCAL STORAGE
  // (repos/<repoKey>/ — never the working repo). Best-effort so a seeding failure never blocks enlisting.
  try {
    ensureRepoStorageDoc(repoRoot);
  } catch (e) {
    log.warn("storage", `seed repo_storage doc for ${repoRoot} failed: ${(e as Error).message}`);
  }
  return desc;
}

// The `.lfbridge/` at a git-backed storage root now holds ONLY files that are MEANT to be committed:
// for a repo storage the user's CONTENT artifacts (transcripts / AI descriptions,
// artifact_placement_policy.mdx §1), and for an SDL storage the device registry (storage_personal.mdx §1).
// LFB's noisy tracking state no longer lives here — it is in Local Storage — so `.lfbridge/` must NOT be
// git-ignored for ANY storage type. Heal a repo that a prior build (or the user) wrongly ignored by REMOVING
// a bare `.lfbridge/` line from `.gitignore`, so committed content/device files can travel. Idempotent;
// leaves the big-file byte ignores (`*.mp4`, …) untouched.
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

// Keep a git-backed storage's `.gitignore` correct: `.lfbridge/` is NEVER git-ignored anymore (it holds only
// committed content / device text; the noisy tracking state moved to Local Storage). Heal any storage a
// prior build wrongly ignored, regardless of type.
function reconcileLfbridgeIgnore(root: string, _type: StorageType): void {
  unignoreLfbridge(root);
}

// ── discovery ─────────────────────────────────────────────────────────────────
/** Classify a directory as a storage type by its `storage.yaml` or naming convention, else null. */
function classifyByConvention(root: string): StorageType | null {
  const base = path.basename(root);
  if (base === `personal${CONVENTION_SUFFIX}`) return "personal";
  if (base.endsWith(CONVENTION_SUFFIX)) return "company";
  return null;
}

/**
 * The canonical home for dedicated LFB file repos (`~/BGit/Bryan_git/`), and every `*_large_files_bridge`
 * directory in it — personal AND company alike.
 *
 * One shallow readdir of a single directory, so it is cheap enough to run on every discovery pass, and it
 * finds a company SDL that was cloned after the scanner roots were configured. Returns [] if the directory
 * does not exist (a machine that keeps its SDLs elsewhere relies on `scanner.roots`, exactly as before).
 */
function conventionalSdlDirs(): string[] {
  const home = path.join(os.homedir(), "BGit", "Bryan_git");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return []; // not this machine's layout — the scanner roots are the only source, as before
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.endsWith(CONVENTION_SUFFIX))
    .map((e) => path.join(home, e.name))
    .filter(safeIsDir);
}

/** Walk each scanner root (bounded depth) collecting storage roots: those with a descriptor OR the name convention. */
function discoverRoots(): string[] {
  const roots = new Set<string>();
  const scanRoots = getAppConfig().scanner.roots.map(expandHome).filter(safeIsDir);
  // ALWAYS probe the canonical SDL home, even when it is outside the scanner roots — and probe it for EVERY
  // storage there, not just the personal one.
  //
  // This used to name exactly one path, `personal_large_files_bridge`. That gave the personal storage a
  // guarantee the COMPANY storage did not have: a company SDL was found only if it happened to sit inside a
  // `scanner.roots` entry within DISCOVER_DEPTH. Narrow the roots, or move the company SDL somewhere else,
  // and it drops out of `listStorageIds()` entirely — so `pushDeviceBackbone()` never visits it, its text
  // never commits or pushes, and NOTHING warns: the "no resolvable git backbone" warning in pin.service.ts
  // only fires for a storage that was discovered in the first place. Personal, meanwhile, keeps working, so
  // the failure looks like "company sync is broken" rather than "the company storage does not exist".
  // Convention is the whole point of the `_large_files_bridge` suffix; apply it evenly.
  for (const dir of conventionalSdlDirs()) roots.add(dir);

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
    // "Does this storage have its tracking area yet?" — kind-correct (§0): the hidden `.lfbridge/` for a
    // working repo; for an SDL the root IS the tracking area, so this is true once the root exists.
    hasLfbridge: safeIsDir(trackingBaseDir(root, type)),
    fileCount: countStorageIndex(root, type),
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

// ── binding a forge org to a company storage (storage_company.mdx §8.4.4) ─────────────────────────────
// A repo's remote names an ORG (`ACT3ai`); the sync-repo target is a company STORAGE ROW. Nothing joined the
// two, so an auto-derived company owner carried `companyId: null` forever and the repo could never resolve to
// its company's SDL. The join is `company.owner_slugs` in the committed descriptor — explicit, auditable, and
// it TRAVELS to every member, so one member's binding is everyone's.

/** Normalized name for pragmatic matching: lowercased, every non-alphanumeric char stripped. */
function normalizeSlug(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The forge orgs a company storage explicitly claims (`company.owner_slugs` in its `storage.yaml`). */
function ownerSlugsOf(row: StorageRow): string[] {
  const raw = readDescriptor(row.root)?.company?.owner_slugs;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

/** Record `slug` as claimed by this company storage, so a heuristic match becomes an explicit, travelling
 *  fact (§8.4.4). Idempotent + best-effort: a failed write just means the heuristic runs again next time. */
function recordOwnerSlug(row: StorageRow, slug: string): void {
  try {
    let desc = readDescriptor(row.root);
    if (!desc) {
      // A convention-named company dir with no `storage.yaml` (the common shape of a storage the user made
      // by hand) has nowhere to record the binding, so the heuristic would re-run forever and the org would
      // never become an auditable, travelling fact. Initialize the descriptor here — that IS the "set this
      // storage up" step, and doing it at the moment we learn its org is the least surprising time.
      ensureStorage(row.root, "company", {
        name: row.name,
        company: { companyName: row.companyName ?? row.name },
      });
      desc = readDescriptor(row.root);
      if (!desc) return; // still nothing (unwritable dir) — the match stands for this pass, unrecorded
    }
    const have = ownerSlugsOf(row);
    if (have.some((s) => normalizeSlug(s) === normalizeSlug(slug))) return;
    writeDescriptor(row.root, {
      ...desc,
      company: { ...(desc.company ?? { companyName: row.companyName ?? row.name }), owner_slugs: [...have, slug] },
    });
    log.info("storage", `company ${row.id} (${row.name}) now claims forge org "${slug}" (owner_slugs)`);
  } catch (e) {
    log.warn("storage", `recordOwnerSlug(${row.id}, ${slug}) failed: ${(e as Error).message}`);
  }
}

/**
 * Resolve a repo's forge-org slug (e.g. `ACT3ai`) to the COMPANY STORAGE that owns it
 * (storage_company.mdx §8.4.4), or null when nothing claims it.
 *
 * Order, per the locked rule:
 *   1. an explicit `company.owner_slugs` entry — always wins;
 *   2. a normalized match against the company's friendly name / row name (`ACT3 AI` ⇢ `act3ai`);
 *   3. the ONE company storage on this computer takes an unclaimed org — with exactly one company, refusing
 *      to guess means the product does nothing at all for the overwhelmingly common case.
 * More than one company and no match ⇒ null (unresolved), never a guess.
 *
 * A win by rule 2 or 3 is written back as an explicit `owner_slugs` entry, so the heuristic runs once and the
 * binding becomes something the user can see, edit, and share.
 */
export function ensureCompanyForOwner(slug: string | null): StorageRow | null {
  const want = normalizeSlug(slug);
  if (!want) return null;
  const companies = discoverRows().filter((r) => r.type === "company");
  if (companies.length === 0) return null;

  // 1. explicit claim
  const claimed = companies.find((r) => ownerSlugsOf(r).some((s) => normalizeSlug(s) === want));
  if (claimed) return claimed;

  // A company that ALREADY claims an org must never absorb a second one by heuristic. A company storage is
  // 1:1 with a forge organization (§10); a company MAY claim several orgs, but only because a person said so
  // — never because a guess fired twice. Without this the "lone company" rule below adopted EVERY org on the
  // machine in turn: on the reference disk, `ACT3ai`, `BryanStarbuck` and `trykimu` all resolved to the one
  // existing company, which is exactly the cross-company mixing §10.4.3 calls a confidentiality boundary.
  const claimsNothingYet = (r: StorageRow) => ownerSlugsOf(r).length === 0;

  // 2. normalized name match — the company's own name IS the org (`Act3 AI` ⇢ `act3ai`).
  const byName = companies.find(
    (r) => claimsNothingYet(r) && [r.companyName, r.name].some((n) => n && normalizeSlug(n) === want),
  );
  if (byName) {
    recordOwnerSlug(byName, slug!);
    return byName;
  }

  // 3. a lone, UNCLAIMED company storage adopts the org — the "you only have one company" case.
  if (companies.length === 1 && claimsNothingYet(companies[0]!)) {
    recordOwnerSlug(companies[0]!, slug!);
    return companies[0]!;
  }
  return null;
}

export function getStorageDetail(id: string): StorageDetail {
  const storage = findRowById(id);
  if (!storage) throw new Error(`unknown storage: ${id}`);
  return {
    storage,
    descriptor: storage.type === "local" ? null : readDescriptor(storage.root),
    files: storage.type === "local" ? [] : readStorageIndex(storage.root, storage.type),
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
    const r = spawnSync(stableGitBin(), ["init"], { cwd: root, encoding: "utf8" });
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
  return { indexed: await indexStorageFiles(storage.root, storage.type) };
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
    // A working repo is marked by its hidden `.lfbridge/`; an SDL has NO `.lfbridge/` (§0), so it is marked
    // by its root descriptor instead. Probing only for `.lfbridge/` would walk straight past every SDL.
    if (safeIsDir(path.join(cur, LFBRIDGE_DIR)) || exists(path.join(cur, STORAGE_YAML))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// ── bookmarks (syncable_data_location.mdx §4.4) — travel with the storage ─────────────────────────────
// Starred files are a property of the STORAGE, not the computer, so they live in the SDL
// (`<root>/bookmarks.yaml` — at the root, since an SDL has no `.lfbridge/`, artifact_placement_policy.mdx
// §0) and come across in the YAML to every machine that carries it.
function bookmarksPath(root: string): string {
  return path.join(trackingBaseDir(root), "bookmarks.yaml");
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
    // Kind-correct (§0): `.lfbridge/` for a working repo, the root itself for an SDL (a no-op mkdir).
    fs.mkdirSync(trackingBaseDir(dir, type), { recursive: true });
    if (exists(path.join(dir, ".git"))) reconcileLfbridgeIgnore(dir, type);
  } catch (e) {
    log.warn("storage", `ensure tracking area at ${dir} failed: ${(e as Error).message}`);
  }
}

export function ensureBackingLocations(id: string): void {
  const storage = findRowById(id);
  if (!storage || storage.type === "local") return;

  const settings = readStorageSettings(id);

  // The storage's own tracking area at its configured (possibly relocated) location (§3). The DEFAULT is
  // kind-correct (§0): `<root>/.lfbridge` for a working repo, `<root>` itself for an SDL.
  if (settings.lfbridge.enabled) {
    const lfDir = settings.lfbridge.path ? expandHome(settings.lfbridge.path) : trackingBaseDir(storage.root, storage.type);
    try {
      fs.mkdirSync(lfDir, { recursive: true });
    } catch (e) {
      log.warn("storage", `ensure tracking area for ${id} at ${lfDir} failed: ${(e as Error).message}`);
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
      const r = spawnSync(stableGitBin(), ["init"], { cwd: abs, encoding: "utf8" });
      if (r.status === 0) log.info("storage", `${id}: git init dedicated repo at ${abs}`);
      else log.warn("storage", `${id}: git init at ${abs} failed: ${(r.stderr || r.error?.message || "unknown").trim()}`);
    }
    ensureLfbridgeAt(abs, storage.type); // §6.2
  }
}
