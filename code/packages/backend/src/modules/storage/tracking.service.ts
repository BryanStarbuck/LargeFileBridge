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
import { isFileAt, statOrNull } from "../../shared/fs-probe.js";
import { relPosix, healWindowsPath, hasWindowsSeparator, joinRel } from "../../shared/rel-path.js";
import { log } from "../../shared/logging.js";
import { repoStateDir, resolveStateSyncRepo } from "./tracking-root.service.js";
import { dbEnabled, tryDb } from "../../shared/persistence/db.js";
import { readArtifactsForFiles, unitIdForRoot } from "../store-model/file-detail.repo.js";
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
// Keep consistent with TRANSCRIPTION_EXT / AI_DESCRIPTION_EXT / OCR_EXT in storage/artifact-placement.service.ts.
// Inlined (not imported) to avoid an import cycle — artifact-placement imports LFBRIDGE_DIR from here.
const TRANSCRIPTION_EXT = ".transcription";
const AI_DESCRIPTION_EXT = ".ai_description";
const OCR_EXT = ".ocr";
// ── Index size bounds (storages.mdx §4.1a) ────────────────────────────────────────────────────────────────
// THE CAP IS A CRASH BACKSTOP, NOT A ROUTINE LIMIT. Every file the index drops is a file that is never
// fingerprinted, never pinned, never synced to the user's other computers, and never counted in the
// compression / big-file / git-ignore rollups. A cap a real tree can reach is therefore not a safety
// measure — it is silent, permanent under-reporting of the user's own data (the walk order is
// deterministic, so the SAME tail files are dropped on EVERY re-index, forever).
//
// SIZING (measured on this machine, 2026-07):
//   • YAML cost per entry: 275 B (measured — 411 real entries with a mean relative path of 48 chars
//     rendered through YAML.stringify() in exactly the shape written below). Live phase-1 `Entry` objects
//     run ~400 B (abs + rel + name + two ISO strings + 3 numbers).
//   • Largest tree on this machine: `~/BGit/all/jfk`, 76,825 files TOTAL — i.e. the absolute ceiling of
//     entries that tree could ever produce even with the big-file threshold set to zero. The largest real
//     candidate set measured by the scanner walk was 5,364 (`~/BGit/Bryan_git/UAP_Murder_Docus`) — already
//     OVER the old 5,000 cap, which is exactly how this bug showed up.
//   • At the default 100 MB threshold, real repos here index 0–4 entries. This cap is nowhere near
//     routine use; it is reachable only by a pathological tree (a runaway generated dir, a mounted archive).
// 200,000 entries ≈ 55 MB of YAML and ≈ 80 MB of peak heap — bounded, while being ~2.6× the entry count the
// largest tree observed could produce at a ZERO threshold and ~37× the largest measured candidate set.
// Deliberately the same number as the scanner's UNIT_CANDIDATE_HARD_CAP so both walks fail at the same place.
const MAX_FILES = 200_000;
// A heads-up, never a limit: crossing it drops NOTHING, it only logs once so a tree heading somewhere
// unusual is noticed BEFORE the backstop could ever truncate. ~10× the largest tree measured here, because a
// soft cap a normal storage crosses on every re-index is noise nobody reads (mirrors the scanner's
// UNIT_CANDIDATE_CAP).
const SOFT_NOTICE_FILES = 50_000;
// Written at the TOP of `files.yaml` when — and only when — the backstop truncated the index, carrying the
// EXACT number of large files that were found but not recorded. Its presence is what makes every count
// derived from this index non-authoritative, so it is read back (cheaply, see storageIndexDroppedFiles)
// and surfaced in the UI rather than living only in a log line.
const DROPPED_KEY = "dropped_files";
const FINGERPRINT_CHUNK = 64 * 1024;
// Phase-1 walk responsiveness: hand the event loop back every N processed entries, exactly like the flat
// walk in fs/fsindex (performance.mdx P-16, charter T3). A recursive SYNC walk with no yield pins the single
// Node thread and starves every concurrent request on a large tree.
const WALK_YIELD_EVERY = 200;
// Phase 2 fingerprints in SLICES rather than one mapLimit over everything, so the intermediate result rows
// are folded into `files` and released a slice at a time instead of all co-existing with `collected` (2_2_do
// §I2 — three co-resident generations). Comfortably above any realistic core budget, so the fan-out is still
// saturated within a slice.
const FINGERPRINT_SLICE = 512;
const trackingYield = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

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
  const primed = primedOutputs(root, rel);
  if (primed) return primed;
  return analysisOutputsFromDisk(root, rel, type);
}

