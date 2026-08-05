// Turning the One-repo table's checked set into the paths an endpoint actually speaks.
//
// The table keys rows by `fileId` (`<repoId>:<relPath>`, tables.mdx getRowId), so the selection Set holds
// fileIds — NOT paths. Two different path forms are then needed downstream, and sending the raw fileIds to
// either one matches nothing server-side and no-ops in silence:
//
//   • REPO-RELATIVE — the repo-scoped routes: POST /repos/:id/pin, PATCH /repos/:id/files.
//   • ABSOLUTE      — the path-scoped batch routes: compress, and the producing trio.
//
// One module, so no call site hand-rolls the mapping and drifts back into passing fileIds.
import type { FileRow } from "@lfb/shared";

/** The checked rows, in table order. Rows that vanished from the data since being checked are dropped. */
export function selectedRows(files: readonly FileRow[], selected: ReadonlySet<string>): FileRow[] {
  return files.filter((f) => selected.has(f.fileId));
}

/** Repo-relative paths for the checked rows — what the repo-scoped pin/decision routes take. */
export function selectedRelPaths(files: readonly FileRow[], selected: ReadonlySet<string>): string[] {
  return selectedRows(files, selected).map((f) => f.path);
}

/** Absolute paths for the checked rows — what the path-scoped batch routes take. */
export function selectedAbsPaths(
  files: readonly FileRow[],
  selected: ReadonlySet<string>,
  repoPath: string | undefined,
): string[] {
  if (!repoPath) return [];
  return selectedRows(files, selected).map((f) => `${repoPath}/${f.path}`);
}
