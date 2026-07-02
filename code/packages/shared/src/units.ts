// Big-file threshold unit math (settings.mdx §1.2 — BINARY multipliers, matching storage.mdx bytes).
import type { SizeUnit } from "./types.js";

export const UNIT_MULTIPLIER: Record<SizeUnit, number> = {
  MB: 1024 * 1024, // 1,048,576 (MiB)
  GB: 1024 * 1024 * 1024, // 1,073,741,824 (GiB)
  TB: 1024 * 1024 * 1024 * 1024, // 1,099,511,627,776 (TiB)
};

export const SIZE_UNITS: SizeUnit[] = ["MB", "GB", "TB"];

export const DEFAULT_THRESHOLD_VALUE = 100;
export const DEFAULT_THRESHOLD_UNIT: SizeUnit = "MB";
export const DEFAULT_THRESHOLD_BYTES = DEFAULT_THRESHOLD_VALUE * UNIT_MULTIPLIER.MB; // 104,857,600

/** value + unit -> resolved bytes (what downstream code compares). */
export function toBytes(value: number, unit: SizeUnit): number {
  return Math.round(value * UNIT_MULTIPLIER[unit]);
}

/** Human-readable byte size, e.g. 8.2 GB. Used in the files table (one_repo.mdx §4.3). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
