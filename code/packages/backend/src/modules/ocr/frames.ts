// VIDEO FRAME SAMPLING for OCR (ocr.mdx §2.2 + §15). A video is SAMPLED, never fully decoded frame-by-frame:
// advance every 15 seconds, take one frame, fast-OCR it (§2). This module owns the extraction half.
//
// §15's counter-intuitive finding drives every rule here: EXTRACTION DOMINATES, ~3× the recognition cost. A
// 40-minute deck is ~20s of ffmpeg and ~6s of recognition. Optimizing the recognizer while ignoring the
// decode would be optimizing the cheap half. So:
//   • ONE sequential ffmpeg pass (`-vf fps=1/15`), NEVER N × `-ss` seeks (§15.2 rule 1). N seeks pay
//     container-open + keyframe-seek + teardown per frame and cost multiples of a straight decode.
//   • Downscale IN the extraction (§15.2 rule 2) — ffmpeg's scaler is far faster than the recognizer's, and
//     text legible at 4K is legible at 1080p.
//   • `-an` (rule 3) — audio is decoded for nothing otherwise; speech is the transcript's job.
//   • JPEG q≈3, not PNG (rule 4) — frames are ephemeral; PNG encoding is needless CPU + disk at 160/file.
//   • The extraction holds the SHARED transcode slot (rule 5 / §10.3); the recognitions do not.
//   • max_frames bounds a pathological input, and when it bites we SAY SO (rule 7, no silent caps).
//
// Everything here is ASYNC (§10.4, LOCKED): `spawn`, awaited — never `spawnSync`. This is the same rule
// whose violation made the Processing page unloadable during a 2,000-file describe run (performance.mdx P-27).
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";
import { registerChildProcess, unregisterChildProcess } from "../../shared/heap-watch.js";
import { acquireTranscodeSlot } from "../describe/fit-media.js";
import { log } from "../../shared/logging.js";

/** Frames are emitted at ≤ this width. Text legible at 4K is legible here, and the recognizer's cost scales
 *  with pixels — a 4K clip that skips this pays ~4× recognition for ZERO accuracy (§15.2 rule 2). */
const MAX_FRAME_WIDTH = 1920;

/** One sampled frame: the temp image and the timecode it was taken at. */
export interface SampledFrame {
  file: string;
  /** Seconds into the clip — the CENTER of its stride window (§2.2.2). */
  at: number;
}

export interface FrameSample {
  frames: SampledFrame[];
  durationSeconds: number | null;
  /** True when max_frames bit and the clip was sampled only up to that point (§15.2 rule 7). */
  truncated: boolean;
  cleanup: () => Promise<void>;
}

/** Fold ffmpeg's multi-line stderr into ONE log line. Two reasons this is not cosmetic: a raw paste breaks
 *  the one-fault-per-line format every log reader and the repeat-collapser (logging.ts `collapseKey`) assume,
 *  and a blind tail slice can cut mid-line — the real 36-video failure logged as `failed: F`, with the actual
 *  diagnostic stranded on orphan lines below. Keep the LAST few real lines: ffmpeg puts the cause last. */
function oneLineStderr(stderr: string, max = 300): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "(no stderr)";
  const tail = lines.slice(-3).join(" | ").replace(/\s+/g, " ");
  return tail.length > max ? `…${tail.slice(-max)}` : tail;
}

/** Run a child process to completion, capturing stdout. Async — the whole point (§10.4). `label` attributes
 *  the child's RSS in a heap warning, so a runaway ffmpeg is identifiable as OCR's rather than anonymous. */
