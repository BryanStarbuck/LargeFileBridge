// Optimistically splice one entity's fresh badges onto every cached File-System listing that contains
// it, INSTEAD of invalidating the (expensive) directory-walk queries (performance.mdx P-17).
//
// A flag/decision change from the ⋯ menu returns the updated EntityView, whose `badges` are the new
// truth for that one path. Patching the cache in place flips the row's chips immediately without
// re-walking every open column (the P-16 endpoint) or the flat large-file list. The scheduled scan
// remains the source of truth and reconciles later.
import type { QueryClient } from "@tanstack/react-query";
import type { FsBadge, FsListing, FlatFileListing } from "@lfb/shared";
import { emitFlatBadgePatch } from "./flatListingPatch.js";
import { clientLog } from "./clientLog.js";

export function patchEntityBadges(qc: QueryClient, path: string, badges: FsBadge[]): void {
  // Optimistic cache splice — never fatal: if it throws, the scheduled scan is still the source of
  // truth and reconciles later, so log and swallow rather than break the caller's success path.
  try {
    // Column-browser listings: ["fs", "list", root, showHidden] → FsListing.
    qc.setQueriesData<FsListing>({ queryKey: ["fs", "list"] }, (prev) =>
      prev
        ? { ...prev, entries: prev.entries.map((e) => (e.path === path ? { ...e, badges } : e)) }
        : prev,
    );
    // Flat large-file listings that still use React Query (any non-streamed reader): ["fsFlat", …].
    qc.setQueriesData<FlatFileListing>({ queryKey: ["fsFlat"] }, (prev) =>
      prev
        ? { ...prev, files: prev.files.map((f) => (f.path === path ? { ...f, badges } : f)) }
        : prev,
    );
    // The streamed Full Paths listing left React Query (P-23) — patch it through the pub/sub bridge.
    emitFlatBadgePatch(path, badges);
  } catch (e) {
    clientLog.warn("patchEntityBadges", e);
  }
}
