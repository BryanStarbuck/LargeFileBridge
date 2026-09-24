// The PDQ sidecar manager (perceptual_fingerprint.mdx §FD, apis.mdx §6).
//
// ONE long-lived `lfb-pdq` process (code/sidecars/pdq — the Go binary built on ajdnik/imghash v2, the FINAL
// image AND video engine). We talk to it over stdin/stdout, one JSON object per line, and match replies to
// requests by id. Keeping it alive matters: a spawn per image would cost more than the hash itself (the
// sidecar hashes a 512 px frame in ~1–3 ms).
//
// FAILURE POSTURE — every failure is a logged, typed error; none of them may crash the backend:
//   * binary missing        → we try ONE background `go build` (if Go is installed), else a clear
//                             `pdq_unavailable` error naming the fix (`just build-pdq`).
//   * the process dies      → every in-flight request is rejected with the exit reason, the death goes to
//                             error.err, and the NEXT request respawns it (at most once per RESPAWN_MIN_MS,
//                             so a binary that crashes on start cannot spin).
//   * a request hangs       → its own timeout rejects it; the process is left alone (other work continues).
//   * a malformed reply line → logged and dropped; the matching request then times out.
//
// NO NETWORK (perceptual_fingerprint.mdx §6): this file spawns a local binary and speaks over pipes. It
// imports no HTTP client and opens no socket — enforced by fingerprints.no-network.spec.ts.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log, logError } from "../../shared/logging.js";

const FILE = "pdq-sidecar.ts";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `code/sidecars/pdq` — five levels up from src/modules/fingerprints is `code/`. */
export const PDQ_SIDECAR_DIR = path.resolve(HERE, "../../../../../sidecars/pdq");
const EXE = process.platform === "win32" ? "lfb-pdq.exe" : "lfb-pdq";

const RESPAWN_MIN_MS = 5_000;
const IMAGE_TIMEOUT_MS = 30_000;

export class PdqUnavailableError extends Error {
  readonly code = "pdq_unavailable";
}

export interface PdqImageReply {
  hash: string;
  quality: number;
  ms: number;
}

export interface PdqVideoFrame {
  n: number;
  h: string;
  q: number;
  ts: number;
}

export interface PdqVideoReply {
  frames: PdqVideoFrame[];
  quality: number;
  strategy: string;
  tried: string[];
  ms: number;
  /** Container duration (seconds) when ffprobe knew it. */
  duration: number | null;
}

interface Pending {
  resolve: (v: RawReply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface RawReply {
  id: number;
  hash?: string;
  quality?: number;
  ms?: number;
  error?: string;
  frames?: PdqVideoFrame[];
  strategy?: string;
  tried?: string[];
  duration?: number;
}

/** Where the binary is: LFB_PDQ_BIN wins (tests, packaged installs), else the build output in the repo. */
export function pdqBinaryPath(): string {
  return process.env.LFB_PDQ_BIN?.trim() || path.join(PDQ_SIDECAR_DIR, "bin", EXE);
}

let child: ChildProcessWithoutNullStreams | null = null;
let childVersion: string | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let lastSpawnAt = 0;
let lastExit: string | null = null;
let buildInFlight: Promise<boolean> | null = null;
let buildFailed: string | null = null;

/** Status for GET /api/fingerprints/info and the MCP's lfb_whoami. Never throws. */
export function pdqStatus(): {
  binary: string;
  present: boolean;
  running: boolean;
  version: string | null;
  inFlight: number;
  lastExit: string | null;
  buildError: string | null;
} {
  const binary = pdqBinaryPath();
  return {
    binary,
    present: fs.existsSync(binary),
    running: child !== null,
    version: childVersion,
    inFlight: pending.size,
    lastExit,
    buildError: buildFailed,
  };
}

/**
 * Build the sidecar with the local Go toolchain. Called automatically once when the binary is missing, and
 * by `just build-pdq` through scripts/dev/pdq.mjs. Resolves true on success; never throws.
 */
export function buildPdqSidecar(): Promise<boolean> {
  if (buildInFlight) return buildInFlight;
  buildInFlight = new Promise<boolean>((resolve) => {
    const out = pdqBinaryPath();
    log.info("fingerprints", `PDQ sidecar missing — building it with Go into ${out}`);
    let err = "";
    let proc;
    try {
      proc = spawn("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", out, "."], {
        cwd: PDQ_SIDECAR_DIR,
        env: { ...process.env, CGO_ENABLED: "0" },
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      buildFailed = `cannot start go: ${(e as Error).message}`;
      logError({ file: FILE, operation: "buildPdqSidecar spawn", error: e, data: { dir: PDQ_SIDECAR_DIR } });
      resolve(false);
      return;
    }
    proc.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    proc.on("error", (e) => {
      buildFailed = `go is not installed (${e.message}) — install Go, then run: just build-pdq`;
      logError({ file: FILE, operation: "buildPdqSidecar", error: e, expected: "go on PATH" });
      resolve(false);
    });
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(out)) {
        buildFailed = null;
        log.info("fingerprints", `PDQ sidecar built: ${out}`);
        resolve(true);
      } else if (code !== null) {
        buildFailed = `go build exited ${code}: ${err.trim().slice(-400)}`;
        logError({ file: FILE, operation: "buildPdqSidecar", error: buildFailed, data: { dir: PDQ_SIDECAR_DIR } });
        resolve(false);
      }
    });
  }).finally(() => {
    buildInFlight = null;
  });
  return buildInFlight;
}

