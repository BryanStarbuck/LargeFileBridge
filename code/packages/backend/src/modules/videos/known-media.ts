// Candidate enumeration + icon-state enrichment for the Videos feature.
//
// CANDIDATE SET (duplicates.mdx §8.1): "all video and image files LFB knows on this computer — every
// scanned unit". We deliberately REUSE the existing enumerations instead of re-walking the disk
// (the walk already happened — scan.mdx):
//   • repo units — the per-unit status.yaml candidate rows, composed through the SAME
//     computeRepoDetail() row model the UI and files-query trust (decision, git-ignore, task statuses
//     ride along for free);
//   • directory storages (personal/company) — the SDL fingerprint index rows (readStorageIndex).
//
// ICON-STATE ENRICHMENT (tables.mdx §4c): the same pass hands back the per-file fields the review
// tables' leading icon columns need — decision, gitIgnored, hasTranscription/Description/Ocr — reusing
// the backend-computed FileRow verdicts (never re-derived here). For storage-index files only the
// analysis flags exist; the rest default to null/false (best-effort by design).
import fsp from "node:fs/promises";
import path from "node:path";
import { mediaKindForName } from "@lfb/shared";
import type { FileRow, IpfsHealth, MediaKind } from "@lfb/shared";
import { listRepoFolders, getRepoConfig, computeRepoDetail } from "../store-model/units.service.js";
import { listStoragesPage } from "../storage/storage.service.js";
import { readStorageIndex } from "../storage/tracking.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { collectFilesRecursive } from "../../shared/fs-walk.js";
import { HARD_SKIP, isMacPackageDir } from "../../shared/scan-filters.js";
import { log } from "../../shared/logging.js";

/** The icon-control-column state for one file (shared/videos.ts row fields). */
export interface IconState {
  decision: string | null;
  gitIgnored: boolean;
  hasTranscription: boolean;
  hasDescription: boolean;
  hasOcr: boolean;
}

export const EMPTY_ICON_STATE: IconState = {
  decision: null,
  gitIgnored: false,
  hasTranscription: false,
  hasDescription: false,
  hasOcr: false,
};

export interface KnownMediaFile {
  abs: string;
  sizeBytes: number;
  kind: MediaKind; // "video" | "image" (audio is out of scope for v1 — videos.mdx §2)
  icon: IconState;
}