/**
 * THE FILESYSTEM PROBE — the original `analysisOutputs`, unchanged, kept under its own name.
 *
 * It stays for two jobs beyond being the fallback: it is the VERIFICATION ORACLE area 7 is checked against
 * (R3 / database_migration.mdx §4.5 — the old function survives a cutover and is what proves the new one),
 * and it is what answers for every file the index has never heard of.
 */
export function analysisOutputsFromDisk(root: string, rel: string, type?: StorageType): string[] {
  const out: string[] = [];
  // isFileAt comes from shared/fs-probe (non-throwing statSync). This function fires ~12 probes per
  // file across every artifact placement and nearly all of them MISS, so the old
  // `try { statSync(p).isFile() } catch { false }` idiom paid a full V8 Error + stack capture per miss
  // — profiling showed that single pattern owning ~64% of the backend's CPU. Same semantics, 6–9×
  // cheaper per miss. See shared/fs-probe.ts.
  const layout = artifactLayoutFor(root, type);
  // Detect the artifact in EVERY placement (placement_radios.mdx): under the tracking base (the default) OR
  // beside the media (the opt-in beside-media layout) OR, for an SDL awaiting migration, the legacy
  // `.lfbridge/` base — so a file's "done" status is correct whichever layout it is actually in. (The
  // sync-repo placement is detected via its own path when that seam lands.)
  const bases = layout.bodyBases.map((b) => joinRel(b.dir, rel)); // full filename kept; ext appended below
  if (bases.some((b) => isFileAt(b + TRANSCRIPTION_EXT))) out.push("transcript");
  if (bases.some((b) => isFileAt(b + AI_DESCRIPTION_EXT))) out.push("description");
  // OCR text (ocr.mdx §5.2) — the third artifact, detected in the same three layouts. Existence IS the
  // signal: an artifact whose text is empty still counts as done, because most images have no text and a
  // text-free file must never be re-offered forever (ocr.mdx §2.3).
  if (bases.some((b) => isFileAt(b + OCR_EXT))) out.push("ocr");
  const analysisDirs = layout.analysisBases.map((b) => joinRel(b.dir, rel));
  for (const [key, file] of Object.entries(ANALYSIS_FILES)) {
    if (analysisDirs.some((d) => isFileAt(path.join(d, file)))) out.push(key);
  }
  // Travelling compression record (compression.mdx §8 step 6 / §8.4) — `analysis/<rel>/compression.yaml`,
  // written by analysis.service.ts writeCompressionRecord() after an in-place re-encode (and backfilled on
  // a §8.4 marker skip). An in-place video compress keeps its FILENAME, so the name-only heuristic
  // (badges.ts compressInfo) would re-offer the file forever on every computer; the record flips it to
  // "done" mesh-wide. Probed in every placement it can live in: the Category-B Local-Storage state dir
  // (the write target), the shared sync-repo mirror (how ANOTHER computer's record reaches this one), and
  // the tracking-base dirs (legacy records written before the Category-B placement fix). Probed ONLY when
  // the name still reads "should compress" (the record is the only signal that can override it) and
  // counted ONLY while FRESH: the record carries the compressed size, so replacing the media with new
  // bytes of a different size invalidates it and the file is offered again.
  if (compressInfo(path.basename(rel)).compressState === "should") {
    for (const b of layout.recordBases(root)) {
      const f = path.join(joinRel(b.dir, rel), COMPRESSION_RECORD_FILE);
      if (!isFileAt(f)) continue;
      if (compressionRecordFresh(f, joinRel(root, rel))) out.push("compression");
      break; // first record found decides — a stale record never falls through to another copy
    }
  }
  return out;
}

export const COMPRESSION_RECORD_FILE = "compression.yaml";

// ── the artifact layout, named ONCE ─────────────────────────────────────────────────────────────────────

/** The five `lfb.placement` enum values (0002), which are exactly the layouts `analysisOutputs` probes. */
export type ArtifactPlacementKind = "tracking_base" | "beside" | "legacy_lfbridge" | "sync_repo" | "local_state";

export interface ArtifactBase {
  dir: string;
  placement: ArtifactPlacementKind;
}

