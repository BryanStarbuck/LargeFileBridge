// Fingerprint JOBS — the hybrid synchronous/asynchronous contract (apis.mdx §6).
//
// Every compute request becomes a job, even a one-file one. The HTTP call then WAITS up to `wait_ms`
// (default 20 s, max 55 s):
//   * finished inside the budget → the caller gets every result in the same response (synchronous, the
//     common case: one image ≈ 10–40 ms, one 1080p minute of video ≈ 1–3 s);
//   * not finished → the caller gets the job id and whatever finished so far, the work continues in the
//     background, and GET /api/fingerprints/jobs/:id is polled. Nothing is ever cut off by a timeout.
// So a Claude Code MCP call never hits its tool timeout, and a web page never holds a connection for minutes.
//
// A directory job WALKS and COMPUTES at the same time: workers start on the first files while the walk is
// still discovering the rest (`discovering: true`, `total` still growing).
//
// Jobs are in-memory (a job that outlives a restart is not "in flight" any more — the same stance as the
// progress registry), but their RESULTS are not lost: every fingerprint is already in Postgres, and each
// finished job writes its CSV into the state root.
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FingerprintJob, FingerprintKind, FingerprintResult } from "@lfb/shared";
import { mediaKindForName } from "@lfb/shared";
import { log, logError } from "../../shared/logging.js";
import { HARD_SKIP, isMacPackageDir } from "../../shared/scan-filters.js";
import * as progress from "../progress/progress.registry.js";
import { fingerprintPath, expandPath, IMAGE_CONCURRENCY, VIDEO_CONCURRENCY, pdqEngineVersion, versionFor, shapeFingerprint, VIDEO_INTERVAL_S, VIDEO_MAX_FRAMES, VIDEO_TIMEOUT_S } from "./fingerprint.service.js";
import { resultsToCsv, writeCsvExport } from "./fingerprint.csv.js";
import { getStored, listStoredUnder, putStored } from "./fingerprint.store.js";
import {
  acquireNativeSlot,
  fingerprintFromEvent,
  nativeErrorCode,
  runNativeScan,
  type NativeEvent,
  type NativeScanRequest,
} from "./fingerprint.native-scan.js";

const FILE = "fingerprint.jobs.ts";
const KEEP_FINISHED_JOBS = 25;
/** Workers pulling from a job's queue; the per-kind gates in the service bound the real concurrency. */
const WORKERS = IMAGE_CONCURRENCY + VIDEO_CONCURRENCY;

interface JobState {
  job: FingerprintJob;
  results: FingerprintResult[];
  includeFrames: boolean;
  force: boolean;
  abort: AbortController;
  finished: Promise<void>;
  progressId: string | null;
  t0: number;
}

const jobs = new Map<string, JobState>();

export interface StartPathsJob {
  kind: "paths";
  paths: string[];
  force?: boolean;
  includeFrames?: boolean;
}
export interface StartDirJob {
  kind: "directory";
  dir: string;
  recursive?: boolean;
  kinds?: FingerprintKind[];
  maxFiles?: number;
  force?: boolean;
  includeFrames?: boolean;
}
/** The bulk directory scan (apis.mdx §7.9): the whole job runs in one Go process (fingerprint.native-scan.ts). */
export interface StartNativeDirJob {
  kind: "native-directory";
  dir: string;
  recursive?: boolean;
  extensions?: string[];
  kinds?: FingerprintKind[];
  excludeDirs?: string[];
  skipGeneratedDirs?: boolean;
  includeOnlineOnly?: boolean;
  workers?: number;
  cpuPercent?: number;
  maxFiles?: number;
  force?: boolean;
  includeFrames?: boolean;
}
type StartSpec = StartPathsJob | StartDirJob | StartNativeDirJob;

function newJob(scope: FingerprintJob["scope"]): FingerprintJob {
  return {
    id: randomUUID(),
    status: "queued",
    scope,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    total: 0,
    discovering: scope.kind === "directory",
    done: 0,
    ok: 0,
    failed: 0,
    cached: 0,
    images: 0,
    videos: 0,
    elapsed_ms: 0,
    eta_ms: null,
    error: null,
    csv_path: null,
  };
}

/** A small async queue: producers push, workers pull; `close()` ends it once drained. */
class WorkQueue {
  private items: string[] = [];
  private waiters: Array<(v: string | null) => void> = [];
  private closed = false;
  push(p: string): void {
    const w = this.waiters.shift();
    if (w) w(p);
    else this.items.push(p);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }
  next(): Promise<string | null> {
    const it = this.items.shift();
    if (it !== undefined) return Promise.resolve(it);
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }
}

