// Optimistically splice one entity's fresh badges onto every cached File-System listing that contains
// it, INSTEAD of invalidating the (expensive) directory-walk queries (performance.mdx P-17).
//
// A flag/decision change from the ⋯ menu returns the updated EntityView, whose `badges` are the new
// truth for that one path. Patching the cache in place flips the row's chips immediately without
// re-walking every open column (the P-16 endpoint) or the flat large-file list. The scheduled scan
// remains the source of truth and reconciles later.
import type { QueryClient } from "@tanstack/react-query";
import type { FsBadge, FsListing, FlatFileListing } from "@lfb/shared";

export function patchEntityBadges(qc: QueryClient, path: string, badges: FsBadge[]): void {
  // Column-browser listings: ["fs", "list", root, showHidden] → FsListing.
  qc.setQueriesData<FsListing>({ queryKey: ["fs", "list"] }, (prev) =>
    prev
      ? { ...prev, entries: prev.entries.map((e) => (e.path === path ? { ...e, badges } : e)) }
      : prev,
  );
  // Flat large-file listings: ["fsFlat", root, showHidden] → FlatFileListing.
  qc.setQueriesData<FlatFileListing>({ queryKey: ["fsFlat"] }, (prev) =>
    prev
      ? { ...prev, files: prev.files.map((f) => (f.path === path ? { ...f, badges } : f)) }
      : prev,
  );
}
