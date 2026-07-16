// COMPRESS-TO-FIT for AI description (ai_description.mdx §3.3). A hosted vision model is called with the
// file inline as base64, and that inline request is bounded (~20MB) — so before we upload an image or a
// video we make sure the bytes we send are UNDER a hard target (17.5MB, safely below the 18MB inline
// cap). When a file is already under the target we send it untouched; when it is over, we transcode a
// TEMPORARY copy down to fit and upload that instead. The ORIGINAL FILE IS NEVER TOUCHED — we only ever
// write to a temp file under the state dir and hand its path to the adapter, then delete it.
//
// Video strategy (charter: "keep the pixel resolution the same if highly compressing it, but if that
// doesn't work, reduce the pixel resolution ~25% each time and repeat until it fits"):
//   1. Try a strong CRF encode at the ORIGINAL resolution; if that lands under the target, keep full res.
//   2. Still over → try an even more aggressive CRF at original resolution (last chance to keep res).
//   3. Still over → step the resolution down ~25% (snapping to a standard height within 3%) and retry,
//      repeating down a ladder to a 240p floor.
//   4. Final guarantee → a two-pass encode at the floor resolution to an exact target bitrate, which
//      deterministically lands under the cap.
// Image strategy: re-encode to JPEG at descending quality, then descending scale, until it fits.
//
// H.264 (libx264, yuv420p, +faststart) is chosen deliberately over "better-compressing" HEVC/AV1: the
// point is that the provider's decoder MUST accept it, and H.264/mp4 is the one format every vision
// provider decodes. AAC audio is kept but re-encoded low so it can't dominate the byte budget.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";
import { registerChildProcess, unregisterChildProcess } from "../../shared/heap-watch.js";
import { coreBudget } from "../../shared/concurrency.js";
import { log } from "../../shared/logging.js";
import { txn } from "../../shared/transactions.js";

/** The byte ceiling we compress down to. Held safely under the 18MB inline cap in adapters.ts so the
 *  compressed copy always clears readBase64Capped() with margin. */
export const FIT_TARGET_BYTES = Math.floor(17.5 * 1024 * 1024); // 18,350,080 bytes

/** Standard video heights we prefer to "snap" a 25%-reduced resolution onto when one is within 3%. */
const STANDARD_HEIGHTS = [4320, 2160, 1440, 1080, 900, 720, 540, 480, 360, 288, 240];
const MIN_HEIGHT = 240;
const MAX_LADDER_STEPS = 8;

export interface FitResult {
  /** The path to upload — the original when it already fits, else a temp compressed copy. */
  path: string;
  /** true when `path` is a temp compressed copy that must be cleaned up. */
  compressed: boolean;
  /** Delete the temp copy (no-op when the original was used). Always call in a finally. */
  cleanup: () => void;
  /** A short human note about what happened (for logging / the stored record), or null. */
  note: string | null;
}

const NOOP_CLEANUP = () => {};

// ── small process helpers ───────────────────────────────────────────────────────
// `which` is a near-instant detection probe (a few ms), so it stays synchronous — the mirror of
// compression.service.ts `onPath()`. Only the HEAVY calls below (ffprobe/ffmpeg/magick) run async.
//
// MEMOIZED per binary, for the life of the process — the same fix, for the same reason, as that mirror.
// fitVideoUnderLimit() and magickBin() call this PER FILE, so an un-cached probe forked a child and blocked
// the event loop once per file: on a ~2,000-file describe run that is thousands of synchronous spawns on the
// hot path, which is the freeze performance.mdx P-27 / processing.mdx §4.4 exist to forbid. A tool does not
// appear or vanish mid-process, so the first answer is the only answer we need — one fork per tool, ever.
// The cached probe itself is explicitly permitted (ocr.mdx §10.4); the per-file repetition was the defect.
const _which = new Map<string, boolean>();
function which(bin: string): boolean {
  const hit = _which.get(bin);
  if (hit !== undefined) return hit;
  let found = false;
  try {
    found = spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  } catch {
    found = false;
  }
  _which.set(bin, found);
  return found;
}
// The heavy process runner — ASYNC (child_process.spawn), so a multi-minute ffmpeg/magick transcode (and
// even the shorter ffprobe/magick probes) NEVER block the Node event loop (ai_description.mdx §3.3.1,
// job_queue.mdx §3, performance.mdx P-27). This is what lets the describe queue run ~24 files in parallel
// (job_queue.mdx §3) while the web app stays responsive and GET /api/progress keeps answering — the exact
// freeze that made the Processing page fail to load during a mass AI-description run.
//
// STDOUT CAPTURE IS OPT-IN, and that is a memory decision, not a style one (memory.mdx P-30). This runner
// used to capture stdout for EVERY caller, bounded at 32MB — which meant every concurrent child reserved a
// 32MB ceiling, and on the ~24-wide describe path that is up to ~0.7GB of headroom sitting behind payloads
// that are already the heap hazard. Worse, the bound was applied as `out = (out + d.toString()).slice(-32MB)`,
// which transiently allocates ~2× the accumulated string on EVERY chunk — quadratic in chunk count for a
// chatty ffmpeg. And the whole cost bought nothing: only probeVideo() ever reads `out`; encodeCrf(),
// encodeTwoPass() and fitImageUnderLimit() throw it away. So: capture only when asked, cap at ~1MB (an
// ffprobe JSON is kilobytes), and accumulate into a chunk ARRAY joined once at close so the concat is linear.
// When capture is off we hand the child /dev/null for stdout — nothing is allocated, and there is no pipe
// that could fill and block the child. stderr is unchanged: still captured, still tail-bounded at 4096.
const STDOUT_CAP_BYTES = 1024 * 1024;