async function runAsync(cmd: string, args: string[], label: string, timeoutMs = 30 * 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerChildProcess(child.pid, label);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    // ffmpeg is chatty on stderr; keep only the tail so a long encode can't grow the heap.
    child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-4000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      unregisterChildProcess(child.pid);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      unregisterChildProcess(child.pid);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Is a tool on PATH? The one deliberately SYNCHRONOUS probe — a few ms, the same exception the compression
 *  engine makes for `onPath()` (§10.4). */
export function toolOnPath(tool: string): boolean {
  try {
    return spawnSync("which", [tool], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Clip duration in seconds via ffprobe, or null when it can't be read (a missing duration is not fatal —
 *  we simply can't predict the frame count, and the extraction still emits what it emits). */
export async function probeVideo(abs: string): Promise<number | null> {
  try {
    const { code, stdout } = await runAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", abs],
      `ocr-probe:${path.basename(abs)}`,
      60_000,
    );
    if (code !== 0) return null;
    const d = Number(JSON.parse(stdout)?.format?.duration);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * How many frames a clip will yield at a stride — what the popup shows per video row (§9.2).
 *
 * This MUST agree with what `extractFrames` actually emits, or the popup promises work that never happens
 * (the §9.2 hint) and §2.2.2's "the count of frames is unchanged; only the phase moves" becomes a lie. The
 * arithmetic is therefore the ffmpeg `fps` filter's REAL behaviour, measured rather than assumed: with the
 * grid phased by `half`, the filter emits one frame per output slot and ROUNDS TO THE NEAREST slot, so a
 * clip yields `round((D - half) / stride)` frames — NOT `ceil(D / stride)`, which over-counted every clip
 * (a 40s clip promised 3 and delivered 2) and, worse, promised 1 for a clip that delivered 0 (see below).
 *
 * The SHORT-CLIP branch (D < stride) mirrors extractFrames': one frame at the clip's midpoint, always.
 */
export function frameCountFor(durationSeconds: number | null, stride: number, maxFrames: number): number | null {
  if (durationSeconds === null) return null;
  // A clip shorter than one stride is a single window — extractFrames grabs exactly one frame at D/2.
  if (durationSeconds < stride) return 1;
  const emitted = Math.floor((durationSeconds - stride / 2) / stride + 0.5); // round-half-up = the fps filter
  return Math.min(maxFrames, Math.max(1, emitted));
}

/**
 * Extract one frame every `stride` seconds into a temp dir, and return them with their timecodes.
 *
 * THE HALF-STRIDE PHASE (§2.2.2, LOCKED): `fps=1/15` emits its first frame at t=0, which on a huge share of
 * real videos is black, a fade-in, or a platform splash — reliably the WORST frame in the clip. We offset the
 * sampling grid by half a stride so frames land at 7.5s, 22.5s, 37.5s… — the MIDDLE of each window, where the
 * content of that window actually is. The frame count is unchanged; only the phase moves.
 *
 * Holds the SHARED transcode slot for the ffmpeg pass only (§10.3) — the same semaphore describe's
 * compress-to-fit uses, so an OCR extraction and a describe transcode compete for ONE core budget instead of
 * each believing it owns the machine. Released BEFORE recognition: holding it across the cheap half would
 * serialize the recognitions behind the expensive half's budget.
 */
export async function extractFrames(
  abs: string,
  opts: { stride: number; maxFrames: number },
): Promise<FrameSample> {
  const dir = path.join(resolveStateDir(), "ocr-frames", randomUUID());
  ensureDir(dir);
  const cleanup = async (): Promise<void> => {
    // 160 JPEGs × 2,000 videos is real disk (§15.2 rule 8). Best-effort: a failed cleanup must never fail the
    // OCR that already succeeded.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const durationSeconds = await probeVideo(abs);

    // A clip SHORTER THAN ONE STRIDE has exactly one window — itself — and the half-stride phase breaks on it:
    // `-ss 7.5` on a 4.5s clip seeks past EOF, and even at 14.9s the post-seek remainder is too short for
    // `fps=1/15` to emit anything. Either way ZERO frames reach the encoder, and ffmpeg then fails opening
    // mjpeg at EOF with `-22 (Invalid argument)` / "Non full-range YUV is non-standard" — noise that names
    // neither the clip's length nor the real problem. That is the whole story of the 36/1779 batch failure:
    // every failure was <15s, every video >=15s passed, 36 short videos in the tree and 36 failures.
    //
    // §2.2.2's intent is "sample the MIDDLE of the window, never t=0". For a sub-stride clip the window IS the
    // clip, so its middle is `duration/2` — one frame, no `fps` grid to stride. Same rule, honestly applied to
    // a clip that only has one window; the LOCKED phase is unchanged for everything >= one stride.
    const shortClip = durationSeconds !== null && durationSeconds < opts.stride;
    const phase = shortClip ? durationSeconds! / 2 : opts.stride / 2;
    const scale = `scale='min(${MAX_FRAME_WIDTH},iw)':-2`;

    const release = await acquireTranscodeSlot();
    try {
      // ONE sequential pass. `-ss <phase>` phases the grid (§2.2.2); `fps=1/stride` strides it; `scale` bounds
      // the width (rule 2); `-an` drops audio (rule 3); `-q:v 3` is a good JPEG at a fraction of PNG's cost
      // (rule 4); `-frames:v` bounds a pathological input (rule 7).
      const { code, stderr } = await runAsync("ffmpeg", [
        "-nostdin",
        "-v", "error",
        "-ss", String(phase),
        "-i", abs,
        "-an",
        "-vf", shortClip ? scale : `fps=1/${opts.stride},${scale}`,
        "-frames:v", shortClip ? "1" : String(opts.maxFrames),
        "-q:v", "3",
        path.join(dir, "f_%05d.jpg"),
      ], `ocr-frames:${path.basename(abs)}`);
      if (code !== 0) {
        throw new Error(
          `ffmpeg frame extraction failed (exit ${code}, ${durationSeconds ? `${durationSeconds.toFixed(1)}s` : "duration unknown"} clip, sampled from ${phase.toFixed(1)}s): ${oneLineStderr(stderr)}`,
        );
      }
    } finally {
      // Release BEFORE the caller recognizes (§10.3) — the slot covers the ffmpeg pass only.
      release();
    }

    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
    const frames: SampledFrame[] = files.map((f, i) => ({
      file: path.join(dir, f),
      // Frame i is the center of window i: phase + i × stride (§2.2.2). For a sub-stride clip there is one
      // window and `phase` is the clip's own midpoint.
      at: phase + i * opts.stride,
    }));

    // ffmpeg CAN exit 0 having written nothing (it is the encoder-open at EOF that errors, and not always).
    // A zero-frame extraction must never read as "a video with no text" — §2.3 makes empty a SUCCESS for
    // images, and letting an empty frame set through here would launder a real extraction fault into a
    // `status: done, text: ""` artifact that is never retried. Say what happened instead. Reachable when
    // ffprobe gave no duration (so `shortClip` could not be detected) and the clip is in fact sub-stride.
    if (frames.length === 0) {
      throw new Error(
        `ffmpeg extracted 0 frames from a ${durationSeconds ? `${durationSeconds.toFixed(1)}s` : "duration-unknown"} clip (stride ${opts.stride}s, sampled from ${phase.toFixed(1)}s) — nothing to OCR.`,
      );
    }

    // The cap BIT if we emitted exactly max_frames and the clip is longer than they cover. Recorded so the
    // artifact and the UI can SAY it (rule 7) — a silent truncation reads as "we covered it all".
    const covered = phase + frames.length * opts.stride;
    const truncated = frames.length >= opts.maxFrames && (durationSeconds === null || durationSeconds > covered);
    if (truncated) {
      log.warn("ocr", `${abs}: hit max_frames (${opts.maxFrames}) — sampled only the first ~${Math.round(covered)}s of ${durationSeconds ? Math.round(durationSeconds) + "s" : "the clip"} (ocr.mdx §15.2 rule 7).`);
    }
    return { frames, durationSeconds, truncated, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/**
 * Collapse CONSECUTIVE duplicate observations into one entry with a time RANGE (ocr.mdx §2.2.3, LOCKED).
 *
 * A slide on screen for 3 minutes yields 12 identical frames → 12 identical text blocks. Recording all 12
 * would bloat the artifact, wreck the timecode index, and make the Text column unreadable.
 *
 * The comparison is a SIMILARITY THRESHOLD, not strict equality, and that is deliberate: two fast-level
 * passes over the SAME pixels can and do differ by a character, and strict equality would let a one-character
 * wobble defeat the collapse entirely. Non-adjacent repeats do NOT collapse — a slide returned to later is a
 * genuinely separate appearance, and the user searching for it wants both timecodes.
 */
export function collapseDuplicates(
  entries: Array<{ at: number; text: string; confidence: number | null }>,
  stride: number,
  threshold = 0.95,
): OcrTimedEntry[] {
  const out: OcrTimedEntry[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev && similarity(norm(prev.text), norm(e.text)) >= threshold) {
      prev.end = e.at + stride / 2; // extend the run to cover this sample's window
      continue;
    }
    out.push({ start: e.at - stride / 2, end: e.at + stride / 2, text: e.text, confidence: e.confidence });
  }
  // Never report a negative start (the first window's center is half a stride in, so its start is 0).
  for (const e of out) e.start = Math.max(0, e.start);
  return out;
}

export interface OcrTimedEntry {
  start: number;
  end: number;
  text: string;
  confidence: number | null;
}

/** Whitespace-collapsed, case-SENSITIVE (§2.2.3) — "OK" and "ok" are different glyphs on screen. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Levenshtein ratio in [0,1]. Bounded work: identical/empty short-circuit, and the frames being compared
 *  are a single screen of text, not a book. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  // Two-row DP — O(min) memory. These strings are one screen of text each; this is not the hot path.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Both tools the VIDEO path needs. Images need NO external tool at all (§6) — state the asymmetry rather
 *  than papering over it: an ffmpeg-less machine OCRs every image fine and every video not at all. */
export function videoToolsPresent(): boolean {
  return toolOnPath("ffmpeg") && toolOnPath("ffprobe");
}

/** Guard for a temp-dir leak in the degenerate case where a caller never reaches cleanup. */
export function framesDirRoot(): string {
  return path.join(resolveStateDir(), "ocr-frames");
}

/** Best-effort sweep of orphaned frame dirs at boot (a crash mid-extraction leaves one behind). */
export function sweepOrphanFrameDirs(): void {
  try {
    const root = framesDirRoot();
    if (!fs.existsSync(root)) return;
    for (const d of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
    }
  } catch {
    /* a sweep that fails must never block boot */
  }
}
