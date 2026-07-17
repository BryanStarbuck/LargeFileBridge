// One shared async, cooperatively-yielding recursive file collector for the interactive batch-plan walks
// (OCR / AI-description / transcription "Create …" over a `root`). These fire when a batch popup OPENS
// (page_actions.mdx §1.1), so they run on a request path — and the media trees they cross frequently live
// on cloud mounts (~/Library/CloudStorage/…) where even a `readdirSync` can block for seconds hydrating a
// placeholder. The old per-service walks were fully SYNCHRONOUS and recursive with no yield, so a single
// large tree froze the whole Node event loop (every concurrent request stalled) until it finished.
//
// This collector fixes that two ways: (1) directory I/O uses `fs.promises.readdir` so it never blocks the
// loop, and (2) it hands the loop back every WALK_YIELD_EVERY entries so other requests keep flowing even
// on a huge tree. Behavior is otherwise identical to the walks it replaces: same dot-dir / skip-dir
// pruning, symlinked directories are not followed (isDirectory() is false for a symlink, so there is no
// cycle risk), and unreadable directories are silently skipped best-effort.
import fs from "node:fs";
import path from "node:path";

const WALK_YIELD_EVERY = 1000; // hand the event loop back every N processed directory entries
const walkYield = (): Promise<void> => new Promise((r) => setImmediate(r));

export interface CollectOpts {
  /** Descend into subdirectories (default true). When false, only `root`'s immediate children are collected. */
  recursive?: boolean;
  /** Extra per-directory skip predicate, applied on top of `skipDirs` + the dot-dir rule. E.g. pass
   *  `isMacPackageDir` so a walk never descends into `.app`/`.framework` bundles (compress must never touch
   *  bundle-internal assets — the bundles-opaque rule). Omitted → no extra pruning. */
  skipDir?: (name: string) => boolean;
}

/**
 * Recursively collect the absolute paths of every FILE under `root` for which `accept(name)` is true,
 * pruning any directory in `skipDirs`, whose name starts with ".", or (when given) matched by
 * `opts.skipDir`. If `root` is itself a file, it is returned when `accept(basename)` holds. Never throws —
 * an unreadable root or subdir yields no entries.
 */
export async function collectFilesRecursive(
  root: string,
  accept: (name: string) => boolean,
  skipDirs: Set<string>,
  opts: CollectOpts = {},
): Promise<string[]> {
  const recursive = opts.recursive ?? true;
  const out: string[] = [];
  let sinceYield = 0;

  const visit = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subdir → skip (best-effort), matching the sync walks this replaces
    }
    for (const ent of entries) {
      // Yield BEFORE recursing/collecting so a deep tree can never run to completion without letting the
      // loop breathe. Counts every entry (dir or file) — one heavy directory must still force a breather.
      if ((sinceYield += 1) >= WALK_YIELD_EVERY) {
        sinceYield = 0;
        await walkYield();
      }
      if (ent.isDirectory()) {
        if (!recursive) continue;
        if (skipDirs.has(ent.name) || ent.name.startsWith(".") || opts.skipDir?.(ent.name)) continue;
        await visit(path.join(dir, ent.name));
      } else if (ent.isFile() && accept(ent.name)) {
        out.push(path.join(dir, ent.name));
      }
    }
  };

  try {
    const st = await fs.promises.stat(root);
    if (st.isDirectory()) await visit(root);
    else if (accept(path.basename(root))) out.push(root);
  } catch {
    /* unreadable root → empty */
  }
  return out;
}