function runAsync(
  bin: string,
  args: string[],
  timeoutMs = 15 * 60 * 1000,
  opts: { captureStdout?: boolean } = {},
): Promise<{ code: number | null; err: string; out: string }> {
  return new Promise((resolve) => {
    const captureStdout = opts.captureStdout === true;
    const chunks: string[] = [];
    let captured = 0;
    let err = "";
    let settled = false;
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"] });
    } catch (e) {
      resolve({ code: null, err: (e as Error).message, out: "" });
      return;
    }
    // Make the transcode child's RSS visible to heap-watch (to_fix.mdx §6.1, row E1). ffmpeg is not free,
    // and a describe batch can run several at once under the transcode slot — none of it in `heapUsed`.
    registerChildProcess(child.pid, path.basename(bin));
    // Joined once, at settle — never in the data handler (that concat is the quadratic part of P-30).
    const finishOut = (): string => (captureStdout ? chunks.join("") : "");
    const timer = setTimeout(() => {
      if (!settled) child!.kill("SIGKILL");
    }, timeoutMs);
    // Null when capture is off (stdio "ignore") — the optional chain is what makes that a no-op.
    child.stdout?.on("data", (d) => {
      if (captured >= STDOUT_CAP_BYTES) return; // past the cap we drop, we do not grow
      const s = d.toString();
      chunks.push(s);
      captured += s.length;
    });
    child.stderr?.on("data", (d) => {
      err = (err + d.toString()).slice(-4096); // keep only the tail — a long ffmpeg log can be huge
    });
    child.on("error", (e) => {
      unregisterChildProcess(child.pid);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, err: e.message, out: finishOut() });
    });
    child.on("close", (code) => {
      unregisterChildProcess(child.pid);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, err, out: finishOut() });
    });
  });
}
function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}
function tryUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}
function tmpPath(ext: string): string {
  const dir = path.join(resolveStateDir(), "tmp");
  ensureDir(dir);
  // randomUUID() (no child process) — the old spawnSync("uuidgen") was a synchronous process spawn per
  // temp file, another needless event-loop hit on the hot path.
  return path.join(dir, `describe-fit-${randomUUID()}${ext}`);
}
function lastErr(err: string): string {
  return (err || "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200);
}

// ── resolution ladder ────────────────────────────────────────────────────────────
function evenDown(n: number): number {
  const f = Math.floor(n);
  return f % 2 === 0 ? f : f - 1;
}
/** A 25%-reduced height, snapped to a standard height when one is within 3% of the reduced value. */
function stepDownHeight(h: number): number {
  const candidate = h * 0.75;
  for (const s of STANDARD_HEIGHTS) {
    if (Math.abs(s - candidate) / candidate <= 0.03) return s;
  }
  return evenDown(candidate);
}
/** [origH, then repeated 25% reductions] down to the floor — the resolutions we try in order. */
function resolutionLadder(origH: number): number[] {
  const out: number[] = [];
  let h = Math.max(evenDown(origH), MIN_HEIGHT);
  out.push(h);
  while (h > MIN_HEIGHT && out.length < MAX_LADDER_STEPS) {
    let next = stepDownHeight(h);
    if (next >= h) next = evenDown(h - 2); // guarantee progress
    if (next < MIN_HEIGHT) next = MIN_HEIGHT;
    if (next === h) break;
    out.push(next);
    h = next;
  }
  return out;
}

// ── video probe + encode ──────────────────────────────────────────────────────────
interface VideoInfo {
  width: number;
  height: number;
  duration: number; // seconds
}
async function probeVideo(abs: string): Promise<VideoInfo | null> {
  // The ONE call site that needs stdout — the ffprobe JSON below is the whole point of the call, and it is
  // kilobytes, comfortably inside runAsync's 1MB capture cap (memory.mdx P-30). Every other runAsync() in
  // this file discards stdout and therefore must NOT ask for it.
  const r = await runAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", abs,
  ], 60_000, { captureStdout: true });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
    const s = j.streams?.[0];
    const width = Number(s?.width);
    const height = Number(s?.height);
    const duration = Number(j.format?.duration);
    if (!width || !height) return null;
    return { width, height, duration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
  } catch {
    return null;
  }
}

