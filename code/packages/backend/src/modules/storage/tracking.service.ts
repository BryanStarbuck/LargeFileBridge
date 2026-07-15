// Per-storage file tracking (storages.mdx §4.1). Builds and reads the hidden fingerprint index
// `<storage root>/.lfbridge/files.yaml`: one entry per LARGE file with a fingerprint (hash), size, and
// dates, plus its compressible kind and which media-analysis outputs exist. Node fs only (charter).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import type { StorageFileRow, StorageType } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { compressInfo, HARD_SKIP } from "../fs/badges.js";
import { mapLimit, responsiveBudget } from "../../shared/concurrency.js";
import { log } from "../../shared/logging.js";
import { repoStateDir } from "./tracking-root.service.js";
import {
  resolveStorageType,
  tracksIndexInLocalStorage,
  trackingBaseDir,
  legacyTrackingBaseDir,
  usesLfbridgeDir,
  RESERVED_SDL_ROOT_NAMES,
  LFBRIDGE_DIR,
} from "./storage-type.service.js";

// Re-exported for the many existing importers; the canonical definition lives in storage-type.service (the
// leaf that owns the storage-KIND rule). Reminder: `.lfbridge/` is a WORKING-REPO-ONLY concept — never join
// it directly, always go through `trackingBaseDir(root)` (artifact_placement_policy.mdx §0).
export { LFBRIDGE_DIR };
const FILES_YAML = "files.yaml";
const ANALYSIS_DIR = "analysis";
// Analysis outputs that still live as YAML under .lfbridge/analysis/<rel>/ (visuals-by-time; the
// compression record is tracked separately). Transcript + description now live INSIDE the committed
// `.lfbridge/`, path-mirrored, with the ext APPENDED (Transcribe.mdx §3, ai_description.mdx §2) — detected
// below by that path rather than a YAML here.
const ANALYSIS_FILES: Record<string, string> = {
  visuals_by_time: "visuals_by_time.yaml",
};
// Keep consistent with TRANSCRIPTION_EXT / AI_DESCRIPTION_EXT in storage/artifact-placement.service.ts.
// Inlined (not imported) to avoid an import cycle — artifact-placement imports LFBRIDGE_DIR from here.
const TRANSCRIPTION_EXT = ".transcription";
const AI_DESCRIPTION_EXT = ".ai_description";
const MAX_FILES = 5000; // a safety cap so an enormous tree can't run the index unbounded (logged if hit).
const FINGERPRINT_CHUNK = 64 * 1024;

/** The legacy in-repo index location — `<root>/.lfbridge/files.yaml`. Still READ as a fallback in two cases:
 *  a working repo indexed before the Local-Storage migration (SWEPT afterward — § sweepLegacyRepoIndex), and
 *  an SDL not yet migrated to the root layout (artifact_placement_policy.mdx §0.3). Never a WRITE target. */
function lfbridgeFilesYamlPath(root: string): string {
  return path.join(root, LFBRIDGE_DIR, FILES_YAML);
}

/** Where THIS storage's `files.yaml` fingerprint index lives — both rules compose (storage-type.service.ts):
 *  by CATEGORY, a working `repo` → Local Storage `~/T/_large_files_bridge/repos/<repoKey>/files.yaml` (never
 *  the working tree); by KIND, a personal/company/community SDL → its committed `<root>/files.yaml` — at the
 *  ROOT, since an SDL has no `.lfbridge/` (§0). Pass the known `type` to skip a descriptor read on hot paths
 *  (the Storages/Repos list); omit it to resolve here. */
function filesYamlPath(root: string, type?: StorageType): string {
  const t = type ?? resolveStorageType(root);
  if (tracksIndexInLocalStorage(t)) return path.join(repoStateDir(root), FILES_YAML);
  return path.join(trackingBaseDir(root, t), FILES_YAML);
}

