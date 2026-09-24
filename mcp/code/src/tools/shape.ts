// Result shaping: keep a tool result inside the byte budget (config.maxResultBytes) without lying about it.
import os from "node:os";
import path from "node:path";
import { maxResultBytes } from "../config.js";

/**
 * Resolve a path the way a user means it: `~` is home, absolute stays absolute, and a relative path is
 * taken from the directory Claude Code started this server in (its working directory).
 */
export function resolveUserPath(p: string): string {
  const t = p.trim();
  if (t === "~") return os.homedir();
  if (t.startsWith("~/")) return path.join(os.homedir(), t.slice(2));
  return path.resolve(process.cwd(), t);
}

interface WithResults {
  results?: unknown[];
  results_total?: number;
  [k: string]: unknown;
}

/**
 * If the JSON is over budget, drop trailing `results` entries until it fits, and say so with `truncated`
 * plus a hint pointing at the CSV export (which has no size limit).
 */
export function capResults<T extends WithResults>(data: T): T & { truncated?: { shown: number; of: number; hint: string } } {
  const limit = maxResultBytes();
  if (JSON.stringify(data).length <= limit || !Array.isArray(data.results)) return data;
  const all = data.results;
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify({ ...data, results: all.slice(0, mid) }).length <= limit) lo = mid;
    else hi = mid - 1;
  }
  return {
    ...data,
    results: all.slice(0, lo),
    truncated: {
      shown: lo,
      of: data.results_total ?? all.length,
      hint: "Too many results to show inline. Use lfb_fingerprint_export_csv with this job_id to get them all as a CSV file, or page with lfb_fingerprint_job offset/limit.",
    },
  };
}

/** A compact summary of results by outcome, so the model can report counts without reading every row. */
export function summarize(results: Array<{ ok: boolean; code?: string; source?: string; fingerprint?: { kind?: string } }>): Record<string, number> {
  const s: Record<string, number> = {};
  for (const r of results) {
    const k = r.ok ? `ok_${r.fingerprint?.kind ?? "file"}${r.source && r.source !== "computed" ? "_cached" : ""}` : `failed_${r.code ?? "unknown"}`;
    s[k] = (s[k] ?? 0) + 1;
  }
  return s;
}
