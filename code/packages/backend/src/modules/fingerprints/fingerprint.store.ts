// Where computed fingerprints live (perceptual_fingerprint.mdx §FD.4, apis.mdx §5).
//
// Two tiers:
//   L1 — a bounded in-process map. It makes a repeated MCP/API request for the same files instant, and it
//        keeps the cache useful on a machine with no Postgres (the app's documented `auto` fallback).
//   L2 — Postgres `perceptual_fp` (migration 0018): the durable store the product asked for. It survives
//        restarts, and the web app reads it back.
//
// VALIDITY: a stored fingerprint answers for a path only while the file still has the size and mtime it had
// when the fingerprint was computed, and the engine version still matches. A file modified after its
// fingerprint was computed has a new mtime, so the row reads as stale and the caller recomputes.
//
// Postgres failures NEVER reach a request: every call goes through tryDb(), which logs (throttled, into
// error.err) and falls back to "no row" / "not stored". The response then says `stored: false` so the
// caller knows the value was computed but not persisted.
import type { Fingerprint } from "@lfb/shared";
import { dbEnabled, q, tryDb } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";

// Bounded two ways: by entry count, and by the approximate bytes of video frame lists (a 1-hour video at
// 1 fps is ~3,600 frames ≈ 300 KB), so the memory tier can never grow into a heap problem.
const L1_MAX = 20_000;
const L1_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const FRAME_BYTES = 90; // one frame object, roughly
const l1 = new Map<string, Fingerprint>();
let l1FrameBytes = 0;

function frameBytes(fp: Fingerprint): number {
  return (fp.frames?.length ?? 0) * FRAME_BYTES;
}

/** True when `fp` still describes the file at (size, mtimeMs) and was made by `version`. */
export function isValid(fp: Fingerprint, size: number, mtimeMs: number, version: string): boolean {
  return fp.size_bytes === size && Math.abs(fp.mtime_ms - mtimeMs) < 1 && fp.algo_version === version;
}

function l1Put(fp: Fingerprint): void {
  const prev = l1.get(fp.path);
  if (prev) {
    l1.delete(fp.path); // re-insert = most recently used
    l1FrameBytes -= frameBytes(prev);
  }
  l1.set(fp.path, fp);
  l1FrameBytes += frameBytes(fp);
  while (l1.size > L1_MAX || l1FrameBytes > L1_MAX_FRAME_BYTES) {
    const oldest = l1.keys().next().value;
    if (oldest === undefined) break;
    l1FrameBytes -= frameBytes(l1.get(oldest)!);
    l1.delete(oldest);
  }
}

interface Row {
  abs_path: string;
  kind: "image" | "video";
  algo: "pdq" | "pdq-frames";
  algo_version: string;
  size_bytes: string; // bigint arrives as a string from pg
  mtime_ms: number;
  value: string;
  value_alt: string | null;
  quality: number | null;
  frame_count: number | null;
  frames: string | null;
  duration_s: number | null;
  strategy: string | null;
  compute_ms: number | null;
  computed_at: Date;
}

function fromRow(r: Row, withFrames: boolean): Fingerprint {
  return {
    path: r.abs_path,
    kind: r.kind,
    algo: r.algo,
    algo_version: r.algo_version,
    size_bytes: Number(r.size_bytes),
    mtime_ms: Number(r.mtime_ms),
    value: r.value,
    value_alt: r.value_alt ?? null,
    quality: r.quality,
    frame_count: r.frame_count,
    frames: withFrames && r.frames ? parseFrames(r.frames) : undefined,
    duration_s: r.duration_s,
    strategy: r.strategy,
    compute_ms: r.compute_ms,
    computed_at: r.computed_at.toISOString(),
  };
}

/** "n,hex,quality,ts" lines — the same text format as the videos module's .vpdq files. */
export function serializeFrames(frames: NonNullable<Fingerprint["frames"]>): string {
  return frames.map((f) => `${f.n},${f.h},${f.q},${f.ts}`).join("\n");
}

