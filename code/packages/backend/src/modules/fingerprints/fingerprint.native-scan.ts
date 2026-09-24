// The BULK directory scan's bridge to the Go engine (perceptual_fingerprint.mdx §FD.8, apis.mdx §7.9).
//
// POST /api/fingerprints/directory-csv starts a job whose work is ONE `lfb-pdq --scan` process: Go walks the
// directory, keeps the files whose extension was asked for, and fingerprints them in-process on ~80% of the
// cores (scan.go). This file spawns that process, hands it the request on stdin, and turns each NDJSON event
// it prints into a normal FingerprintResult — stored in L1/Postgres exactly like a per-file result, so
// lookup, compare, and the per-file path all see the values the bulk scan produced.
//
// Why not the per-file path in a loop: its gates allow 3 videos at a time, and videos set the pace of a
// real media tree (about 5 files/s on 7,000 files). The bulk scan runs 19 videos at once on the 24-core
// tower, longest first; images were already fast on both paths (~260/s). §FD.8 has the numbers.
//
// ONE AT A TIME: each scan already uses ~80% of the cores, so a second concurrent scan would only fight the
// first. `nativeSlot` queues later scans (job.waiting_for_slot) until the running one ends.
//
// NO NETWORK: a local binary over pipes (fingerprints.no-network.spec.ts).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, type Fingerprint, type FingerprintErrorCode } from "@lfb/shared";
import { log, logError } from "../../shared/logging.js";
import { HARD_SKIP, MAC_PACKAGE_EXTENSIONS } from "../../shared/scan-filters.js";
import { pdqBinaryPath, buildPdqSidecar } from "./pdq-sidecar.js";

const FILE = "fingerprint.native-scan.ts";

/** Folders every walk skips, even with skip_generated_dirs false: VCS, dependencies, trash, agent
 *  worktrees, and the cloud vendors' own metadata. The rest of HARD_SKIP is generated output. */
const ALWAYS_SKIP = [".git", "node_modules", ".Trash", ".claude", ".dropbox", ".dropbox.cache", ".tmp.drivedownload", ".driveupload"];

export interface NativeScanRequest {
  dir: string;
  recursive: boolean;
  extensions: string[] | null;
  kinds: Array<"image" | "video">;
  excludeDirs: string[];
  skipGeneratedDirs: boolean;
  includeOnlineOnly: boolean;
  workers?: number;
  cpuPercent: number;
  maxFiles: number;
  video: { intervalS: number; maxFrames: number; timeoutS: number };
  /** Files whose stored fingerprint is still valid: Go answers them without reading them. */
  known: Array<{ path: string; size: number; mtime_ms: number }>;
}

/** One NDJSON line from scan.go (its scanEvent). */
export interface NativeEvent {
  t: "start" | "walk" | "file" | "known" | "defer" | "fail" | "done" | "error";
  path?: string;
  kind?: "image" | "video";
  size?: number;
  mtime_ms?: number;
  hash?: string;
  hash_alt?: string;
  quality?: number;
  frames?: Array<{ n: number; h: string; q: number; ts: number }>;
  duration?: number;
  strategy?: string;
  tried?: string[];
  ms?: number;
  stable?: boolean;
  code?: string;
  error?: string;
  why?: string;
  total?: number;
  images?: number;
  videos?: number;
  known?: number;
  unreadable_dirs?: number;
  truncated?: boolean;
  workers?: number;
  cores?: number;
  version?: string;
  cancelled?: boolean;
}

export interface NativeScanHandlers {
  onEvent(ev: NativeEvent): void;
}

// ── one scan at a time ─────────────────────────────────────────────────────────
let slotBusy = false;
const slotWaiters: Array<() => void> = [];

/** Wait for the single native-scan slot. Returns a release function (call it exactly once). */
export async function acquireNativeSlot(signal?: AbortSignal): Promise<(() => void) | null> {
  while (slotBusy) {
    if (signal?.aborted) return null;
    await new Promise<void>((r) => {
      slotWaiters.push(r);
      signal?.addEventListener("abort", () => r(), { once: true });
    });
  }
  if (signal?.aborted) return null;
  slotBusy = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slotBusy = false;
    slotWaiters.splice(0).forEach((w) => w());
  };
}

/** Resolve `exclude_dirs`: bare names match at any depth, anything with a slash is a path under `dir`. */
export function splitExcludes(dir: string, excludes: string[]): { names: string[]; paths: string[] } {
  const names: string[] = [];
  const paths: string[] = [];
  for (const raw of excludes) {
    const e = raw.replace(/\/+$/, "");
    if (!e) continue;
    if (!e.includes("/")) names.push(e);
    else paths.push(path.isAbsolute(e) ? path.normalize(e) : path.join(dir, e));
  }
  return { names, paths };
}

