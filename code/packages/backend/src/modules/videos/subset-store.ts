// subsets.csv + subset_run.yaml — the subset scan's durable output (subsets.mdx §9, LOCKED). One row
// per member; rows sharing a `subset_group` form one group, and EXACTLY ONE row per group carries
// `role: superset`. Rewritten whole each run (atomic temp + rename). The run stamp drives the §5
// staleness clock — its OWN clock, never satisfied by the duplicate scan's (videos.mdx §4).
import fs from "node:fs";
import path from "node:path";
import type { SubsetMatchBasis, SubsetRole } from "@lfb/shared";
import { videosDir, writeFileAtomic } from "./paths.js";
import { csvLine, parseCsv, numOrNull } from "./csv.js";
import { writeRunStamp, readRunStamp, type VideosRunStamp } from "./dedupe-store.js";
import { log } from "../../shared/logging.js";

/** One subsets.csv row — the §9 column set exactly. */
export interface SubsetCsvRow {
  group: string; // subset_group
  fullPath: string;
  role: SubsetRole;
  sha256: string;
  fingerprint: string; // relative reference to the cached MPEG-7 signature (§7.4)
  matchBasis: SubsetMatchBasis;
  startOffsetS: number | null; // subset rows only — superset-time containment start
  endOffsetS: number | null;
  confidence: number;
  sizeBytes: number;
  durationS: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  detectedAt: string;
}

const HEADER = [
  "subset_group",
  "full_path",
  "role",
  "sha256",
  "fingerprint",
  "match_basis",
  "start_offset_s",
  "end_offset_s",
  "confidence",
  "size_bytes",
  "duration_s",
  "width",
  "height",
  "codec",
  "detected_at",
] as const;

export function subsetsCsvPath(): string {
  return path.join(videosDir(), "subsets.csv");
}

export function subsetRunStampPath(): string {
  return path.join(videosDir(), "subset_run.yaml");
}

/** Rewrite subsets.csv whole, atomically (§9). */
export function writeSubsetsCsv(rows: SubsetCsvRow[]): void {
  const lines = [csvLine([...HEADER])];
  for (const r of rows) {
    lines.push(
      csvLine([
        r.group,
        r.fullPath,
        r.role,
        r.sha256,
        r.fingerprint,
        r.matchBasis,
        r.startOffsetS,
        r.endOffsetS,
        r.confidence,
        r.sizeBytes,
        r.durationS,
        r.width,
        r.height,
        r.codec,
        r.detectedAt,
      ]),
    );
  }
  writeFileAtomic(subsetsCsvPath(), lines.join("\n") + "\n");
}

/** Read subsets.csv (missing → empty; malformed rows skipped). */
export function readSubsetsCsv(): SubsetCsvRow[] {
  let text: string;
  try {
    text = fs.readFileSync(subsetsCsvPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("videos", `subsets.csv unreadable: ${(e as Error).message}`);
    }
    return [];
  }
  const rows = parseCsv(text);
  const out: SubsetCsvRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i];
    if (f.length < HEADER.length) continue;
    const role = f[2] === "superset" || f[2] === "subset" ? (f[2] as SubsetRole) : null;
    const basis = f[5] === "mpeg7" || f[5] === "vpdq" ? (f[5] as SubsetMatchBasis) : null;
    if (!f[0] || !f[1] || !role || !basis) continue;
    out.push({
      group: f[0],
      fullPath: f[1],
      role,
      sha256: f[3],
      fingerprint: f[4],
      matchBasis: basis,
      startOffsetS: numOrNull(f[6]),
      endOffsetS: numOrNull(f[7]),
      confidence: numOrNull(f[8]) ?? 0,
      sizeBytes: numOrNull(f[9]) ?? 0,
      durationS: numOrNull(f[10]),
      width: numOrNull(f[11]),
      height: numOrNull(f[12]),
      codec: f[13] || null,
      detectedAt: f[14] ?? "",
    });
  }
  return out;
}

export function writeSubsetRunStamp(stamp: VideosRunStamp): void {
  writeRunStamp(subsetRunStampPath(), stamp);
}

export function readSubsetRunStamp(): VideosRunStamp | null {
  return readRunStamp(subsetRunStampPath());
}