/** CRF-based encode of the whole clip to a temp mp4. Only downscales when targetH < origH. */
async function encodeCrf(src: string, out: string, origH: number, targetH: number, crf: number): Promise<{ code: number | null; err: string }> {
  const scale = targetH < origH ? ["-vf", `scale=-2:${targetH}`] : [];
  return runAsync("ffmpeg", [
    "-y", "-i", src,
    ...scale,
    "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    out,
  ]);
}

/** Two-pass encode to an EXACT target video bitrate — the deterministic "must fit" fallback. `audioKbps`
 *  of 0 drops the audio track entirely (§3.3.2); `fps` of null keeps the source frame rate. Both passes
 *  share the scale/rate/bitrate args so the pass-1 statistics describe the same encode pass 2 performs. */
async function encodeTwoPass(
  src: string,
  out: string,
  origH: number,
  targetH: number,
  videoKbps: number,
  audioKbps: number,
  fps: number | null,
): Promise<{ code: number | null; err: string }> {
  const scale = targetH < origH ? ["-vf", `scale=-2:${targetH}`] : [];
  const rate = fps ? ["-r", String(fps)] : [];
  const logbase = tmpPath("").replace(/\.$/, "") + "-2pass";
  const common = [...scale, ...rate, "-c:v", "libx264", "-preset", "medium", "-b:v", `${videoKbps}k`, "-passlogfile", logbase];
  const p1 = await runAsync("ffmpeg", ["-y", "-i", src, ...common, "-pass", "1", "-an", "-f", "mp4", "/dev/null"]);
  if (p1.code !== 0) {
    tryUnlink(`${logbase}-0.log`);
    tryUnlink(`${logbase}-0.log.mbtree`);
    return p1;
  }
  const audio = audioKbps > 0 ? ["-c:a", "aac", "-b:a", `${audioKbps}k`] : ["-an"];
  const p2 = await runAsync("ffmpeg", [
    "-y", "-i", src, ...common, "-pass", "2",
    "-pix_fmt", "yuv420p", ...audio, "-movflags", "+faststart", out,
  ]);
  tryUnlink(`${logbase}-0.log`);
  tryUnlink(`${logbase}-0.log.mbtree`);
  return p2;
}

// ── the byte budget for the deterministic two-pass fit ────────────────────────────
// A duration-derived budget is the whole game for a long video: the cap is a fixed number of BYTES, so the
// longer the clip the fewer bits per second we may spend. These helpers spend that budget honestly.

/** Never ask x264 for less than this — below it the encode is not a video, and the retry loop's ratio
 *  correction would chase zero. When even this overshoots we fail honestly rather than lie. */
const MIN_VIDEO_KBPS = 8;

/**
 * The audio bitrate this budget can afford (§3.3.2). Audio is kept when it costs a small share of the
 * budget, degraded when it costs more, and DROPPED when the budget is too small to seat it — because a
 * fixed audio track is a per-SECOND cost against a fixed BYTE cap, so on a long enough clip it consumes
 * the entire cap by itself (64kbps alone exceeds 17.5MB past ~36 min) and makes the file impossible to fit
 * at ANY video bitrate. Dropping it is what keeps a long video describable at all; speech is the
 * transcript's job (Transcribe.mdx), while this prompt describes what is SEEN.
 */
