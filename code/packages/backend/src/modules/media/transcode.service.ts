// On-the-fly video streaming for browser-incompatible files (codecs.mdx §6). When a file's real codec
// can't be decoded natively by the browser — HEVC/ProRes/MPEG-4-ASP, or an "H.264" that is actually
// 10-bit / 4:2:2 / 4:4:4, or an MP4 whose audio is AC-3/DTS/PCM, or a .mkv/.avi container — we don't
// force the user to convert the file on disk. Instead the backend pipes a live, browser-safe
// **fragmented MP4** (H.264 High 8-bit yuv420p + AAC) that any <video> element can play.
//
// The decision tree (codecs.mdx §6c → §6a) is ffprobe-driven and picks the CHEAPEST path:
//   • video already browser-safe + audio safe          → REMUX  (-c copy, near-instant, no quality loss)
//   • video safe, audio unsafe (AC-3/DTS/PCM)           → REMUX video, re-encode audio to AAC
//   • video unsafe (HEVC/ProRes/10-bit/4:2:2/…)         → full TRANSCODE to H.264 High yuv420p + AAC
//   • ffprobe unavailable                               → full TRANSCODE (the always-safe fallback)
//
// This is ordinary same-origin serving of the signed-in user's OWN local file to their OWN browser —
// NOT an IPFS gateway/relay (charter). It shells out to ffmpeg/ffprobe exactly like the compression
// engine already does (compression.service.ts); the no-shell rule applies only to the quick probe.
import { spawn, spawnSync } from "node:child_process";
import type { Response } from "express";
import { log } from "../../shared/logging.js";

// ── tool presence ────────────────────────────────────────────────────────────────
// Memoized per binary for the life of the process — this is on the HTTP request path (every /stream hit
// called it), and a tool cannot appear or vanish mid-process, so one fork per tool is all we ever need
// (to_fix.mdx §3.3.4 / T3). Same shape as compression.service.ts onPath().
const _onPath = new Map<string, boolean>();
function onPath(bin: string): boolean {
  const hit = _onPath.get(bin);
  if (hit !== undefined) return hit;
  let found = false;
  try {
    found = spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  } catch {
    found = false;
  }
  _onPath.set(bin, found);
  return found;
}
export function hasFfmpeg(): boolean {
  return onPath("ffmpeg");
}

// The probe runner — ASYNC (child_process.spawn), never spawnSync. probeStream() sits on the /stream HTTP
// request path, and its 20 s timeout as a SYNC call was a 20 s freeze of the WHOLE app: the event loop
// stops, so every other request (the Processing page poll included) hangs behind one slow ffprobe. Same
// class of bug as the describe/fit-media freeze (to_fix.mdx §3.3.4 / T3); this mirrors that file's
// runAsync() — capped stdout joined once at settle, tail-only stderr, timeout that SIGKILLs.
const STDOUT_CAP_BYTES = 1024 * 1024; // 1 MiB — ffprobe key=value output is bytes; a runaway is a fault
function runAsync(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    let captured = 0;
    let err = "";
    let settled = false;
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, out: "", err: (e as Error).message });
      return;
    }
    // Joined once, at settle — never in the data handler (that concat is the quadratic part of P-30).
    const finishOut = (): string => chunks.join("");
    const timer = setTimeout(() => {
      if (!settled) child!.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (captured >= STDOUT_CAP_BYTES) return; // past the cap we drop, we do not grow
      const s = d.toString();
      chunks.push(s);
      captured += s.length;
    });
    child.stderr?.on("data", (d) => {
      err = (err + d.toString()).slice(-4096); // keep only the tail
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, out: finishOut(), err: e.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: finishOut(), err });
    });
  });
}

