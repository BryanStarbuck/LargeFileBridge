// /api/fingerprints — the perceptual-fingerprint REST surface (apis.mdx §7). Used by the web app's power
// option, the MCP server (mcp/), and the CLI.
//
// Auth: every route requires an allow-listed principal. The MCP and the CLI reach it through the loopback
// `X-LFB-Api-Key` machine channel (identify.ts apiKeyUser); the browser through its signed-in session.
//
// Every handler catches its own failures: a problem becomes a JSON `{ ok:false, error, code }` with the
// right status, and a problem that is OURS (not the caller's input) is written to error.err via logError.
import { Router, type Request, type Response } from "express";
import {
  FingerprintCompareBodySchema,
  FingerprintComputeBodySchema,
  FingerprintDirectoryCsvBodySchema,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  FINGERPRINT_NATIVE_CPU_PERCENT_DEFAULT,
  FingerprintScanBodySchema,
  FINGERPRINT_WAIT_MS_DEFAULT,
  PDQ_MATCH_THRESHOLD,
  PDQ_MATCH_THRESHOLD_STRICT,
  PDQ_QUALITY_FLOOR,
  type Fingerprint,
  type FingerprintCompareResult,
  type FingerprintJobResponse,
} from "@lfb/shared";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { log, logError } from "../../shared/logging.js";
import { dbHealth } from "../../shared/persistence/db.js";
import { hammingDistance } from "../media/perceptual.service.js";
import { longestSharedRun, symmetricSharedFraction, type VpdqFrame } from "../videos/vpdq.service.js";
import { cancelJob, getJob, listJobs, startJob, waitForJob } from "./fingerprint.jobs.js";
import { expandPath, fingerprintPath, IMAGE_CONCURRENCY, pdqEngineVersion, VIDEO_CONCURRENCY, VIDEO_INTERVAL_S, VIDEO_MAX_FRAMES } from "./fingerprint.service.js";
import { getStored, isValid, listStoredUnder, storeStats } from "./fingerprint.store.js";
import { resultsToCsv, writeCsvExport, exportsDir } from "./fingerprint.csv.js";
import { pdqStatus } from "./pdq-sidecar.js";
import fsp from "node:fs/promises";

const FILE = "fingerprint.router.ts";
const RESULTS_PAGE_DEFAULT = 1000;
const RESULTS_PAGE_MAX = 5000;

export const fingerprintsRouter = Router();
fingerprintsRouter.use(requireAllowListed);

/** One place that turns an unexpected failure into a 500 AND an error.err line. */
function internal(res: Response, req: Request, op: string, e: unknown): void {
  logError({ file: FILE, operation: op, error: e, data: { route: `${req.method} ${req.path}` } });
  if (!res.headersSent) res.status(500).json({ ok: false, code: "internal", error: (e as Error)?.message ?? String(e) });
}

function badRequest(res: Response, msg: string): void {
  res.status(400).json({ ok: false, code: "bad_request", error: msg });
}

function jobResponse(id: string, offset: number, limit: number, includeFrames: boolean): FingerprintJobResponse | null {
  const j = getJob(id);
  if (!j) return null;
  const page = j.results.slice(offset, offset + limit).map((r) => {
    if (includeFrames || !r.fingerprint?.frames) return r;
    const { frames: _f, ...fp } = r.fingerprint;
    return { ...r, fingerprint: fp as Fingerprint };
  });
  return {
    job: j.job,
    results: page,
    results_offset: offset,
    results_total: j.results.length,
    pending: !j.job.finished_at,
  };
}

function pageArgs(req: Request): { offset: number; limit: number } {
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(RESULTS_PAGE_MAX, Math.max(1, Number(req.query.limit) || RESULTS_PAGE_DEFAULT));
  return { offset, limit };
}

// GET /api/fingerprints/info — engine, storage and budget facts (the MCP's lfb_whoami shows these).
fingerprintsRouter.get("/info", async (req, res) => {
  try {
    const [version, stats] = await Promise.all([pdqEngineVersion(), storeStats()]);
    res.json({
      ok: true,
      data: {
        engine: {
          image: { algo: "pdq", library: "ajdnik/imghash v2 (Go sidecar)", decode_max_edge: 512 },
          video: {
            algo: "pdq-frames",
            sampler: "ffmpeg keyframes-first (videotoolbox → software → full decode)",
            interval_s: VIDEO_INTERVAL_S,
            max_frames: VIDEO_MAX_FRAMES,
          },
          version,
          sidecar: pdqStatus(),
        },
        matching: {
          threshold: PDQ_MATCH_THRESHOLD,
          threshold_strict: PDQ_MATCH_THRESHOLD_STRICT,
          quality_floor: PDQ_QUALITY_FLOOR,
        },
        concurrency: { images: IMAGE_CONCURRENCY, videos: VIDEO_CONCURRENCY },
        storage: { ...stats, db_health: dbHealth().state, exports_dir: exportsDir() },
        wait_ms_default: FINGERPRINT_WAIT_MS_DEFAULT,
        caller: currentUser(req).name,
      },
    });
  } catch (e) {
    internal(res, req, "GET /info", e);
  }
});