export interface ArtifactLayout {
  /** Where an artifact BODY (`<rel><ext>`) can live, in the app's own probe order. */
  bodyBases: ArtifactBase[];
  /** Where an `analysis/<rel>/<file>.yaml` can live. */
  analysisBases: ArtifactBase[];
  /** Where a travelling `analysis/<rel>/compression.yaml` can live, in the app's own probe order. */
  recordBases: (root: string) => ArtifactBase[];
}

/**
 * THE ONE SPELLING of "where can this root's artifacts be", shared by the probe above and by backfill
 * area 7.
 *
 * Area 7 has to ENUMERATE artifacts (it walks to discover them) where the probe only has to CONFIRM one it
 * was handed a path for. Those are opposite directions over the same layout, and a second copy of the layout
 * for the enumerating direction is precisely how a placement gets forgotten — which for the artifact index
 * means a FALSE MISSING, and for a paid AI description a re-billed regeneration
 * (database_migration.mdx §4.3, area 7). So the layout is stated here and both directions read it.
 *
 * `recordBases` is a function of `root` rather than a plain array because the compression record's first two
 * placements (the Local-Storage state dir and the sync-repo mirror) are resolved from the root, not from the
 * tracking base — the record is Category-B tracking state, not a Category-A content artifact.
 */
export function artifactLayoutFor(root: string, type?: StorageType): ArtifactLayout {
  const t = type ?? resolveStorageType(root);
  const trackingBase = trackingBaseDir(root, t);
  const legacy = legacyTrackingBaseDir(root, t);
  const analysisBases: ArtifactBase[] = [
    { dir: path.join(trackingBase, ANALYSIS_DIR), placement: "tracking_base" },
    ...(legacy ? [{ dir: path.join(legacy, ANALYSIS_DIR), placement: "legacy_lfbridge" as const }] : []),
  ];
  return {
    bodyBases: [
      { dir: trackingBase, placement: "tracking_base" },
      { dir: root, placement: "beside" },
      ...(legacy ? [{ dir: legacy, placement: "legacy_lfbridge" as const }] : []),
    ],
    analysisBases,
    recordBases: (r: string) => {
      const syncSub = cachedStateSyncRepo(r);
      return [
        { dir: path.join(repoStateDir(r), ANALYSIS_DIR), placement: "local_state" },
        ...(syncSub ? [{ dir: path.join(syncSub, ANALYSIS_DIR), placement: "sync_repo" as const }] : []),
        ...analysisBases,
      ];
    },
  };
}

// ── the batched Postgres read (database.mdx §9 slice 9) ─────────────────────────────────────────────────
//
// READ THE MEASUREMENT BEFORE YOU WIRE THIS UP. Taken on this machine, 2026-08-24, against the real corpus
// (12,720 artifact rows, `charlie-kirk`, warm APFS dentry cache, 5 alternating passes):
//
//     500 files THAT HAVE artifacts   disk 6.4 ms   |   prime 12.6 ms + read 2.5 ms = 15.1 ms
//     500 files with NO artifact      disk 13.2 ms  |   (the index cannot answer these at all — see the
//                                                   |    fence below — so it would ADD its 12.6 ms)
//
// ON A WARM LOCAL FILESYSTEM THE INDEX LOSES. `isFileAt` (shared/fs-probe.ts) already removed the V8
// Error-plus-stack-capture that made the old miss idiom cost ~64% of backend CPU, and what is left is ~1 µs
// per cached `statSync`. The batched query is an index scan doing one PK descent per key — `EXPLAIN ANALYZE`
// measured 12.6 ms for 500 keys / 1,689 buffer hits — and 25 µs per key cannot beat 1 µs per stat.
//
// The index therefore wins in exactly the case the filesystem is slow: a COLD cache, or a network / cloud
// mounted repo, where a single `statSync` blocks for milliseconds and a page pays it ~12 times per row
// (units.service.ts already names that case: "on a cloud-mounted repo each statSync can block, so a large
// repo multiplied that into a multi-second load"). It is built, verified against the disk oracle on 302 real
// files with zero disagreements, and left UNPRIMED BY DEFAULT: no caller in the app calls
// `primeAnalysisOutputs` today, so `analysisOutputs` behaves exactly as it did before this slice. Whoever
// wires it into `composeFileRows` should do it behind the storage-kind or a setting, on these numbers.
//
// THE FENCE, stated before the code because it is the whole design:
//
//     POSTGRES MAY CONFIRM A `DONE`. IT MAY NEVER ASSERT A `MISSING`.
//
// `analysisOutputs` is the "is it already done?" check, and its own header states the rule it lives by: it
// must NEVER report a false MISSING, because that regenerates work and for a paid AI description it re-bills
// the provider. An index of a filesystem cannot honestly answer "there is no artifact here" unless every
// writer of an artifact also writes the index — and the artifact writers (transcribe / describe / ocr) are
// not part of this slice. So a file the index has no row for falls through to the full disk probe, exactly
// as before. Nothing regresses; the win lands on the ~12,921 files that DO have artifact rows.
//
// AND EVEN A HIT IS RE-STATTED. `body_size` / `body_mtime_ms` are "the ONLY validity token: a mismatch on
// re-stat means UNKNOWN, never done" (0009's own header). One `statSync` on a path we know exists is a hot
// dentry-cache hit; what it replaces is up to a dozen probes that MISS. A mismatch means the artifact was
// edited or replaced under us, and the file falls back to the full disk probe rather than trusting a row
// that no longer describes anything.