function audioKbpsFor(totalKbps: number): number {
  if (totalKbps >= 320) return 64; // audio ≤ 20% of budget — keep it
  if (totalKbps >= 160) return 32; // tight — degrade it
  return 0; // audio would crowd out the picture — drop it
}

/**
 * The frame rate to encode at for a given video budget. A vision model samples video at roughly ONE frame
 * per second, so frames beyond that rate are bits spent on detail the model never looks at. Trading them
 * away is what turns a sub-100kbps encode from a smear of artifacts into legible frames. Generous budgets
 * keep the source rate (null).
 */
function fpsFor(videoKbps: number): number | null {
  if (videoKbps >= 200) return null; // plenty — keep the source frame rate
  if (videoKbps >= 60) return 5;
  return 1; // what the model samples anyway
}

async function fitVideoUnderLimit(src: string, limitBytes: number): Promise<{ out: string; note: string }> {
  if (!which("ffmpeg")) {
    throw new Error("this video is over the AI-description size limit and needs ffmpeg to compress it — install it with: brew install ffmpeg");
  }
  const info = await probeVideo(src); // ffprobe may be absent; we degrade gracefully below
  const origH = info?.height ?? 1080;
  const ladder = resolutionLadder(origH);

  // Is the CRF ladder worth walking at all? The ladder is a SEARCH — every rung is a full encode of the
  // whole clip — and it only pays off when "keep the resolution, compress harder" has a real chance. For a
  // long video it has none: the byte cap divided by the duration leaves a bitrate no CRF encode at source
  // resolution will ever land under, so all ~10 rungs are doomed and each one re-encodes a multi-hundred-MB
  // file before the two-pass below finally does the job. That is not a slow path, it is a WASTED one —
  // hours of ffmpeg per file. When the budget is that tight, skip straight to the deterministic two-pass
  // (ai_description.mdx §3.3.2), which is also where such a clip was always going to end up.
  const budgetKbps = info?.duration && info.duration > 0
    ? Math.floor((limitBytes * 8 * 0.94) / 1000 / info.duration)
    : null;
  const ladderIsPlausible = budgetKbps === null || budgetKbps >= 250;
  if (!ladderIsPlausible) {
    log.info(
      "describe",
      `fit: ${path.basename(src)} is ${(info?.duration ?? 0) / 60 | 0}min — a ${budgetKbps}kbps budget can't hold a CRF encode, going straight to the two-pass fit`,
    );
  }

  // Walk the ladder. At the ORIGINAL resolution give two CRF attempts (28, then a very aggressive 34) so
  // we exhaust "keep the resolution, just compress harder" before dropping pixels. Lower rungs get one.
  for (let i = 0; ladderIsPlausible && i < ladder.length; i++) {
    const targetH = ladder[i];
    const crfs = i === 0 ? [28, 34] : [30];
    for (const crf of crfs) {
      const out = tmpPath(".mp4");
      const r = await encodeCrf(src, out, origH, targetH, crf);
      const outSize = sizeOf(out);
      if (r.code === 0 && outSize > 0 && outSize <= limitBytes) {
        const note = targetH < origH
          ? `compressed to fit: H.264 CRF ${crf}, downscaled to ${targetH}p (${(outSize / 1024 / 1024).toFixed(1)}MB)`
          : `compressed to fit: H.264 CRF ${crf} at original resolution (${(outSize / 1024 / 1024).toFixed(1)}MB)`;
        return { out, note };
      }
      tryUnlink(out);
    }
  }

  // Final guarantee: two-pass to an exact bitrate at the floor resolution. Needs a duration to size the
  // bitrate; if ffprobe couldn't give one, assume a conservative 600s so we err on the smaller side.
  const floorH = ladder[ladder.length - 1];
  const duration = info?.duration && info.duration > 0 ? info.duration : 600;
  const totalKbps = Math.floor((limitBytes * 8 * 0.94) / 1000 / duration);
  let audioKbps = audioKbpsFor(totalKbps);
  // Spend exactly what the budget allows. This must NOT be clamped UP to some minimum: a floor higher than
  // the budget is precisely how this "guarantee" used to produce an oversize file and then throw — every
  // video past ~12.5 min failed that way (ai_description.mdx §3.3.2).
  let videoKbps = Math.max(MIN_VIDEO_KBPS, totalKbps - audioKbps);
  let lastFfmpegErr = "";

  // MEASURE AND CORRECT. The bitrate above is a prediction, and predictions can miss — a wrong/absent
  // duration, container overhead, an unusually incompressible source. So we check the ACTUAL size and, if
  // it overshot, re-derive the bitrate from what we measured (and stop paying for audio) rather than
  // failing on the first miss.
  for (let attempt = 0; attempt < 3; attempt++) {
    const fps = fpsFor(videoKbps);
    const out = tmpPath(".mp4");
    const r = await encodeTwoPass(src, out, origH, floorH, videoKbps, audioKbps, fps);
    const outSize = sizeOf(out);
    if (r.code === 0 && outSize > 0 && outSize <= limitBytes) {
      const parts = [`H.264 two-pass ${videoKbps}kbps at ${floorH}p`];
      if (fps) parts.push(`${fps}fps`);
      parts.push(audioKbps > 0 ? `${audioKbps}k audio` : "no audio");
      return { out, note: `compressed to fit: ${parts.join(", ")} (${(outSize / 1024 / 1024).toFixed(1)}MB)` };
    }
    tryUnlink(out);
    // The encode itself failed (missing codec, unreadable source) — a smaller bitrate won't help.
    if (r.code !== 0 || outSize <= 0) {
      lastFfmpegErr = r.err;
      break;
    }
    // Overshot: correct from the MEASURED overshoot, drop the audio, and try once more.
    const corrected = Math.floor(videoKbps * (limitBytes / outSize) * 0.9);
    log.warn(
      "describe",
      `fit: ${path.basename(src)} landed at ${(outSize / 1024 / 1024).toFixed(1)}MB over the ${(limitBytes / 1024 / 1024).toFixed(1)}MB cap at ${videoKbps}kbps — retrying at ${Math.max(MIN_VIDEO_KBPS, corrected)}kbps, no audio`,
    );
    if (Math.max(MIN_VIDEO_KBPS, corrected) === videoKbps && audioKbps === 0) break; // already at the floor
    audioKbps = 0;
    videoKbps = Math.max(MIN_VIDEO_KBPS, corrected);
  }
  throw new Error(`could not compress this video under ${(limitBytes / 1024 / 1024).toFixed(1)}MB for AI description${lastFfmpegErr ? ` (ffmpeg: ${lastErr(lastFfmpegErr)})` : ""}`);
}

