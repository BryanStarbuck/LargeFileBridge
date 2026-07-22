// vPDQ-style per-frame perceptual fingerprints for VIDEOS (duplicates.mdx §7.4/§7.8, subsets.mdx §7.2
// cross-check). The vPDQ shape: sample frames with the local ffmpeg, fingerprint each frame with the
// SAME image primitive the platform already ships (modules/media/perceptual.service.ts —
// fingerprintImage / hammingDistance), and keep the ORDERED list as plain text lines
//
//   frame_number,hex,quality,timestamp
//
// — the native vPDQ output format, already CSV-shaped (§7.3). The list is cached at
// `<state root>/videos/vpdq/<sha256>.vpdq`, keyed by CONTENT hash so a re-encode is stale by
// construction (§7.6). All later comparisons are pure functions over two STORED frame lists — media
// bytes are never re-read to compare (§7.8):
//
//   • symmetricSharedFraction — duplicates: the fraction of frames matching in BOTH directions; a high
//     symmetric bar is what distinguishes a duplicate from a mere subset.
//   • longestSharedRun — subsets: the longest CONTIGUOUS run of subset frames Hamming-matching
//     consecutive superset frames; its position independently corroborates the MPEG-7 offset.
//
// Everything is local: ffmpeg by name on PATH for frame extraction, sharp+blockhash for the hashes.
// No network, ever (charter; perceptual_fingerprint.mdx §6).
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fingerprintImage, hammingDistance } from "../media/perceptual.service.js";
import { runAsync, toolOnPath } from "./exec.js";
import { vpdqDir, writeFileAtomic } from "./paths.js";
import { log } from "../../shared/logging.js";

export interface VpdqFrame {
  n: number; // output frame index (0-based)
  hex: string; // 64-hex 256-bit frame fingerprint
  quality: number; // 0..100 luminance-spread proxy (perceptual.service.ts)
  ts: number; // seconds into the clip
}

// Sampling: ~1 fps like the duplicate fingerprint (§7.5), stretched for long inputs so the list stays
// bounded — a 2 h movie samples one frame every ~12 s instead of producing 7,200 lines.
const VPDQ_FPS = 1;
const VPDQ_MAX_FRAMES = 600;

// Matching (§7.8): the image Hamming threshold over 256-bit hashes; frames below the quality floor are
// junk (black/flat) and never participate in automatic matching. Mirrors perceptual.service.ts §4.
const FRAME_MATCH_THRESHOLD = 32;
const QUALITY_FLOOR = 8;

/** The cached frame-list path for a content hash — what the duplicates.csv `fingerprint` column
 *  references, RELATIVE to the videos dir: `vpdq/<sha256>.vpdq` (duplicates.mdx §7.7). */
export function vpdqRelRef(sha256: string): string {
  return `vpdq/${sha256}.vpdq`;
}

export function vpdqAbsPath(sha256: string): string {
  return path.join(vpdqDir(), `${sha256}.vpdq`);
}

/** Serialize frames to the text-line format. */
export function serializeVpdq(frames: VpdqFrame[]): string {
  return frames.map((f) => `${f.n},${f.hex},${f.quality},${f.ts.toFixed(2)}`).join("\n") + (frames.length ? "\n" : "");
}

/** Parse stored lines, tolerantly — a malformed line is skipped, never fatal. */
export function parseVpdq(text: string): VpdqFrame[] {
  const out: VpdqFrame[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(",");
    if (parts.length < 4) continue;
    const n = Number(parts[0]);
    const hex = parts[1].trim().toLowerCase();
    const quality = Number(parts[2]);
    const ts = Number(parts[3]);
    if (!Number.isFinite(n) || !/^[0-9a-f]{16,}$/.test(hex) || !Number.isFinite(ts)) continue;
    out.push({ n, hex, quality: Number.isFinite(quality) ? quality : 0, ts });
  }
  return out;
}

