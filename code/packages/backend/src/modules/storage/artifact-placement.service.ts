// Storage-aware placement of derived artifacts — the transcript (.transcription) and AI description
// (.ai_description) SIDECARS. Given ANY media file, decide WHICH root the artifact's mirrored path hangs
// under, by the ordered rule locked in Transcribe.mdx §3.4. The sidecar itself is written BESIDE the media
// (same folder), the media's own base name with its extension REPLACED — there is NO .transcribe/ or
// .lfbridge/analysis/ directory for these two (see siblingArtifactPath below):
//
//   A. Containing storage/repo root — the NEAREST ancestor carrying storage.yaml / .lfbridge/ / .git/
//      (the "walk up to the repo root" the product owner described). Git repos get the sidecars
//      gitignored (*.transcription / *.ai_description).
//   B. Owning company/personal storage for a file living OUT in the wider filesystem: the most specific
//      storage whose MAPPED source dir (via this device's graft) contains it, else PERSONAL as the default
//      catch-all for anything under ~. Its artifact is written under the storage's DEDICATED GIT REPO when
//      that backing is enabled (mirroring the file's hierarchy, NOT git-ignored — the repo exists to hold
//      and sync these), else under the storage's own root.
//   C. First-time signal — no Personal storage exists and nothing owns the file → needsSetup:true so the
//      action routes to the setup wizard (Transcribe.mdx §3.5) instead of writing somewhere surprising.
//   D. Last resort — literally beside the media (its own directory is the root), the narrow legacy fallback.
//
// Pure resolver: reads config, never writes. Home-expands every path first (Transcribe.mdx §3.6). Node fs
// only (charter). Shared by transcribe.service and describe.service so the two never drift.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactPlacementView } from "@lfb/shared";
import { expandHome } from "../fs/badges.js";
import { LFBRIDGE_DIR } from "./tracking.service.js";
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
 * Resolve where a media file's derived-artifact hierarchy lives, by the ordered rule (Transcribe.mdx §3.4).
 * `input` may be a `~/…` or absolute path — it is home-expanded and resolved first (§3.6).
 */
export function resolveArtifactPlacement(input: string): ArtifactPlacement {
  const abs = path.resolve(expandHome(input.trim()));

  // A. Containing storage/repo root (walk-up).
  const containing = nearestContainingRoot(abs);
  if (containing) {
    const isGit = exists(path.join(containing, ".git"));
    return { root: containing, rel: path.relative(containing, abs), gitIgnore: isGit, owner: isGit ? "repo" : "storage-root", needsSetup: false };
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

// The sidecar extensions (Transcribe.mdx §3, ai_description.mdx §2). Single source of truth — imported by
// transcribe.service / describe.service so the two never drift. The transcript/description are written
// BESIDE the media with the media's extension REPLACED by one of these (no .transcribe/ dot-directory).
export const TRANSCRIPTION_EXT = ".transcription";
export const AI_DESCRIPTION_EXT = ".ai_description";

/**
 * The sidecar path for a media file's derived artifact: the media's mirrored relative path under `root`
 * with its extension REPLACED by `ext` (Transcribe.mdx §3.1). Same folder as the (mirrored) media —
 * `render/talk.mp3` + `.transcription` → `<root>/render/talk.transcription`. Files with no extension just
 * get `ext` appended. `ext` includes the leading dot.
 */
export function siblingArtifactPath(root: string, rel: string, ext: string): string {
  const relNoExt = rel.slice(0, rel.length - path.extname(rel).length);
  return path.join(root, relNoExt + ext);
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
    transcriptPath: siblingArtifactPath(p.root, p.rel, TRANSCRIPTION_EXT),
    gitIgnore: p.gitIgnore,
    owner: p.owner,
    needsSetup: p.needsSetup,
  };
}