async function ensureChild(): Promise<ChildProcessWithoutNullStreams> {
  if (child) return child;
  const bin = pdqBinaryPath();
  if (!fs.existsSync(bin)) {
    const built = await buildPdqSidecar();
    if (!built) {
      throw new PdqUnavailableError(
        `The PDQ fingerprint engine is not built (${bin}). ${buildFailed ?? ""} Fix: run \`just build-pdq\` ` +
          `(needs Go: brew install go).`.trim(),
      );
    }
  }
  if (child) return child; // a concurrent caller spawned it while we awaited the build
  const since = Date.now() - lastSpawnAt;
  if (lastSpawnAt && since < RESPAWN_MIN_MS) {
    throw new PdqUnavailableError(
      `The PDQ fingerprint engine exited moments ago (${lastExit ?? "unknown reason"}); retry shortly.`,
    );
  }
  lastSpawnAt = Date.now();
  const proc = spawn(bin, ["--serve"], { stdio: ["pipe", "pipe", "pipe"] });
  child = proc;
  childVersion = null;
  readVersion(bin);

  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
  let errTail = "";
  proc.stderr.on("data", (d: Buffer) => (errTail = (errTail + d.toString()).slice(-2000)));
  proc.stdin.on("error", (e) => {
    // EPIPE when the process died mid-write: the close handler below rejects the requests.
    log.warn("fingerprints", `PDQ sidecar stdin error: ${e.message}`);
  });
  proc.on("error", (e) => {
    logError({ file: FILE, operation: "spawn lfb-pdq", error: e, data: { bin } });
    failAll(`PDQ engine failed to start: ${e.message}`);
    if (child === proc) child = null;
  });
  proc.on("close", (code, signal) => {
    lastExit = `code=${code} signal=${signal}${errTail ? ` stderr=${errTail.trim().slice(-300)}` : ""}`;
    if (pending.size > 0 || code !== 0) {
      logError({
        file: FILE,
        operation: "lfb-pdq exited",
        error: lastExit,
        data: { inFlight: pending.size },
      });
    }
    failAll(`PDQ engine exited (${lastExit})`);
    if (child === proc) child = null;
  });
  return proc;
}

function readVersion(bin: string): void {
  try {
    const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", () => {});
    p.on("close", () => {
      childVersion = out.trim() || null;
    });
  } catch {
    /* version is informational */
  }
}

function onLine(line: string): void {
  let msg: RawReply;
  try {
    msg = JSON.parse(line) as RawReply;
  } catch (e) {
    logError({ file: FILE, operation: "parse lfb-pdq reply", error: e, data: { line: line.slice(0, 300) } });
    return;
  }
  const p = pending.get(msg.id);
  if (!p) {
    log.warn("fingerprints", `PDQ reply for unknown/expired request id ${msg.id}`);
    return;
  }
  pending.delete(msg.id);
  clearTimeout(p.timer);
  p.resolve(msg);
}

function failAll(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

async function call(body: Record<string, unknown>, timeoutMs: number): Promise<RawReply> {
  const proc = await ensureChild();
  const id = nextId++;
  return new Promise<RawReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`PDQ engine did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ id, ...body }) + "\n");
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`PDQ engine write failed: ${(e as Error).message}`));
    }
  });
}

/** PDQ of an already-decoded RGB frame (3 bytes per pixel, row-major). */
export async function pdqFromRgb(rgb: Buffer, width: number, height: number): Promise<PdqImageReply> {
  if (rgb.length !== width * height * 3) {
    throw new Error(`pdqFromRgb: ${rgb.length} bytes is not ${width}x${height}x3`);
  }
  const r = await call({ raw: rgb.toString("base64"), w: width, h: height }, IMAGE_TIMEOUT_MS);
  if (r.error || !r.hash) throw new Error(r.error || "PDQ engine returned no hash");
  return { hash: r.hash, quality: r.quality ?? 0, ms: r.ms ?? 0 };
}

export interface PdqVideoOptions {
  intervalS?: number;
  maxFrames?: number;
  timeoutS?: number;
  noHw?: boolean;
}

/** Per-frame PDQ for a video. The sidecar runs ffmpeg itself (keyframes first — video.go). */
export async function pdqFromVideo(absPath: string, opts: PdqVideoOptions = {}): Promise<PdqVideoReply> {
  const timeoutS = opts.timeoutS ?? 900;
  const r = await call(
    {
      video: absPath,
      interval: opts.intervalS,
      max_frames: opts.maxFrames,
      timeout_s: timeoutS,
      no_hw: opts.noHw === true,
    },
    (timeoutS + 30) * 1000,
  );
  if (r.error) throw new Error(r.error);
  return {
    frames: r.frames ?? [],
    quality: r.quality ?? 0,
    strategy: r.strategy ?? "",
    tried: r.tried ?? [],
    ms: r.ms ?? 0,
    duration: typeof r.duration === "number" && r.duration > 0 ? r.duration : null,
  };
}

/** Stop the sidecar (backend shutdown, tests). Closing stdin lets it finish in-flight work and exit. */
export function stopPdqSidecar(): void {
  const proc = child;
  child = null;
  if (!proc) return;
  try {
    proc.stdin.end();
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }, 2_000).unref();
}