// POST /api/fingerprints/compute — explicit files. Hybrid sync/async (apis.mdx §6.2).
fingerprintsRouter.post("/compute", async (req, res) => {
  try {
    const parsed = FingerprintComputeBodySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const b = parsed.data;
    const job = startJob({ kind: "paths", paths: b.paths, force: b.force, includeFrames: b.include_frames });
    const finished = await waitForJob(job.id, b.wait_ms ?? FINGERPRINT_WAIT_MS_DEFAULT);
    const body = jobResponse(job.id, 0, RESULTS_PAGE_MAX, b.include_frames === true)!;
    res.status(finished ? 200 : 202).json({ ok: true, data: body });
  } catch (e) {
    internal(res, req, "POST /compute", e);
  }
});

// POST /api/fingerprints/scan — a whole directory (recursive by default). Same hybrid contract.
fingerprintsRouter.post("/scan", async (req, res) => {
  try {
    const parsed = FingerprintScanBodySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const b = parsed.data;
    const dir = expandPath(b.dir);
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) return badRequest(res, `${dir} is not a directory`);
    } catch {
      return res.status(404).json({ ok: false, code: "not_found", error: `${dir} does not exist` });
    }
    if (dir === "/") return badRequest(res, "refusing to fingerprint the whole filesystem root — name a directory");
    const job = startJob({
      kind: "directory",
      dir,
      recursive: b.recursive,
      kinds: b.kinds,
      maxFiles: b.max_files,
      force: b.force,
      includeFrames: b.include_frames,
    });
    log.info("fingerprints", `scan job ${job.id} started for ${dir} by ${currentUser(req).name}`);
    const finished = await waitForJob(job.id, b.wait_ms ?? FINGERPRINT_WAIT_MS_DEFAULT);
    const body = jobResponse(job.id, 0, RESULTS_PAGE_DEFAULT, b.include_frames === true)!;
    res.status(finished ? 200 : 202).json({ ok: true, data: body });
  } catch (e) {
    internal(res, req, "POST /scan", e);
  }
});

// POST /api/fingerprints/directory-csv — the BULK directory scan (apis.mdx §7.9). One Go process walks the
// directory (recursive by default), keeps the files whose extension was asked for, and fingerprints them
// in-process on ~80% of the cores. The answer is a CSV file (job.csv_path) — one row per file, the path in
// one column and the 64-hex fingerprint in another. Same hybrid contract as /scan: 200 when it finished
// inside wait_ms, else 202 with a job to poll.
fingerprintsRouter.post("/directory-csv", async (req, res) => {
  try {
    const parsed = FingerprintDirectoryCsvBodySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const b = parsed.data;
    const dir = expandPath(b.dir);
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) return badRequest(res, `${dir} is not a directory`);
    } catch {
      return res.status(404).json({ ok: false, code: "not_found", error: `${dir} does not exist` });
    }
    if (dir === "/") return badRequest(res, "refusing to fingerprint the whole filesystem root — name a directory");
    const media = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
    const unsupported = (b.extensions ?? []).filter((e) => !media.has(e));
    if (unsupported.length > 0) {
      return badRequest(
        res,
        `extensions ${unsupported.join(", ")} are not image or video types. Supported: ${[...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS].join(", ")}`,
      );
    }
    const job = startJob({
      kind: "native-directory",
      dir,
      recursive: b.recursive,
      extensions: b.extensions ? [...new Set(b.extensions)] : undefined,
      kinds: b.kinds,
      excludeDirs: b.exclude_dirs,
      skipGeneratedDirs: b.skip_generated_dirs,
      includeOnlineOnly: b.include_online_only,
      workers: b.workers,
      cpuPercent: b.cpu_percent ?? FINGERPRINT_NATIVE_CPU_PERCENT_DEFAULT,
      maxFiles: b.max_files,
      force: b.force,
      includeFrames: b.include_frames,
    });
    log.info("fingerprints", `bulk directory-csv job ${job.id} queued for ${dir} by ${currentUser(req).name}`);
    const finished = await waitForJob(job.id, b.wait_ms ?? FINGERPRINT_WAIT_MS_DEFAULT);
    const body = jobResponse(job.id, 0, b.results_limit ?? 0, b.include_frames === true)!;
    // limit 0 still reports results_total; the CSV is the answer.
    if ((b.results_limit ?? 0) === 0) body.results = [];
    res.status(finished ? 200 : 202).json({ ok: true, data: { ...body, csv_path: body.job.csv_path } });
  } catch (e) {
    internal(res, req, "POST /directory-csv", e);
  }
});

