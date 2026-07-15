// One-time, idempotent on-disk migration of an SDL's `.lfbridge/` up to its ROOT
// (artifact_placement_policy.mdx §0 / §0.3).
//
// The storage-KIND rule: `.lfbridge/` exists ONLY inside a WORKING git repo, where LFB is a guest and
// quarantines its files in one hidden corner. A DEDICATED LFB FILE REPO — the Personal / Company / Community
// SDL — has NO `.lfbridge/` at all, because the SDL repo root IS the .lfbridge area. Older builds wrote
// `<sdl>/.lfbridge/_Mirror/…`, `<sdl>/.lfbridge/devices/…`, `<sdl>/.lfbridge/storage.yaml`, …; this moves all
// of it to `<sdl>/_Mirror/…`, `<sdl>/devices/…`, `<sdl>/storage.yaml`, … and drops the empty `.lfbridge/`.
//
// Contract:
//   * Runs ONCE at startup, over every discovered SDL storage. Working repos are NEVER touched — their
//     `.lfbridge/` is current, not legacy.
//   * MERGE, never clobber. Directories are merged recursively. For a genuine file-vs-file conflict the ROOT
//     copy WINS, the `.lfbridge/` copy is LEFT IN PLACE, and a WARN names both paths. We never overwrite and
//     never delete the loser — a wrong guess here would destroy a transcript the user paid for.
//   * `git mv` when the SDL is a git repo with the file tracked, so history follows the move and the rename
//     lands as a rename; a plain rename otherwise (untracked file, or not a git repo).
//   * Idempotent: an absent `.lfbridge/` is an immediate no-op, so a re-run costs one stat per SDL. A
//     partially-completed run resumes — every entry is handled independently.
//   * Best-effort and NEVER throws: any failure is logged and swallowed so a broken migration can't crash
//     boot. Whatever is left behind is still READ via the legacy fallback (legacyTrackingBaseDir), so a
//     failed or partial migration degrades to "an extra path segment", never to "the artifact is missing"
//     (which for a paid AI description would re-bill the provider).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listStoragesPage } from "../modules/storage/storage.service.js";
import { resolveStorageType, usesLfbridgeDir, LFBRIDGE_DIR, clearStorageTypeCache } from "../modules/storage/storage-type.service.js";
import { expandHome } from "../modules/fs/badges.js";
import { log } from "../shared/logging.js";

export function migrateSdlLfbridge(): void {
  let migrated = 0;
  let moved = 0;
  try {
    const page = listStoragesPage();
    const rows = [...page.companies, ...(page.personal ? [page.personal] : [])];
    for (const row of rows) {
      try {
        const root = path.resolve(expandHome(row.root));
        // Guard on the RESOLVED kind, not on the row's declared type — the two agree in practice, but this
        // module deletes directories, so it re-checks against the same function every writer uses. A working
        // repo must never be touched: its `.lfbridge/` is where its artifacts correctly live.
        if (usesLfbridgeDir(resolveStorageType(root))) continue;
        const n = migrateOne(root);
        if (n > 0) {
          migrated++;
          moved += n;
        }
      } catch (err) {
        log.warn("migrate", `SDL .lfbridge→root for ${row.root} failed (ignored): ${errMsg(err)}`);
      }
    }
    if (moved > 0) {
      log.info("migrate", `SDL .lfbridge→root: moved ${moved} entr(ies) across ${migrated} storage(s)`);
      clearStorageTypeCache(); // storage.yaml may have moved → re-resolve kinds from their new home
    }
  } catch (err) {
    log.warn("migrate", `SDL .lfbridge→root sweep failed (ignored): ${errMsg(err)}`);
  }
}

/** Migrate ONE SDL root — exported so it can be exercised directly against a fixture without standing up the
 *  whole storage registry. Returns how many entries were moved out of `.lfbridge/`. */
export function migrateOne(root: string): number {
  const legacy = path.join(root, LFBRIDGE_DIR);
  if (!isDir(legacy)) return 0; // already migrated (or never had one) → no-op

  const git = isDir(path.join(root, ".git"));
  let count = 0;
  for (const ent of readdir(legacy)) {
    if (mergeEntry(root, path.join(legacy, ent), path.join(root, ent), git)) count++;
  }
  // Drop `.lfbridge/` only when it is now COMPLETELY empty — anything left is a conflict loser we chose to
  // keep, and it must survive for the legacy read-fallback to find.
  pruneIfEmpty(legacy);
  if (count > 0) log.info("migrate", `${root}: moved ${count} entr(ies) from .lfbridge/ to the storage root`);
  return count;
}

/**
 * Move `src` to `dst`, merging directories recursively. Returns true when anything moved.
 *
 * The three cases:
 *   • `dst` absent          → move it (the common case).
 *   • both are directories  → recurse; merge their contents entry by entry.
 *   • a real conflict       → the ROOT copy wins; leave `src` in place and WARN with both paths.
 */
function mergeEntry(root: string, src: string, dst: string, git: boolean): boolean {
  const dstStat = statOrNull(dst);
  if (!dstStat) return move(root, src, dst, git);

  const srcStat = statOrNull(src);
  if (srcStat?.isDirectory() && dstStat.isDirectory()) {
    let any = false;
    for (const ent of readdir(src)) {
      if (mergeEntry(root, path.join(src, ent), path.join(dst, ent), git)) any = true;
    }
    pruneIfEmpty(src); // the merged-away dir goes only once every child has moved out
    return any;
  }

  log.warn(
    "migrate",
    `conflict: ${dst} already exists — keeping it and LEAVING ${src} in place (nothing overwritten, nothing deleted)`,
  );
  return false;
}

function move(root: string, src: string, dst: string, git: boolean): boolean {
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // `git mv` keeps history attached to the file and stages the rename as a rename. It fails for an
    // untracked path (nothing to move in the index) — fall through to a plain rename, which is correct for
    // an untracked file and leaves it untracked.
    if (git && gitMv(root, src, dst)) return true;
    fs.renameSync(src, dst);
    return true;
  } catch (err) {
    log.warn("migrate", `could not move ${src} → ${dst} (left in place): ${errMsg(err)}`);
    return false;
  }
}

function gitMv(root: string, src: string, dst: string): boolean {
  try {
    execFileSync("git", ["mv", "-k", path.relative(root, src), path.relative(root, dst)], {
      cwd: root,
      stdio: "ignore",
    });
    // `git mv -k` SKIPS (rather than errors on) an untracked or conflicting move, so a zero exit does not by
    // itself prove the move happened. Verify on disk before reporting success, else the plain-rename
    // fallback below would be skipped and the entry silently left behind.
    return !fs.existsSync(src);
  } catch {
    return false; // untracked path / not a git repo / git unavailable → caller falls back to fs.rename
  }
}

function pruneIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* non-empty (a conflict loser stayed) or already gone → leave it; the read-fallback still finds it */
  }
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  return statOrNull(p)?.isDirectory() ?? false;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