// ── image fit ──────────────────────────────────────────────────────────────────────
function magickBin(): string | null {
  if (which("magick")) return "magick";
  if (which("convert")) return "convert";
  return null;
}
async function fitImageUnderLimit(src: string, limitBytes: number): Promise<{ out: string; note: string }> {
  const bin = magickBin();
  if (!bin) {
    throw new Error("this image is over the AI-description size limit and needs ImageMagick to compress it — install it with: brew install imagemagick");
  }
  // Descend quality first (keeps resolution), then descend scale. A temp JPEG is fine — it exists only to
  // show the model; the original (which may keep alpha/PNG) is never modified.
  for (const scalePct of [100, 75, 56, 42, 32, 24, 18]) {
    for (const q of [85, 72, 60]) {
      const out = tmpPath(".jpg");
      const resize = scalePct < 100 ? ["-resize", `${scalePct}%`] : [];
      const r = await runAsync(bin, [src, ...resize, "-strip", "-quality", String(q), out], 5 * 60 * 1000);
      const outSize = sizeOf(out);
      if (r.code === 0 && outSize > 0 && outSize <= limitBytes) {
        const note = scalePct < 100
          ? `compressed to fit: JPEG q${q}, scaled to ${scalePct}% (${(outSize / 1024 / 1024).toFixed(1)}MB)`
          : `compressed to fit: JPEG q${q} at original resolution (${(outSize / 1024 / 1024).toFixed(1)}MB)`;
        return { out, note };
      }
      tryUnlink(out);
    }
  }
  throw new Error(`could not compress this image under ${(limitBytes / 1024 / 1024).toFixed(1)}MB for AI description`);
}