export function startJob(spec: StartSpec): FingerprintJob {
  const scope: FingerprintJob["scope"] =
    spec.kind === "paths"
      ? { kind: "paths", count: spec.paths.length }
      : spec.kind === "native-directory"
        ? { kind: "directory", dir: expandPath(spec.dir), recursive: spec.recursive !== false, engine: "native", extensions: spec.extensions ?? null }
        : { kind: "directory", dir: expandPath(spec.dir), recursive: spec.recursive !== false };
  const job = newJob(scope);
  const state: JobState = {
    job,
    results: [],
    includeFrames: spec.includeFrames === true,
    force: spec.force === true,
    abort: new AbortController(),
    finished: Promise.resolve(),
    progressId: null,
    t0: Date.now(),
  };
  jobs.set(job.id, state);
  pruneJobs();
  state.finished = (spec.kind === "native-directory" ? runNative(state, spec) : run(state, spec)).catch((e) => {
    // run() handles its own failures; reaching here is a bug, and it must not become an unhandled rejection.
    logError({ file: FILE, operation: "job runner crashed", error: e, data: { job: job.id } });
    job.status = "failed";
    job.error = (e as Error)?.message ?? String(e);
  });
  return job;
}

async function run(state: JobState, spec: StartPathsJob | StartDirJob): Promise<void> {
  const { job } = state;
  job.status = "running";
  job.started_at = new Date().toISOString();
  const target = job.scope.kind === "directory" ? path.basename(job.scope.dir) || job.scope.dir : `${job.scope.count} files`;
  state.progressId = progress.begin("fingerprint", target);
  const queue = new WorkQueue();

  const producer = (async () => {
    try {
      if (spec.kind === "paths") {
        const seen = new Set<string>();
        for (const p of spec.paths) {
          const abs = expandPath(p);
          if (seen.has(abs)) continue; // the same file twice is one fingerprint
          seen.add(abs);
          job.total++;
          queue.push(abs);
        }
      } else {
        await walk(state, queue, expandPath(spec.dir), spec.recursive !== false, new Set(spec.kinds ?? ["image", "video"]), spec.maxFiles ?? 50_000);
      }
    } catch (e) {
      job.error = `could not list ${job.scope.kind === "directory" ? job.scope.dir : "paths"}: ${(e as Error).message}`;
      logError({ file: FILE, operation: "job producer", error: e, data: { job: job.id, scope: job.scope } });
    } finally {
      job.discovering = false;
      queue.close();
    }
  })();

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = await queue.next();
      if (next === null) return;
      if (state.abort.signal.aborted) {
        record(state, { path: next, ok: false, code: "cancelled", error: "cancelled" });
        continue;
      }
      const r = await fingerprintPath(next, { force: state.force, includeFrames: state.includeFrames, signal: state.abort.signal });
      record(state, r);
    }
  };

  await Promise.all([producer, ...Array.from({ length: WORKERS }, worker)]);
  await finishJob(state);
}

/** Close out a job: final status, progress end, the CSV in the state root, and one summary log line. */
async function finishJob(state: JobState): Promise<void> {
  const { job } = state;
  job.eta_ms = 0;
  job.elapsed_ms = Date.now() - state.t0;
  job.finished_at = new Date().toISOString();
  if (state.abort.signal.aborted) job.status = "cancelled";
  else if (job.error && job.done === 0) job.status = "failed";
  else job.status = "done";
  if (state.progressId) progress.end(state.progressId);

  try {
    job.csv_path = await writeCsvExport(`fingerprints_${job.id}`, resultsToCsv(state.results, state.includeFrames));
  } catch (e) {
    logError({ file: FILE, operation: "write job CSV", error: e, data: { job: job.id } });
  }
  if (job.failed > 0) {
    // One WARN per job (not per file) into error.err, grouped by failure code, so a folder full of corrupt
    // files is visible without drowning the fault trail.
    const byCode: Record<string, number> = {};
    for (const r of state.results) if (!r.ok && r.code !== "cancelled") byCode[r.code ?? "unknown"] = (byCode[r.code ?? "unknown"] ?? 0) + 1;
    const example = state.results.find((r) => !r.ok && r.code !== "cancelled");
    log.warn(
      "fingerprints",
      `job ${job.id}: ${job.failed} of ${job.total} files could not be fingerprinted ${JSON.stringify(byCode)}` +
        (example ? ` — e.g. ${example.path}: ${example.error}` : ""),
    );
  }
  log.info(
    "fingerprints",
    `job ${job.id} ${job.status}: ${job.ok} ok, ${job.failed} failed, ${job.cached} cached of ${job.total} in ${job.elapsed_ms} ms`,
  );
}

