// HUMAN-READABLE names for the hash-keyed per-repo directories (artifact_placement_policy.mdx §3.1).
//
// THE DEFECT THIS CLOSES. Both per-repo tracking subtrees were named by a bare 12-hex hash:
// `~/T/_large_files_bridge/repos/bad3cd4187d0/` (Local Storage, keyed by repoKey) and
// `<syncRepo>/repos/83e62afc2c80/` (the shared mirror, keyed by repoUid). The hashes are correct
// identities and stay, but nothing on disk said WHICH repo a directory belonged to, so a person — or an
// AI agent later reading the company repo to find a `.ocr` / `.ai_description` — had to open 109
// anonymous directories to find one repo. The directory name is the index; it should read like one.
//
// THE SHAPE: `<slug>-<key>`, e.g. `charlie-kirk-83e62afc2c80`.
//   - The KEY is unchanged, so identity, collision-freedom and cross-computer agreement are untouched.
//   - The SLUG is derived DETERMINISTICALLY (see the callers: the repo's directory basename for the
//     machine-local key, the remote's repo name for the machine-SHARED key), never from discovery order.
//     Two computers therefore compute the SAME directory name for the same repo in a shared sync repo —
//     the property a "first one wins, append -2 on collision" scheme would have destroyed.
//   - The key SUFFIX is what resolution matches on, so a legacy bare-`<key>` directory written by an
//     older build (or by a fleet member who has not updated yet) is still found. A mixed fleet degrades
//     to an ugly directory name, never to a missing one.
import fs from "node:fs";
import path from "node:path";
import { repoFolderKey } from "./sanitize.js";

/** The directory name for `key`, prefixed with `slug` when there is one: `charlie-kirk-83e62afc2c80`. */
export function namedKeyDir(slug: string | null | undefined, key: string): string {
  const s = slug ? repoFolderKey(slug) : "";
  return s ? `${s}-${key}` : key;
}

/** True when `name` is a directory for `key` — either the legacy bare key or any `<slug>-<key>`. */
export function isDirForKey(name: string, key: string): boolean {
  return name === key || name.endsWith(`-${key}`);
}

// Resolution runs on hot paths (analysisOutputs asks per ROW), and the readdir fallback below scans a
// directory holding one entry per repo the user has ever touched (579 on this machine). Memoized, and
// invalidated by the boot migration that does the renaming (the only thing that moves these directories).
const cache = new Map<string, string>();
export function clearKeyedDirCache(): void {
  cache.clear();
}

/**
 * The absolute path of the per-repo directory for `key` under `parent`, preferring the named form.
 *
 * 1. `<parent>/<slug>-<key>` when it already exists — the steady state.
 * 2. `<parent>/<key>` when it exists — a legacy directory the migration has not renamed yet.
 * 3. any sibling ending `-<key>` — a peer computer named it, or the slug changed (repo renamed on disk).
 * 4. otherwise `<parent>/<slug>-<key>`, the name a caller should CREATE.
 *
 * Never creates anything and never throws.
 */
export function resolveNamedKeyDir(parent: string, key: string, slug?: string | null): string {
  const named = namedKeyDir(slug, key);
  const memoKey = `${parent} ${key} ${named}`;
  const hit = cache.get(memoKey);
  if (hit) return hit;

  const pick = (name: string): string => {
    const abs = path.join(parent, name);
    cache.set(memoKey, abs);
    return abs;
  };

  if (named !== key && dirExists(path.join(parent, named))) return pick(named);
  if (dirExists(path.join(parent, key))) return pick(key);
  try {
    for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
      if (e.isDirectory() && isDirForKey(e.name, key)) return pick(e.name);
    }
  } catch {
    // No parent yet (first repo on a fresh install) — fall through to the name to create.
  }
  // Deliberately NOT memoized: the caller is about to mkdir this, and a later rename by the migration
  // must stay visible. The two statSync calls above are the whole cost of a miss.
  return path.join(parent, named);
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