const PRIME_TTL_MS = 30_000;

interface PrimedArtifact {
  kind: string;
  bodyPath: string;
  bodySize: number;
  bodyMtimeMs: number;
  mediaSizeAtRecord: number | null;
}

/** `<root>\u0000<relPosix>` → the indexed artifacts for it. Only paths WITH artifacts are ever present. */
let primeIndex = new Map<string, PrimedArtifact[]>();
let primeAt = 0;

function primeKey(root: string, rel: string): string {
  return `${path.resolve(root)}\u0000${healWindowsPath(rel)}`;
}

/**
 * Load one PAGE of artifact rows in a single round trip, ahead of the per-row `analysisOutputs` calls.
 *
 * BATCHED, never per row. A per-row query would swap a ~1 µs cached `statSync` for a ~150-300 µs socket
 * round trip and make the page slower than the filesystem it replaced — the same trap the foreign-pin work
 * had to avoid inside the scanner loop. The caller hands over the page's whole candidate list at once.
 *
 * Returns the number of artifact rows primed. Never throws: with no database, no unit row, or a query
 * failure it primes nothing and every row takes the disk path (R2).
 */
export async function primeAnalysisOutputs(root: string, rels: string[]): Promise<number> {
  if (!dbEnabled() || rels.length === 0) return 0;
  return tryDb(
    async () => {
      const unitId = await unitIdForRoot(root);
      if (unitId === null) return 0;
      const keys = [...new Set(rels.map((r) => healWindowsPath(r)))];
      const rows = await readArtifactsForFiles(unitId, keys);
      if (Date.now() - primeAt > PRIME_TTL_MS) primeIndex = new Map(); // drop a stale page's entries
      for (const r of rows) {
        const key = primeKey(root, r.rel_posix);
        const list = primeIndex.get(key) ?? [];
        list.push({
          kind: r.kind,
          bodyPath: r.body_path,
          bodySize: Number(r.body_size),
          bodyMtimeMs: Number(r.body_mtime_ms),
          mediaSizeAtRecord: r.media_size_at_record === null ? null : Number(r.media_size_at_record),
        });
        primeIndex.set(key, list);
      }
      primeAt = Date.now();
      return rows.length;
    },
    0,
    "tracking.primeAnalysisOutputs",
  );
}

/** Tests only — the primed page is module state. */
export function resetAnalysisOutputsPrime(): void {
  primeIndex = new Map();
  primeAt = 0;
}

/**
 * The primed answer for one file, or null to fall through to the disk probe.
 *
 * Null is returned for THREE distinct situations, and all three are the same thing to the caller — "the
 * index cannot answer, go and look":
 *   * no row for this path (the index has never seen it, or it genuinely has no artifacts);
 *   * a row whose body no longer stats to the size/mtime it was indexed at (0009's validity token);
 *   * a `compression` row that cannot be re-checked against the media's CURRENT size.
 */