// ── browser-playability decision (codecs.mdx §2) ──────────────────────────────────
// Video codecs a modern browser can decode from a fragmented MP4 without extra libraries. VP8/VP9/AV1
// are safe in MP4 for Chromium/Firefox; H.264 is universal — but ONLY at 8-bit 4:2:0 (yuv420p). A
// 10-bit / 4:2:2 / 4:4:4 stream reports codec "h264" yet fails to decode, so the pixel format is the
// real gate, not the codec name.
const SAFE_VCODEC = new Set(["h264", "vp8", "vp9", "av1"]);
const SAFE_PIXFMT = new Set(["yuv420p", "yuvj420p"]);
// Audio codecs a browser can decode inside MP4/WebM. AC-3/E-AC-3/DTS/TrueHD/PCM are not → re-encode.
const SAFE_ACODEC = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

export type StreamMode = "copy" | "remux-audio" | "transcode";

export interface StreamPlan {
  mode: StreamMode;
  reason: string;
  vcodec: string | null;
  pixFmt: string | null;
  acodec: string | null;
}

interface ProbeStreams {
  vcodec: string | null;
  pixFmt: string | null;
  acodec: string | null; // null = no audio track
  hasAudio: boolean;
}

/** Run ffprobe for one selected stream and return its fields as a key→value map. `key=value` output
 *  (default=nw=1) is used deliberately: ffprobe's `csv` writer emits fields in its own fixed internal
 *  order, NOT the order you list in -show_entries, so positional parsing silently misreads. */