// ── the bulk (native) directory scan ────────────────────────────────────────────
async function runNative(state: JobState, spec: StartNativeDirJob): Promise<void> {
  const { job } = state;
  const dir = expandPath(spec.dir);
  // One bulk scan at a time: each already uses ~80% of the cores.
  job.waiting_for_slot = true;
  const release = await acquireNativeSlot(state.abort.signal);
  job.waiting_for_slot = false;
  if (!release) {
    job.discovering = false;
    return finishJob(state);
  }
  try {
    job.status = "running";
    job.started_at = new Date().toISOString();
    state.t0 = Date.now();
    state.progressId = progress.begin("fingerprint", path.basename(dir) || dir);
    job.deferred = 0;

    const engine = await pdqEngineVersion();
    const imageVersion = versionFor("image", engine);
    const videoVersion = versionFor("video", engine);

    // Still-valid stored values under this directory: Go answers them without opening the file. Validity is
    // size + mtime (checked by Go against its own stat) + engine version (checked here).
    const known = spec.force
      ? []
      : (await listStoredUnder(dir, false, 500_000))
          .filter((fp) => fp.algo_version === (fp.kind === "video" ? videoVersion : imageVersion))
          .map((fp) => ({ path: fp.path, size: fp.size_bytes, mtime_ms: fp.mtime_ms }));

    const req: NativeScanRequest = {
      dir,
      recursive: spec.recursive !== false,
      extensions: spec.extensions ?? null,
      kinds: spec.kinds ?? ["image", "video"],
      excludeDirs: spec.excludeDirs ?? [],
      skipGeneratedDirs: spec.skipGeneratedDirs !== false,
      includeOnlineOnly: spec.includeOnlineOnly === true,
      workers: spec.workers,
      cpuPercent: spec.cpuPercent ?? 80,
      maxFiles: spec.maxFiles ?? 50_000,
      video: { intervalS: VIDEO_INTERVAL_S, maxFrames: VIDEO_MAX_FRAMES, timeoutS: VIDEO_TIMEOUT_S },
      known,
    };

    const deferred: string[] = [];
    const pendingWrites: Promise<void>[] = [];
    const onEvent = (ev: NativeEvent): void => {
      switch (ev.t) {
        case "start":
          job.workers = ev.workers ?? null;
          job.cores = ev.cores ?? null;
          log.info("fingerprints", `bulk scan ${job.id}: ${dir} on ${ev.workers} workers of ${ev.cores} cores`);
          return;
        case "walk":
          job.total = ev.total ?? 0;
          job.discovering = false;
          if (ev.truncated) log.warn("fingerprints", `bulk scan of ${dir} stopped at max_files=${req.maxFiles}`);
          if (ev.unreadable_dirs) log.warn("fingerprints", `bulk scan of ${dir}: ${ev.unreadable_dirs} directories were unreadable`);
          return;
        case "file": {
          const fp = fingerprintFromEvent(ev, ev.kind === "video" ? videoVersion : imageVersion);
          pendingWrites.push(
            (async () => {
              // A torn read (the file changed while Go read it) is returned but never stored.
              const stored = ev.stable === true ? await putStored(fp) : false;
              if (ev.stable !== true) log.warn("fingerprints", `${fp.path} changed while it was being fingerprinted — result returned, not stored`);
              record(state, { path: fp.path, ok: true, fingerprint: shapeFingerprint(fp, state.includeFrames), source: "computed", stored });
            })(),
          );
          return;
        }
        case "known":
          pendingWrites.push(
            (async () => {
              const hit = await getStored(ev.path!, state.includeFrames);
              if (hit) record(state, { path: ev.path!, ok: true, fingerprint: shapeFingerprint(hit.fp, state.includeFrames), source: hit.tier, stored: hit.tier === "postgres" ? true : undefined });
              else deferred.push(ev.path!); // evicted from memory since the walk: compute it the per-file way
            })(),
          );
          return;
        case "defer":
          job.deferred = (job.deferred ?? 0) + 1;
          deferred.push(ev.path!);
          return;
        case "fail":
          record(state, { path: ev.path!, ok: false, code: nativeErrorCode(ev.code), error: ev.error ?? "failed" });
          return;
        case "error":
          job.error = ev.error ?? "the bulk scan failed";
          return;
        default:
          return;
      }
    };

    try {
      await runNativeScan(req, { onEvent }, state.abort.signal);
    } catch (e) {
      job.error = (e as Error).message;
      logError({ file: FILE, operation: "bulk scan", error: e, data: { job: job.id, dir } });
    }
    await Promise.all(pendingWrites);

    // Images Go could not decode (HEIC/AVIF, animated WebP, …) go through the per-file sharp path now.
    if (deferred.length > 0 && !state.abort.signal.aborted) {
      log.info("fingerprints", `bulk scan ${job.id}: ${deferred.length} files handed to the per-file path`);
      let i = 0;
      const worker = async (): Promise<void> => {
        while (i < deferred.length) {
          const p = deferred[i++];
          if (state.abort.signal.aborted) {
            record(state, { path: p, ok: false, code: "cancelled", error: "cancelled" });
            continue;
          }
          record(state, await fingerprintPath(p, { force: state.force, includeFrames: state.includeFrames, signal: state.abort.signal }));
        }
      };
      await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
    }
    job.discovering = false;
    await finishJob(state);
  } finally {
    release();
  }
}