function primedOutputs(root: string, rel: string): string[] | null {
  if (primeIndex.size === 0) return null;
  if (Date.now() - primeAt > PRIME_TTL_MS) return null;
  const rows = primeIndex.get(primeKey(root, rel));
  if (!rows || rows.length === 0) return null;

  const out: string[] = [];
  for (const r of rows) {
    const st = statOrNull(r.bodyPath);
    // The validity token. A body that moved, shrank or was rewritten invalidates its row: we know LESS than
    // the index claims, so the honest answer is to go and look rather than to report a possibly-stale done.
    if (!st || st.size !== r.bodySize || Math.round(st.mtimeMs) !== r.bodyMtimeMs) return null;
    if (r.kind === "compression") {
      // THE LIVE STAT STAYS (database.mdx §9 slice 9). `compressionRecordFresh()` compares the record's
      // compressed size against the media's CURRENT size — the verdict is not a static fact. A row that
      // said "done" without re-checking would be a FALSE DONE that silently never re-offers a file the user
      // has since re-edited, which is worse than the ~12 probes it saves.
      if (r.mediaSizeAtRecord === null) return null; // "a record without a size is trusted" has no row form
      if (compressInfo(path.basename(rel)).compressState !== "should") continue; // the name already says done
      if (statOrNull(joinRel(root, rel))?.size !== r.mediaSizeAtRecord) continue; // stale → not done
    }
    out.push(r.kind);
  }
  // The disk probe emits its kinds in a fixed order and callers compare the two lists in the verification
  // pass, so the primed answer is sorted into the SAME order. Every consumer uses `.includes()`, so this is
  // about being comparable, not about being correct.
  return OUTPUT_ORDER.filter((k) => out.includes(k));
}

/** The order `analysisOutputsFromDisk` pushes its kinds in. */
const OUTPUT_ORDER = ["transcript", "description", "ocr", "visuals_by_time", "compression"];

// resolveStateSyncRepo reads the `.sync-repo` marker file each call; analysisOutputs runs per ROW on the
// View-One-Repo hot path, so memoize per root (the marker changes only when the user re-configures the
// owning storage's sync repo — a restart-scale event; a stale null/path here only delays a metric hint).
const stateSyncRepoCache = new Map<string, string | null>();
function cachedStateSyncRepo(root: string): string | null {
  if (!stateSyncRepoCache.has(root)) {
    stateSyncRepoCache.set(
      root,
      (() => {
        try {
          return resolveStateSyncRepo(root);
        } catch {
          return null;
        }
      })(),
    );
  }
  return stateSyncRepoCache.get(root) ?? null;
}

/** Fresh iff the record's compressed size matches the media's CURRENT size (a record without a size is
 *  trusted). A mismatch means the bytes changed since the compress — the record no longer describes them. */
function compressionRecordFresh(recordAbs: string, mediaAbs: string): boolean {
  try {
    const rec = YAML.parse(fs.readFileSync(recordAbs, "utf8")) as {
      compressed?: { size?: number | null };
    } | null;
    const recSize = rec?.compressed?.size;
    if (recSize == null) return true;
    return statOrNull(mediaAbs)?.size === recSize; // missing media → not "done" (undefined !== recSize)
  } catch {
    return false; // unreadable record / missing media → never claim "done" on it
  }
}

/** A cheap-but-robust fingerprint: hash of size + mtime + the head and tail bytes. ASYNC (fs.promises) so
 *  that MANY files' head/tail reads OVERLAP when fingerprinting fans out under mapLimit (the disk I/O is
 *  the cost, and async reads let the event loop drive several at once — parallelization.mdx §3). */
