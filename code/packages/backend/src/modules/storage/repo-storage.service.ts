// `repo_storage.yaml` — the repo-WIDE settings-and-state file (repo_tracking_scheme.mdx §2). It is
// Category-B tracking state, so it lives in LOCAL STORAGE at `~/T/_large_files_bridge/repos/<repoKey>/
// repo_storage.yaml` (resolved by `resolveTrackingRoot()`), NEVER inside a working repo — which is exactly
// why it can no longer merge-conflict (it re-stamps `last_scan.at` + `counts:` on EVERY scan). When the
// owning company/Personal storage has a sync repo configured and the per-repo toggle is on, it is
// ADDITIONALLY mirrored to `<syncRepo>/repos/<repoKey>/` (mirrorToSyncRepo). HARD SCHEMA RULE: the ONLY
// level-one key is `repo_storage:`. Written automatically on enlist, then updated by every scan and user
// action; serialized DETERMINISTICALLY (stable key order) and ATOMICALLY (temp → fsync → rename).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { RepoStorageDocSchema, type RepoStorageDoc } from "@lfb/shared";
import { readStorageIndex, analysisOutputs } from "./tracking.service.js";
import { resolveTrackingRoot } from "./tracking-root.service.js";
import { mirrorToSyncRepo } from "./tracking-sync.service.js";
import { selfDeviceName } from "./devices.service.js";
import { getAppConfig } from "../store-model/config.service.js";
import {
  classifySpecial,
  type SpecialClassifyCtx,
  type SpecialCategory,
} from "../scanner/special-file.service.js";
import { log } from "../../shared/logging.js";

// ── paths + consent (same pattern as decisions.service.ts) ─────────────────────

/** WHERE this repo's tracking files live (artifact_placement_policy.mdx §2): always the Local-Storage
 *  `~/T/_large_files_bridge/repos/<repoKey>/` dir — NEVER a working repo — so `repo_storage.yaml` never
 *  churns or merge-conflicts a git working tree. */
function trackingDir(repoRoot: string): string {
  return resolveTrackingRoot(repoRoot);
}

function repoStoragePath(repoRoot: string): string {
  return path.join(trackingDir(repoRoot), "repo_storage.yaml");
}


// ── read / write ───────────────────────────────────────────────────────────────

// Dedupe the "schema mismatch" WARN so a repeatedly-read bad file logs it ONCE per process, not on every
// read (a scan/refreshCounts pass reads this file constantly). Keyed by absolute file path; cleared
// implicitly on process restart. A file that later parses cleanly (e.g. the next writeRepoStorage()
// overwrites it) simply never re-adds to the set.
const warnedSchemaMismatch = new Set<string>();

/** Read `repo_storage.yaml` from Local Storage (`resolveTrackingRoot()`); missing/corrupt → schema defaults. */
export function readRepoStorage(repoRoot: string): RepoStorageDoc {
  const file = repoStoragePath(repoRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    // ENOENT is the NORMAL, expected case for a repo that hasn't been seeded/enlisted yet (or is mid-seed) —
    // refreshCounts() calls readRepoStorage() unconditionally, so this fires constantly and must stay
    // silent. Only a genuine I/O error (permissions, etc.) is worth a WARN.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("storage", `repo_storage read failed (using defaults): ${file}: ${(e as Error).message}`);
    }
    return RepoStorageDocSchema.parse({ repo_storage: {} });
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (e) {
    log.warn("storage", `repo_storage parse failed (using defaults): ${file}: ${(e as Error).message}`);
    return RepoStorageDocSchema.parse({ repo_storage: {} });
  }

  const result = RepoStorageDocSchema.safeParse(parsed);
  if (result.success) return result.data;

  // Tolerant migration: a pre-redesign file whose content is flat (no `repo_storage:` wrapper key) — lift it
  // under the root key and re-validate rather than discarding it. Covers a legacy/foreign-shaped file that
  // wandered in (e.g. via an older build, or a sync-repo mirror written before the wrapper rule existed).
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("repo_storage" in parsed)) {
    const lifted = RepoStorageDocSchema.safeParse({ repo_storage: parsed });
    if (lifted.success) return lifted.data;
  }

  // A genuine, unmigratable mismatch — warn ONCE per file per process, not on every read.
  if (!warnedSchemaMismatch.has(file)) {
    warnedSchemaMismatch.add(file);
    log.warn("storage", `repo_storage schema mismatch (using defaults): ${file}: ${result.error.message}`);
  }
  return RepoStorageDocSchema.parse({ repo_storage: {} });
}

/**
 * Write `repo_storage.yaml` deterministically + atomically (single `repo_storage:` root key) to LOCAL STORAGE
 * (`repos/<repoKey>/`). Not gated on the keep-`.lfbridge/` consent — that consent governs only the in-repo
 * Category-A artifacts; tracking state always lands in Local Storage, which never touches the working repo.
 * After a successful write, best-effort mirrors the repo's tracking subtree into the owning storage's sync
 * repo when one is configured (additive; no-op by default) — artifact_placement_policy.mdx §2/§4.
 */
