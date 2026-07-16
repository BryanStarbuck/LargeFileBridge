// Storage-aware placement of derived artifacts — the transcript (.transcription) and AI description
// (.ai_description). Given ANY media file, decide WHICH root the artifact's mirrored path hangs under, by
// the ordered rule locked in Transcribe.mdx §3.4. The artifact is written under that root's TRACKING BASE,
// path-mirrored, with the ext APPENDED to the media's full filename (extension kept) — NOT beside the media
// and NOT with the extension replaced (see lfbridgeArtifactPath below).
//
// The TRACKING BASE depends on the root's storage KIND (artifact_placement_policy.mdx §0):
//   • a WORKING repo → `<root>/.lfbridge/<rel>` — LFB is a guest, so it quarantines its files in one hidden
//     corner that is obviously not the user's own content.
//   • an SDL file repo (personal/company/community) → `<root>/<rel>` — NO `.lfbridge/` segment. That repo
//     exists ONLY to hold LFB's files, so its root IS the .lfbridge area.
// Resolve it via storage-type.service's `trackingBaseDir()`; never join LFBRIDGE_DIR directly.
//
//   A. Containing storage/repo root — the NEAREST ancestor carrying storage.yaml / .lfbridge/ / .git/
//      (the "walk up to the repo root" the product owner described). Classified by storage KIND, NOT by the
//      presence of .git/ (every SDL is a git repo too — see ownerForRoot). Artifacts live in the COMMITTED
//      tracking area so they travel with the repo — no *.transcription/*.ai_description gitignore nudge.
//   B. Owning company/personal storage for a file living OUT in the wider filesystem: the most specific
//      storage whose MAPPED source dir (via this device's graft) contains it, else PERSONAL as the default
//      catch-all for anything under ~. Its artifact is written under the storage's DEDICATED GIT REPO when
//      that backing is enabled (mirroring the file's hierarchy off the repo ROOT, NOT git-ignored — the repo
//      exists to hold and pin these), else under the storage's own root. This is the canonical case:
//      ~/_Mirror/…/x.mp4 → ~/BGit/Bryan_git/personal_large_files_bridge/_Mirror/…/x.mp4.transcription.
//   C. First-time signal — no Personal storage exists and nothing owns the file → needsSetup:true so the
//      action routes to the setup wizard (Transcribe.mdx §3.5) instead of writing somewhere surprising.
//   D. Last resort — literally beside the media (its own directory is the root), the narrow legacy fallback.
//
// Pure resolver: reads config, never writes. Home-expands every path first (Transcribe.mdx §3.6). Node fs
// only (charter). Shared by transcribe.service and describe.service so the two never drift.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactPlacementView, PlacementChoice } from "@lfb/shared";
import { expandHome } from "../fs/badges.js";
import { LFBRIDGE_DIR } from "./tracking.service.js";
import { resolveStorageType, usesLfbridgeDir, trackingBaseDir } from "./storage-type.service.js";
import { resolveStateSyncRepo } from "./tracking-root.service.js";
import { listStoragesPage } from "./storage.service.js";
import { resolveBackingLocations } from "./storage-settings.service.js";
import { readSelfGraft } from "./devices.service.js";
import { log } from "../../shared/logging.js";

export type ArtifactOwner = "repo" | "storage-root" | "dedicated-repo" | "beside";

