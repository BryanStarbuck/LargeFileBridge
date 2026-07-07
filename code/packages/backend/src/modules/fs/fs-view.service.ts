// The File System page's persisted view state (directories.mdx §1.3). We remember the open column
// chain + selection + header filters per-user, so leaving the page and coming back drops the user
// right back where they were instead of restarting at $HOME.
//
// Storage: the per-user config.yaml `file_system:` block (the same personal-state file the web-session
// history lives in — sessions.mdx §4), via getUserConfig/updateUserConfig. It is VIEW state, not
// security state: it never gates access and never derives identity.
//
// Stale-path tolerance (§1.3): between two visits a folder can move or be deleted. On load we prune to
// the LONGEST still-valid prefix of the column chain and drop any selection entries that no longer
// exist (or now sit outside the allow-roots), so restoring never errors just because something moved.
import fs from "node:fs";
import type { FileSystemView } from "@lfb/shared";
import { FileSystemViewSchema } from "@lfb/shared";
import { getUserConfig, updateUserConfig } from "../store-model/user-config.service.js";
import { assertAllowedPath } from "./allow-root.js";

/** True iff `p` is an existing, allow-listed absolute path of the required kind. Never throws. */
function pathOk(p: string, kind: "dir" | "any"): boolean {
  try {
    const abs = assertAllowedPath(p); // throws for out-of-root / secret / malformed
    const st = fs.statSync(abs); // throws for a gone path
    return kind === "dir" ? st.isDirectory() : true;
  } catch {
    return false;
  }
}

/**
 * Load the user's persisted File System view, pruned to what still exists on THIS machine:
 *   • columns → the longest leading run of paths that are still existing directories (stops at the
 *     first gone/deleted one, so a moved deep folder collapses the chain to its valid ancestors);
 *   • selection → only the entries that still exist (files or dirs).
 * A wholly-gone chain returns empty columns — the caller falls back to the home root (§1).
 */
export function loadFsView(email: string): FileSystemView {
  const view = getUserConfig(email).file_system;

  // Longest valid prefix of the column chain.
  const columns: string[] = [];
  for (const dir of view.columns) {
    if (!pathOk(dir, "dir")) break;
    columns.push(dir);
  }

  // Drop selection entries that no longer exist (or fell outside the allow-roots).
  const selection = view.selection.filter((p) => pathOk(p, "any"));

  return { ...view, columns, selection };
}

/** Persist the user's File System view (debounced by the frontend). Stamps `updated_at`. The input is
 *  loose (filters may be partial); it is re-parsed through the schema so every field lands defaulted. */
export async function saveFsView(
  email: string,
  patch: { columns: string[]; selection: string[]; filters?: Record<string, boolean> },
  nowIso: string,
): Promise<FileSystemView> {
  // Validate + fill defaults before writing so a malformed body can never corrupt the config.
  const next = FileSystemViewSchema.parse({ ...patch, updated_at: nowIso });
  const updated = await updateUserConfig(email, (c) => {
    c.file_system = next;
    return c;
  });
  return updated.file_system;
}
