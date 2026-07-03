// The File System column browser backend (directory.mdx). Lists ONE directory level per call.
// Node fs only — never the `find`/`du` shell (charter + macOS-indexing rule). Metadata-only walk;
// the only file reads are the small capped peeks in badges.ts for IPFS-list detection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FsEntry, FsEntryKind, FsListing, FlatFileListing } from "@lfb/shared";
import { buildBadgeContext, computeBadges, nearestGitAtOrAbove, HARD_SKIP } from "./badges.js";

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

// ── Full paths: the flat recursive large-file walk (full_paths.mdx) ───────────
// Rows are the files at/above the big-file threshold under `root`, gathered from every depth.
// Metadata-only (stat), Node fs only, bounded by a file cap + an iteration budget (no silent
// truncation — `truncated` is surfaced). Same hard-skip set / dotfile rule as the column browser.
const FLAT_FILE_CAP = 5000; // max rows returned before we stop and flag truncation
const FLAT_ITER_BUDGET = 300000; // max directory pops before we stop and flag truncation

// Cooperative yielding — the flat walk is a tight synchronous readdirSync/statSync loop that can run
// for seconds on a big home directory. Served straight from the HTTP request, a synchronous walk pins
// the single Node thread and starves EVERY other request (scan-status polls, page loads, auth) until
// it finishes — which reads as "the whole app hangs." So we yield to the event loop every few hundred
// entries, exactly like scanner.service.walkUnit (scan.mdx §10, performance.mdx P-04).
const FLAT_YIELD_EVERY = 400;
const flatYield = () => new Promise<void>((r) => setImmediate(r));

export async function listFilesFlat(
  input: string | undefined,
  showHidden: boolean,
): Promise<FlatFileListing> {
  const rootAbs = resolveDir(input);
  // One shared badge context (registered repos, sticky flags, threshold) built once; its
  // per-directory `enclosingRepoForChildren` is re-pointed as we descend (cached per dir).
  const ctx = buildBadgeContext(rootAbs);
  const threshold = ctx.thresholdBytes;
  const repoCache = new Map<string, string | null>();
  const enclosingFor = (dir: string): string | null => {
    let v = repoCache.get(dir);
    if (v === undefined) {
      v = nearestGitAtOrAbove(dir);
      repoCache.set(dir, v);
    }
    return v;
  };

  const files: FsEntry[] = [];
  let truncated = false;
  let budget = FLAT_ITER_BUDGET;
  let sinceYield = 0;
  const stack: string[] = [rootAbs];

  while (stack.length) {
    if (budget-- <= 0) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Hand the event loop back every few hundred entries so concurrent requests aren't starved.
    if ((sinceYield += dirents.length) >= FLAT_YIELD_EVERY) {
      sinceYield = 0;
      await flatYield();
    }
    // All files in this directory share the same enclosing repo → set it once for the batch.
    ctx.enclosingRepoForChildren = enclosingFor(dir);
    for (const ent of dirents) {
      if (!showHidden && ent.name.startsWith(".")) continue;
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!HARD_SKIP.has(ent.name)) stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs); // metadata only (scan.mdx §1)
      } catch {
        continue;
      }
      if (st.size < threshold) continue;
      if (files.length >= FLAT_FILE_CAP) {
        truncated = true;
        stack.length = 0; // stop the walk
        break;
      }
      const { badges, isRepoRoot } = computeBadges(abs, ent.name, "file", st.size, ctx);
      files.push({
        name: ent.name,
        path: abs,
        kind: "file",
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
        isRepoRoot,
        badges,
        hasChildren: false,
      });
    }
  }

  return { root: rootAbs, home: homeDir(), thresholdBytes: threshold, files, truncated };
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
