// duplicates.csv + dedupe_run.yaml — the duplicate scan's durable output (duplicates.mdx §9, LOCKED).
// One row per MEMBER file; rows sharing a `duplicate_group` id form one group. The CSV is REWRITTEN
// WHOLE each run (atomic temp + rename) — a computed artifact, not an append log. The run stamp drives
// the §5 4-day staleness clock, INDEPENDENT of the subset scan's stamp (videos.mdx §4).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { DedupeMatchBasis } from "@lfb/shared";
import { videosDir, writeFileAtomic } from "./paths.js";
import { csvLine, parseCsv, numOrNull } from "./csv.js";
import { log } from "../../shared/logging.js";

/** One duplicates.csv row — the §9 column set exactly. */
export interface DuplicateCsvRow {
  group: string; // duplicate_group — short hash shared by all members
  fullPath: string;
  sha256: string;
  fingerprint: string; // images: 64-hex inline; videos: relative `.vpdq` reference (§7.7)
  matchBasis: DedupeMatchBasis;
  sizeBytes: number;
  durationS: number | null; // null (empty cell) for images
  width: number | null;
  height: number | null;
  codec: string | null;
  detectedAt: string; // ISO
}

const HEADER = [
  "duplicate_group",
  "full_path",
  "sha256",
  "fingerprint",
  "match_basis",
  "size_bytes",
  "duration_s",
  "width",
  "height",
  "codec",
  "detected_at",
] as const;

export function duplicatesCsvPath(): string {
  return path.join(videosDir(), "duplicates.csv");
}

export function dedupeRunStampPath(): string {
  return path.join(videosDir(), "dedupe_run.yaml");
}

/** Rewrite duplicates.csv whole, atomically (§9). */
export function writeDuplicatesCsv(rows: DuplicateCsvRow[]): void {
  const lines = [csvLine([...HEADER])];
  for (const r of rows) {
    lines.push(
      csvLine([
        r.group,
        r.fullPath,
        r.sha256,
        r.fingerprint,
        r.matchBasis,
        r.sizeBytes,
        r.durationS,
        r.width,
        r.height,
        r.codec,
        r.detectedAt,
      ]),
    );
  }
  writeFileAtomic(duplicatesCsvPath(), lines.join("\n") + "\n");
}

/** Read duplicates.csv (missing file → empty; malformed rows skipped, never fatal). */
export function readDuplicatesCsv(): DuplicateCsvRow[] {
  let text: string;
  try {
    text = fs.readFileSync(duplicatesCsvPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("videos", `duplicates.csv unreadable: ${(e as Error).message}`);
    }
    return [];
  }
  const rows = parseCsv(text);
  const out: DuplicateCsvRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i];
    if (f.length < HEADER.length) continue;
    const basis = f[4] === "sha256" || f[4] === "fingerprint" ? (f[4] as DedupeMatchBasis) : null;
    if (!f[0] || !f[1] || !basis) continue;
    out.push({
      group: f[0],
      fullPath: f[1],
      sha256: f[2],
      fingerprint: f[3],
      matchBasis: basis,
      sizeBytes: numOrNull(f[5]) ?? 0,
      durationS: numOrNull(f[6]),
      width: numOrNull(f[7]),
      height: numOrNull(f[8]),
      codec: f[9] || null,
      detectedAt: f[10] ?? "",
    });
  }
  return out;
}

// ── the run stamp (§5 staleness + §9) ─────────────────────────────────────────────────────────────────

export interface VideosRunStamp {
  lastRunAt: string; // ISO of the last run that PUBLISHED results (partial or complete)
  ok: boolean;
  counts: Record<string, number>;
  durationMs: number;
  /**
   * False for a PARTIAL publish — the engine published what one phase produced and is still working
   * (or was killed before the next phase finished). The staleness check keeps recommending a rescan
   * until a run reaches completion (duplicates.mdx §8.3/§8.5). Absent in stamps written before this
   * field existed, which read as complete — the old writer only ever stamped at the very end.
   */
  complete: boolean;
  /** The phase this stamp was written at: "hash" (partial) or "fingerprint" (the full run). */
  phase?: string;
}

export function writeRunStamp(file: string, stamp: VideosRunStamp): void {
  writeFileAtomic(
    file,
    YAML.stringify({
      schema_version: 1,
      last_run_at: stamp.lastRunAt,
      ok: stamp.ok,
      complete: stamp.complete,
      ...(stamp.phase ? { phase: stamp.phase } : {}),
      counts: stamp.counts,
      duration_ms: stamp.durationMs,
    }),
  );
}

export function readRunStamp(file: string): VideosRunStamp | null {
  try {
    const doc = YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> | null;
    if (!doc || typeof doc.last_run_at !== "string") return null;
    return {
      lastRunAt: doc.last_run_at,
      ok: doc.ok !== false,
      // Absent → complete: stamps written before progressive publishing existed were only ever
      // written at the very end of a finished run.
      complete: doc.complete !== false,
      ...(typeof doc.phase === "string" ? { phase: doc.phase } : {}),
      counts: (doc.counts as Record<string, number>) ?? {},
      durationMs: Number(doc.duration_ms ?? 0),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("videos", `run stamp unreadable (${path.basename(file)}): ${(e as Error).message}`);
    }
    return null;
  }
}

export function writeDedupeRunStamp(stamp: VideosRunStamp): void {
  writeRunStamp(dedupeRunStampPath(), stamp);
}

export function readDedupeRunStamp(): VideosRunStamp | null {
  return readRunStamp(dedupeRunStampPath());
}
