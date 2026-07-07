// Code-badge computation for the File System column browser (directory.mdx §3).
// All checks are metadata-cheap. The only file reads are small, capped reads for the
// IPFS-list markdown/manifest detection (§ ipfs) — the browser is user-initiated, not the
// background scan, so a bounded content peek is allowed. No shell, ever (charter).
import fs from "node:fs";
import path from "node:path";
import type { FsBadge, FsEntryKind, FolderInterest } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { listRepoFolders, getRepoConfig, isGitWorkingTree } from "../store-model/units.service.js";
// One source of truth for the never-descend set — shared with the scanner (scan.mdx §4).
import { HARD_SKIP } from "../../shared/scan-filters.js";
import { log } from "../../shared/logging.js";

// IPFS list artifacts (directory.mdx §3.4, ipfs_share_files.mdx §3). Case-insensitive match.
const IPFS_ARTIFACT_NAMES = new Set(["ipfs.sh", "ipfs.txt", "get_videos.sh"]);
const IPFS_TEXT_SIGNAL = /ipfs\s+pin\s+add|\/ipfs\/[A-Za-z0-9]{10,}|ipfs_cid|ipfs\.io\/ipfs/i;
const MARKDOWN_EXT = new Set([".md", ".mdx"]);
const IPFS_READ_CAP = 512 * 1024; // don't read files larger than this for signal detection

// Compressible media (charter: video primary, image secondary).
// Exported so the interesting-folder walk (computeDirInterest) and the entity rollup classify with the
// SAME vocabulary the badges use — the classifier never drifts (file_system.mdx §3.2).
export const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv", ".ts",
]);
// Images that are lossless / uncompressed-ish → offer to compress/convert (C).
export const IMAGE_UNCOMPRESSED_EXT = new Set([".png", ".bmp", ".tif", ".tiff", ".gif"]);
// Interest floor for uncompressed images (file_system.mdx §1): 3 MB — HIGHER than the 1 MiB compress
// floor, so a folder of small PNG icons does NOT light up. Videos have NO size floor for interest.
export const IMAGE_INTEREST_FLOOR_BYTES = 3 * 1024 * 1024;
// Images already in an efficient lossy format → already compressed (c).
const IMAGE_COMPRESSED_EXT = new Set([".jpg", ".jpeg", ".webp", ".heic", ".heif", ".avif"]);
// A filename that advertises an already-compressed video encode.
const VIDEO_COMPRESSED_MARK = /(compress|h264|x264|hevc|x265|av1|reenc|shrunk|small)/i;

export interface FsBadgeContext {
  thresholdBytes: number;
  /** Registered repos: resolved absolute path → its sync decisions (for the S badge). */
  registeredRepos: { path: string; decisions: Record<string, string> }[];
  /** The nearest git working tree at-or-above the listed directory (children are inside it). */
  enclosingRepoForChildren: string | null;
  /** Shared, bounded budget for the "contains a repo below" downward probes. */
  ancestorProbeBudget: { left: number };
  /** Sticky per-entity flags (menus.mdx §6.6), snapshotted once so each row is cheap. */
  fileFlags: Array<{ path: string; never_ipfs: boolean; no_compress: boolean }>;
}

/** Build the per-listing context once, so each row is cheap. */
export function buildBadgeContext(dirAbs: string): FsBadgeContext {
  const cfg = getAppConfig();
  const registeredRepos: { path: string; decisions: Record<string, string> }[] = [];
  for (const folder of listRepoFolders()) {
    const rc = getRepoConfig(folder);
    if (rc.repo.path) {
      registeredRepos.push({ path: path.resolve(expandHome(rc.repo.path)), decisions: rc.decisions });
    }
  }
  const fileFlags = Object.entries(cfg.file_flags).map(([p, v]) => ({
    path: path.resolve(p),
    never_ipfs: !!v.never_ipfs,
    no_compress: !!v.no_compress,
  }));
  return {
    thresholdBytes: cfg.big_file.threshold_bytes,
    registeredRepos,
    enclosingRepoForChildren: nearestGitAtOrAbove(dirAbs),
    ancestorProbeBudget: { left: 4000 },
    fileFlags,
  };
}