/** Which §6 analysis outputs already exist for a file. Transcript + description are detected under the root's
 *  TRACKING BASE (artifact_placement_policy.mdx §0) — `<root>/.lfbridge/` for a working repo, `<root>` itself
 *  for an SDL — path-mirrored, with the ext APPENDED to the full filename (Transcribe.mdx §3.1); visuals-by-
 *  time is still a YAML under `<base>/analysis/<rel>/`.
 *
 *  This is the "is it already done?" check, so it must NEVER report a false MISSING: that regenerates work,
 *  and for a paid AI description it re-bills the provider. So it probes every layout an artifact could
 *  legitimately be in — the tracking base, beside the media, and (for a not-yet-migrated SDL) the legacy
 *  `.lfbridge/` base (§0.3). */
export function analysisOutputs(root: string, rel: string, type?: StorageType): string[] {
  const out: string[] = [];
  const isFileAt = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const t = type ?? resolveStorageType(root);
  // Detect the artifact in EVERY placement (placement_radios.mdx): under the tracking base (the default) OR
  // beside the media (the opt-in beside-media layout) OR, for an SDL awaiting migration, the legacy
  // `.lfbridge/` base — so a file's "done" status is correct whichever layout it is actually in. (The
  // sync-repo placement is detected via its own path when that seam lands.)
  const legacy = legacyTrackingBaseDir(root, t);
  const bases = [
    path.join(trackingBaseDir(root, t), rel), // full filename kept; ext appended below
    path.join(root, rel), // beside the media
    ...(legacy ? [path.join(legacy, rel)] : []), // legacy pre-migration SDL layout
  ];
  if (bases.some((b) => isFileAt(b + TRANSCRIPTION_EXT))) out.push("transcript");
  if (bases.some((b) => isFileAt(b + AI_DESCRIPTION_EXT))) out.push("description");
  const analysisDirs = [
    path.join(trackingBaseDir(root, t), ANALYSIS_DIR, rel),
    ...(legacy ? [path.join(legacy, ANALYSIS_DIR, rel)] : []),
  ];
  for (const [key, file] of Object.entries(ANALYSIS_FILES)) {
    if (analysisDirs.some((d) => isFileAt(path.join(d, file)))) out.push(key);
  }
  return out;
}

/** A cheap-but-robust fingerprint: hash of size + mtime + the head and tail bytes. ASYNC (fs.promises) so
 *  that MANY files' head/tail reads OVERLAP when fingerprinting fans out under mapLimit (the disk I/O is
 *  the cost, and async reads let the event loop drive several at once — parallelization.mdx §3). */
async function fingerprint(abs: string, st: fs.Stats): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    const h = crypto.createHash("sha256");
    h.update(String(st.size));
    h.update(String(Math.round(st.mtimeMs)));
    fh = await fs.promises.open(abs, "r");
    const headLen = Math.min(FINGERPRINT_CHUNK, st.size);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    h.update(head);
    if (st.size > FINGERPRINT_CHUNK) {
      const tailLen = Math.min(FINGERPRINT_CHUNK, st.size);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, Math.max(0, st.size - tailLen));
      h.update(tail);
    }
    return h.digest("hex").slice(0, 32);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * (Re)build the storage's `files.yaml` index from the large files under it — at `filesYamlPath(root, type)`,
 * which is Local Storage for a working repo and `<root>/files.yaml` for an SDL. Returns the count.
 * Two phases (parallelization.mdx §3): (1) a cheap metadata-only walk collects the large-file entries; then
 * (2) the per-file FINGERPRINTING (head+tail read + sha256) fans out WIDE across files, bounded by the
 * RESPONSIVE budget (cores − 2), so a large storage indexes quickly without pinning the app. Indexing
 * MULTIPLE storages parallelizes across storages too — each writes only its own index.
 */