// GET /api/fingerprints/jobs — recent jobs (newest first).
fingerprintsRouter.get("/jobs", (req, res) => {
  try {
    res.json({ ok: true, data: listJobs() });
  } catch (e) {
    internal(res, req, "GET /jobs", e);
  }
});

// GET /api/fingerprints/jobs/:id?offset=&limit=&include_frames=&wait_ms= — status + a page of results.
// `wait_ms` lets a poller long-poll (block until done or the budget passes) instead of spinning.
fingerprintsRouter.get("/jobs/:id", async (req, res) => {
  try {
    const wait = Math.min(55_000, Math.max(0, Number(req.query.wait_ms) || 0));
    if (wait > 0) await waitForJob(req.params.id, wait);
    const { offset, limit } = pageArgs(req);
    const body = jobResponse(req.params.id, offset, limit, req.query.include_frames === "true");
    if (!body) return res.status(404).json({ ok: false, code: "not_found", error: "no such job (jobs are kept in memory; it may predate a restart)" });
    res.json({ ok: true, data: body });
  } catch (e) {
    internal(res, req, "GET /jobs/:id", e);
  }
});

// POST /api/fingerprints/jobs/:id/cancel — stop handing out new files; in-flight ones finish.
fingerprintsRouter.post("/jobs/:id/cancel", (req, res) => {
  try {
    const job = cancelJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, code: "not_found", error: "no such job" });
    res.json({ ok: true, data: job });
  } catch (e) {
    internal(res, req, "POST /jobs/:id/cancel", e);
  }
});

