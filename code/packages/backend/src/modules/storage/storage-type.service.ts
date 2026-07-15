// Leaf-safe storage-type resolution (no imports from storage.service, so tracking.service can use it without
// an import cycle — storage.service already imports tracking.service). It answers ONE question, and owns the
// SINGLE CHOKE POINT that every LFB writer resolves its base directory through: is a given root a WORKING
// repo, or a dedicated LFB SDL storage (personal/company/community)?
//
// TWO rules hang off that answer (artifact_placement_policy.mdx):
//
// (1) §0 — the storage-KIND rule: WHERE inside a root does LFB write AT ALL?
//   • A WORKING repo (type "repo") — LFB is a GUEST there, so everything it writes is quarantined under one
//     hidden `<root>/.lfbridge/`, obviously not the user's own content.
//   • A dedicated SDL (personal/company/community) — a purpose-built LFB git repo that exists ONLY to hold
//     LFB's files. It has NO `.lfbridge/` AT ALL: the SDL ROOT *IS* the .lfbridge area. Hiding files under
//     `.lfbridge/` inside a repo containing nothing else buys no separation and only adds a meaningless path
//     segment. So `<sdl>/_Mirror/a/b.mp4.transcription`, NOT `<sdl>/.lfbridge/_Mirror/…` (the OLD pattern),
//     and the SDL's own metadata (storage.yaml, mapped_dirs.yaml, files.yaml, manifest.yaml, bookmarks.yaml,
//     devices/, analysis/) sits at the root too. → `trackingBaseDir()` / `usesLfbridgeDir()` below.
//
// (2) §1+ — the data-CATEGORY split: WHICH root may hold a given file? Relevant to `files.yaml`:
//   • A WORKING repo must NOT carry LFB's noisy Category-B tracking state; its fingerprint index lives in
//     Local Storage at ~/T/_large_files_bridge/repos/<repoKey>/files.yaml, never in the repo's own
//     `.lfbridge/` (the merge-conflict-every-scan failure that drove this; the user's absolute rule that a
//     working repo's `.lfbridge/` exists ONLY for transcripts / AI descriptions).
//   • An SDL's committed text is MEANT to travel — its `files.yaml`/`manifest.yaml` belong in it so teammates
//     and the user's other computers share the index (storage_personal.mdx §1, storage_company.mdx §1).
//     Committing per-scan churn to a repo that exists only for that is the intended behavior.
//     → `tracksIndexInLocalStorage()` below.
//
// The two compose: (1) picks the BASE DIRECTORY inside a root; (2) picks WHICH root.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { StorageType } from "@lfb/shared";

const STORAGE_YAML = "storage.yaml";
/** The hidden tracking dir — a WORKING-REPO-ONLY concept. An SDL never has one (§0). Canonical definition;
 *  tracking.service re-exports it so the many existing importers keep working. */
export const LFBRIDGE_DIR = ".lfbridge";
const CONVENTION_SUFFIX = "_large_files_bridge";

// resolveStorageType() reads (up to two) YAML files off disk, and the hot paths call it PER FILE across
// thousands of files (analysisOutputs, the artifact placers). Memoize per root for a short window — well
// under any period in which a root's KIND realistically changes (it changes only when a descriptor is
// written or a directory is renamed, both of which clear the cache explicitly below).
const TYPE_TTL_MS = 5000;
const typeCache = new Map<string, { at: number; type: StorageType }>();

/** Drop the memoized storage-kind for one root (or all roots) — called after a descriptor write / storage
 *  create / rename, so the next resolve re-reads from disk instead of serving a stale kind. */
export function clearStorageTypeCache(root?: string): void {
  if (root) typeCache.delete(path.resolve(root));
  else typeCache.clear();
}

/** Resolve a root's storage type WITHOUT importing storage.service (leaf-safe). Mirrors the classification
 *  storage.service uses: an explicit descriptor `type` wins; else the `<name>_large_files_bridge` naming
 *  convention names an SDL; else it is a plain working `repo` (the safe default — an unclassified root is far
 *  more likely a stray working directory than a mis-detected SDL). The default matters in BOTH directions
 *  (§0.2): "repo" routes tracking OFF the working tree (Category B), and it KEEPS `.lfbridge/` (§0) — the
 *  conservative choice, since mis-reading a working repo as an SDL would scatter LFB's files across the
 *  user's project tree, while mis-reading an SDL as a working repo merely leaves an extra path segment.
 *
 *  NOTE the descriptor probe order: `<root>/storage.yaml` (the SDL's NEW home) is tried BEFORE the legacy
 *  `<root>/.lfbridge/storage.yaml`, so a migrated SDL resolves without touching the old path, and one that
 *  has not been migrated yet still resolves correctly. */