/** Effective sticky flag for a path: its own entry OR any ancestor directory's entry (path-scoped). */
function effectiveFlag(childAbs: string, ctx: FsBadgeContext, key: "never_ipfs" | "no_compress"): boolean {
  for (const f of ctx.fileFlags) {
    if (!f[key]) continue;
    if (childAbs === f.path || childAbs.startsWith(f.path + path.sep)) return true;
  }
  return false;
}

export interface BadgeResult {
  badges: FsBadge[];
  isRepoRoot: boolean;
}

/**
 * Compute the ordered badge list for one entry. Order is rightmost-first
 * (directory.mdx §3.5): repo(R/r) · sync(S) · compress(C/c) · ipfs(i).
 */
export function computeBadges(
  childAbs: string,
  name: string,
  kind: FsEntryKind,
  sizeBytes: number | null,
  ctx: FsBadgeContext,
): BadgeResult {
  const badges: FsBadge[] = [];
  const isDir = kind === "dir";
  const isFile = kind === "file";

  // 1. Repo badge (at most one; precedence root → descendant → ancestor).
  const isRepoRoot = isDir && isGitWorkingTree(childAbs);
  const repo = repoBadge(childAbs, isDir, isRepoRoot, ctx);
  if (repo) badges.push(repo);

  // 2. Sync badge (files whose decision is "sync"). Never IPFS forbids sync, so suppress it (menus §6.6).
  if (isFile && fileIsSynced(childAbs, ctx) && !effectiveFlag(childAbs, ctx, "never_ipfs")) {
    badges.push("sync");
  }

  // 3. Compress badge (video/image files). "Do not compress" suppresses the "should compress" C offer.
  if (isFile) {
    const c = compressBadge(name, sizeBytes, ctx.thresholdBytes);
    // Only the "should compress" (C) offer is user-suppressible; the "already compressed" (c) fact stays.
    if (c && !(c === "compress" && effectiveFlag(childAbs, ctx, "no_compress"))) badges.push(c);
  }

  // 4. IPFS badge (files: artifact/markdown list; dirs: publishes one underneath).
  if (isFile && fileIsIpfsArtifact(childAbs, name, sizeBytes)) badges.push("ipfs");
  else if (isDir && dirPublishesIpfs(childAbs)) badges.push("ipfs");

  return { badges, isRepoRoot };
}

// ── repo ────────────────────────────────────────────────────────────────────
function repoBadge(
  childAbs: string,
  isDir: boolean,
  isRepoRoot: boolean,
  ctx: FsBadgeContext,
): FsBadge | null {
  if (isRepoRoot) return "repo_root"; // R, dark brown
  if (ctx.enclosingRepoForChildren) return "repo_descendant"; // r, medium brown (file or dir)
  if (isDir && containsRepoBelow(childAbs, ctx)) return "repo_ancestor"; // r, light brown
  return null;
}

/** Does this directory contain a git repo somewhere below it? Registered set first, then a bounded probe. */
function containsRepoBelow(dirAbs: string, ctx: FsBadgeContext): boolean {
  const prefix = dirAbs + path.sep;
  if (ctx.registeredRepos.some((r) => r.path.startsWith(prefix))) return true;
  // Bounded downward probe so unregistered repos still count (shared budget across the listing).
  const stack: Array<{ dir: string; depth: number }> = [{ dir: dirAbs, depth: 0 }];
  while (stack.length && ctx.ancestorProbeBudget.left-- > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > 5) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Intentional: an unreadable dir (permissions/transient) during this bounded downward probe
      // is expected across arbitrary trees — skip it silently rather than flooding the fault trail.
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      if (HARD_SKIP.has(ent.name)) continue;
      const sub = path.join(dir, ent.name);
      if (isGitWorkingTree(sub)) return true;
      stack.push({ dir: sub, depth: depth + 1 });
    }
  }
  return false;
}

// ── sync ──────────────────────────────────────────────────────────────────────
function fileIsSynced(fileAbs: string, ctx: FsBadgeContext): boolean {
  // Longest registered-repo path that encloses this file wins.
  let best: { path: string; decisions: Record<string, string> } | null = null;
  for (const r of ctx.registeredRepos) {
    if (fileAbs === r.path || fileAbs.startsWith(r.path + path.sep)) {
      if (!best || r.path.length > best.path.length) best = r;
    }
  }
  if (!best) return false;
  const rel = path.relative(best.path, fileAbs);
  return best.decisions[rel] === "sync";
}

