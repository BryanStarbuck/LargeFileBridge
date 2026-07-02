// The File System column browser backend (directory.mdx). Lists ONE directory level per call.
// Node fs only — never the `find`/`du` shell (charter + macOS-indexing rule). Metadata-only walk;
// the only file reads are the small capped peeks in badges.ts for IPFS-list detection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FsEntry, FsEntryKind, FsListing } from "@lfb/shared";
import { buildBadgeContext, computeBadges, HARD_SKIP } from "./badges.js";

export function homeDir(): string {
  return os.homedir();
}

/** Resolve + validate the requested path to an existing absolute directory. */
export function resolveDir(input: string | undefined): string {
  const raw = (input && input.trim()) || homeDir();
  const expanded = raw.replace(/^~(?=\/|$)/, os.homedir());
  const abs = path.resolve(expanded);
  if (abs.includes("\0")) throw new Error("invalid path");
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error("directory not found");
  }
  if (!st.isDirectory()) throw new Error("not a directory");
  return abs;
}

export function listDirectory(input: string | undefined, showHidden: boolean): FsListing {
  const dirAbs = resolveDir(input);
  const parent = path.dirname(dirAbs);
  const ctx = buildBadgeContext(dirAbs);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    throw new Error("cannot read directory");
  }

  const entries: FsEntry[] = [];
  for (const ent of dirents) {
    if (!showHidden && ent.name.startsWith(".")) continue;
    const abs = path.join(dirAbs, ent.name);
    const kind = kindOf(ent);
    const collapsed = kind === "dir" && HARD_SKIP.has(ent.name); // shown, but never expandable

    let sizeBytes: number | null = null;
    let modifiedAt: string | null = null;
    if (kind === "file") {
      try {
        const st = fs.statSync(abs);
        sizeBytes = st.size;
        modifiedAt = st.mtime.toISOString();
      } catch {
        /* keep nulls */
      }
    }

    let badges: FsEntry["badges"] = [];
    let isRepoRoot = false;
    if (!collapsed) {
      const res = computeBadges(abs, ent.name, kind, sizeBytes, ctx);
      badges = res.badges;
      isRepoRoot = res.isRepoRoot;
    }

    entries.push({
      name: ent.name,
      path: abs,
      kind,
      sizeBytes,
      modifiedAt,
      isRepoRoot,
      badges,
      hasChildren: kind === "dir" && !collapsed && dirHasChildren(abs, showHidden),
    });
  }

  entries.sort(compareEntries);

  return {
    root: dirAbs,
    parent: parent === dirAbs ? null : parent, // null at a volume root
    home: homeDir(),
    entries,
  };
}

function kindOf(ent: fs.Dirent): FsEntryKind {
  if (ent.isSymbolicLink()) return "symlink";
  if (ent.isDirectory()) return "dir";
  if (ent.isFile()) return "file";
  return "other";
}

/** Directories before files, then locale-aware case-insensitive by name. */
function compareEntries(a: FsEntry, b: FsEntry): number {
  const ad = a.kind === "dir" ? 0 : 1;
  const bd = b.kind === "dir" ? 0 : 1;
  if (ad !== bd) return ad - bd;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Cheap "does this directory have any visible child" for the disclosure chevron. */
function dirHasChildren(dirAbs: string, showHidden: boolean): boolean {
  try {
    for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      if (!showHidden && ent.name.startsWith(".")) continue;
      return true;
    }
  } catch {
    /* unreadable → treat as empty */
  }
  return false;
}
