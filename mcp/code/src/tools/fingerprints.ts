// The fingerprint tools (pm/mcp.mdx §8, apis.mdx §7). Thin: each one maps arguments onto ONE REST call and
// shapes the reply. No fingerprint is ever computed in this process.
import { z } from "zod";
import { api } from "../http.js";
import { capResults, resolveUserPath, summarize } from "./shape.js";
import { defineTool } from "./types.js";

const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(50)
  .optional()
  .describe("How long to wait for the job before returning pending (default 20, max 50). 0 returns at once.");

interface JobResponse {
  job: { id: string; status: string; total: number; done: number; ok: number; failed: number; cached: number; eta_ms: number | null; csv_path: string | null; discovering: boolean };
  results: Array<{ ok: boolean; code?: string; source?: string; fingerprint?: { kind?: string } }>;
  results_offset: number;
  results_total: number;
  pending: boolean;
}

function shapeJob(r: JobResponse) {
  const { job, pending } = r;
  return capResults({
    job_id: job.id,
    pending,
    status: job.status,
    progress: { done: job.done, total: job.total, discovering: job.discovering, eta_seconds: job.eta_ms == null ? null : Math.round(job.eta_ms / 1000) },
    summary: summarize(r.results),
    next: pending
      ? `Still running. Call lfb_fingerprint_job with job_id "${job.id}" and wait_seconds 50 to wait for it.`
      : "Finished. lfb_fingerprint_export_csv with this job_id writes every row to a CSV file.",
    results_offset: r.results_offset,
    results_total: r.results_total,
    results: r.results,
  });
}

export const fingerprintFiles = defineTool({
  name: "lfb_fingerprint_files",
  description:
    "Compute (or recall, when unchanged) the PDQ perceptual fingerprint of specific image and video files on this computer. " +
    "Use when the user names files. Returns each file's 64-hex value, quality, and for videos the frame count; " +
    "if the work takes longer than wait_seconds it returns pending + job_id — then poll lfb_fingerprint_job (never re-issue). " +
    "Runs 100% locally.",
  schema: z.object({
    paths: z.array(z.string().min(1)).min(1).max(5000).describe("Absolute paths (a leading ~ is home; relative paths resolve against this session's directory)."),
    force: z.boolean().optional().describe("Recompute even if a valid stored fingerprint exists. Only when the user asks."),
    include_frames: z.boolean().optional().describe("Include each video's per-frame list (large). Default false."),
    wait_seconds: waitSeconds,
  }),
  async run(a) {
    const { data } = await api<JobResponse>("POST", "/fingerprints/compute", {
      paths: a.paths.map(resolveUserPath),
      force: a.force,
      include_frames: a.include_frames,
      wait_ms: (a.wait_seconds ?? 20) * 1000,
    });
    return shapeJob(data);
  },
});

export const fingerprintDirectory = defineTool({
  name: "lfb_fingerprint_directory",
  description:
    "Fingerprint every image and video under a directory (recursive by default; skips .git, node_modules, hidden folders and macOS bundles). " +
    "Use when the user names a folder or repo. Usually returns pending + job_id for anything but small folders — poll lfb_fingerprint_job, then lfb_fingerprint_export_csv for a CSV.",
  schema: z.object({
    dir: z.string().min(1).describe("Absolute directory path (~ allowed)."),
    recursive: z.boolean().optional().describe("Default true."),
    kinds: z.array(z.enum(["image", "video"])).min(1).optional().describe("Limit to images or videos. Default both."),
    max_files: z.number().int().min(1).max(500000).optional().describe("Stop after this many files (default 50,000)."),
    force: z.boolean().optional(),
    include_frames: z.boolean().optional(),
    wait_seconds: waitSeconds,
  }),
  async run(a) {
    const { data } = await api<JobResponse>("POST", "/fingerprints/scan", {
      dir: resolveUserPath(a.dir),
      recursive: a.recursive,
      kinds: a.kinds,
      max_files: a.max_files,
      force: a.force,
      include_frames: a.include_frames,
      wait_ms: (a.wait_seconds ?? 20) * 1000,
    });
    return shapeJob(data);
  },
});

export const fingerprintJob = defineTool({
  name: "lfb_fingerprint_job",
  description:
    "Status and results of a fingerprint job started by lfb_fingerprint_files or lfb_fingerprint_directory. " +
    "wait_seconds makes the server wait for the job (up to 50 s) instead of answering at once — use it instead of polling fast. " +
    "Page long result lists with offset/limit.",
  schema: z.object({
    job_id: z.string().min(1),
    wait_seconds: waitSeconds,
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(5000).optional().describe("Results per page (default 500)."),
    include_frames: z.boolean().optional(),
  }),
  async run(a) {
    const q = new URLSearchParams({
      wait_ms: String((a.wait_seconds ?? 0) * 1000),
      offset: String(a.offset ?? 0),
      limit: String(a.limit ?? 500),
      include_frames: String(a.include_frames === true),
    });
    const { data } = await api<JobResponse>("GET", `/fingerprints/jobs/${encodeURIComponent(a.job_id)}?${q}`);
    return shapeJob(data);
  },
});