// ── compress ──────────────────────────────────────────────────────────────────
// First-cut heuristic (directory.mdx §3.3). Seam to the learned size-baseline model (code_plan §13).
function compressBadge(name: string, _sizeBytes: number | null, _threshold: number): FsBadge | null {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_COMPRESSED_EXT.has(ext)) return "compressed"; // c
  if (IMAGE_UNCOMPRESSED_EXT.has(ext)) return "compress"; // C — lossless/convertible
  if (VIDEO_EXT.has(ext)) {
    if (VIDEO_COMPRESSED_MARK.test(name)) return "compressed"; // c — name advertises a compressed encode
    return "compress"; // C — offer to (re)compress
  }
  return null;
}

/** Compression classification for the entity view (files.mdx §2). Mirrors compressBadge's rules. */
export function compressInfo(name: string): {
  compressible: "video" | "image" | null;
  compressState: "should" | "done" | null;
} {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_COMPRESSED_EXT.has(ext)) return { compressible: "image", compressState: "done" };
  if (IMAGE_UNCOMPRESSED_EXT.has(ext)) return { compressible: "image", compressState: "should" };
  if (VIDEO_EXT.has(ext)) {
    return {
      compressible: "video",
      compressState: VIDEO_COMPRESSED_MARK.test(name) ? "done" : "should",
    };
  }
  return { compressible: null, compressState: null };
}

// ── ipfs ──────────────────────────────────────────────────────────────────────
function fileIsIpfsArtifact(fileAbs: string, name: string, sizeBytes: number | null): boolean {
  const lower = name.toLowerCase();
  if (IPFS_ARTIFACT_NAMES.has(lower)) return true; // ipfs.sh (also IPFS.sh) / ipfs.txt / get_videos.sh
  const ext = path.extname(lower);
  // A public manifest.yaml or an IPFS-list markdown → read a capped slice and look for signals.
  if (lower === "manifest.yaml" || MARKDOWN_EXT.has(ext)) {
    if (sizeBytes !== null && sizeBytes > IPFS_READ_CAP) return false;
    return fileHasIpfsSignal(fileAbs);
  }
  return false;
}

function fileHasIpfsSignal(fileAbs: string): boolean {
  try {
    const text = fs.readFileSync(fileAbs, "utf8").slice(0, IPFS_READ_CAP);
    return IPFS_TEXT_SIGNAL.test(text);
  } catch (e) {
    // Couldn't peek the file for an IPFS signal — treat as "no signal", but leave a trace.
    log.warn("fs", `ipfs-signal peek failed for ${fileAbs}: ${(e as Error).message}`);
    return false;
  }
}