// ── the transcode gate (ai_description.mdx §12.6.1) ───────────────────────────────────────────────────
// The describe queue fans out ~24-wide on the premise that describe is NETWORK-bound — "the machine sits
// idle while the provider thinks", so parallelism is free (§12.6). That premise holds for a file that fits
// and is only true for that file. An OVERSIZE file makes describe run a full ffmpeg transcode first, which
// is the most core-hungry work in the app — so ~24-wide describe silently means up to ~24 concurrent
// ffmpeg encodes, blowing past the core budget every other bucket is careful to respect
// (parallelization.mdx §3). The machine then starves, in-flight provider calls miss their deadline, and
// files that never needed a transcode at all fail as collateral.
//
// So the fan-out stays wide for the NETWORK (the spec's real intent) and is gated here for the CPU: many
// describes may be in flight, but only a core-budgeted few may be transcoding at any moment. The rest wait
// their turn at the gate instead of fighting for cores.
//
// SHARED WITH OCR (ocr.mdx §10.3). OCR's video path always shells out to ffmpeg to sample frames — its CPU
// branch is unconditional, where describe's is only taken by an oversize file — so it takes this SAME slot.
// One semaphore, one core budget: an OCR extraction and a describe transcode compete with each other rather
// than each believing it owns the machine. This gate is the module's export precisely because a second,
// parallel gate would silently double the real cap and re-create the defect it exists to prevent.
let transcodeActive = 0;
const transcodeWaiters: Array<() => void> = [];

/** Reserve a transcode slot, waiting when the core budget is already spent. Always release in a finally.
 *  Shared by describe's compress-to-fit and OCR's frame extraction (ocr.mdx §10.3). */
export async function acquireTranscodeSlot(): Promise<() => void> {
  const cap = Math.max(1, Math.floor(coreBudget() / VIDEO_THREADS_PER_ENCODE));
  if (transcodeActive >= cap) {
    log.info("describe", `fit: core budget full (${transcodeActive}/${cap} transcodes) — queueing behind it`);
    await new Promise<void>((resolve) => transcodeWaiters.push(resolve));
  }
  transcodeActive++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    transcodeActive--;
    transcodeWaiters.shift()?.();
  };
}

/** Threads a single ffmpeg encode realistically uses — the divisor that turns cores into concurrent jobs,
 *  mirroring the compress:video bucket's cap (parallelization.mdx §3). */
const VIDEO_THREADS_PER_ENCODE = 4;

/**
 * Ensure the media we upload for AI description is at or under `limitBytes`. Returns the ORIGINAL path
 * untouched when it already fits; otherwise transcodes a temporary compressed copy that fits and returns
 * its path with a cleanup(). Never modifies the original. Throws (with a helpful message) only when the
 * required tool is missing or the file genuinely can't be squeezed under the cap.
 *
 * Ledgered as `op=fit_media` (transactions_log.mdx §5.6). This is the most memory-hungry step in the
 * product — it holds media buffers and shells out to ffmpeg for minutes at a time — so if the OOM lives
 * anywhere, the heap numbers the ledger stamps on these BEGIN/END lines are what will show it. The END
 * carries `outBytes` and `transcoded`, which is what distinguishes "this file was already small enough and
 * we did nothing" from "we burned 14 seconds of ffmpeg on it"; a BEGIN with no END means the process died
 * mid-transcode on THIS path, and naming that step is the entire reason the pair exists.
 *
 * `parent` lets the owning describe txn claim this one (§4) — `grep <describeTxn>` then returns the file's
 * complete story, fit_media child included, de-interleaved from its ~23 concurrent siblings.
 */
export async function fitMediaUnderLimit(
  absPath: string,
  kind: "image" | "video",
  limitBytes = FIT_TARGET_BYTES,
  opts: { parent?: string } = {},
): Promise<FitResult> {
  const size = sizeOf(absPath);
  return txn(
    "fit_media",
    { parent: opts.parent, file: absPath, bytes: size, kind, limitBytes },
    async (_t, end): Promise<FitResult> => {
      if (size >= 0 && size <= limitBytes) {
        // A pass-through is still a ledger event: it is the cheap, common case, and its absence from the
        // file is how you would otherwise mistake "never started" for "nothing to do".
        end({ outcome: "skipped", reason: "already_fits", outBytes: size, transcoded: false });
        return { path: absPath, compressed: false, cleanup: NOOP_CLEANUP, note: null };
      }
      // Only the oversize path transcodes, so only it pays the core-budget gate (§12.6.1).
      const release = await acquireTranscodeSlot();
      let out: string;
      let note: string;
      try {
        ({ out, note } = kind === "video"
          ? await fitVideoUnderLimit(absPath, limitBytes)
          : await fitImageUnderLimit(absPath, limitBytes));
      } finally {
        release();
      }
      log.info("describe", `${absPath} (${(size / 1024 / 1024).toFixed(1)}MB) → ${note}`);
      end({ outBytes: sizeOf(out), transcoded: true });
      return {
        path: out,
        compressed: true,
        cleanup: () => tryUnlink(out),
        note,
      };
    },
  );
}