export const exportCsv = defineTool({
  name: "lfb_fingerprint_export_csv",
  description:
    "Write fingerprint results to a CSV file on this computer and return its absolute path (csv_path). " +
    "Pass job_id for a job's results, or dir to export every fingerprint already stored under a directory (no computing). " +
    "Use for any CSV/spreadsheet request or more than ~50 files; then read or copy the file.",
  schema: z
    .object({
      job_id: z.string().min(1).optional(),
      dir: z.string().min(1).optional(),
      include_frames: z.boolean().optional().describe("Add a frames column (ts:hex:quality|…) for videos."),
    })
    .refine((a) => !!a.job_id !== !!a.dir, "pass exactly one of job_id or dir"),
  async run(a) {
    if (a.job_id) {
      const q = new URLSearchParams({ save: "true", include_frames: String(a.include_frames === true) });
      const { data } = await api<{ csv_path: string; rows: number; pending: boolean }>(
        "GET",
        `/fingerprints/jobs/${encodeURIComponent(a.job_id)}/csv?${q}`,
      );
      return { ...data, note: data.pending ? "The job is still running — this CSV has only the rows finished so far. Export again when it is done." : "Complete." };
    }
    const q = new URLSearchParams({ dir: resolveUserPath(a.dir!), format: "csv", save: "true", include_frames: String(a.include_frames === true), limit: "200000" });
    const { data } = await api<{ csv_path: string; rows: number }>("GET", `/fingerprints/lookup?${q}`);
    return { ...data, note: "Stored fingerprints only; files never fingerprinted (or whose rows are stale) are not included." };
  },
});

export const lookup = defineTool({
  name: "lfb_fingerprint_lookup",
  description:
    "Read the fingerprint ALREADY STORED for one file (path) or for everything under a directory (dir), without computing. " +
    "For a single file it says whether the stored value is still valid (the file unchanged since it was fingerprinted).",
  schema: z
    .object({
      path: z.string().min(1).optional(),
      dir: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(5000).optional().describe("dir only: max rows (default 500)."),
      include_frames: z.boolean().optional(),
    })
    .refine((a) => !!a.path !== !!a.dir, "pass exactly one of path or dir"),
  async run(a) {
    const q = new URLSearchParams({ include_frames: String(a.include_frames === true) });
    if (a.path) q.set("path", resolveUserPath(a.path));
    else {
      q.set("dir", resolveUserPath(a.dir!));
      q.set("limit", String(a.limit ?? 500));
    }
    const { data } = await api<Record<string, unknown>>("GET", `/fingerprints/lookup?${q}`);
    if (Array.isArray((data as { fingerprints?: unknown[] }).fingerprints)) {
      const d = data as { fingerprints: unknown[]; count: number };
      const capped = capResults({ results: d.fingerprints, results_total: d.count });
      return { ...data, fingerprints: capped.results, truncated: capped.truncated };
    }
    return data;
  },
});

export const compare = defineTool({
  name: "lfb_fingerprint_compare",
  description:
    "Are two files the same content? Each side is a file path or a 64-hex PDQ value. Returns the Hamming distance (0–256; ≤32 = same content, ≤24 strict; " +
    "for transparent images the nearer of the white- and black-background hashes) " +
    "and, for two videos, the both-ways shared-frame fraction (duplicate) and the longest matching run (subset, with where it sits in the longer video). " +
    "A match is a signal only — never delete or move files because of it.",
  schema: z.object({
    a: z.string().min(1),
    b: z.string().min(1),
    strict: z.boolean().optional(),
  }),
  async run(x) {
    const side = (s: string) => (/^[0-9a-f]{64}$/i.test(s.trim()) ? s.trim() : resolveUserPath(s));
    const { data } = await api<unknown>("POST", "/fingerprints/compare", { a: side(x.a), b: side(x.b), strict: x.strict });
    return data;
  },
});

export const cancel = defineTool({
  name: "lfb_fingerprint_cancel",
  description: "Cancel a running fingerprint job. Files already in progress finish; no new ones start.",
  schema: z.object({ job_id: z.string().min(1) }),
  async run(a) {
    const { data } = await api<unknown>("POST", `/fingerprints/jobs/${encodeURIComponent(a.job_id)}/cancel`, {});
    return data;
  },
});

export const listJobs = defineTool({
  name: "lfb_list_jobs",
  description: "Recent fingerprint jobs on this computer, newest first (kept in memory until the backend restarts).",
  schema: z.object({}),
  async run() {
    const { data } = await api<unknown[]>("GET", "/fingerprints/jobs");
    return { jobs: data };
  },
});

export const FINGERPRINT_TOOLS = [fingerprintFiles, fingerprintDirectory, fingerprintJob, exportCsv, lookup, compare, cancel, listJobs];