export async function indexStorageFiles(root: string, type?: StorageType): Promise<number> {
  const t = type ?? resolveStorageType(root);
  const threshold = getAppConfig().big_file.threshold_bytes;

  // Phase 1 — metadata-only walk: collect the eligible large files (bounded by MAX_FILES). No hashing yet.
  interface Entry { rel: string; name: string; abs: string; st: fs.Stats; }
  const collected: Entry[] = [];
  const walk = (dir: string): void => {
    if (collected.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // In an SDL the tracking base IS the root, so LFB's own metadata (devices/, analysis/, the root YAMLs)
    // sits in the walk's path. Skip it at the TOP LEVEL ONLY — these names are reserved there (§0.3), but
    // deeper down they are just ordinary user directories inside a mapped-dir mirror and must be indexed.
    const atSdlRoot = !usesLfbridgeDir(t) && path.resolve(dir) === path.resolve(root);
    for (const ent of entries) {
      if (collected.length >= MAX_FILES) break;
      const name = ent.name;
      if (name === LFBRIDGE_DIR || name === ".git" || name === "node_modules" || HARD_SKIP.has(name)) continue;
      if (atSdlRoot && RESERVED_SDL_ROOT_NAMES.has(name)) continue;
      const abs = path.join(dir, name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size < threshold) continue;
      collected.push({ rel: path.relative(root, abs), name, abs, st });
    }
  };
  walk(root);
  const capped = collected.length >= MAX_FILES;

  // Phase 2 — fingerprint IN PARALLEL across files (bounded by the responsive budget). Each result carries
  // its rel key so the map is assembled deterministically after; per-file failure yields a null fingerprint.
  const rows = await mapLimit(collected, responsiveBudget(), async (e) => {
    const comp = compressInfo(e.name);
    return [
      e.rel,
      {
        size: e.st.size,
        modified: e.st.mtime.toISOString(),
        created: e.st.birthtime && e.st.birthtimeMs ? e.st.birthtime.toISOString() : null,
        fingerprint: await fingerprint(e.abs, e.st),
        compressible: comp.compressible,
        analysis: analysisOutputs(root, e.rel),
      },
    ] as const;
  });
  const files: Record<string, unknown> = Object.fromEntries(rows);

  // Write to the KIND-correct location: a working repo indexes into Local Storage (never its own `.lfbridge/`,
  // so the walk above never has to create one); an SDL commits into `<root>/.lfbridge/`. mkdir the index file's
  // OWN parent — for a repo that is the Local-Storage `repos/<repoKey>/` dir, so a repo with no transcripts
  // keeps NO `.lfbridge/` at all (the absolute rule).
  const outPath = filesYamlPath(root, t);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, YAML.stringify({ files }), "utf8");
  // Now that a repo's index lives in Local Storage, remove any stale Category-B state a prior build left in the
  // working repo's `.lfbridge/` (and drop the folder if it's left empty) — the one-time on-disk migration.
  if (tracksIndexInLocalStorage(t)) sweepLegacyRepoTracking(root);
  if (capped) log.warn("storage", `index for ${root} hit the ${MAX_FILES}-file cap — some files not indexed`);
  else log.info("storage", `indexed ${collected.length} large file(s) in ${root}`);
  return collected.length;
}

// Category-B files/dirs a PRIOR build may have written into a working repo's `.lfbridge/` before they were all
// moved to Local Storage (repo_storage.yaml / decisions.yaml / manifest.yaml / files/ / history/ are already
// written to `~/T/_large_files_bridge/repos/<repoKey>/` today — these are only ever STALE leftovers now).
const LEGACY_CATEGORY_B_FILES = ["files.yaml", "repo_storage.yaml", "decisions.yaml", "manifest.yaml"];
const LEGACY_CATEGORY_B_DIRS = ["files", "history"];

/** One-time on-disk migration for a WORKING repo: delete stale Category-B tracking state from its `.lfbridge/`
 *  (all of it is now written to Local Storage) and, if `.lfbridge/` is then empty (no transcripts / AI
 *  descriptions / visuals), remove it entirely so the repo carries NO `.lfbridge/`. Best-effort — a failure
 *  just leaves the stale file to be retried next index; NEVER touches Category-A content (transcripts,
 *  descriptions, `analysis/`) or the device registry. Only ever called for `repo`-type roots. */
