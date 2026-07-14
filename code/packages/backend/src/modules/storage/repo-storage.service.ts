// `repo_storage.yaml` — the repo-WIDE settings-and-state file (repo_tracking_scheme.mdx §2). Lives at
// `<repo>/.lfbridge/repo_storage.yaml`, a git-ignored WORKING artifact (not a committed traveller). HARD
// SCHEMA RULE: the ONLY level-one key is `repo_storage:` — everything else nests below it. Written
// automatically on enlist, then updated by every scan and user action; serialized DETERMINISTICALLY
// (stable key order, no volatile timestamps beyond the recorded ones) so git-ignored diffs stay legible,
// and ATOMICALLY (temp → fsync → rename) like the decision ledger (decisions.service.ts writeLedger).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { RepoStorageDocSchema, type RepoStorageDoc } from "@lfb/shared";
import { readStorageIndex, analysisOutputs } from "./tracking.service.js";
import { resolveTrackingRoot } from "./tracking-root.service.js";
import { storageSid } from "./storage.service.js";
import { readStorageSettings } from "./storage-settings.service.js";
import { selfDeviceName } from "./devices.service.js";
import { getAppConfig } from "../store-model/config.service.js";
import {
  classifySpecial,
  type SpecialClassifyCtx,
  type SpecialCategory,
} from "../scanner/special-file.service.js";
import { log } from "../../shared/logging.js";

// ── paths + consent (same pattern as decisions.service.ts) ─────────────────────

/** WHERE this repo's tracking files live (artifact_placement_policy.mdx §3). Pre-threshold (the repo has
 *  never been transcribed/described) this is the machine-local state root — NOT `<repo>/.lfbridge/` — so
 *  `repo_storage.yaml` never churns a git working tree the user didn't opt into. Honors a relocated
 *  `.lfbridge/` and the keep-`.lfbridge/` consent (both read from the owning storage's settings). */
function trackingDir(repoRoot: string): string {
  let relocated: string | null | undefined;
  let keeps = true;
  try {
    const lf = readStorageSettings(storageSid(repoRoot)).lfbridge;
    relocated = lf.path;
    keeps = lf.enabled;
  } catch {
    /* no per-storage settings yet → defaults (keep .lfbridge/, no relocation) */
  }
  return resolveTrackingRoot(repoRoot, { relocated, keepsLfbridge: keeps });
}

function repoStoragePath(repoRoot: string): string {
  return path.join(trackingDir(repoRoot), "repo_storage.yaml");
}

/** Whether THIS computer keeps `.lfbridge/` for this repo (decisions.mdx §6 consent). Default ON. */
function keepsLfbridge(repoRoot: string): boolean {
  try {
    return readStorageSettings(storageSid(repoRoot)).lfbridge.enabled;
  } catch {
    return true; // documented default: keep .lfbridge/
  }
}

// ── read / write ───────────────────────────────────────────────────────────────

/** Read `<repo>/.lfbridge/repo_storage.yaml` (missing/corrupt → schema defaults). */
export function readRepoStorage(repoRoot: string): RepoStorageDoc {
  const file = repoStoragePath(repoRoot);
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("storage", `repo_storage read failed (using defaults): ${file}: ${(e as Error).message}`);
    }
    parsed = {};
  }
  const result = RepoStorageDocSchema.safeParse(parsed);
  if (!result.success) {
    log.warn("storage", `repo_storage schema mismatch (using defaults): ${file}: ${result.error.message}`);
    return RepoStorageDocSchema.parse({ repo_storage: {} });
  }
  return result.data;
}

/**
 * Write `repo_storage.yaml` deterministically + atomically (single `repo_storage:` root key). Gated on the
 * keep-`.lfbridge/` consent — with consent OFF, writes NOTHING into the repo root (decisions.mdx §6).
 */
export function writeRepoStorage(repoRoot: string, doc: RepoStorageDoc): void {
  if (!keepsLfbridge(repoRoot)) return; // consent off → never touch the repo root
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
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    log.error("storage", `repo_storage write failed: ${file}: ${(e as Error).message}`);
    throw e;
  }
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