async function fingerprint(abs: string, size: number, mtimeMs: number): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    const h = crypto.createHash("sha256");
    h.update(String(size));
    h.update(String(Math.round(mtimeMs)));
    fh = await fs.promises.open(abs, "r");
    const headLen = Math.min(FINGERPRINT_CHUNK, size);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    h.update(head);
    if (size > FINGERPRINT_CHUNK) {
      const tailLen = Math.min(FINGERPRINT_CHUNK, size);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, Math.max(0, size - tailLen));
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
  // ASYNC + cooperatively yielding (charter T3): the walk touches every directory under the root, so run
  // recursive-sync it pins the event loop for the whole traversal of a large tree. Entries keep only the
  // PRIMITIVES they need — never the `fs.Stats` object itself, which would hold one Stats per file alive for
  // the whole of phase 2 alongside the rows (2_2_do §I2).
  interface Entry { rel: string; name: string; abs: string; size: number; mtimeMs: number; modified: string; created: string | null; }
  const collected: Entry[] = [];
  // Large files found but NOT recorded because the backstop was already full. The walk never aborts early:
  // it keeps descending and keeps counting, so the number we report (and persist) is EXACT — "some files
  // not indexed" is exactly the silent under-report this cap must not produce.
  let dropped = 0;
  let sinceYield = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // In an SDL the tracking base IS the root, so LFB's own metadata (devices/, analysis/, the root YAMLs)
    // sits in the walk's path. Skip it at the TOP LEVEL ONLY — these names are reserved there (§0.3), but
    // deeper down they are just ordinary user directories inside a mapped-dir mirror and must be indexed.
    const atSdlRoot = !usesLfbridgeDir(t) && path.resolve(dir) === path.resolve(root);
    for (const ent of entries) {
      const name = ent.name;
      if (name === LFBRIDGE_DIR || name === ".git" || name === "node_modules" || HARD_SKIP.has(name)) continue;
      if (atSdlRoot && RESERVED_SDL_ROOT_NAMES.has(name)) continue;
      const abs = path.join(dir, name);
      if (++sinceYield >= WALK_YIELD_EVERY) {
        sinceYield = 0;
        await trackingYield();
      }
      if (ent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        continue;
      }
      if (st.size < threshold) continue;
      // At the backstop: stop accumulating, but keep walking and counting so the WARN and the persisted
      // `dropped_files` carry the exact shortfall (storages.mdx §4.1a).
      if (collected.length >= MAX_FILES) {
        dropped++;
        continue;
      }
      collected.push({
        // POSIX from the moment it is built (repo__list_syns.mdx §6.1) — this is the key every row in
        // `files.yaml` is stored under, and the join key the manifest / sidecars / decisions all use.
        rel: relPosix(root, abs),
        name,
        abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
        modified: st.mtime.toISOString(),
        created: st.birthtime && st.birthtimeMs ? st.birthtime.toISOString() : null,
      });
    }
  };
  await walk(root);
  const total = collected.length;

  // Phase 2 — fingerprint IN PARALLEL across files (bounded by the responsive budget). Each result carries
  // its rel key so the map is assembled deterministically after; per-file failure yields a null fingerprint.
  // Done a SLICE at a time and folded straight into `files`: the slice's rows are the only intermediate
  // generation alive, and each consumed slice is dropped out of `collected` as we go, so the three
  // generations (entries / rows / files) are never all co-resident (2_2_do §I2). Insertion order — and
  // therefore the emitted YAML — is identical to the previous single mapLimit over `collected`.
  const files: Record<string, unknown> = {};
  const budget = responsiveBudget();
  for (let i = 0; i < total; i += FINGERPRINT_SLICE) {
    const slice = collected.slice(i, i + FINGERPRINT_SLICE);
    // Release the walk's entries for this slice — `slice` now holds the only references we still need.
    for (let j = i; j < i + slice.length; j++) collected[j] = undefined as unknown as Entry;
    const rows = await mapLimit(slice, budget, async (e) => {
      const comp = compressInfo(e.name);
      return [
        e.rel,
        {
          size: e.size,
          modified: e.modified,
          created: e.created,
          fingerprint: await fingerprint(e.abs, e.size, e.mtimeMs),
          compressible: comp.compressible,
          analysis: analysisOutputs(root, e.rel),
        },
      ] as const;
    });
    for (const [rel, row] of rows) files[rel] = row;
    await trackingYield();
  }
  collected.length = 0;

  // Write to the KIND-correct location: a working repo indexes into Local Storage (never its own `.lfbridge/`,
  // so the walk above never has to create one); an SDL commits into `<root>/.lfbridge/`. mkdir the index file's
  // OWN parent — for a repo that is the Local-Storage `repos/<repoKey>/` dir, so a repo with no transcripts
  // keeps NO `.lfbridge/` at all (the absolute rule).
  const outPath = filesYamlPath(root, t);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // `dropped_files` is written FIRST (and only when non-zero) so the incompleteness is the first thing any
  // reader — ours or a human opening the file — sees, and so storageIndexDroppedFiles can find it in the
  // file's head without parsing the whole index. A complete index is byte-identical to what we wrote before.
  fs.writeFileSync(outPath, YAML.stringify(dropped > 0 ? { [DROPPED_KEY]: dropped, files } : { files }), "utf8");
  // We are the index's only in-process writer — drop any cached read of it immediately, so no reader can be
  // served a pre-build view even within the stat-check's mtime resolution (see readStorageIndex's cache).
  invalidateStorageIndexCache();
  // Now that a repo's index lives in Local Storage, remove any stale Category-B state a prior build left in the
  // working repo's `.lfbridge/` (and drop the folder if it's left empty) — the one-time on-disk migration.
  if (tracksIndexInLocalStorage(t)) sweepLegacyRepoTracking(root);
  if (dropped > 0) {
    // EXACT, never "some": the count is what the user is missing, and it is also persisted in the index
    // itself (`dropped_files`) so the UI can say the same number instead of the truth living only here.
    log.warn(
      "storage",
      `index for ${root} hit the ${MAX_FILES}-file backstop — ${dropped} large file(s) found but NOT indexed ` +
        `(${total} indexed; recorded in files.yaml as ${DROPPED_KEY}, surfaced in the app as an incomplete index)`,
    );
  } else if (total > SOFT_NOTICE_FILES) {
    // Over the heads-up line but nothing dropped — the index is COMPLETE. Logged so a storage growing
    // toward the backstop is visible long before it could ever truncate (storages.mdx §4.1a).
    log.warn(
      "storage",
      `index for ${root} holds ${total} large file(s), over the ${SOFT_NOTICE_FILES}-file heads-up line ` +
        `(nothing dropped — the index is complete; the backstop is ${MAX_FILES})`,
    );
    log.info("storage", `indexed ${total} large file(s) in ${root}`);
  } else log.info("storage", `indexed ${total} large file(s) in ${root}`);
  return total;
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
  // This removes a legacy `files.yaml` that readStorageIndex may have cached under its in-repo path.
  invalidateStorageIndexCache(path.join(lfb, FILES_YAML));
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