export function writeRepoStorage(repoRoot: string, doc: RepoStorageDoc): void {
  const normalized = RepoStorageDocSchema.parse(doc); // fill defaults + fix key set
  const dir = trackingDir(repoRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  // sortMapEntries → stable key order regardless of construction; the doc has no volatile fields beyond
  // the recorded timestamps, so an unchanged doc re-serializes byte-identically.
  const body = YAML.stringify(normalized, { sortMapEntries: true });
  const file = repoStoragePath(repoRoot);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
    warnedSchemaMismatch.delete(file); // a fresh, schema-conforming write — re-arm the mismatch warning
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    log.error("storage", `repo_storage write failed: ${file}: ${(e as Error).message}`);
    throw e;
  }
  // Additive: carry this repo's tracking state to the company/Personal sync repo when configured (default
  // off → no-op). Local Storage stays authoritative; the mirror is the travel vehicle.
  mirrorToSyncRepo(repoRoot);
}

/**
 * Seed `repo_storage.yaml` on enlist if it doesn't exist yet (repo_tracking_scheme.mdx §2) — stamps the LFB
 * name (repo folder name), the enlist provenance (at/on_device), and default policy. Idempotent: an
 * existing file is returned unchanged. Called from storage.service.ts `ensureRepoStorage`.
 */
export function ensureRepoStorageDoc(repoRoot: string): RepoStorageDoc {
  if (fs.existsSync(repoStoragePath(repoRoot))) return readRepoStorage(repoRoot);
  const doc = RepoStorageDocSchema.parse({
    repo_storage: {
      name: path.basename(repoRoot),
      enlisted: { at: new Date().toISOString(), by: null, on_device: selfDeviceName() },
    },
  });
  writeRepoStorage(repoRoot, doc);
  return doc;
}

// ── counts rollup (special_files.mdx §4) ────────────────────────────────────────

/** One file folded into the rollup. When the scanner has richer state cheaply, it passes the git-ignore /
 *  forced / pinned flags; otherwise they default to "unknown" and only size + name drive classification. */
export interface RefreshFile {
  path: string; // repo-relative
  size: number;
  gitIgnored?: boolean;
  forced?: boolean;
  pinned?: boolean;
}

/**
 * Recompute `repo_storage.yaml → counts:` from the repo's special files and write the doc (§2.2). Prefer a
 * passed-in `files` list (the scanner's candidates, which know git-ignore/forced/pinned state); otherwise
 * fall back to the fast `files.yaml` index (large files only, size+name). Folds `classifySpecial` results
 * into the counts, counts `transcribed` from the on-disk transcript sidecars, and stamps `last_scan`.
 */
export function refreshCounts(
  repoRoot: string,
  files?: RefreshFile[],
  opts?: { thresholdBytes?: number; headless?: boolean },
): RepoStorageDoc {
  const list: RefreshFile[] =
    files ?? readStorageIndex(repoRoot).map((r) => ({ path: r.path, size: r.sizeBytes }));

  const giSet = new Set(list.filter((f) => f.gitIgnored).map((f) => f.path));
  const forcedSet = new Set(list.filter((f) => f.forced).map((f) => f.path));
  const pinSet = new Set(list.filter((f) => f.pinned).map((f) => f.path));
  const ctx: SpecialClassifyCtx = {
    thresholdBytes: opts?.thresholdBytes ?? getAppConfig().big_file.threshold_bytes,
    isGitIgnored: (p) => giSet.has(p),
    isForced: (p) => forcedSet.has(p),
    isPinned: (p) => pinSet.has(p),
  };

  const counts = {
    special: 0,
    large: 0,
    ipfs_pinned: 0,
    videos: 0,
    images: 0,
    audio: 0,
    compressible: 0,
    transcribable: 0,
    transcribed: 0,
  };
  const has = (cats: SpecialCategory[], c: SpecialCategory): boolean => cats.includes(c);
  for (const f of list) {
    const cls = classifySpecial({ path: f.path, size: f.size }, ctx);
    if (!cls.isSpecial) continue;
    counts.special++;
    if (has(cls.categories, "large")) counts.large++;
    if (has(cls.categories, "ipfs_pinned")) counts.ipfs_pinned++;
    if (has(cls.categories, "video")) counts.videos++;
    if (has(cls.categories, "image")) counts.images++;
    if (has(cls.categories, "audio")) counts.audio++;
    if (cls.compressible) counts.compressible++;
    if (cls.transcribable) counts.transcribable++;
    // A transcript EXISTS for this file when its `.transcription` sidecar is on disk (tracking.service).
    if (cls.transcribable && analysisOutputs(repoRoot, f.path).includes("transcript")) counts.transcribed++;
  }

  const doc = readRepoStorage(repoRoot);
  doc.repo_storage.counts = counts;
  doc.repo_storage.last_scan = {
    at: new Date().toISOString(),
    on_device: selfDeviceName(),
    headless: opts?.headless ?? false,
  };
  writeRepoStorage(repoRoot, doc);
  return doc;
}
