// CSV rendering of fingerprint results (apis.mdx §7.6) — what the MCP hands Claude Code, what the web app
// offers as "Download CSV", and what a job writes into the state root when it finishes.
import fsp from "node:fs/promises";
import path from "node:path";
import type { FingerprintResult } from "@lfb/shared";
import { resolveStateDir } from "../../config/state-dir.js";

export const CSV_COLUMNS = [
  "path",
  "ok",
  "kind",
  "algo",
  "value",
  "value_alt",
  "quality",
  "frame_count",
  "duration_s",
  "strategy",
  "size_bytes",
  "file_modified",
  "computed_at",
  "compute_ms",
  "source",
  "stored",
  "error_code",
  "error",
] as const;

/** RFC 4180 quoting, plus a leading-apostrophe guard against spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function resultsToCsv(results: FingerprintResult[], includeFrames = false): string {
  const header = includeFrames ? [...CSV_COLUMNS, "frames"] : [...CSV_COLUMNS];
  const lines = [header.join(",")];
  for (const r of results) {
    const f = r.fingerprint;
    const row: unknown[] = [
      r.path,
      r.ok,
      f?.kind,
      f?.algo,
      f?.value,
      f?.value_alt,
      f?.quality,
      f?.frame_count,
      f?.duration_s,
      f?.strategy,
      f?.size_bytes,
      f ? new Date(f.mtime_ms).toISOString() : "",
      f?.computed_at,
      f?.compute_ms,
      r.source,
      r.stored,
      r.code,
      r.error,
    ];
    // Frames as "ts:hex:quality" joined by "|" — one cell, so the CSV stays one row per file.
    if (includeFrames) row.push(f?.frames?.map((x) => `${x.ts}:${x.h}:${x.q}`).join("|") ?? "");
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

export function exportsDir(): string {
  return path.join(resolveStateDir(), "fingerprints", "exports");
}

/** Write a CSV into the exports directory atomically and return its absolute path. */
export async function writeCsvExport(name: string, csv: string): Promise<string> {
  const dir = exportsDir();
  await fsp.mkdir(dir, { recursive: true });
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "fingerprints";
  const out = path.join(dir, safe.endsWith(".csv") ? safe : `${safe}.csv`);
  const tmp = `${out}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, csv, "utf8");
  await fsp.rename(tmp, out);
  return out;
}