// ── files.yaml read cache (2_2_do §I1) ────────────────────────────────────────────────────────────────────
// `readStorageIndex` had NO memoization and many callers (pin, communities, decisions, repo-storage, the two
// To-Do engines, the Storages page), each materializing the YAML TEXT + the parsed doc + rows — ~12 MB a call
// on a large index, all garbage a moment later.
//
// CORRECTNESS FIRST. This index mirrors files on disk that really do change (a re-index, a compression, a new
// transcript), and a cache that outlives a real change is a worse bug than the bytes it saves. So the cache is
// never trusted on its own:
//   1. Every read `stat`s the index file (one cheap syscall, orders of magnitude below a parse) and serves the
//      cache ONLY when inode + size + mtimeMs all still match what was parsed. Any real rewrite moves at least
//      one of them, so a changed index can't be served from cache.
//   2. A short TTL bounds the one theoretical hole in (1) — a rewrite landing within the same mtime tick AND
//      at a byte-identical size. Worst case staleness is TTL, not forever.
//   3. `indexStorageFiles` — our only in-process writer — invalidates explicitly right after its write, so in
//      the case that matters (we just rebuilt it) staleness is zero and doesn't depend on (1) or (2) at all.
// The cache is BOUNDED (a handful of storages, oldest evicted) so it can't become its own leak.
const INDEX_CACHE_TTL_MS = 5000;
const INDEX_CACHE_MAX = 16;
interface IndexCacheEntry { ino: number; size: number; mtimeMs: number; at: number; rows: StorageFileRow[]; }
const indexCache = new Map<string, IndexCacheEntry>();

/** Cached rows for this index path when the file on disk is provably the one we parsed; null otherwise. */
function cachedRows(p: string): StorageFileRow[] | null {
  const hit = indexCache.get(p);
  if (!hit) return null;
  if (Date.now() - hit.at > INDEX_CACHE_TTL_MS) {
    indexCache.delete(p);
    return null;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    indexCache.delete(p); // gone (or unreadable) → never serve the old view
    return null;
  }
  if (st.ino !== hit.ino || st.size !== hit.size || st.mtimeMs !== hit.mtimeMs) {
    indexCache.delete(p);
    return null;
  }
  return hit.rows;
}

/** Cache the rows just parsed from `p`, stamped with that file's identity. The rows stored here are the
 *  cache's OWN copy and are never handed out directly — readStorageIndex returns a per-call copy, so a caller
 *  that mutates its rows (or the array) can't corrupt what the next caller sees. */
function storeRows(p: string, rows: StorageFileRow[]): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return; // can't prove what we parsed → don't cache it
  }
  indexCache.delete(p);
  indexCache.set(p, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, at: Date.now(), rows: rows.map((r) => ({ ...r })) });
  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value; // insertion order = eviction order
    if (oldest === undefined) break;
    indexCache.delete(oldest);
  }
}