async function probeStream(abs: string, select: string, entries: string): Promise<Record<string, string> | null> {
  const r = await runAsync(
    "ffprobe",
    ["-v", "error", "-select_streams", select, "-show_entries", `stream=${entries}`, "-of", "default=nw=1", abs],
    20_000, // unchanged 20 s budget — but it now yields instead of freezing the loop
  );
  if (r.code !== 0) return null;
  const out: Record<string, string> = {};
  for (const line of r.out.trim().split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** ffprobe the first video + first audio stream. Returns null when ffprobe is absent or fails. */
async function probeStreams(abs: string): Promise<ProbeStreams | null> {
  if (!onPath("ffprobe")) return null;
  const v = await probeStream(abs, "v:0", "codec_name,pix_fmt");
  if (!v) return null; // ffprobe present but errored on this file → let caller transcode to be safe
  const a = await probeStream(abs, "a:0", "codec_name");
  return {
    vcodec: v.codec_name || null,
    pixFmt: v.pix_fmt || null,
    acodec: a?.codec_name || null,
    hasAudio: !!a?.codec_name,
  };
}

/** Decide the cheapest browser-safe streaming path for a file (codecs.mdx §6). */
export async function planStream(abs: string): Promise<StreamPlan> {
  const p = await probeStreams(abs);
  if (!p) {
    return { mode: "transcode", reason: "ffprobe unavailable — transcoding to be safe", vcodec: null, pixFmt: null, acodec: null };
  }
  const videoSafe = !!p.vcodec && SAFE_VCODEC.has(p.vcodec) && !!p.pixFmt && SAFE_PIXFMT.has(p.pixFmt);
  const audioSafe = !p.hasAudio || (!!p.acodec && SAFE_ACODEC.has(p.acodec));
  const base = { vcodec: p.vcodec, pixFmt: p.pixFmt, acodec: p.acodec };
  if (!videoSafe) {
    const why = !p.vcodec ? "no video stream detected"
      : !SAFE_VCODEC.has(p.vcodec) ? `${p.vcodec} is not browser-decodable`
      : `pixel format ${p.pixFmt ?? "?"} is not 8-bit 4:2:0`;
    return { mode: "transcode", reason: `${why} — transcoding to H.264 yuv420p`, ...base };
  }
  if (!audioSafe) {
    return { mode: "remux-audio", reason: `video is browser-safe; audio ${p.acodec ?? "?"} re-encoded to AAC`, ...base };
  }
  return { mode: "copy", reason: "video + audio already browser-safe — remuxing to fragmented MP4", ...base };
}

// ── ffmpeg argument builders ───────────────────────────────────────────────────────
// Fragmented MP4 so ffmpeg can write to a non-seekable pipe: empty_moov emits the init segment up
// front and frag_keyframe cuts a fragment at each keyframe (codecs.mdx §6a). default_base_moof keeps
// byte offsets fragment-relative so MSE/<video> ingest it cleanly.
const FRAG = ["-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"];

function ffmpegArgs(abs: string, plan: StreamPlan): string[] {
  const input = ["-i", abs];
  if (plan.mode === "copy") {
    return [...input, "-c", "copy", ...FRAG];
  }
  if (plan.mode === "remux-audio") {
    return [...input, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ac", "2", ...FRAG];
  }
  // Full transcode → the universal safe target (codecs.mdx §5): H.264 High 8-bit yuv420p + AAC.
  // veryfast keeps the live pipe close to real time; scale keeps even dimensions (H.264 needs even w/h)
  // and caps the long edge at 1920 so a huge source doesn't melt the CPU while previewing.
  return [
    ...input,
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-preset", "veryfast", "-crf", "23",
    "-vf", "scale='min(1920,iw)':-2",
    "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    ...FRAG,
  ];
}

/** Pipe a live browser-safe fragmented MP4 for `abs` into `res`. Caller has already verified the grant
 *  and that the file is a real video. Resolves once ffmpeg is spawned and piping; streaming then continues
 *  on the ffmpeg process. Async because the ffprobe plan step must not block the event loop (§3.3.4). */
export async function streamPlayable(abs: string, res: Response, onClose: (cb: () => void) => void): Promise<void> {
  if (!hasFfmpeg()) {
    res.status(503).json({ ok: false, error: "ffmpeg not installed — install it (brew install ffmpeg) to stream this codec" });
    return;
  }
  // The plan step now awaits ffprobe, so the browser can hang up BEFORE we ever spawn ffmpeg. Subscribe to
  // the close event up front — registering it after the await would miss an already-fired close and leave
  // an orphaned encoder behind, the very leak the onClose handler at the bottom exists to prevent.
  let aborted = false;
  let killChild: (() => void) | null = null;
  onClose(() => {
    aborted = true;
    killChild?.();
  });

  const plan = await planStream(abs);
  if (aborted) return; // client gave up during the probe — never start the encoder
  log.info("media", `stream ${plan.mode} (${plan.reason}) for ${abs}`);

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", "inline");
  // Live transcode/remux is a forward-only pipe — no byte-range seeking (codecs.mdx §6a limitation).
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("X-LFB-Stream-Mode", plan.mode);

  const ff = spawn("ffmpeg", ffmpegArgs(abs, plan), { stdio: ["ignore", "pipe", "pipe"] });

  let stderrTail = "";
  ff.stderr.on("data", (d: Buffer) => {
    // Keep only the tail so a failed transcode logs a useful reason without unbounded memory.
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  ff.on("error", (err) => {
    log.warn("media", `ffmpeg spawn failed for ${abs}: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "transcode failed to start" });
    else res.destroy();
  });
  ff.on("close", (code) => {
    if (code && code !== 0 && code !== 255) {
      // 255 is ffmpeg's normal code when the client disconnects mid-stream; anything else is a real fault.
      log.warn("media", `ffmpeg exited ${code} for ${abs}: ${stderrTail.split("\n").slice(-3).join(" ").slice(0, 200)}`);
    }
    if (!res.writableEnded) res.end();
  });

  ff.stdout.pipe(res);

  // Kill ffmpeg when the browser drops the connection (seek, navigate away, tab close) so we don't
  // leave orphaned encoder processes behind. Wired through the flag set above rather than a second
  // onClose subscription, so a close that arrived during the probe is honoured too.
  killChild = () => {
    ff.stdout.unpipe(res);
    if (!ff.killed) ff.kill("SIGKILL");
  };
  if (aborted) killChild(); // closed between the probe check and the spawn
}
