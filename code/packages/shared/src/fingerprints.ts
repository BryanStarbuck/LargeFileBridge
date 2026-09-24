// The perceptual-fingerprint API contract (apis.mdx §4–§7, perceptual_fingerprint.mdx §FD). Shared by the
// backend router, the web app, and (by copy of the JSON shape) the MCP server and the CLI.
import { z } from "zod";

/** Image: one 256-bit PDQ hash. Video: PDQ per sampled frame. */
export type FingerprintAlgo = "pdq" | "pdq-frames";
export type FingerprintKind = "image" | "video";

export interface FingerprintFrame {
  n: number; // 0-based sample index
  h: string; // 64-hex PDQ of the frame
  q: number; // PDQ quality 0..100
  ts: number; // seconds into the video
}

export interface Fingerprint {
  path: string;
  kind: FingerprintKind;
  algo: FingerprintAlgo;
  /** The engine that produced it (the sidecar's `--version`). A version change makes every row stale. */
  algo_version: string;
  size_bytes: number;
  mtime_ms: number;
  /** 64 hex. For a video: the hash of its highest-quality frame (a compact representative). For an image with
   *  transparency: the hash with see-through pixels shown on WHITE. */
  value: string;
  /** Images with ≥0.5% see-through pixels only: the hash with them shown on BLACK (a second tool's JPEG
   *  export of the same PNG). Match against the nearer of value / value_alt. Null otherwise. */
  value_alt: string | null;
  quality: number | null;
  frame_count: number | null;
  /** Video only, and only when the caller asked for frames. */
  frames?: FingerprintFrame[];
  duration_s: number | null;
  /** Video only: which decode plan produced the frames (videotoolbox-keyframes | software-keyframes | software-full). */
  strategy: string | null;
  compute_ms: number | null;
  computed_at: string;
}

/** Where an answer came from: freshly computed, or a still-valid stored value. */
export type FingerprintSource = "computed" | "memory" | "postgres";

export interface FingerprintResult {
  path: string;
  ok: boolean;
  fingerprint?: Fingerprint;
  source?: FingerprintSource;
  /** False when the value was computed but could not be written to Postgres (no database, or it failed). */
  stored?: boolean;
  /** When ok is false: a stable code plus a human message. */
  code?: FingerprintErrorCode;
  error?: string;
}

export type FingerprintErrorCode =
  | "not_found"
  | "not_a_file"
  | "not_media"
  | "too_large"
  | "decode_failed"
  | "ffmpeg_missing"
  | "pdq_unavailable"
  | "timeout"
  | "cancelled"
  | "internal";

export type FingerprintJobStatus = "queued" | "running" | "done" | "cancelled" | "failed";

export interface FingerprintJob {
  id: string;
  status: FingerprintJobStatus;
  /** What was asked: an explicit path list, or a directory walk. */
  scope: { kind: "paths"; count: number } | { kind: "directory"; dir: string; recursive: boolean };
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Files discovered so far (a directory walk grows this while it runs). */
  total: number;
  /** Still walking the directory; `total` is not final yet. */
  discovering: boolean;
  done: number;
  ok: number;
  failed: number;
  /** Answered from a valid stored value (no recompute). */
  cached: number;
  images: number;
  videos: number;
  elapsed_ms: number;
  /** A rough remaining-time estimate, or null while there is not enough signal. */
  eta_ms: number | null;
  /** Set when the whole job failed (not a per-file failure). */
  error: string | null;
  /** Absolute path of the CSV export, once one has been written. */
  csv_path: string | null;
}

// ── request bodies ──────────────────────────────────────────────────────────

/** Wait budget for the hybrid sync/async contract (apis.mdx §6.2). */
export const FINGERPRINT_WAIT_MS_DEFAULT = 20_000;
export const FINGERPRINT_WAIT_MS_MAX = 55_000;
export const FINGERPRINT_MAX_PATHS = 5_000;
export const FINGERPRINT_MAX_DIR_FILES_DEFAULT = 50_000;
export const FINGERPRINT_MAX_DIR_FILES_MAX = 500_000;

const absPath = z
  .string()
  .min(1)
  .refine((p) => p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:[\\/]/.test(p), "must be an absolute path");

export const FingerprintComputeBodySchema = z.object({
  paths: z.array(absPath).min(1).max(FINGERPRINT_MAX_PATHS),
  /** Recompute even when a valid stored value exists. */
  force: z.boolean().optional(),
  /** Include each video's frame list in the results. */
  include_frames: z.boolean().optional(),
  /** How long the call may block before handing back a job to poll (0 = return the job at once). */
  wait_ms: z.number().int().min(0).max(FINGERPRINT_WAIT_MS_MAX).optional(),
});
export type FingerprintComputeBody = z.infer<typeof FingerprintComputeBodySchema>;

export const FingerprintScanBodySchema = z.object({
  dir: absPath,
  recursive: z.boolean().optional(),
  kinds: z.array(z.enum(["image", "video"])).min(1).optional(),
  force: z.boolean().optional(),
  include_frames: z.boolean().optional(),
  max_files: z.number().int().min(1).max(FINGERPRINT_MAX_DIR_FILES_MAX).optional(),
  wait_ms: z.number().int().min(0).max(FINGERPRINT_WAIT_MS_MAX).optional(),
});
export type FingerprintScanBody = z.infer<typeof FingerprintScanBodySchema>;

export const FingerprintCompareBodySchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  /** Stricter Hamming threshold (24 instead of 32 bits). */
  strict: z.boolean().optional(),
});
export type FingerprintCompareBody = z.infer<typeof FingerprintCompareBodySchema>;

export interface FingerprintCompareResult {
  a: { path: string | null; kind: FingerprintKind | "hash" };
  b: { path: string | null; kind: FingerprintKind | "hash" };
  /** Hamming distance between the two representative 256-bit values (0 = identical). */
  distance: number;
  threshold: number;
  same_content: boolean;
  /** Video↔video only: the fraction of frames matched both ways (duplicate evidence). */
  shared_fraction?: number;
  /** Video↔video only: the longest contiguous matched run (subset evidence). */
  longest_run?: {
    frames: number;
    /** Which side is the shorter video (the candidate subset). */
    shorter: "a" | "b";
    shorter_start_s: number;
    longer_start_s: number;
    longer_end_s: number;
    /** Matched run / the shorter video's span, 0..1. */
    coverage: number;
  } | null;
  note: string;
}

/** The per-job HTTP envelope for compute/scan/status (apis.mdx §6). */
export interface FingerprintJobResponse {
  job: FingerprintJob;
  /** Results in completion order; paged via offset/limit on GET /jobs/:id. */
  results: FingerprintResult[];
  results_offset: number;
  results_total: number;
  /** True when the call returned before the job finished — poll GET /api/fingerprints/jobs/:id. */
  pending: boolean;
}

/** Image match thresholds over 256-bit PDQ (perceptual_fingerprint.mdx §4; PDQ reference: ≤31 bits). */
export const PDQ_MATCH_THRESHOLD = 32;
export const PDQ_MATCH_THRESHOLD_STRICT = 24;
/** PDQ quality below this is too flat to trust for automatic matching (PDQ reference recommends 50). */
export const PDQ_QUALITY_FLOOR = 50;
