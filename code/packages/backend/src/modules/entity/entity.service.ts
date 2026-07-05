// Single-entity backend for View-one-file / View-one-directory (files.mdx, directories.mdx) and the
// ⋯ / right-click entity menus (menus.mdx §5). Builds one EntityView for any file or directory on
// disk — its identity, code badges, repo/sync context (when inside a registered repo), compression
// heuristic, sticky flags, and (for directories) the charter category rollup. Node fs only (charter).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EntityView,
  DirRollup,
  Decision,
  TransferStatus,
  FileFlags,
} from "@lfb/shared";
import {
  buildBadgeContext,
  computeBadges,
  compressInfo,
  expandHome,
  HARD_SKIP,
} from "../fs/badges.js";
import { effectiveFlags, ownFlags, setFileFlags, getAppConfig } from "../store-model/config.service.js";
import {
  listRepoFolders,
  getRepoConfig,
  getRepoManifest,
  getRepoStatus,
  updateRepoConfig,
  repoIdFromPath,
} from "../store-model/units.service.js";
import { log } from "../../shared/logging.js";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";

export interface ResolvedEntity {
  abs: string;
  exists: boolean;
  kind: "file" | "dir";
  sizeBytes: number | null;
  createdAt: string | null;
  modifiedAt: string | null;
}

/** Resolve + validate a path to an existing file or directory (no listing yet). */
export function resolveEntity(input: string | undefined): ResolvedEntity {
  const raw = (input && input.trim()) || "";
  if (!raw) throw new Error("path required");
  const abs = path.resolve(expandHome(raw));
  if (abs.includes("\0")) throw new Error("invalid path");
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return { abs, exists: false, kind: "file", sizeBytes: null, createdAt: null, modifiedAt: null };
  }
  const kind: "file" | "dir" = st.isDirectory() ? "dir" : "file";
  return {
    abs,
    exists: true,
    kind,
    sizeBytes: kind === "file" ? st.size : null,
    createdAt: st.birthtime && st.birthtimeMs ? st.birthtime.toISOString() : null,
    modifiedAt: st.mtime.toISOString(),
  };
}

interface RepoMatch {
  folder: string;
  repoPath: string;
  repoName: string;
  repoId: string;
}

/** The longest registered-repo path that encloses (or equals) `abs`, or null. */
function enclosingRepo(abs: string): RepoMatch | null {
  let best: RepoMatch | null = null;
  for (const folder of listRepoFolders()) {
    const cfg = getRepoConfig(folder);
    if (!cfg.repo.path) continue;
    const repoPath = path.resolve(expandHome(cfg.repo.path));
    if (abs === repoPath || abs.startsWith(repoPath + path.sep)) {
      if (!best || repoPath.length > best.repoPath.length) {
        best = { folder, repoPath, repoName: cfg.repo.name || folder, repoId: repoIdFromPath(repoPath) };
      }
    }
  }
  return best;
}

function transferFor(decision: Decision, cid: string | null, peers: string[]): TransferStatus {
  if (decision !== "sync") return "na";
  if (!cid) return "pending";
  return peers.length > 0 ? "synced" : "pending";
}

/** Build the full EntityView for a file or directory. */
export function buildEntityView(input: string | undefined): EntityView {
  const e = resolveEntity(input);
  const name = path.basename(e.abs) || e.abs;
  const flags: FileFlags = effectiveFlags(e.abs);

  if (!e.exists) {
    return {
      kind: e.kind,
      name,
      path: e.abs,
      exists: false,
      sizeBytes: null,
      createdAt: null,
      modifiedAt: null,
      badges: [],
      flags,
      repo: null,
      decision: null,
      transfer: null,
      cid: null,
      peers: [],
      compressible: null,
      compressState: null,
      rollup: null,
    };
  }

  // Badges: build the listing context for the PARENT dir, then compute this entry's badges.
  const parent = path.dirname(e.abs);
  const ctx = buildBadgeContext(parent);
  const { badges } = computeBadges(e.abs, name, e.kind, e.sizeBytes, ctx);

  // Repo / sync context — only when inside a registered repo.
  const match = enclosingRepo(e.abs);
  let repo: EntityView["repo"] = null;
  let decision: Decision | null = null;
  let transfer: TransferStatus | null = null;
  let cid: string | null = null;
  let peers: string[] = [];
  if (match) {
    const rel = path.relative(match.repoPath, e.abs);
    repo = { repoId: match.repoId, name: match.repoName, relPath: rel };
    if (e.kind === "file") {
      const cfg = getRepoConfig(match.folder);
      decision = (cfg.decisions[rel] as Decision) ?? "undecided";
      const m = getRepoManifest(match.folder).files.find((f) => f.path === rel);
      peers = m?.pinned_by ?? [];
      cid = decision === "sync" ? (m?.cid ?? null) : null;
      transfer = transferFor(decision, cid, peers);
    }
  }

  const comp = e.kind === "file" ? compressInfo(name) : { compressible: null, compressState: null };

  return {
    kind: e.kind,
    name,
    path: e.abs,
    exists: true,
    sizeBytes: e.sizeBytes,
    createdAt: e.createdAt,
    modifiedAt: e.modifiedAt,
    badges,
    flags,
    repo,
    decision,
    transfer,
    cid,
    peers,
    compressible: comp.compressible,
    compressState: comp.compressState,
    rollup: e.kind === "dir" ? buildDirRollup(e.abs, match) : null,
  };
}