/** The JSON request scan.go reads from stdin. Exported for the spec. */
export function buildGoRequest(r: NativeScanRequest): Record<string, unknown> {
  const { names, paths } = splitExcludes(r.dir, r.excludeDirs);
  const skipDirs = new Set<string>([...(r.skipGeneratedDirs ? HARD_SKIP : ALWAYS_SKIP), ...names]);
  return {
    dir: r.dir,
    recursive: r.recursive,
    extensions: r.extensions ?? [],
    kinds: r.kinds,
    image_exts: IMAGE_EXTENSIONS,
    video_exts: VIDEO_EXTENSIONS,
    skip_dirs: [...skipDirs],
    skip_dir_suffixes: MAC_PACKAGE_EXTENSIONS,
    skip_hidden: true,
    skip_paths: paths,
    include_dataless: r.includeOnlineOnly,
    workers: r.workers,
    cpu_percent: r.cpuPercent,
    max_files: r.maxFiles,
    interval: r.video.intervalS,
    max_frames: r.video.maxFrames,
    timeout_s: r.video.timeoutS,
    known: r.known,
  };
}

/**
 * Run one bulk scan to completion, delivering every event to `handlers.onEvent` in order. Resolves when the
 * process exits; rejects only when it could not be started or died without its `done` event.
 */
export async function runNativeScan(req: NativeScanRequest, handlers: NativeScanHandlers, signal: AbortSignal): Promise<void> {
  const bin = pdqBinaryPath();
  if (!fs.existsSync(bin) && !(await buildPdqSidecar())) {
    throw Object.assign(new Error(`The PDQ fingerprint engine is not built (${bin}). Fix: run \`just build-pdq\` (needs Go).`), {
      code: "pdq_unavailable",
    });
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["--scan"], { stdio: ["pipe", "pipe", "pipe"] });
    let sawDone = false;
    let errTail = "";
    let buf = "";
    const onAbort = (): void => {
      // SIGTERM: scan.go stops handing out files and kills its ffmpeg children, then prints `done`.
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 10_000).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev: NativeEvent;
        try {
          ev = JSON.parse(line) as NativeEvent;
        } catch (e) {
          logError({ file: FILE, operation: "parse lfb-pdq --scan line", error: e, data: { line: line.slice(0, 300) } });
          continue;
        }
        if (ev.t === "done") sawDone = true;
        try {
          handlers.onEvent(ev);
        } catch (e) {
          logError({ file: FILE, operation: "handle scan event", error: e, data: { t: ev.t, path: ev.path } });
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => (errTail = (errTail + d.toString()).slice(-2000)));
    child.stdin.on("error", (e) => log.warn("fingerprints", `bulk scan stdin error: ${e.message}`));
    child.on("error", (e) => {
      signal.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error(`could not start the fingerprint engine: ${e.message}`), { code: "pdq_unavailable" }));
    });
    child.on("close", (code, sig) => {
      signal.removeEventListener("abort", onAbort);
      if (sawDone || signal.aborted) return resolve();
      reject(new Error(`the fingerprint engine exited before finishing (code=${code} signal=${sig}) ${errTail.trim().slice(-400)}`));
    });
    child.stdin.end(JSON.stringify(buildGoRequest(req)) + "\n");
  });
}

/** Map a scan.go `fail` code onto the API's error codes (anything unknown is decode_failed). */
export function nativeErrorCode(code: string | undefined): FingerprintErrorCode {
  const known: FingerprintErrorCode[] = [
    "not_found", "not_a_file", "not_media", "too_large", "decode_failed", "ffmpeg_missing",
    "pdq_unavailable", "timeout", "cancelled", "not_downloaded", "internal",
  ];
  return (known as string[]).includes(code ?? "") ? (code as FingerprintErrorCode) : "decode_failed";
}

/** A `file` event → the stored Fingerprint shape (the same fields fingerprint.service.ts builds). */
export function fingerprintFromEvent(ev: NativeEvent, algoVersion: string): Fingerprint {
  const kind = ev.kind === "video" ? "video" : "image";
  if (kind === "video") {
    const frames = ev.frames ?? [];
    // Representative = the FIRST highest-quality frame — exactly fingerprint.service.ts computeVideo.
    let best = frames[0];
    for (const f of frames) if (f.q > best.q) best = f;
    const last = frames[frames.length - 1];
    return {
      path: ev.path!,
      kind,
      algo: "pdq-frames",
      algo_version: algoVersion,
      size_bytes: ev.size ?? 0,
      mtime_ms: ev.mtime_ms ?? 0,
      value: best?.h ?? "",
      value_alt: null,
      quality: best?.q ?? null,
      frame_count: frames.length,
      frames,
      duration_s: typeof ev.duration === "number" && ev.duration > 0 ? ev.duration : last ? last.ts : null,
      strategy: ev.strategy ?? null,
      compute_ms: ev.ms ?? null,
      computed_at: new Date().toISOString(),
    };
  }
  return {
    path: ev.path!,
    kind,
    algo: "pdq",
    algo_version: algoVersion,
    size_bytes: ev.size ?? 0,
    mtime_ms: ev.mtime_ms ?? 0,
    value: ev.hash ?? "",
    value_alt: ev.hash_alt && ev.hash_alt !== ev.hash ? ev.hash_alt : null,
    quality: ev.quality ?? null,
    frame_count: null,
    duration_s: null,
    strategy: ev.strategy ?? "go-area",
    compute_ms: ev.ms ?? null,
    computed_at: new Date().toISOString(),
  };
}