/** A directory earns `i` when it directly contains/publishes an IPFS artifact (one-level, bounded). */
function dirPublishesIpfs(dirAbs: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    // Intentional: an unreadable directory simply can't publish an artifact — no signal, no log noise.
    return false;
  }
  for (const ent of entries) {
    const lower = ent.name.toLowerCase();
    if (ent.isFile() || ent.isSymbolicLink()) {
      if (IPFS_ARTIFACT_NAMES.has(lower)) return true;
    }
  }
  // The Docusaurus convention: static/IPFS.sh (a symlink surfacing the pin script publicly).
  try {
    if (fs.existsSync(path.join(dirAbs, "static", "IPFS.sh"))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

// ── interesting-directory folder coloring (file_system.mdx §1–§3.2) ────────────
// A directory is "interesting" if — considering the directory itself AND everything under it,
// recursively — it contains a BIG file (≥ threshold), a VIDEO (any), or an UNCOMPRESSED IMAGE ≥ 3 MB.
// The highest-priority category present picks the color: big → "video" → "image" → null. Big beats
// video beats image, so the walk EARLY-EXITS the moment it finds a big file. Bounded like every other
// walk here (depth ≤ 8, HARD_SKIP, a caller-shared budget) so listing a folder with many subdirs stays
// responsive. When the budget is exhausted we DO NOT throw away what we already saw: if a video or an
// uncompressed image ≥ 3 MB was already found, we return that as a definite FLOOR (at least blue) — the
// only thing truncation robs us of is a deeper BIG file that would upgrade the floor to brown, so a
// truncated floor is safe (never a false "not interesting") and is left UNCACHED so a later full-budget
// walk can still upgrade it to "big". Only when the budget is exhausted with NOTHING found yet is the
// result UNKNOWN (undefined), which the UI renders as a plain glyph — never a false "not interesting".

// Result cache keyed by directory, guarded by the dir's own mtime + a short TTL. Interest depends on the
// whole subtree (an mtime deep inside won't bump this dir's mtime), so the TTL bounds staleness the way
// the listing cache does; a definite result is cached, an unknown (budget-capped) one is NOT.
interface InterestCacheEntry {
  mtimeMs: number;
  at: number;
  interest: FolderInterest; // definite only (null included); unknown is never stored
}
const INTEREST_TTL_MS = 20000;
const INTEREST_CACHE_MAX = 5000;
const interestCache = new Map<string, InterestCacheEntry>();

/**
 * Compute a directory's interest level over its whole subtree. Returns `undefined` when the shared
 * `budget` was exhausted before a definite answer (caller should leave FsEntry.interest absent). Draws
 * down `budget.left` per directory entry examined so one listing's total walk cost is capped.
 */
export function computeDirInterest(
  dirAbs: string,
  threshold: number,
  budget: { left: number },
): FolderInterest | undefined {
  // Fresh cache hit?
  const cached = interestCache.get(dirAbs);
  if (cached && Date.now() - cached.at <= INTEREST_TTL_MS) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(dirAbs).mtimeMs;
    } catch {
      return undefined;
    }
    if (mtimeMs === cached.mtimeMs) return cached.interest;
    interestCache.delete(dirAbs);
  }

  let rootMtimeMs: number;
  try {
    rootMtimeMs = fs.statSync(dirAbs).mtimeMs;
  } catch {
    return undefined; // vanished/unreadable → unknown, not "not interesting"
  }

  let foundVideo = false;
  let foundImage = false;
  // On budget exhaustion, don't discard a positively-found video/image: return it as a definite FLOOR
  // (at least blue). Uncached — a later full-budget walk may still upgrade it to "big". Only truncation
  // with nothing found yet is truly UNKNOWN (undefined → plain glyph). (file_system.mdx §3.3.)
  const truncatedFloor = (): FolderInterest | undefined =>
    foundVideo ? "video" : foundImage ? "image" : undefined;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: dirAbs, depth: 0 }];
  while (stack.length) {
    if (budget.left <= 0) return truncatedFloor(); // budget hit → floor if any, else unknown
    const { dir, depth } = stack.pop()!;
    if (depth > 8) continue;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // best-effort: an unreadable subdir is skipped
    }
    for (const ent of dirents) {
      if (budget.left <= 0) return truncatedFloor();
      budget.left--;
      if (ent.name.startsWith(".")) continue;
      if (ent.isDirectory()) {
        if (HARD_SKIP.has(ent.name) || ent.isSymbolicLink()) continue;
        stack.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      const isVideo = VIDEO_EXT.has(ext);
      const isUncompressedImg = IMAGE_UNCOMPRESSED_EXT.has(ext);
      // Every file needs a size stat: the big-file check applies to ALL files, and the image floor
      // needs the size too. (Big is the only early-exit; video/image just set the running flags.)
      let size: number;
      try {
        size = fs.statSync(path.join(dir, ent.name)).size;
      } catch {
        continue;
      }
      if (size >= threshold) {
        cacheInterest(dirAbs, rootMtimeMs, "big");
        return "big"; // highest priority — stop immediately
      }
      if (isVideo) foundVideo = true;
      else if (isUncompressedImg && size >= IMAGE_INTEREST_FLOOR_BYTES) foundImage = true;
    }
  }

  const interest: FolderInterest = foundVideo ? "video" : foundImage ? "image" : null;
  cacheInterest(dirAbs, rootMtimeMs, interest);
  return interest;
}

function cacheInterest(dirAbs: string, mtimeMs: number, interest: FolderInterest): void {
  if (interestCache.size >= INTEREST_CACHE_MAX) {
    const oldest = interestCache.keys().next().value;
    if (oldest) interestCache.delete(oldest);
  }
  interestCache.set(dirAbs, { mtimeMs, at: Date.now(), interest });
}

// ── helpers ───────────────────────────────────────────────────────────────────
/** The nearest git working tree at-or-above `dir` (so a dir's children are "inside a repo"). */
export function nearestGitAtOrAbove(dir: string): string | null {
  let cur = path.resolve(dir);
  // Walk up to the filesystem root.
  for (;;) {
    if (isGitWorkingTree(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || "~");
}

export { HARD_SKIP };