// A media file smaller than this is not worth surfacing as "can be compressed" in the rollup
// (and guards against the TypeScript-`.ts` vs MPEG-TS-`.ts` extension collision). 1 MiB.
const COMPRESS_FLOOR_BYTES = 1024 * 1024;

/** The charter category rollup for a directory (directories.mdx §2/§3). Bounded recursive walk. */
function buildDirRollup(dirAbs: string, match: RepoMatch | null): DirRollup {
  const threshold = getAppConfig().big_file.threshold_bytes;
  const flags = effectiveFlags(dirAbs); // dir-scoped: suppress offers already opted out

  // Git-ignored big files = the enclosing repo's discovered candidates that live under this dir.
  const candidateRel = new Set<string>();
  const candidateDecided = new Set<string>(); // candidate rels whose decision is sync (tracked)
  let scannedAt: string | null = null;
  if (match) {
    const status = getRepoStatus(match.folder);
    scannedAt = status.last_scan_at;
    const cfg = getRepoConfig(match.folder);
    const dirRelPrefix = path.relative(match.repoPath, dirAbs);
    for (const c of status.candidates) {
      const under = dirRelPrefix === "" || c.path === dirRelPrefix || c.path.startsWith(dirRelPrefix + "/");
      if (!under) continue;
      candidateRel.add(path.resolve(match.repoPath, c.path));
      if (cfg.decisions[c.path] === "sync") candidateDecided.add(path.resolve(match.repoPath, c.path));
    }
  }

  let videosToCompress = 0;
  let imagesToCompress = 0;
  let bigNotIgnored = 0;
  let bigIgnoredNotTracked = 0;
  let entryCount = 0;

  // Immediate-children count (cheap, exact).
  try {
    for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      entryCount++;
    }
  } catch (e) {
    // Unreadable dir → entryCount stays 0; not fatal, but worth a trail (permissions / gone).
    log.warn("entity", `readdir failed for ${dirAbs} (child count): ${(e as Error).message}`);
  }

  // Bounded recursive walk for the category counts (shared budget so huge trees stay cheap).
  const budget = { left: 20000 };
  const stack: Array<{ dir: string; depth: number }> = [{ dir: dirAbs, depth: 0 }];
  while (stack.length && budget.left-- > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > 8) continue;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Intentional best-effort: an unreadable subdir is skipped so the bounded rollup walk keeps
      // going. Not logged — this runs per-subdir across huge trees and would flood error.err.
      continue;
    }
    for (const ent of dirents) {
      if (ent.name.startsWith(".")) continue;
      if (ent.isDirectory()) {
        if (HARD_SKIP.has(ent.name) || ent.isSymbolicLink()) continue;
        stack.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      const abs = path.join(dir, ent.name);
      // Size stat once per file (bounded by the same budget) — feeds both the media and big-file counts.
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        // Intentional best-effort: a file that vanished/denied mid-walk is skipped. Not logged —
        // this runs per-file across huge trees and would flood error.err.
        continue;
      }
      const comp = compressInfo(ent.name);
      // Only count media worth compressing: a real video/image is non-trivial in size. This floor also
      // stops extension collisions (e.g. TypeScript `.ts` vs MPEG-TS `.ts` in badges.ts's VIDEO set)
      // from inflating the rollup in source repos.
      if (comp.compressState === "should" && !flags.noCompress && size >= COMPRESS_FLOOR_BYTES) {
        if (comp.compressible === "video") videosToCompress++;
        else if (comp.compressible === "image") imagesToCompress++;
      }
      if (size >= threshold) {
        if (candidateRel.has(abs)) {
          // git-ignored big file: "not tracked" when we aren't syncing it.
          if (!candidateDecided.has(abs) && !flags.neverIpfs) bigIgnoredNotTracked++;
        } else {
          bigNotIgnored++;
        }
      }
    }
  }

  return {
    videosToCompress,
    imagesToCompress,
    bigNotIgnored,
    bigIgnoredNotTracked,
    entryCount,
    scannedAt,
  };
}