/** Read a cached frame list for a content hash, or null. */
export function readVpdq(sha256: string): VpdqFrame[] | null {
  try {
    return parseVpdq(fs.readFileSync(vpdqAbsPath(sha256), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The frame list for a video — cached by sha256, computed only when missing (§7.6: only inside the
 * dedicated scans, only for missing/stale files). Extraction is ONE sequential ffmpeg pass (`-vf fps=`),
 * async; each frame is fingerprinted BY PATH through the existing bounded image pipeline.
 */
export async function ensureVpdqFrames(abs: string, sha256: string, durationS: number | null): Promise<VpdqFrame[]> {
  const cached = readVpdq(sha256);
  if (cached && cached.length > 0) return cached;
  if (!toolOnPath("ffmpeg")) throw new Error("ffmpeg not installed — install it (brew install ffmpeg) to fingerprint video frames");

  // Stretch the sampling rate so long inputs stay bounded; the timestamps carry the real spacing.
  let fps = VPDQ_FPS;
  if (durationS && durationS * fps > VPDQ_MAX_FRAMES) fps = VPDQ_MAX_FRAMES / durationS;

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lfb-vpdq-"));
  try {
    const outPattern = path.join(workDir, "f_%05d.jpg");
    // Downscale IN the extraction (the hash decodes at ≤512 px anyway — ocr/frames.ts rule 2), strip
    // audio, JPEG frames (ephemeral — PNG would be needless CPU + disk).
    const r = await runAsync(
      "ffmpeg",
      [
        "-nostdin", "-loglevel", "error",
        "-i", abs, "-an",
        "-vf", `fps=${fps},scale='min(512,iw)':-2`,
        "-frames:v", String(VPDQ_MAX_FRAMES),
        "-q:v", "4",
        "-y", outPattern,
      ],
      `vpdq:${abs}`,
      { timeoutMs: 15 * 60 * 1000 },
    );
    if (r.code !== 0) {
      throw new Error(`ffmpeg frame sampling failed (code ${r.code}): ${r.stderr.slice(-300)}`);
    }
    const files = (await fsp.readdir(workDir)).filter((f) => f.endsWith(".jpg")).sort();
    if (files.length === 0) throw new Error("ffmpeg produced no frames");
    const frames: VpdqFrame[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const fp = await fingerprintImage(path.join(workDir, files[i]));
        frames.push({ n: i, hex: fp.value, quality: fp.quality ?? 0, ts: i / fps });
      } catch (e) {
        log.debug("videos", `vpdq: frame ${i} of ${abs} skipped: ${(e as Error).message}`);
      }
    }
    if (frames.length === 0) throw new Error("no frame could be fingerprinted");
    writeFileAtomic(vpdqAbsPath(sha256), serializeVpdq(frames));
    return frames;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── stored-value matchers (§7.8) ──────────────────────────────────────────────────────────────────────

function usable(frames: VpdqFrame[]): VpdqFrame[] {
  return frames.filter((f) => f.quality >= QUALITY_FLOOR);
}

function matchesAny(frame: VpdqFrame, others: VpdqFrame[]): boolean {
  for (const o of others) if (hammingDistance(frame.hex, o.hex) <= FRAME_MATCH_THRESHOLD) return true;
  return false;
}

/**
 * The SYMMETRIC shared-frame fraction between two stored frame lists (duplicates.mdx §7.8): the
 * fraction of quality-gated frames of A matched anywhere in B, and vice versa — the pair's score is
 * the MINIMUM of the two directions, which is what distinguishes a duplicate (high both ways) from a
 * subset (high one way only). Returns 0 when either side has no usable frames.
 */
export function symmetricSharedFraction(a: VpdqFrame[], b: VpdqFrame[]): number {
  const ua = usable(a);
  const ub = usable(b);
  if (ua.length === 0 || ub.length === 0) return 0;
  let ma = 0;
  for (const f of ua) if (matchesAny(f, ub)) ma++;
  let mb = 0;
  for (const f of ub) if (matchesAny(f, ua)) mb++;
  return Math.min(ma / ua.length, mb / ub.length);
}

export interface SharedRun {
  frames: number; // run length in matched frame pairs
  subStartTs: number; // where the run begins in the SUBSET's timeline (seconds)
  supStartTs: number; // where the run begins in the SUPERSET's timeline (seconds)
  supEndTs: number; // where it ends in the superset's timeline (seconds)
  coverage: number; // matched run duration / subset usable duration, 0..1
}

/**
 * The longest CONTIGUOUS run of subset frames matching CONSECUTIVE superset frames (subsets.mdx §7.2
 * cross-check). Classic O(|sub|·|sup|) longest-common-substring DP over Hamming matches. Returns null
 * when no run of ≥ 3 matched frames exists (a 1–2 frame "run" is noise, not containment).
 */
export function longestSharedRun(sub: VpdqFrame[], sup: VpdqFrame[]): SharedRun | null {
  const s = usable(sub);
  const p = usable(sup);
  if (s.length === 0 || p.length === 0) return null;
  // prev[j] = run length ending at (i-1, j-1)
  let prev = new Array<number>(p.length).fill(0);
  let best = 0;
  let bestI = -1;
  let bestJ = -1;
  for (let i = 0; i < s.length; i++) {
    const cur = new Array<number>(p.length).fill(0);
    for (let j = 0; j < p.length; j++) {
      if (hammingDistance(s[i].hex, p[j].hex) <= FRAME_MATCH_THRESHOLD) {
        cur[j] = (j > 0 ? prev[j - 1] : 0) + 1;
        if (cur[j] > best) {
          best = cur[j];
          bestI = i;
          bestJ = j;
        }
      }
    }
    prev = cur;
  }
  if (best < 3) return null;
  const subStart = s[bestI - best + 1].ts;
  const supStart = p[bestJ - best + 1].ts;
  const supEnd = p[bestJ].ts;
  // Coverage: matched duration over the subset's usable span. Guard a zero span (very short clips).
  const subSpan = s[s.length - 1].ts - s[0].ts;
  const runSpan = s[bestI].ts - subStart;
  const coverage = subSpan > 0 ? Math.min(1, runSpan / subSpan) : 1;
  return { frames: best, subStartTs: subStart, supStartTs: supStart, supEndTs: supEnd, coverage };
}