/** Drop cached index reads — all of them, or just this path's. Called by every writer/remover of a
 *  `files.yaml` in this module. Exported so a future out-of-module writer can do the same. */
export function invalidateStorageIndexCache(p?: string): void {
  if (p) indexCache.delete(p);
  else indexCache.clear();
}

/** Read the storage's `files.yaml` index into rows (empty when absent). For a working repo this reads Local
 *  Storage (with a one-migration fallback to the legacy in-repo index); for an SDL it reads its committed
 *  `.lfbridge/`. Pass the known `type` to skip a descriptor read on hot paths. */
export function readStorageIndex(root: string, type?: StorageType): StorageFileRow[] {
  const p = indexReadPath(root, type);
  const cached = cachedRows(p);
  if (cached) return cached.map((r) => ({ ...r }));
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
  // Heal `\` keys a Windows build wrote (repo__list_syns.mdx §6.1). These rows are joined against manifest
  // and candidate paths all over the app — an unhealed key matches nothing, so the file reads as
  // un-fingerprinted, un-compressible and absent from every rollup. A collision between the two spellings
  // folds to ONE row (last wins; the rows carry only derived facts, so either copy is equivalent).
  let rows: StorageFileRow[] = Object.entries(files).map(([rel, f]) => ({
    path: healWindowsPath(rel),
    sizeBytes: Number(f.size ?? 0),
    modifiedAt: (f.modified as string) ?? null,
    createdAt: (f.created as string) ?? null,
    fingerprint: (f.fingerprint as string) ?? null,
    compressible: (f.compressible as "video" | "image" | null) ?? null,
    analysis: Array.isArray(f.analysis) ? (f.analysis as string[]) : [],
  }));
  if (Object.keys(files).some(hasWindowsSeparator)) {
    // Healing can make two keys collide; a duplicated path would double-count the file in every rollup
    // built from this index. The rows carry only derived facts, so the later (POSIX-spelled) one wins.
    rows = [...new Map(rows.map((r) => [r.path, r])).values()];
  }
  storeRows(p, rows);
  // Hand back a copy for the same reason the cache stores its own: callers own their rows (see storeRows).
  return rows.map((r) => ({ ...r }));
}

/** File count from the index without materializing rows; null when the storage was never indexed. Reads the
 *  KIND-correct location (Local Storage for a repo, `.lfbridge/` for an SDL) with the same legacy fallback as
 *  {@link readStorageIndex}. Pass the known `type` to skip a descriptor read on the Storages/Repos list. */
export function countStorageIndex(root: string, type?: StorageType): number | null {
  const p = indexReadPath(root, type);
  // Same stat-validated cache as readStorageIndex — this parses the WHOLE YAML just to count its keys, so a
  // hit saves exactly as much as it does there. A miss falls through to the original read/parse untouched
  // (its null-on-anything-unreadable contract differs from readStorageIndex's empty-on-corrupt one).
  const hit = cachedRows(p);
  if (hit) return hit.length;
  try {
    const doc = YAML.parse(fs.readFileSync(p, "utf8")) ?? {};
    return Object.keys(doc.files ?? {}).length;
  } catch {
    return null;
  }
}

// How many bytes of the index's HEAD we need to decide "is this index complete?". `dropped_files` is always
// written as the FIRST line (see indexStorageFiles), so a small head read answers it; 512 B is generous.
const DROPPED_HEAD_BYTES = 512;

/**
 * How many large files the last index build FOUND but could not RECORD — 0 when the index is complete,
 * which is the normal case. Every count derived from this index (file counts, the compression / big-file /
 * git-ignore rollups, the sync decisions) is an UNDER-report by exactly this many while it is > 0, so no
 * caller may present those numbers as authoritative without also showing this (storages.mdx §4.1a).
 *
 * Deliberately cheap: it reads only the head of `files.yaml` and never parses the index, so callers on the
 * Storages/Repos list hot path can ask per storage. A legacy index written before this field existed simply
 * has no `dropped_files` line and reads as complete.
 */
export function storageIndexDroppedFiles(root: string, type?: StorageType): number {
  const p = indexReadPath(root, type);
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(DROPPED_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, DROPPED_HEAD_BYTES, 0);
    // Column 0 is unambiguous — every `files:` entry underneath is indented.
    const m = new RegExp(`^${DROPPED_KEY}:\\s*(\\d+)`, "m").exec(buf.toString("utf8", 0, n));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0; // never indexed / unreadable → nothing to claim was dropped
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}