export interface ArtifactPlacement {
  /** Root the media's mirrored relative path hangs under; the sidecar lands at <root>/<relNoExt>.<ext>. */
  root: string;
  /** The media file's path relative to `root` (no leading separator) — mirrored, then ext-replaced. */
  rel: string;
  /** Whether the sidecars should be git-ignored in `root`. FALSE inside a dedicated repo. */
  gitIgnore: boolean;
  /** Which rule matched — for logging + the placement endpoint. */
  owner: ArtifactOwner;
  /** True when no Personal storage exists and nothing owns the file → first-time setup wizard (§3.5). */
  needsSetup: boolean;
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** True when `child` is `parent` itself or nested beneath it (both already absolute + resolved). */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** A directory is a containing root when it carries a storage.yaml, a `.lfbridge/`, or a `.git/` (a repo). */
function isContainingRoot(dir: string): boolean {
  return exists(path.join(dir, "storage.yaml")) || exists(path.join(dir, LFBRIDGE_DIR)) || exists(path.join(dir, ".git"));
}

/**
 * Classify a containing root as an SDL storage-root or a plain working repo (artifact_placement_policy.mdx
 * §0.2). The storage KIND WINS over the presence of `.git/`: every SDL *is* a git repo, so testing `.git/`
 * first would classify `personal_large_files_bridge/` as a working repo and give every artifact in it a
 * phantom `.lfbridge/` segment — exactly the bug this rule removes.
 */
function ownerForRoot(root: string): ArtifactOwner {
  return usesLfbridgeDir(resolveStorageType(root)) ? "repo" : "storage-root";
}

/** Nearest ancestor of `absFile` that is a containing root (rule A), or null when the file is out loose. */
function nearestContainingRoot(absFile: string): string | null {
  let dir = path.dirname(absFile);
  for (;;) {
    if (isContainingRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

// ── owning-storage index (mapped dirs + dedicated repo) with a short TTL cache ───────────────────────
// A batch transcribe/describe resolves placement per file; discovering storages + reading each graft/
// backing every time would be wasteful. Snapshot the index for a couple seconds — well under any window
// where a storage setting realistically changes mid-run.
interface OwnerStorage {
  id: string;
  root: string;
  isPersonal: boolean;
  mapped: Array<{ key: string; localPath: string }>;
  dedicatedRepoPath: string | null; // resolved absolute path when the dedicated-repo backing is ON, else null
}

let indexCache: { at: number; index: OwnerStorage[]; personalExists: boolean } | null = null;
const INDEX_TTL_MS = 2000;

function buildOwnerIndex(): { index: OwnerStorage[]; personalExists: boolean } {
  const page = listStoragesPage();
  const rows = [...page.companies, ...(page.personal ? [page.personal] : [])];
  const index: OwnerStorage[] = rows.map((row) => {
    let mapped: OwnerStorage["mapped"] = [];
    try {
      mapped = Object.entries(readSelfGraft(row.root))
        .filter(([, g]) => g.wanted && g.localPath)
        .map(([key, g]) => ({ key, localPath: path.resolve(expandHome(g.localPath as string)) }));
    } catch (e) {
      log.warn("placement", `graft read failed for ${row.id}: ${(e as Error).message}`);
    }
    let dedicatedRepoPath: string | null = null;
    try {
      const backing = resolveBackingLocations(row.id);
      if (backing.dedicatedRepo.enabled) {
        dedicatedRepoPath = path.resolve(expandHome(backing.dedicatedRepo.path ?? backing.dedicatedRepo.proposedDefault));
      }
    } catch (e) {
      log.warn("placement", `backing read failed for ${row.id}: ${(e as Error).message}`);
    }
    return { id: row.id, root: path.resolve(expandHome(row.root)), isPersonal: row.type === "personal", mapped, dedicatedRepoPath };
  });
  return { index, personalExists: page.personal !== null };
}

function ownerIndex(): { index: OwnerStorage[]; personalExists: boolean } {
  const now = Date.now();
  if (indexCache && now - indexCache.at < INDEX_TTL_MS) return indexCache;
  const built = buildOwnerIndex();
  indexCache = { at: now, ...built };
  return indexCache;
}

/** Test/opt-in hook: drop the memoized owner index so the next resolve re-reads storages + config. */
export function clearPlacementCache(): void {
  indexCache = null;
}

/**
 * The company/personal storage that OWNS `abs` when it lives out in the wider filesystem (rule B): the most
 * specific mapped source dir that contains it, else Personal as the catch-all for anything under ~. Returns
 * the owning storage plus the mirror-relative path (mapped-dir key + within-dir path, or home-relative).
 */
function resolveOwningStorage(abs: string, index: OwnerStorage[]): { storage: OwnerStorage; rel: string } | null {
  let best: { storage: OwnerStorage; localPath: string; key: string } | null = null;
  for (const s of index) {
    for (const m of s.mapped) {
      if (isUnder(abs, m.localPath) && (!best || m.localPath.length > best.localPath.length)) {
        best = { storage: s, localPath: m.localPath, key: m.key };
      }
    }
  }
  if (best) return { storage: best.storage, rel: path.join(best.key, path.relative(best.localPath, abs)) };

  const personal = index.find((s) => s.isPersonal);
  if (personal) {
    const home = path.resolve(os.homedir());
    if (isUnder(abs, home)) return { storage: personal, rel: path.relative(home, abs) };
  }
  return null;
}

/**
 * The absolute path of the SYNC REPO for a repo — the owning company/Personal storage's dedicated repo when
 * one is configured, else null (artifact_placement_policy.mdx §4). Used by the per-repo "sync tracking state"
 * toggle to decide what to write into the sync-repo marker (tracking-sync.service.ts). This COMPUTES the
 * owner's dedicated repo (unlike `resolveStateSyncRepo`, which just reads the already-written marker).
 */
export function resolveOwnerDedicatedRepo(repoRoot: string): string | null {
  const abs = path.resolve(expandHome(repoRoot));
  const { index } = ownerIndex();
  const owned = resolveOwningStorage(abs, index);
  return owned?.storage.dedicatedRepoPath ?? null;
}

/**
 * Resolve where a media file's derived-artifact hierarchy lives, by the ordered rule (Transcribe.mdx §3.4).
 * `input` may be a `~/…` or absolute path — it is home-expanded and resolved first (§3.6).
 */
export function resolveArtifactPlacement(input: string): ArtifactPlacement {
  const abs = path.resolve(expandHome(input.trim()));

  // A. Containing storage/repo root (walk-up). Classify by storage KIND, not by `.git/` (§0.2).
  const containing = nearestContainingRoot(abs);
  if (containing) {
    const owner = ownerForRoot(containing);
    const isGit = exists(path.join(containing, ".git"));
    return { root: containing, rel: path.relative(containing, abs), gitIgnore: owner === "repo" && isGit, owner, needsSetup: false };
  }

  // B. Owning company/personal storage → its dedicated repo (no gitignore), else its own root.
  const { index, personalExists } = ownerIndex();
  const owned = resolveOwningStorage(abs, index);
  if (owned) {
    if (owned.storage.dedicatedRepoPath) {
      return { root: owned.storage.dedicatedRepoPath, rel: owned.rel, gitIgnore: false, owner: "dedicated-repo", needsSetup: false };
    }
    const isGit = exists(path.join(owned.storage.root, ".git"));
    return { root: owned.storage.root, rel: owned.rel, gitIgnore: isGit, owner: "storage-root", needsSetup: false };
  }

  // C. Nothing owns it and there is no Personal storage yet → first-time setup wizard.
  if (!personalExists) {
    return { root: path.dirname(abs), rel: path.basename(abs), gitIgnore: false, owner: "beside", needsSetup: true };
  }

  // D. Last resort — beside the media.
  const isGit = exists(path.join(path.dirname(abs), ".git"));
  return { root: path.dirname(abs), rel: path.basename(abs), gitIgnore: isGit, owner: "beside", needsSetup: false };
}

// The derived-artifact extensions (Transcribe.mdx §3, ai_description.mdx §2, ocr.mdx §5). Single source of
// truth — imported by transcribe.service / describe.service / ocr.service so the three never drift. All are
// written INSIDE the owning root's committed `.lfbridge/` directory, path-mirrored, with the ext APPENDED to
// the media's FULL filename (extension kept) — NOT beside the media and NOT with the extension replaced.
export const TRANSCRIPTION_EXT = ".transcription";
export const AI_DESCRIPTION_EXT = ".ai_description";
export const OCR_EXT = ".ocr";

/**
 * The path for a media file's derived artifact (Transcribe.mdx §3.1). It lives under the owning root's
 * TRACKING BASE, mirroring the media's relative path, with `ext` APPENDED to the full filename (original
 * extension kept). Appending (not replacing) means `talk.mp3` and `talk.wav` no longer collide. `ext`
 * includes the leading dot.
 *
 * The base depends on the root's storage KIND (artifact_placement_policy.mdx §0) — the whole point of
 * routing through `trackingBaseDir()` rather than joining LFBRIDGE_DIR here:
 *
 *   working repo (LFB is a guest → quarantine under one hidden dir):
 *     charlie-kirk/ + `videos/x.mp4` → charlie-kirk/.lfbridge/videos/x.mp4.transcription
 *   SDL file repo (the repo exists ONLY for LFB → its root IS the .lfbridge area):
 *     personal_large_files_bridge/ + `_Mirror/a/x.mp4` → personal_large_files_bridge/_Mirror/a/x.mp4.transcription
 *
 * (Name kept for its many callers; it is no longer literally always a `.lfbridge` path.)
 *
 * Pass the resolved `owner` when you have one ({@link resolveArtifactPlacement}) — see {@link artifactBase}
 * for why that is more reliable than re-deriving the kind from `root` alone.
 */
export function lfbridgeArtifactPath(root: string, rel: string, ext: string, owner?: ArtifactOwner): string {
  return path.join(artifactBase(root, owner), rel) + ext;
}

/**
 * The tracking base for an artifact root, preferring the ALREADY-RESOLVED owner over a fresh type lookup.
 *
 * Rules B/D resolved the root's role directly, and that knowledge beats re-deriving it: a storage's dedicated
 * repo and a storage root are SDLs BY ROLE — they exist only to hold LFB's files — even when the directory
 * name does not follow the `*_large_files_bridge` convention (a user may point the dedicated-repo backing at
 * `~/BGit/my_big_files`) and even before a descriptor has been written into it. Re-deriving from the path
 * would classify those as working repos and reintroduce the phantom `.lfbridge/` segment for exactly the
 * users who configured a custom path. With no owner in hand, fall back to resolving by kind.
 */
function artifactBase(root: string, owner?: ArtifactOwner): string {
  if (owner === "dedicated-repo" || owner === "storage-root") return root;
  if (owner === "repo") return path.join(root, LFBRIDGE_DIR);
  return trackingBaseDir(root);
}

/**
 * The artifact path for a chosen PLACEMENT (placement_radios.mdx / repo_settings.mdx §4-5). The per-repo
 * setting picks WHERE the transcript/description lands:
 *   • "lfbridge"  → the root's TRACKING BASE, `<base>/<rel><ext>` (the default; {@link lfbridgeArtifactPath}).
 *   • "beside"    → `<root>/<rel><ext>` — literally next to the media (the opt-in beside-media layout).
 *   • "sync_repo" → `<syncRepo>/<rel><ext>` when the owning storage has a state-sync repo configured, else
 *                   falls back to "lfbridge" (the sync-repo settings surface is a later seam).
 * Switching the radio only changes WHERE FUTURE artifacts are written; existing ones stay put until a
 * "move existing" action relocates them (repo_settings.mdx §4.3).
 *
 * NOTE "lfbridge" is a FROZEN WIRE LITERAL naming the option, not a promise of a `.lfbridge/` path segment
 * (placement_radios.mdx §1.1). In a working repo it resolves to `<root>/.lfbridge/<rel>`; in an SDL it
 * resolves to `<root>/<rel>` — no segment, because an SDL has no `.lfbridge/` (§0). Do not rename the value.
 * In an SDL, "lfbridge" and "beside" therefore differ only in root: the SDL's mirror vs. the media's own
 * directory out in the filesystem.
 */
export function artifactPathForPlacement(
  root: string,
  rel: string,
  ext: string,
  placement: PlacementChoice,
  owner?: ArtifactOwner,
): string {
  if (placement === "beside") return path.join(root, rel) + ext;
  if (placement === "sync_repo") {
    const sync = resolveStateSyncRepo(root);
    if (sync) return path.join(sync, rel) + ext;
    // No state-sync repo configured yet → fall back to the default tracking base.
  }
  return lfbridgeArtifactPath(root, rel, ext, owner);
}

/**
 * The placement resolved for a media file, shaped for the UI (GET /api/storages/placement). Adds the
 * concrete transcript destination + the resolved absolute media path so an action can show/decide WHERE its
 * output lands — and whether the first-time wizard must run — BEFORE it runs (Transcribe.mdx §3.4–§3.5).
 */
export function placementView(input: string): ArtifactPlacementView {
  const abs = path.resolve(expandHome(input.trim()));
  const p = resolveArtifactPlacement(input);
  return {
    mediaPath: abs,
    root: p.root,
    rel: p.rel,
    transcriptPath: lfbridgeArtifactPath(p.root, p.rel, TRANSCRIPTION_EXT, p.owner),
    gitIgnore: p.gitIgnore,
    owner: p.owner,
    needsSetup: p.needsSetup,
  };
}
