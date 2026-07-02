// The scan (scan.mdx): metadata-only discovery. Stat big files; never open/read/hash them.
// Runs the whole-filesystem discovery walk that feeds the Repos/Sync UI.
import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import {
  UnitStatusSchema,
  ComputerUnitConfigSchema,
  type UnitStatus,
} from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import {
  listRepoFolders,
  getRepoConfig,
  getRepoStatus,
  writeRepoStatus,
  registerRepo,
  isGitWorkingTree,
} from "../store-model/units.service.js";
import { readYaml, writeYaml } from "../../shared/store/yaml-store.js";
import { computerUnitDir, unitConfigPath, unitStatusPath } from "../../shared/store/scopes.js";
import { log } from "../../shared/logging.js";

interface Candidate {
  path: string; // relative to unit root
  size: number;
  modified_at: string;
}

const HARD_SKIP = new Set([".git", "node_modules", ".Trash", ".cache", "Caches"]);

export async function scanAll(source: "scheduled" | "manual" = "scheduled"): Promise<void> {
  const cfg = getAppConfig();
  const roots = cfg.scanner.roots.map(expandHome).filter((r) => safeIsDir(r));
  log.info("scan", `Scan (${source}) starting over ${roots.length} root(s).`);

  // 1. Repo discovery — register any .git working tree found under the roots.
  const discovered = new Set<string>();
  for (const root of roots) {
    for (const repoPath of findGitRepos(root, cfg.scanner.follow_symlinks)) {
      discovered.add(repoPath);
    }
  }
  for (const repoPath of discovered) {
    try {
      await registerRepo(repoPath);
    } catch {
      // already registered or not a working tree — fine
    }
  }

  // 2. Build the mask: every registered repo working-tree path.
  const repoFolders = listRepoFolders();
  const repoPaths: string[] = [];
  for (const folder of repoFolders) {
    const rc = getRepoConfig(folder);
    if (rc.repo.path) repoPaths.push(path.resolve(expandHome(rc.repo.path)));
  }

  // 3. Scan each repo unit.
  for (const folder of repoFolders) {
    const rc = getRepoConfig(folder);
    const repoPath = rc.repo.path ? path.resolve(expandHome(rc.repo.path)) : "";
    if (!repoPath || !isGitWorkingTree(repoPath)) {
      const st = getRepoStatus(folder);
      writeRepoStatus(folder, { ...st, repo_state: "missing" });
      continue;
    }
    const threshold = resolveThreshold(rc.big_file_override, cfg.big_file.threshold_bytes);
    const ig = rc.large_files.follow_gitignore ? buildRepoIgnore(repoPath) : null;
    const candidates = walkUnit(repoPath, threshold, {
      ignore: ig,
      includeGlobs: rc.large_files.include_globs,
      excludeGlobs: rc.large_files.exclude_globs,
      maskPaths: [],
    });
    writeStatus(folder, "repo", candidates, threshold, source);
  }

  // 4. Scan the computer unit (roots minus the repo mask).
  scanComputerUnit(roots, repoPaths, cfg.big_file.threshold_bytes, source);

  log.info("scan", `Scan (${source}) complete.`);
}

function scanComputerUnit(
  roots: string[],
  maskPaths: string[],
  globalThreshold: number,
  source: "scheduled" | "manual",
): void {
  const cc = readYaml(unitConfigPath(computerUnitDir()), ComputerUnitConfigSchema);
  const scanRoots = (cc.roots.length ? cc.roots.map(expandHome) : roots).filter(safeIsDir);
  const all: Candidate[] = [];
  for (const root of scanRoots) {
    all.push(
      ...walkUnit(root, globalThreshold, {
        ignore: null,
        includeGlobs: [],
        excludeGlobs: cc.exclude_globs,
        maskPaths,
        rootLabelAbsolute: true,
      }),
    );
  }
  const dir = computerUnitDir();
  const prev = readYaml(unitStatusPath(dir), UnitStatusSchema);
  const next = diffStatus(prev, all, globalThreshold, source, "computer");
  writeYaml(unitStatusPath(dir), { ...next });
}

interface WalkOpts {
  ignore: Ignore | null;
  includeGlobs: string[];
  excludeGlobs: string[];
  maskPaths: string[];
  rootLabelAbsolute?: boolean;
}