export function resolveStorageType(root: string): StorageType {
  const key = path.resolve(root);
  const hit = typeCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TYPE_TTL_MS) return hit.type;
  const type = readStorageType(root);
  typeCache.set(key, { at: now, type });
  return type;
}

function readStorageType(root: string): StorageType {
  for (const p of [path.join(root, STORAGE_YAML), path.join(root, LFBRIDGE_DIR, STORAGE_YAML)]) {
    try {
      const raw = YAML.parse(fs.readFileSync(p, "utf8")) as { type?: StorageType } | null;
      if (raw?.type) return raw.type;
    } catch {
      /* not present / unreadable → keep probing, then fall through to convention */
    }
  }
  const base = path.basename(root);
  if (base === `personal${CONVENTION_SUFFIX}`) return "personal";
  if (base.endsWith(CONVENTION_SUFFIX)) return "company";
  return "repo";
}

/** True when this storage kind quarantines LFB's files under a hidden `.lfbridge/` — i.e. it is a WORKING
 *  repo, where LFB is a guest (artifact_placement_policy.mdx §0). FALSE for every SDL (personal / company /
 *  community): those have NO `.lfbridge/` at all, because the SDL root IS the .lfbridge area. */
export function usesLfbridgeDir(type: StorageType): boolean {
  return type === "repo";
}

/**
 * THE CHOKE POINT (artifact_placement_policy.mdx §0): the base directory that every LFB-written file in
 * `root` hangs under — path-mirrored artifacts AND, for an SDL, its own metadata.
 *
 *   working repo → `<root>/.lfbridge`      e.g. charlie-kirk/.lfbridge/videos/x.mp4.transcription
 *   SDL          → `<root>` itself         e.g. personal_large_files_bridge/_Mirror/a/x.mp4.transcription
 *
 * EVERY writer resolves its base through this function; none joins LFBRIDGE_DIR directly. Pass the known
 * `type` to skip a descriptor read on hot paths; omit it to resolve here.
 *
 * The kind WINS over the presence of `.git/` — every SDL is itself a git repo, so a caller that classifies by
 * "has .git/ → working repo" MUST consult the type first or every SDL gets a phantom `.lfbridge/` segment.
 */
export function trackingBaseDir(root: string, type?: StorageType): string {
  const t = type ?? resolveStorageType(root);
  return usesLfbridgeDir(t) ? path.join(root, LFBRIDGE_DIR) : root;
}

/**
 * The LEGACY pre-migration base for a root, or null when there is none (§0.3). Only an SDL has a legacy base
 * — `<root>/.lfbridge`, where an older LFB wrote — and only until `migrateSdlLfbridge()` moves it to the
 * root. READERS fall back to this so that, mid-migration, no artifact is reported missing and none is
 * needlessly regenerated (for a paid AI description, a false "missing" would re-bill the provider). WRITERS
 * must never use it. Returns null for a working repo, whose `.lfbridge/` is current, not legacy.
 */
export function legacyTrackingBaseDir(root: string, type?: StorageType): string | null {
  const t = type ?? resolveStorageType(root);
  return usesLfbridgeDir(t) ? null : path.join(root, LFBRIDGE_DIR);
}

/** The SDL-root filenames LFB owns (§0.3). Because an SDL's mirror hangs off the ROOT, a mapped-dir key equal
 *  to one of these would shadow the SDL's own metadata — so they are RESERVED and the mapped-dir add/rename
 *  validator rejects a colliding key (storage_settings.mdx §4a.1). Irrelevant for a working repo, whose
 *  metadata is safely nested under `.lfbridge/`. */
export const RESERVED_SDL_ROOT_NAMES: ReadonlySet<string> = new Set([
  "storage.yaml",
  "mapped_dirs.yaml",
  "files.yaml",
  "manifest.yaml",
  "bookmarks.yaml",
  "decisions.yaml",
  "devices",
  "analysis",
  "repos",
  LFBRIDGE_DIR,
]);

/** True when this storage's Category-B tracking (the `files.yaml` fingerprint index, etc.) belongs in LOCAL
 *  STORAGE rather than the storage's own committed `.lfbridge/` — i.e. it is a working `repo`. A personal /
 *  company / community SDL commits its index into `.lfbridge/` so it travels, so this is false for those. */
export function tracksIndexInLocalStorage(type: StorageType): boolean {
  return type === "repo";
}
