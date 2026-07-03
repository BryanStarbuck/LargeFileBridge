// The File System column browser backend (directory.mdx). Lists ONE directory level per call.
// Node fs only — never the `find`/`du` shell (charter + macOS-indexing rule). Metadata-only walk;
// the only file reads are the small capped peeks in badges.ts for IPFS-list detection.
import fs from "node:fs";
import path from "node:path";
import type { FsEntry, FsEntryKind, FsListing, FlatFileListing } from "@lfb/shared";
import { buildBadgeContext, computeBadges, HARD_SKIP } from "./badges.js";
import { homeDir, resolveDir } from "./paths.js";
import {
  walkFilesFlatStreaming,
  getListingCached,
  putListing,
} from "../fsindex/fsindex.service.js";

// Path resolution lives in ./paths.ts so fs.service and the streaming index can share it without
// importing each other (performance.mdx Part III). Re-exported here to keep existing import sites
// (fs.router, badges callers) unchanged.
export { homeDir, resolveDir };

// One directory level (the column browser). Async + cooperatively yielding + entry-capped, exactly
// like listFilesFlat/walkUnit — because per entry it does MORE synchronous filesystem work than the
// flat walk (statSync + computeBadges, which can run the recursive containsRepoBelow probe + an IPFS
// probe + isGitWorkingTree, + an O(1) hasChildren peek). Run synchronously and uncapped it pins the
// single Node thread and starves every concurrent request on a large directory (performance.mdx P-16).
const FS_ENTRY_CAP = 5000; // max rows one column returns before we stop and flag truncation
const FS_YIELD_EVERY = 200; // hand the event loop back every N processed entries
const fsYield = () => new Promise<void>((r) => setImmediate(r));

export async function listDirectory(
  input: string | undefined,
  showHidden: boolean,
): Promise<FsListing> {
  const dirAbs = resolveDir(input);
  // Serve a fresh cached listing without re-walking / recomputing badges (performance.mdx P-24).
  const cached = getListingCached(dirAbs, showHidden);
  if (cached) return cached;

  const parent = path.dirname(dirAbs);
  const ctx = buildBadgeContext(dirAbs);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    throw new Error("cannot read directory");
  }

  const entries: FsEntry[] = [];
  let truncated = false;
  let sinceYield = 0;
  for (const ent of dirents) {
    if (!showHidden && ent.name.startsWith(".")) continue;
    if (entries.length >= FS_ENTRY_CAP) {
      truncated = true;
      break;
    }
    // Yield to the event loop every few hundred entries so concurrent requests aren't starved.
    if (++sinceYield >= FS_YIELD_EVERY) {
      sinceYield = 0;
      await fsYield();
    }
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
      hasChildren: kind === "dir" && !collapsed && dirHasChildren(abs, showHidden),
      badges,
    });
  }

  entries.sort(compareEntries);

  const listing: FsListing = {
    root: dirAbs,
    parent: parent === dirAbs ? null : parent, // null at a volume root
    home: homeDir(),
    entries,
    truncated,
  };
  putListing(dirAbs, showHidden, listing);
  return listing;
}

// ── Full paths: the flat recursive large-file walk (full_paths.mdx) ───────────
// Rows are the files at/above the big-file threshold under `root`, gathered from every depth. The one
// walk implementation now lives in the streaming index (fsindex.service.walkFilesFlatStreaming) so the
// NDJSON stream and this buffered form can't drift (performance.mdx P-19/P-22). This wrapper collects
// the streamed batches into one FlatFileListing for any non-streaming caller.
export async function listFilesFlat(
  input: string | undefined,
  showHidden: boolean,
): Promise<FlatFileListing> {
  const files: FsEntry[] = [];
  const summary = await walkFilesFlatStreaming(input, showHidden, {
    onBatch: (b) => {
      for (const f of b) files.push(f);
    },
  });
  return {
    root: summary.root,
    home: summary.home,
    thresholdBytes: summary.thresholdBytes,
    files,
    truncated: summary.truncated,
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

/** Cheap "does this directory have any visible child" for the disclosure chevron.
 * Uses opendir + a few readSync peeks instead of a full readdirSync, so it stays O(1) syscalls even
 * for a directory with tens of thousands of children (performance.mdx P-16). */
function dirHasChildren(dirAbs: string, showHidden: boolean): boolean {
  let dir: fs.Dir | null = null;
  try {
    dir = fs.opendirSync(dirAbs);
    for (;;) {
      const ent = dir.readSync();
      if (!ent) return false; // exhausted → empty
      if (!showHidden && ent.name.startsWith(".")) continue; // skip dotfiles, keep peeking
      return true; // found a visible child
    }
  } catch {
    return false; // unreadable → treat as empty
  } finally {
    try {
      dir?.closeSync();
    } catch {
      /* ignore */
    }
  }
}