export function parseFrames(text: string): NonNullable<Fingerprint["frames"]> {
  const out: NonNullable<Fingerprint["frames"]> = [];
  for (const line of text.split("\n")) {
    const [n, h, qq, ts] = line.split(",");
    if (!h || !/^[0-9a-f]{64}$/.test(h)) continue; // a malformed line is skipped, never fatal
    out.push({ n: Number(n), h, q: Number(qq) || 0, ts: Number(ts) || 0 });
  }
  return out;
}

/**
 * The stored fingerprint for `path`, or null. L1 first, then Postgres. Does NOT judge validity — the
 * caller has the fresh stat and calls isValid().
 */
export async function getStored(path: string, withFrames: boolean): Promise<{ fp: Fingerprint; tier: "memory" | "postgres" } | null> {
  const hit = l1.get(path);
  if (hit && (!withFrames || hit.kind !== "video" || hit.frames)) return { fp: hit, tier: "memory" };
  if (!dbEnabled()) return null;
  const row = await tryDb(
    async () => (await q<Row>(`SELECT * FROM ${S}.perceptual_fp WHERE abs_path = $1`, [path]))[0] ?? null,
    null,
    "fingerprints.getStored",
  );
  if (!row) return null;
  const fp = fromRow(row, true);
  l1Put(fp);
  return { fp, tier: "postgres" };
}

/** Persist a freshly computed fingerprint. Returns whether it reached Postgres (L1 always gets it). */
export async function putStored(fp: Fingerprint): Promise<boolean> {
  l1Put(fp);
  if (!dbEnabled()) return false;
  return tryDb(
    async () => {
      await q(
        `INSERT INTO ${S}.perceptual_fp
           (abs_path, kind, algo, algo_version, size_bytes, mtime_ms, value, quality, frame_count, frames,
            duration_s, strategy, compute_ms, computed_at, value_alt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (abs_path) DO UPDATE SET
           kind = EXCLUDED.kind, algo = EXCLUDED.algo, algo_version = EXCLUDED.algo_version,
           size_bytes = EXCLUDED.size_bytes, mtime_ms = EXCLUDED.mtime_ms, value = EXCLUDED.value,
           quality = EXCLUDED.quality, frame_count = EXCLUDED.frame_count, frames = EXCLUDED.frames,
           duration_s = EXCLUDED.duration_s, strategy = EXCLUDED.strategy, compute_ms = EXCLUDED.compute_ms,
           computed_at = EXCLUDED.computed_at, value_alt = EXCLUDED.value_alt`,
        [
          fp.path,
          fp.kind,
          fp.algo,
          fp.algo_version,
          fp.size_bytes,
          fp.mtime_ms,
          fp.value,
          fp.quality,
          fp.frame_count,
          fp.frames ? serializeFrames(fp.frames) : null,
          fp.duration_s,
          fp.strategy,
          fp.compute_ms,
          fp.computed_at,
          fp.value_alt,
        ],
      );
      return true;
    },
    false,
    "fingerprints.putStored",
  );
}

/** Every stored row under a directory (prefix scan), for lookup/export of a whole tree. */
export async function listStoredUnder(dir: string, withFrames: boolean, limit: number): Promise<Fingerprint[]> {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  if (!dbEnabled()) {
    return [...l1.values()].filter((f) => f.path.startsWith(prefix)).slice(0, limit);
  }
  const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
  const rows = await tryDb(
    () => q<Row>(`SELECT * FROM ${S}.perceptual_fp WHERE abs_path LIKE $1 ORDER BY abs_path LIMIT $2`, [like, limit]),
    [] as Row[],
    "fingerprints.listStoredUnder",
  );
  return rows.map((r) => fromRow(r, withFrames));
}

/** Counts for GET /api/fingerprints/info. */
export async function storeStats(): Promise<{ postgres: boolean; rows: number | null; memory: number }> {
  if (!dbEnabled()) return { postgres: false, rows: null, memory: l1.size };
  const rows = await tryDb(
    async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.perceptual_fp`))[0]?.n ?? 0),
    null,
    "fingerprints.storeStats",
  );
  return { postgres: rows !== null, rows, memory: l1.size };
}

/** Tests only. */
export function clearMemoryTier(): void {
  l1.clear();
  l1FrameBytes = 0;
}
