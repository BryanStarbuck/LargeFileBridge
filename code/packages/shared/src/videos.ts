// Videos feature contract — Duplicates & Subsets review screens (pm/videos.mdx,
// pm/duplicates.mdx, pm/subsets.mdx). Shared between the backend routers under
// /api/videos/* and the frontend pages under /videos/*.

/** How a duplicate group was formed (duplicates.mdx §2). */
export type DedupeMatchBasis = "sha256" | "fingerprint";

/** One member file of a duplicate group — one CSV row (duplicates.mdx §9). */
export interface DuplicateMemberRow {
  /** Unique group id; all members of one group share it. */
  group: string;
  matchBasis: DedupeMatchBasis;
  fullPath: string;
  /** Basename only — the File column shows the name without its path (duplicates.mdx §3.1). */
  name: string;
  sizeBytes: number;
  /** Video duration in seconds; null for images. */
  durationS: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  sha256: string;
  /** Text-encoded fingerprint: images = 64-hex inline; videos = relative .vpdq reference (duplicates.mdx §7.7). */
  fingerprint: string;
  detectedAt: string;
  /** Icon-control-column state, best-effort from existing tracking state (tables.mdx §4c). */
  decision: string | null;
  gitIgnored: boolean;
  hasTranscription: boolean;
  hasDescription: boolean;
  hasOcr: boolean;
}

export interface DuplicatesListResponse {
  rows: DuplicateMemberRow[];
  groupCount: number;
  fileCount: number;
}

export type SubsetRole = "superset" | "subset";
export type SubsetMatchBasis = "mpeg7" | "vpdq";

/** One member file of a subset group — one CSV row (subsets.mdx §9). */
export interface SubsetMemberRow {
  group: string;
  /** Exactly one superset per group. */
  role: SubsetRole;
  fullPath: string;
  name: string;
  sizeBytes: number;
  durationS: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  sha256: string;
  /** Reference to the cached MPEG-7 signature file (subsets.mdx §7.4). */
  fingerprint: string;
  matchBasis: SubsetMatchBasis;
  /** Containment range in SUPERSET time — subset rows only, null on the superset row. */
  startOffsetS: number | null;
  endOffsetS: number | null;
  confidence: number;
  detectedAt: string;
  decision: string | null;
  gitIgnored: boolean;
  hasTranscription: boolean;
  hasDescription: boolean;
  hasOcr: boolean;
}

export interface SubsetsListResponse {
  rows: SubsetMemberRow[];
  groupCount: number;
  fileCount: number;
}

/** Staleness status for one of the two dedicated scans (duplicates.mdx §5, subsets.mdx §5). */
export interface VideosScanStatus {
  /** ISO datetime of the last COMPLETED run, or null if never run. */
  lastRunAt: string | null;
  running: boolean;
  /** True when never run or lastRunAt is VIDEOS_SCAN_STALE_DAYS+ old — opens the Start-Scan pop-up. */
  recommend: boolean;
}

/** The 4-day staleness recommendation window (duplicates.mdx §5). */
export const VIDEOS_SCAN_STALE_DAYS = 4;

/**
 * Known common resolution classes (duplicates.mdx §4.4, LOCKED): the parenthesized
 * class is appended ONLY when dimensions snap to one of these (±8 px per axis;
 * portrait matches by the transposed dimensions).
 */
const RESOLUTION_CLASSES: Array<{ w: number; h: number; label: string }> = [
  { w: 640, h: 480, label: "480p" },
  { w: 854, h: 480, label: "480p" },
  { w: 1280, h: 720, label: "720p" },
  { w: 1920, h: 1080, label: "1080p" },
  { w: 2048, h: 1080, label: "2K" },
  { w: 2560, h: 1440, label: "1440p" },
  { w: 3840, h: 2160, label: "4K" },
  { w: 4096, h: 2160, label: "4K" },
];

const SNAP_TOLERANCE_PX = 8;

/** "1280x720 (720p)" for known classes; bare "1442x1080" otherwise (duplicates.mdx §4.4). */
export function resolutionLabel(width: number, height: number): string {
  const bare = `${width}x${height}`;
  const [lw, lh] = width >= height ? [width, height] : [height, width];
  for (const c of RESOLUTION_CLASSES) {
    if (Math.abs(lw - c.w) <= SNAP_TOLERANCE_PX && Math.abs(lh - c.h) <= SNAP_TOLERANCE_PX) {
      return `${bare} (${c.label})`;
    }
  }
  return bare;
}

/** "codec (h264)" — the codec value in parentheses after the word codec (duplicates.mdx §4.5). */
export function codecLabel(codec: string): string {
  return `codec (${codec.toLowerCase()})`;
}
