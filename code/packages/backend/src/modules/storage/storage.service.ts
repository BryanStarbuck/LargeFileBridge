// The Storages backend (storages.mdx). Discovers the directory-based storages (repo / personal /
// company / community) by their `storage.yaml` descriptor and by the `*_large_files_bridge` naming
// convention, reads/writes the descriptor, and assembles the Storages tab/page payload. Local storage
// (settings/config, the DB replacement) is represented as a single row, not discovered. Node fs only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import type {
  StorageDescriptor,
  StorageRow,
  StoragesPageData,
  StorageDetail,
  StorageType,
  StorageClones,
} from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { listRepoFolders } from "../store-model/units.service.js";
import { expandHome } from "../fs/badges.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { readStorageIndex, countStorageIndex, indexStorageFiles, LFBRIDGE_DIR } from "./tracking.service.js";
import { analyzeFile } from "./analysis.service.js";
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
  if (exists(path.join(root, ".git"))) ensureGitignore(root); // keep .lfbridge/ out of commits
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

function ensureGitignore(root: string): void {
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

export function indexStorageById(id: string): { indexed: number } {
  const storage = findRowById(id);
  if (!storage || storage.type === "local") throw new Error(`cannot index storage: ${id}`);
  return { indexed: indexStorageFiles(storage.root) };
}

export function analyzeStorageFile(id: string, rel: string): { path: string; outputs: string[] } {
  const storage = findRowById(id);
  if (!storage || storage.type === "local") throw new Error(`cannot analyze in storage: ${id}`);
  return { path: rel, outputs: analyzeFile(storage.root, rel) };
}