function expandHome(p: string): string {
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

function iconStateFromRow(row: FileRow): IconState {
  return {
    decision: row.decision ?? null,
    gitIgnored: row.gitignore === true,
    hasTranscription: row.transcribe === "done",
    hasDescription: row.describe === "done",
    hasOcr: row.ocr === "done",
  };
}

export interface CollectMediaOpts {
  /**
   * Also sweep every unit root on DISK for media files the persisted rows do not know yet
   * (duplicates.mdx §8.4 — candidate freshness).
   *
   * THE BUG THIS FIXES: the persisted rows below are the last repo SCAN's census. A file copied in
   * after that scan — the exact "I just duplicated a file, now find it" case — is simply absent, so
   * the duplicate engine never had both copies in hand and could not possibly group them. The Start
   * Scan button promised a fresh answer and silently computed over a stale candidate set.
   *
   * The sweep is media-extension-only (no git check-ignore, no sidecar reads — the two dominant
   * per-file costs of a real scan), async and cooperatively yielding, so it is a small fraction of a
   * full repo scan. Freshly discovered files get default icon state: they are real candidates that
   * have not been scanned yet, and a blank icon is honest.
   */
  freshen?: boolean;
}

/**
 * Every video/image file LFB already knows on this computer, with its icon state. Remote-only rows are
 * excluded (no local bytes to hash or preview). Never throws — a unit whose composition fails is logged
 * and skipped, so one bad repo cannot blank the whole feature.
 *
 * With `freshen`, the persisted census is unioned with a live media sweep of the same roots (§8.4).
 */
export async function collectKnownMedia(
  kinds: ReadonlySet<MediaKind>,
  opts: CollectMediaOpts = {},
): Promise<KnownMediaFile[]> {
  const byAbs = new Map<string, KnownMediaFile>();
  const roots = new Set<string>();

  // Live IPFS health fetched once — computeRepoDetail requires it (same pattern as files-query; a down
  // node degrades pin detail we do not use here anyway).
  let health: IpfsHealth = "unreachable";
  try {
    health = await ipfs.health();
  } catch (e) {
    log.debug("videos", `ipfs health probe failed (continuing): ${(e as Error).message}`);
  }

  for (const folder of listRepoFolders()) {
    try {
      const cfg = getRepoConfig(folder);
      if (!cfg.repo.path) continue;
      const root = expandHome(cfg.repo.path);
      roots.add(root);
      const rows = computeRepoDetail(folder, health).files;
      for (const row of rows) {
        if (row.presence === "remote-only") continue;
        const kind = mediaKindForName(row.path);
        if (!kind || !kinds.has(kind)) continue;
        const abs = path.join(root, row.path);
        byAbs.set(abs, { abs, sizeBytes: row.sizeBytes, kind, icon: iconStateFromRow(row) });
      }
    } catch (e) {
      log.warn("videos", `candidate enumeration failed for repo ${folder}: ${(e as Error).message}`);
    }
  }

  // Directory storages (personal/company) — the SDL index rows. Only analysis flags are known here.
  try {
    const page = listStoragesPage();
    const sdlRows = [page.personal, ...page.companies].filter(
      (r): r is NonNullable<typeof r> => r !== null && r.root !== "" && r.hasLfbridge,
    );
    for (const storage of sdlRows) {
      const root = expandHome(storage.root);
      roots.add(root);
      try {
        for (const f of readStorageIndex(root, storage.type)) {
          const kind = mediaKindForName(f.path);
          if (!kind || !kinds.has(kind)) continue;
          const abs = path.join(root, f.path);
          if (byAbs.has(abs)) continue; // a repo row already carries richer state
          byAbs.set(abs, {
            abs,
            sizeBytes: f.sizeBytes,
            kind,
            icon: {
              ...EMPTY_ICON_STATE,
              hasTranscription: f.analysis.includes("transcript"),
              hasDescription: f.analysis.includes("description"),
              hasOcr: f.analysis.includes("ocr"),
            },
          });
        }
      } catch (e) {
        log.warn("videos", `candidate enumeration failed for storage ${root}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    log.warn("videos", `storage enumeration skipped: ${(e as Error).message}`);
  }

  if (opts.freshen) await freshenFromDisk(byAbs, roots, kinds);

  return [...byAbs.values()];
}

/** Directories a media sweep must never descend into — the house skip set plus our own artifact homes. */
const SWEEP_SKIP = new Set([...HARD_SKIP, ".lfbridge", ".transcribe"]);

/**
 * Union the persisted census with a live media sweep of the same roots (duplicates.mdx §8.4). Only files
 * MISSING from `byAbs` are stat'ed, so a warm tree costs one readdir per directory and nothing else.
 * Never throws — an unreadable root contributes nothing and the scan proceeds on the persisted rows.
 */
export async function freshenFromDisk(
  byAbs: Map<string, KnownMediaFile>,
  roots: ReadonlySet<string>,
  kinds: ReadonlySet<MediaKind>,
): Promise<void> {
  const t0 = Date.now();
  let added = 0;
  for (const root of roots) {
    try {
      const found = await collectFilesRecursive(
        root,
        (name) => {
          const kind = mediaKindForName(name);
          return kind !== null && kinds.has(kind);
        },
        SWEEP_SKIP,
        { skipDir: isMacPackageDir },
      );
      for (const abs of found) {
        if (byAbs.has(abs)) continue; // the persisted row is richer — never downgrade it
        const kind = mediaKindForName(abs);
        if (!kind || !kinds.has(kind)) continue;
        try {
          const st = await fsp.stat(abs);
          if (!st.isFile()) continue;
          byAbs.set(abs, { abs, sizeBytes: st.size, kind, icon: { ...EMPTY_ICON_STATE } });
          added += 1;
        } catch {
          // Vanished between readdir and stat — not a candidate, not an error.
        }
      }
    } catch (e) {
      log.warn("videos", `media sweep failed for ${root}: ${(e as Error).message}`);
    }
  }
  log.info(
    "videos",
    `candidate freshen: ${added} media file(s) found on disk that the last repo scan did not know, ` +
      `across ${roots.size} root(s) in ${Math.round((Date.now() - t0) / 1000)}s`,
  );
}

/**
 * Best-effort icon-state lookup for the LIST endpoints: abs path → IconState. Built from the same
 * enumeration; on any failure returns an empty map so the list renders with cheap defaults rather
 * than blocking (the endpoints must stay light — duplicates.mdx §3.2 reads only the CSV).
 *
 * TTL-cached and single-flight: the enumeration composes every repo's row model (sidecar reads +
 * git check-ignore — the dominant walk cost), which must not run per request. Icon state is a
 * nicety, so a 30 s stale view is fine; concurrent requests share one in-flight build.
 */
const ICON_INDEX_TTL_MS = 30_000;
let iconIndexCache: { at: number; index: Map<string, IconState> } | null = null;
let iconIndexInFlight: Promise<Map<string, IconState>> | null = null;

export function buildIconStateIndex(): Promise<Map<string, IconState>> {
  if (iconIndexCache && Date.now() - iconIndexCache.at < ICON_INDEX_TTL_MS) {
    return Promise.resolve(iconIndexCache.index);
  }
  if (iconIndexInFlight) return iconIndexInFlight;
  iconIndexInFlight = (async () => {
    try {
      const files = await collectKnownMedia(new Set<MediaKind>(["video", "image"]));
      const index = new Map(files.map((f) => [f.abs, f.icon]));
      iconIndexCache = { at: Date.now(), index };
      return index;
    } catch (e) {
      log.warn("videos", `icon-state index unavailable (rows get defaults): ${(e as Error).message}`);
      return new Map<string, IconState>();
    } finally {
      iconIndexInFlight = null;
    }
  })();
  return iconIndexInFlight;
}
