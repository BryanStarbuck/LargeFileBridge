// The two Videos batch kinds (videos.mdx §4): `dedupe_scan` (duplicates.mdx §6) and `subset_scan`
// (subsets.mdx §6). Each dedicated scan is its OWN kind — the two scans are separate and one never
// satisfies the other's staleness clock.
//
// VOCABULARY NOTE (deliberate local cast): processing_batches.mdx says a batch kind is registered "at
// every vocabulary point together", and the canonical union is `ProgressKind` in @lfb/shared. That
// package is FROZEN for this change, so the two kinds are declared here and cast through the ONE choke
// point below wherever a `ProgressKind` is required (createBatch kind, progress-registry cards, failure
// rows). The wire format is plain JSON strings, so the frontend receives the literal "dedupe_scan" /
// "subset_scan" exactly as it would with the union widened. When @lfb/shared is next open, add
//   | "dedupe_scan" | "subset_scan"
// to `ProgressKind` (types.ts) and delete the cast here — nothing else changes.
import type { ProgressKind } from "@lfb/shared";

export const DEDUPE_SCAN_KIND = "dedupe_scan" as const;
export const SUBSET_SCAN_KIND = "subset_scan" as const;

export type VideosScanKind = typeof DEDUPE_SCAN_KIND | typeof SUBSET_SCAN_KIND;

/** The ONE cast choke point — every ProgressKind-typed surface goes through here. */
export function asProgressKind(kind: VideosScanKind): ProgressKind {
  return kind as unknown as ProgressKind;
}