export function sweepLegacyRepoTracking(root: string): void {
  const lfb = path.join(root, LFBRIDGE_DIR);
  try {
    if (!fs.existsSync(lfb)) return;
  } catch {
    return;
  }
  let removed = 0;
  for (const f of LEGACY_CATEGORY_B_FILES) {
    try {
      fs.rmSync(path.join(lfb, f), { force: true });
      removed++;
    } catch {
      /* best-effort */
    }
  }
  for (const d of LEGACY_CATEGORY_B_DIRS) {
    try {
      if (fs.existsSync(path.join(lfb, d))) {
        fs.rmSync(path.join(lfb, d), { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* best-effort */
    }
  }
  // Remove `.lfbridge/` only when nothing Category-A remains — rmdir fails (harmlessly) if it isn't empty.
  try {
    if (fs.readdirSync(lfb).length === 0) fs.rmdirSync(lfb);
  } catch {
    /* not empty (has transcripts/analysis) or racing — leave it */
  }
  if (removed) log.info("storage", `swept legacy Category-B state from ${lfb} — a working repo tracks in Local Storage`);
}

/** Resolve which `files.yaml` to READ: the KIND-correct canonical path, but if that doesn't exist yet and this
 *  is a working repo whose index still sits in the legacy in-repo location, read that so counts survive until
 *  the next re-index sweeps it (§ indexStorageFiles). Returns the canonical (ENOENT) path when neither exists
 *  so callers still see the ordinary "never indexed" state. */
function indexReadPath(root: string, type?: StorageType): string {
  const t = type ?? resolveStorageType(root);
  const canonical = filesYamlPath(root, t);
  try {
    if (fs.existsSync(canonical)) return canonical;
  } catch {
    /* fall through */
  }
  if (tracksIndexInLocalStorage(t)) {
    const legacy = lfbridgeFilesYamlPath(root);
    try {
      if (fs.existsSync(legacy)) return legacy;
    } catch {
      /* fall through */
    }
  }
  return canonical;
}

/** Read the storage's `files.yaml` index into rows (empty when absent). For a working repo this reads Local
 *  Storage (with a one-migration fallback to the legacy in-repo index); for an SDL it reads its committed
 *  `.lfbridge/`. Pass the known `type` to skip a descriptor read on hot paths. */
export function readStorageIndex(root: string, type?: StorageType): StorageFileRow[] {
  const p = indexReadPath(root, type);
  let doc: { files?: Record<string, Record<string, unknown>> };
  try {
    doc = YAML.parse(fs.readFileSync(p, "utf8")) ?? {};
  } catch (e) {
    // A missing index (ENOENT) is the ordinary "never indexed yet" state — silent. But a file that EXISTS
    // and won't parse (truncated/corrupt write, permissions) must reach error.err: otherwise a broken index
    // masquerades as an empty one and the Storages page / fingerprint lookups silently lose data.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("storage", `files.yaml unreadable/corrupt for ${root}: ${(e as Error).message}`);
    }
    return [];
  }
  const files = doc.files ?? {};
  return Object.entries(files).map(([rel, f]) => ({
    path: rel,
    sizeBytes: Number(f.size ?? 0),
    modifiedAt: (f.modified as string) ?? null,
    createdAt: (f.created as string) ?? null,
    fingerprint: (f.fingerprint as string) ?? null,
    compressible: (f.compressible as "video" | "image" | null) ?? null,
    analysis: Array.isArray(f.analysis) ? (f.analysis as string[]) : [],
  }));
}

/** File count from the index without materializing rows; null when the storage was never indexed. Reads the
 *  KIND-correct location (Local Storage for a repo, `.lfbridge/` for an SDL) with the same legacy fallback as
 *  {@link readStorageIndex}. Pass the known `type` to skip a descriptor read on the Storages/Repos list. */
export function countStorageIndex(root: string, type?: StorageType): number | null {
  const p = indexReadPath(root, type);
  try {
    const doc = YAML.parse(fs.readFileSync(p, "utf8")) ?? {};
    return Object.keys(doc.files ?? {}).length;
  } catch {
    return null;
  }
}