// GET /api/fingerprints/jobs/:id/csv — the job's results as CSV. `?save=true` also writes it into the
// state root and returns the path as JSON (what the MCP uses: Claude Code then reads the file directly).
fingerprintsRouter.get("/jobs/:id/csv", async (req, res) => {
  try {
    const j = getJob(req.params.id);
    if (!j) return res.status(404).json({ ok: false, code: "not_found", error: "no such job" });
    const frames = req.query.include_frames === "true" && j.includeFrames;
    const csv = resultsToCsv(j.results, frames);
    if (req.query.save === "true") {
      const out = await writeCsvExport(`fingerprints_${j.job.id}${frames ? "_frames" : ""}`, csv);
      return res.json({ ok: true, data: { csv_path: out, rows: j.results.length, pending: !j.job.finished_at } });
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="fingerprints_${j.job.id}.csv"`);
    res.send(csv);
  } catch (e) {
    internal(res, req, "GET /jobs/:id/csv", e);
  }
});

// GET /api/fingerprints/lookup?path=…  — the STORED value for one file, never computing. Reports whether
//     it is still valid (the file unchanged since the fingerprint was computed).
// GET /api/fingerprints/lookup?dir=…&limit=&format=csv — every stored value under a directory.
fingerprintsRouter.get("/lookup", async (req, res) => {
  try {
    const includeFrames = req.query.include_frames === "true";
    if (typeof req.query.path === "string" && req.query.path) {
      const abs = expandPath(req.query.path);
      const stored = await getStored(abs, includeFrames);
      if (!stored) return res.json({ ok: true, data: { path: abs, found: false } });
      let valid = false;
      let reason = "file is gone";
      try {
        const st = await fsp.stat(abs);
        const version = stored.fp.algo_version;
        valid = isValid(stored.fp, st.size, st.mtimeMs, version) && version.startsWith(await pdqEngineVersion());
        reason = valid ? "unchanged since computed" : "file changed after the fingerprint was computed (or the engine changed)";
      } catch {
        /* reason stays "file is gone" */
      }
      const fp = includeFrames ? stored.fp : { ...stored.fp, frames: undefined };
      return res.json({ ok: true, data: { path: abs, found: true, valid, reason, tier: stored.tier, fingerprint: fp } });
    }
    if (typeof req.query.dir === "string" && req.query.dir) {
      const dir = expandPath(req.query.dir);
      const limit = Math.min(200_000, Math.max(1, Number(req.query.limit) || 10_000));
      const rows = await listStoredUnder(dir, includeFrames, limit);
      if (req.query.format === "csv") {
        const results = rows.map((fp) => ({ path: fp.path, ok: true, fingerprint: fp, source: "postgres" as const }));
        const csv = resultsToCsv(results, includeFrames);
        if (req.query.save === "true") {
          const out = await writeCsvExport(`stored_${dir.replace(/[/\\]+/g, "_")}`, csv);
          return res.json({ ok: true, data: { csv_path: out, rows: rows.length } });
        }
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        return res.send(csv);
      }
      return res.json({ ok: true, data: { dir, count: rows.length, fingerprints: rows } });
    }
    badRequest(res, "pass ?path=<file> or ?dir=<directory>");
  } catch (e) {
    internal(res, req, "GET /lookup", e);
  }
});

const HEX256 = /^[0-9a-f]{64}$/i;

// POST /api/fingerprints/compare { a, b, strict? } — each side a file path or a 64-hex PDQ value.
fingerprintsRouter.post("/compare", async (req, res) => {
  try {
    const parsed = FingerprintCompareBodySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.issues.map((i) => i.message).join("; "));
    const { a, b, strict } = parsed.data;
    const side = async (x: string): Promise<{ path: string | null; fp: Fingerprint | null; hexes: string[]; err?: string }> => {
      if (HEX256.test(x)) return { path: null, fp: null, hexes: [x.toLowerCase()] };
      const r = await fingerprintPath(x, { includeFrames: true });
      if (!r.ok || !r.fingerprint) return { path: r.path, fp: null, hexes: [], err: `${r.path}: ${r.error}` };
      const f = r.fingerprint;
      return { path: r.path, fp: f, hexes: f.value_alt ? [f.value, f.value_alt] : [f.value] };
    };
    const [sa, sb] = await Promise.all([side(a), side(b)]);
    if (sa.err || sb.err) return res.status(422).json({ ok: false, code: "fingerprint_failed", error: [sa.err, sb.err].filter(Boolean).join("; ") });

    const threshold = strict ? PDQ_MATCH_THRESHOLD_STRICT : PDQ_MATCH_THRESHOLD;
    // A transparent image carries two hashes (on white, on black); the pair's distance is the nearest
    // combination, because either rendering is a faithful copy of it (perceptual_fingerprint.mdx §FD.1).
    let distance = 256;
    for (const x of sa.hexes) for (const y of sb.hexes) distance = Math.min(distance, hammingDistance(x, y));
    const out: FingerprintCompareResult = {
      a: { path: sa.path, kind: sa.fp?.kind ?? "hash" },
      b: { path: sb.path, kind: sb.fp?.kind ?? "hash" },
      distance,
      threshold,
      same_content: distance <= threshold,
      note: "",
    };
    if (sa.fp?.frames && sb.fp?.frames) {
      const toV = (f: Fingerprint): VpdqFrame[] => f.frames!.map((x) => ({ n: x.n, hex: x.h, quality: x.q, ts: x.ts }));
      const va = toV(sa.fp);
      const vb = toV(sb.fp);
      out.shared_fraction = Math.round(symmetricSharedFraction(va, vb) * 1000) / 1000;
      // The shorter one is the candidate subset of the longer one.
      const aShorter = va.length <= vb.length;
      const run = aShorter ? longestSharedRun(va, vb) : longestSharedRun(vb, va);
      out.longest_run = run
        ? {
            frames: run.frames,
            shorter: aShorter ? "a" : "b",
            shorter_start_s: run.subStartTs,
            longer_start_s: run.supStartTs,
            longer_end_s: run.supEndTs,
            coverage: Math.round(run.coverage * 1000) / 1000,
          }
        : null;
      out.same_content = out.shared_fraction >= 0.8;
      out.note =
        out.shared_fraction >= 0.8
          ? "duplicate: most frames match in both directions"
          : run && run.coverage >= 0.7
            ? "subset: the shorter video appears inside the longer one (see longest_run)"
            : "different videos";
    } else {
      out.note = out.same_content ? "same content (within the Hamming threshold)" : "different content";
    }
    res.json({ ok: true, data: out });
  } catch (e) {
    internal(res, req, "POST /compare", e);
  }
});
