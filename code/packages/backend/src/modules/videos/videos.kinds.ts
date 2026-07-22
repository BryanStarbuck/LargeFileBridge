// The two Videos batch kinds (videos.mdx §4): `dedupe_scan` (duplicates.mdx §6) and `subset_scan`
// (subsets.mdx §6). Each dedicated scan is its OWN kind — the two scans are separate and one never
// satisfies the other's staleness clock. Both are first-class members of the `ProgressKind` union
// (@lfb/shared types.ts), so every exhaustive kind map (e.g. the dock VERBS table) registers them.
import type { ProgressKind } from "@lfb/shared";

export const DEDUPE_SCAN_KIND = "dedupe_scan" as const;
export const SUBSET_SCAN_KIND = "subset_scan" as const;

export type VideosScanKind = typeof DEDUPE_SCAN_KIND | typeof SUBSET_SCAN_KIND;

/** Kept as the one typed seam batch producers go through (now a no-op widening). */
export function asProgressKind(kind: VideosScanKind): ProgressKind {
  return kind;
}