function record(state: JobState, r: FingerprintResult): void {
  const { job } = state;
  state.results.push(r);
  job.done++;
  if (r.ok) {
    job.ok++;
    if (r.source && r.source !== "computed") job.cached++;
    if (r.fingerprint?.kind === "video") job.videos++;
    else if (r.fingerprint?.kind === "image") job.images++;
  } else if (r.code !== "cancelled") {
    job.failed++;
  }
  job.elapsed_ms = Date.now() - state.t0;
  const remaining = job.total - job.done;
  job.eta_ms = job.discovering || job.done < 3 ? null : Math.round((job.elapsed_ms / job.done) * remaining);
  if (state.progressId) progress.report(state.progressId, { done: job.done, total: job.total, unit: "files" });
}

/** Recursive, streaming media walk. Skips the same things every other walk skips (scan-filters.ts). */
async function walk(
  state: JobState,
  queue: WorkQueue,
  root: string,
  recursive: boolean,
  kinds: Set<FingerprintKind>,
  maxFiles: number,
): Promise<void> {
  const st = await fsp.stat(root); // throws for a missing root — the job then reports it
  if (!st.isDirectory()) throw new Error("not a directory");
  const stack = [root];
  let unreadable = 0;
  while (stack.length > 0) {
    if (state.abort.signal.aborted || state.job.total >= maxFiles) break;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      unreadable++;
      if (dir === root) throw e;
      if (unreadable <= 5) log.warn("fingerprints", `cannot read ${dir} during fingerprint walk: ${(e as Error).message}`);
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow links out of the tree (or into a loop)
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!recursive || HARD_SKIP.has(e.name) || e.name.startsWith(".") || isMacPackageDir(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        const k = mediaKindForName(e.name);
        if ((k === "image" || k === "video") && kinds.has(k)) {
          state.job.total++;
          queue.push(abs);
          if (state.job.total >= maxFiles) {
            log.warn("fingerprints", `fingerprint walk of ${root} stopped at max_files=${maxFiles}`);
            break;
          }
        }
      }
    }
  }
  if (unreadable > 5) log.warn("fingerprints", `fingerprint walk of ${root}: ${unreadable} directories were unreadable`);
}

function pruneJobs(): void {
  const finished = [...jobs.values()].filter((s) => s.job.finished_at).sort((a, b) => a.t0 - b.t0);
  while (finished.length > KEEP_FINISHED_JOBS) jobs.delete(finished.shift()!.job.id);
}

export function getJob(id: string): { job: FingerprintJob; results: FingerprintResult[]; includeFrames: boolean } | null {
  const s = jobs.get(id);
  if (!s) return null;
  if (!s.job.finished_at) s.job.elapsed_ms = Date.now() - s.t0;
  return { job: s.job, results: s.results, includeFrames: s.includeFrames };
}

export function listJobs(): FingerprintJob[] {
  return [...jobs.values()].map((s) => s.job).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function cancelJob(id: string): FingerprintJob | null {
  const s = jobs.get(id);
  if (!s) return null;
  if (!s.job.finished_at) s.abort.abort();
  return s.job;
}

/** Resolve when the job finishes or `waitMs` passes, whichever is first. True = finished. */
export async function waitForJob(id: string, waitMs: number): Promise<boolean> {
  const s = jobs.get(id);
  if (!s) return false;
  if (s.job.finished_at) return true;
  if (waitMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), waitMs)));
  const done = s.finished.then(() => true as const);
  const out = await Promise.race([done, timeout]);
  clearTimeout(timer);
  return out;
}