/**
 * Set the sticky flags on an entity, applying the menus.mdx §6.6 side-effects:
 * turning Never IPFS ON demotes any `sync` decision under this path back to non-sync.
 */
export async function setEntityFlags(
  input: string,
  patch: { neverIpfs?: boolean; noCompress?: boolean },
): Promise<EntityView> {
  const abs = path.resolve(expandHome(input.trim()));
  const before = ownFlags(abs);
  await setFileFlags(abs, patch);

  // Demotion: if Never IPFS just turned on, clear `sync` decisions this flag now forbids.
  if (patch.neverIpfs === true && !before.neverIpfs) {
    const match = enclosingRepo(abs);
    if (match) {
      await updateRepoConfig(match.folder, (c) => {
        const relPrefix = path.relative(match.repoPath, abs);
        for (const rel of Object.keys(c.decisions)) {
          const isUnder =
            relPrefix === "" || rel === relPrefix || rel.startsWith(relPrefix + "/");
          if (isUnder && c.decisions[rel] === "sync") c.decisions[rel] = "ignore";
        }
        return c;
      });
    }
  }
  return buildEntityView(abs);
}

/**
 * Set a file's sync decision from the entity menu (Add to IPFS = sync, Remove from IPFS = ignore).
 * Enforces menus.mdx §6.6: `sync` is refused while Never IPFS is in effect for this path.
 */
export async function setEntityDecision(input: string, decision: Decision): Promise<EntityView> {
  const abs = path.resolve(expandHome(input.trim()));
  if (decision === "sync" && effectiveFlags(abs).neverIpfs) {
    throw new Error("Never IPFS is on for this file — turn it off before adding to IPFS.");
  }
  const match = enclosingRepo(abs);
  if (!match) throw new Error("This file isn't inside a registered repo, so it can't be synced yet.");
  const rel = path.relative(match.repoPath, abs);
  await updateRepoConfig(match.folder, (c) => {
    if (decision === "undecided") delete c.decisions[rel];
    else c.decisions[rel] = decision;
    return c;
  });
  return buildEntityView(abs);
}

export function osHome(): string {
  return os.homedir();
}

// ── Move & Delete (media_viewer.mdx §4.4) — explicit, guarded, recoverable ─────────────────────────
// Both operate on a single REGULAR FILE (never a directory). They are the only entity ops that relocate
// real bytes, so the router gates them behind the allow-list and the UI behind an explicit click + confirm.

/** Rename/move a file to a new absolute path. Guards: source is a file; dest parent exists; no overwrite. */
export function moveEntity(input: string, dest: string): { moved: true; path: string } {
  const src = resolveEntity(input);
  if (!src.exists || src.kind !== "file") throw new Error("move: source must be an existing file");
  const destRaw = (dest && dest.trim()) || "";
  if (!destRaw) throw new Error("destination required");
  const destAbs = path.resolve(expandHome(destRaw));
  if (destAbs.includes("\0")) throw new Error("invalid destination");
  if (destAbs === src.abs) throw new Error("destination is the same as the source");
  const parent = path.dirname(destAbs);
  let pst: fs.Stats;
  try {
    pst = fs.statSync(parent);
  } catch {
    throw new Error(`destination folder does not exist: ${parent}`);
  }
  if (!pst.isDirectory()) throw new Error(`destination folder is not a directory: ${parent}`);
  if (fs.existsSync(destAbs)) throw new Error("a file already exists at the destination — won't overwrite");
  renameAcrossDevices(src.abs, destAbs);
  log.info("entity", `move ${src.abs} -> ${destAbs}`);
  return { moved: true, path: destAbs };
}

/**
 * "Delete" a file the RECOVERABLE way: move it into LFBridge's trash under the state dir
 * (`<stateDir>/trash/<ts>__<name>`). We never `unlink` — the charter forbids silently destroying bytes.
 */
export function deleteEntity(input: string): { trashed: true; trashPath: string } {
  const src = resolveEntity(input);
  if (!src.exists || src.kind !== "file") throw new Error("delete: target must be an existing file");
  const trashDir = path.join(resolveStateDir(), "trash");
  ensureDir(trashDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashPath = path.join(trashDir, `${stamp}__${path.basename(src.abs)}`);
  renameAcrossDevices(src.abs, trashPath);
  log.info("entity", `delete (to trash) ${src.abs} -> ${trashPath}`);
  return { trashed: true, trashPath };
}

/** `fs.renameSync`, falling back to copy+unlink when src and dest are on different volumes (EXDEV). */
function renameAcrossDevices(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}
