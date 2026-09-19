// Migration: move a WORKING repo's Category-A artifacts (.transcription / .ai_description /
// .ai_description_rejected / .ocr) out of `<repo>/.lfbridge/` and into the owning company/Personal sync
// repo's mirror subtree, `<syncRepo>/repos/<slug>-<repoUid>/` (artifact_placement_policy.mdx §0.5).
//
// The defect this repairs. Until 2026-09-19 the default `lfbridge` placement wrote every artifact of a working
// repo into that repo's own `.lfbridge/`, even when the repo belonged to a company whose LFB sync repo was
// cloned right next to it — e.g. 5,545 OCR / AI-description / transcript files under
// ~/BGit/Bryan_git/charlie-kirk/.lfbridge/ that belonged in ~/BGit/act3/act3_large_files_bridge/. The write
// path now prefers the sync repo (artifact-placement.service.ts `workingRepoArtifactBase`); this moves what the
// old code already wrote.
//
// Contract (the same as its siblings):
//   * Runs every boot, but is a no-op for a repo with no `.lfbridge/` — one existsSync per registered repo.
//     Not latched: a repo can gain a sync repo later (a teammate's owner mapping, a fresh clone of the company
//     repo), and it must migrate then too.
//   * Only a repo whose sync repo is a real git clone on THIS computer is touched (`usableSyncRepoSubtree`).
//   * Only artifact files move. Anything else under `.lfbridge/` is left exactly where it is.
//   * Never loses a version: identical bytes → drop the source; different bytes → the NEWER mtime wins, and
//     the older copy is still in the history of whichever git repo held it.
//   * Best-effort and NEVER throws — a failed migration must never crash boot.
//   * Afterwards both repos are scheduled through the ordinary artifact-delivery path: the sync repo commits +
//     pushes the new files, and the working repo commits + pushes the REMOVAL of its `.lfbridge/` (pathspec-
//     scoped — repo-artifact-sync.service.ts — never touching the user's own changes).
import fs from "node:fs";
import path from "node:path";
import { log } from "../shared/logging.js";
import { expandHome } from "../shared/home-path.js";
import { listRepoFolders, getRepoConfig } from "../modules/store-model/units.service.js";
import { LFBRIDGE_DIR, resolveStorageType, usesLfbridgeDir } from "../modules/storage/storage-type.service.js";
import { usableSyncRepoSubtree } from "../modules/storage/artifact-placement.service.js";
import { repoStateDir } from "../modules/storage/tracking-root.service.js";

/** Local-Storage latch: "this repo's `.lfbridge/` was emptied into the sync repo, and that REMOVAL has not
 *  yet been committed + pushed". Written here, cleared by repo-artifact-sync.service.ts once it lands. Without
 *  it a restart inside the delivery debounce loses the removal for good — the next boot finds no `.lfbridge/`
 *  and has nothing to schedule (it happened on the first live run). Never mirrored (tracking-sync LOCAL_ONLY). */
export const LFBRIDGE_MOVED_LATCH = ".lfbridge-moved";

const ARTIFACT_RE = /\.(transcription|ai_description|ai_description_rejected|ocr)$/;

export interface RepoLfbridgeMigration {
  root: string;
  dest: string;
  moved: number;
  deduped: number;
  replaced: number;
  keptDest: number;
  failed: number;
  /** One absolute path of each side, for scheduling delivery (null when nothing changed on that side). */
  sampleDest: string | null;
  sampleSource: string | null;
}

function sameBytes(a: string, b: string): boolean {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** Move one file, falling back to copy+unlink across volumes. */
function moveFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.copyFileSync(src, dst);
    const st = fs.statSync(src);
    fs.utimesSync(dst, st.atime, st.mtime);
    fs.unlinkSync(src);
  }
}

