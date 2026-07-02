// Code-badge computation for the File System column browser (directory.mdx §3).
// All checks are metadata-cheap. The only file reads are small, capped reads for the
// IPFS-list markdown/manifest detection (§ ipfs) — the browser is user-initiated, not the
// background scan, so a bounded content peek is allowed. No shell, ever (charter).
import fs from "node:fs";
import path from "node:path";
import type { FsBadge, FsEntryKind } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { listRepoFolders, getRepoConfig, isGitWorkingTree } from "../store-model/units.service.js";

// Directories we never descend into (matches the scanner's hard-skip set, scan.mdx §4).
const HARD_SKIP = new Set([".git", "node_modules", ".Trash", ".cache", "Caches"]);

// IPFS list artifacts (directory.mdx §3.4, ipfs_share_files.mdx §3). Case-insensitive match.
const IPFS_ARTIFACT_NAMES = new Set(["ipfs.sh", "ipfs.txt", "get_videos.sh"]);
const IPFS_TEXT_SIGNAL = /ipfs\s+pin\s+add|\/ipfs\/[A-Za-z0-9]{10,}|ipfs_cid|ipfs\.io\/ipfs/i;
const MARKDOWN_EXT = new Set([".md", ".mdx"]);
const IPFS_READ_CAP = 512 * 1024; // don't read files larger than this for signal detection

// Compressible media (charter: video primary, image secondary).
const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv", ".ts",
]);
// Images that are lossless / uncompressed-ish → offer to compress/convert (C).
const IMAGE_UNCOMPRESSED_EXT = new Set([".png", ".bmp", ".tif", ".tiff", ".gif"]);
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
  return {
    thresholdBytes: cfg.big_file.threshold_bytes,
    registeredRepos,
    enclosingRepoForChildren: nearestGitAtOrAbove(dirAbs),
    ancestorProbeBudget: { left: 4000 },
  };
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

  // 2. Sync badge (files whose decision is "sync").
  if (isFile && fileIsSynced(childAbs, ctx)) badges.push("sync");

  // 3. Compress badge (video/image files).
  if (isFile) {
    const c = compressBadge(name, sizeBytes, ctx.thresholdBytes);
    if (c) badges.push(c);
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
  } catch {
    return false;
  }
}

/** A directory earns `i` when it directly contains/publishes an IPFS artifact (one-level, bounded). */
function dirPublishesIpfs(dirAbs: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
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
