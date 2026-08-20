// One-time, idempotent rename of the anonymous hash-keyed per-repo directories to `<slug>-<key>`
// (artifact_placement_policy.mdx §3.1).
//
// WHAT WAS ON DISK. Two parallel trees of 12-hex directory names and nothing anywhere saying which repo
// each one was:
//   ~/T/_large_files_bridge/repos/bad3cd4187d0/                      (579 of them, keyed by repoKey)
//   ~/BGit/act3/act3_large_files_bridge/repos/83e62afc2c80/          (109 of them, keyed by repoUid)
// Both of those are charlie-kirk. Finding that out meant opening directories one at a time — and the
// company sync repo is precisely where a later agent goes looking for a repo's tracking state, so the cost
// landed on every single lookup. `repo_storage.yaml` did not rescue it either: its `name:` field was `""`
// in every file (see repo-storage.service.ts `ensureRepoStorageDoc`, which now heals that too).
//
// WHAT THIS DOES. Renames each directory it can identify to `<slug>-<key>`, keeping the key intact so no
// identity changes and no reader breaks. It never invents a mapping: the slug comes from the repos this
// computer actually has registered, so a directory belonging to a teammate's repo we have never seen is
// left exactly as it is (their computer renames it when they upgrade, and `resolveNamedKeyDir` finds either
// spelling in the meantime).
//
// Contract, identical to its siblings:
//   * Runs ONCE at startup, guarded by a marker in the state root; re-running is a no-op.
//   * Best-effort and NEVER throws — a failed migration must never crash boot.
//   * NEVER destructive. It only ever RENAMES, and only when the destination is free; a collision is logged
//     and the source left alone. No file is deleted, merged, or overwritten.
import fs from "node:fs";
import path from "node:path";
import { log } from "../shared/logging.js";
import { expandHome } from "../shared/home-path.js";
import { namedKeyDir, isDirForKey, clearKeyedDirCache } from "../shared/store/keyed-dir.js";
import { repoKeyFor, repoSlugForPath } from "../modules/storage/tracking-root.service.js";
import { repoUidFor, repoSlugFor } from "../modules/storage/repo-identity.js";
import { listRepoFolders, getRepoConfig } from "../modules/store-model/units.service.js";

const MARKER = ".repo-dir-names-migrated";

interface Tally {
  local: number;
  sync: number;
  unknown: number;
  collisions: number;
}

export function migrateRepoDirNames(stateDir: string): void {
  try {
    const marker = path.join(stateDir, MARKER);
    if (fs.existsSync(marker)) return;

    const tally: Tally = { local: 0, sync: 0, unknown: 0, collisions: 0 };
    // key -> slug, built from the repos THIS computer knows. Two maps because the two trees are keyed
    // differently on purpose (repoKey = "this repo on this computer", repoUid = "this repo, anywhere").
    const byRepoKey = new Map<string, string>();
    const byRepoUid = new Map<string, string>();
    // Every sync repo any registered repo mirrors into — normally one company SDL plus the Personal one.
    const syncRoots = new Set<string>();

    for (const folder of listRepoFolders()) {
      let repoPath: string | null = null;
      let remote: string | null = null;
      try {
        const cfg = getRepoConfig(folder);
        repoPath = cfg.repo.path ? expandHome(cfg.repo.path) : null;
        remote = cfg.repo.remote ?? null;
      } catch {
        continue; // unreadable unit config — this repo just does not contribute a name
      }
      if (repoPath) byRepoKey.set(repoKeyFor(repoPath), repoSlugForPath(repoPath));
      const uid = repoUidFor(remote);
      const slug = repoSlugFor(remote);
      if (uid && slug) byRepoUid.set(uid, slug);
      // The sync-repo root lives in the per-repo `.sync-repo` marker, whose FIRST line is the root. Read it
      // straight rather than via readSyncRepoMarker(root) so an unresolvable repo path cannot skip it.
      if (repoPath) {
        const root = firstLine(path.join(stateDir, "repos", legacyOrNamed(stateDir, repoPath), ".sync-repo"));
        if (root) syncRoots.add(root);
      }
    }

    renameTree(path.join(stateDir, "repos"), byRepoKey, tally, "local");
    for (const syncRoot of syncRoots) renameTree(path.join(syncRoot, "repos"), byRepoUid, tally, "sync");

    // Anything cached before the renames now points at a directory that no longer exists.
    clearKeyedDirCache();

    fs.writeFileSync(marker, new Date().toISOString());
    if (tally.local || tally.sync || tally.unknown || tally.collisions) {
      log.info(
        "migrate",
        `repo dir names: renamed ${tally.local} local + ${tally.sync} sync-repo directories to <slug>-<key>; ` +
          `${tally.unknown} left anonymous (no repo registered here owns them), ${tally.collisions} collisions`,
      );
    }
  } catch (e) {
    log.warn("migrate", `repo dir name migration failed: ${(e as Error).message}`);
  }
}

/** Rename every bare-key directory under `parent` that `slugs` can name. Leaves everything else alone. */
function renameTree(parent: string, slugs: Map<string, string>, tally: Tally, kind: "local" | "sync"): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return; // no such tree on this computer (e.g. a sync repo that has not been cloned)
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const key = e.name;
    // Already named (`<slug>-<key>`) — nothing to do. Only a BARE key is a migration candidate; renaming an
    // already-named directory would fight a teammate whose slug differs and churn the shared repo forever.
    if (!/^[0-9a-f]{12}$/.test(key)) continue;
    const slug = slugs.get(key);
    if (!slug) {
      tally.unknown++;
      continue;
    }
    const to = path.join(parent, namedKeyDir(slug, key));
    if (fs.existsSync(to)) {
      tally.collisions++;
      log.warn(
        "migrate",
        `repo dir names: leaving ${path.join(parent, key)} alone — ${to} already exists. Both hold state ` +
          `for the same repo; compare them and remove the stale one by hand.`,
      );
      continue;
    }
    try {
      fs.renameSync(path.join(parent, key), to);
      tally[kind]++;
    } catch (err) {
      log.warn("migrate", `repo dir names: could not rename ${key} -> ${path.basename(to)}: ${(err as Error).message}`);
    }
  }
}

/** The existing directory name for `repoPath` under the state root, named or bare — used only to locate the
 *  `.sync-repo` marker BEFORE the rename pass runs (so it works whichever spelling is on disk). */
function legacyOrNamed(stateDir: string, repoPath: string): string {
  const key = repoKeyFor(repoPath);
  try {
    for (const e of fs.readdirSync(path.join(stateDir, "repos"), { withFileTypes: true })) {
      if (e.isDirectory() && isDirForKey(e.name, key)) return e.name;
    }
  } catch {
    /* no repos tree yet */
  }
  return key;
}

/** First non-blank line of a file, or null. */
function firstLine(file: string): string | null {
  try {
    const line = fs.readFileSync(file, "utf8").split("\n")[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}