/** Remove now-empty directories bottom-up; returns true when `dir` itself was removed. */
function pruneEmptyDirs(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let remaining = entries.length;
  for (const e of entries) {
    if (e.isDirectory() && pruneEmptyDirs(path.join(dir, e.name))) remaining--;
    else if (e.isFile() && e.name === ".DS_Store") {
      try {
        fs.unlinkSync(path.join(dir, e.name));
        remaining--;
      } catch {
        /* leave it */
      }
    }
  }
  if (remaining > 0) return false;
  try {
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Migrate ONE working repo. Returns null when there is nothing to do here. Never throws. */
export function migrateRepoLfbridgeToSync(repoRoot: string): RepoLfbridgeMigration | null {
  const root = path.resolve(expandHome(repoRoot));
  const lfb = path.join(root, LFBRIDGE_DIR);
  try {
    if (!fs.statSync(lfb).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    if (!usesLfbridgeDir(resolveStorageType(root))) return null; // an SDL — migrate-sdl-lfbridge owns it
    const dest = usableSyncRepoSubtree(root);
    if (!dest) return null; // no sync repo on this computer → `.lfbridge/` is still the right home
    const r: RepoLfbridgeMigration = {
      root,
      dest,
      moved: 0,
      deduped: 0,
      replaced: 0,
      keptDest: 0,
      failed: 0,
      sampleDest: null,
      sampleSource: null,
    };
    const walk = (dir: string, rel: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const src = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(src, childRel);
          continue;
        }
        if (!e.isFile() || !ARTIFACT_RE.test(e.name)) continue;
        const dst = path.join(dest, childRel);
        try {
          if (!fs.existsSync(dst)) {
            moveFile(src, dst);
            r.moved++;
            r.sampleDest ??= dst;
          } else if (sameBytes(src, dst)) {
            fs.unlinkSync(src);
            r.deduped++;
          } else if (fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) {
            moveFile(src, dst); // rename over the older copy
            r.replaced++;
            r.sampleDest ??= dst;
          } else {
            fs.unlinkSync(src);
            r.keptDest++;
          }
          r.sampleSource ??= src;
        } catch (err) {
          r.failed++;
          log.warn("migrate", `repo-lfbridge→sync: could not move ${src} → ${dst}: ${(err as Error).message}`);
        }
      }
    };
    walk(lfb, "");
    pruneEmptyDirs(lfb);
    if (r.moved + r.deduped + r.replaced + r.keptDest + r.failed === 0) return null;
    if (r.sampleSource) {
      try {
        fs.mkdirSync(repoStateDir(root), { recursive: true });
        fs.writeFileSync(path.join(repoStateDir(root), LFBRIDGE_MOVED_LATCH), new Date().toISOString());
      } catch {
        /* best-effort: without the latch only a restart inside the debounce can lose the removal */
      }
    }
    log.info(
      "migrate",
      `repo-lfbridge→sync: ${root} → ${dest}: moved ${r.moved}, identical ${r.deduped}, newer-replaced ${r.replaced}, ` +
        `kept-existing ${r.keptDest}, failed ${r.failed}`,
    );
    return r;
  } catch (e) {
    log.warn("migrate", `repo-lfbridge→sync: ${root} failed: ${(e as Error).message}`);
    return null;
  }
}

/** Boot entry: every registered working repo. Schedules delivery of both sides for each repo that changed. */
export function migrateAllRepoLfbridgeToSync(): RepoLfbridgeMigration[] {
  const out: RepoLfbridgeMigration[] = [];
  let folders: string[] = [];
  try {
    folders = listRepoFolders();
  } catch (e) {
    log.warn("migrate", `repo-lfbridge→sync: could not list repos: ${(e as Error).message}`);
    return out;
  }
  for (const folder of folders) {
    let repoPath: string | null = null;
    try {
      repoPath = getRepoConfig(folder).repo.path ?? null;
    } catch {
      continue;
    }
    if (!repoPath) continue;
    const r = migrateRepoLfbridgeToSync(repoPath);
    if (r) out.push(r);
    else if (removalPending(repoPath)) {
      // Moved on an earlier boot, removal not delivered yet — schedule it again.
      const root = path.resolve(expandHome(repoPath));
      out.push({
        root,
        dest: "",
        moved: 0,
        deduped: 0,
        replaced: 0,
        keptDest: 0,
        failed: 0,
        sampleDest: null,
        sampleSource: path.join(root, LFBRIDGE_DIR, LFBRIDGE_MOVED_LATCH),
      });
    }
  }
  if (out.length > 0) scheduleDelivery(out);
  return out;
}

function removalPending(repoPath: string): boolean {
  try {
    return fs.existsSync(path.join(repoStateDir(path.resolve(expandHome(repoPath))), LFBRIDGE_MOVED_LATCH));
  } catch {
    return false;
  }
}

/** Hand both sides to the ordinary artifact-delivery debounce (sync-trigger.service.ts). Lazy import: the
 *  trigger module pulls in the git stack, which the other boot migrations deliberately do not load. */
function scheduleDelivery(results: RepoLfbridgeMigration[]): void {
  void import("../modules/pin/sync-trigger.service.js")
    .then((m) => {
      for (const r of results) {
        if (r.sampleDest) m.noteArtifactWritten(r.sampleDest, "migrate");
        if (r.sampleSource) m.noteArtifactWritten(r.sampleSource, "migrate");
      }
    })
    .catch((e) => log.warn("migrate", `repo-lfbridge→sync: delivery scheduling failed: ${(e as Error).message}`));
}