// Recursive stat-only walk. Returns files >= threshold that pass the ignore/mask rules.
function walkUnit(root: string, threshold: number, opts: WalkOpts): Candidate[] {
  const out: Candidate[] = [];
  const stack: string[] = [root];
  const excl = ignore().add(opts.excludeGlobs);
  const incl = opts.includeGlobs.length ? ignore().add(opts.includeGlobs) : null;

  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (opts.maskPaths.some((m) => abs === m || abs.startsWith(m + path.sep))) continue;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (HARD_SKIP.has(ent.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = path.relative(root, abs);
      const relForIgnore = opts.rootLabelAbsolute ? abs : rel;
      if (excl.ignores(rel)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs); // metadata only — never open the file (scan.mdx §1)
      } catch {
        continue;
      }
      const bigEnough = st.size >= threshold;
      const forced = incl?.ignores(rel) ?? false;
      const isCandidate = forced || (bigEnough && (opts.ignore ? opts.ignore.ignores(rel) : true));
      if (!isCandidate) continue;
      out.push({
        path: opts.rootLabelAbsolute ? abs : rel,
        size: st.size,
        modified_at: st.mtime.toISOString(),
      });
      void relForIgnore;
    }
  }
  return out;
}

function writeStatus(
  folder: string,
  _unit: "repo" | "computer",
  candidates: Candidate[],
  threshold: number,
  source: "scheduled" | "manual",
): void {
  const prev = getRepoStatus(folder);
  const next = diffStatus(prev, candidates, threshold, source, "repo");
  next.folder_name = folder;
  writeRepoStatus(folder, next);
}

// Compare against the previous scan; classify added/grew/shrank/moved/deleted (scan.mdx §6).
function diffStatus(
  prev: UnitStatus,
  candidates: Candidate[],
  threshold: number,
  source: "scheduled" | "manual",
  repoState: "repo" | "computer",
): UnitStatus {
  const prevByPath = new Map(prev.candidates.map((c) => [c.path, c]));
  const nowByPath = new Map(candidates.map((c) => [c.path, c]));
  const added: string[] = [];
  const grew: string[] = [];
  for (const c of candidates) {
    const p = prevByPath.get(c.path);
    if (!p) added.push(c.path);
    else if (c.size > p.size) grew.push(c.path);
  }
  const deleted: string[] = [];
  for (const p of prev.candidates) if (!nowByPath.has(p.path)) deleted.push(p.path);

  return {
    ...prev,
    schema_version: 1,
    last_scan_at: new Date().toISOString(),
    scan_source: source,
    effective_threshold_bytes: threshold,
    big_file_count: candidates.length,
    big_file_bytes: candidates.reduce((s, c) => s + c.size, 0),
    repo_state: repoState === "computer" ? "present" : "present",
    candidates: candidates.map((c) => ({ path: c.path, size: c.size, modified_at: c.modified_at })),
    changes_since_last_scan: { added, grew, shrank: [], moved: [], deleted },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────
export function resolveThreshold(
  override: { enabled: boolean; value: number; unit: "MB" | "GB" | "TB" },
  globalBytes: number,
): number {
  if (!override.enabled) return globalBytes;
  const mult = override.unit === "MB" ? 1024 ** 2 : override.unit === "GB" ? 1024 ** 3 : 1024 ** 4;
  return Math.round(override.value * mult);
}

function buildRepoIgnore(repoPath: string): Ignore {
  const ig = ignore();
  try {
    const gi = fs.readFileSync(path.join(repoPath, ".gitignore"), "utf8");
    ig.add(gi);
  } catch {
    // no .gitignore -> nothing is git-ignored; treat all big files as candidates instead
    return ignore().add("*");
  }
  return ig;
}

function findGitRepos(root: string, followSymlinks: boolean): string[] {
  const found: string[] = [];
  const stack: string[] = [root];
  let budget = 20000; // bounded walk so discovery never runs away
  while (stack.length && budget-- > 0) {
    const dir = stack.pop()!;
    if (isGitWorkingTree(dir)) {
      found.push(dir);
      continue; // do not descend into a repo to find nested repos (keep it simple)
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (HARD_SKIP.has(ent.name)) continue;
      if (ent.isSymbolicLink() && !followSymlinks) continue;
      stack.push(path.join(dir, ent.name));
    }
  }
  return found;
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || "~");
}
function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
