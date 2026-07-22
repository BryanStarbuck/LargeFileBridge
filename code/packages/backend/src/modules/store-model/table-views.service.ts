// Per-user, per-table persisted view state (tables.mdx — "save the sorts, filters, and which columns
// are shown" per logged-in user). We remember each table's sort/filters/search/hidden-columns/facets
// keyed by a stable table id, so leaving a page and coming back restores exactly the view the user had.
//
// Storage: the per-user config.yaml `tables:` record (the same personal-state file the File System view
// and web-session history live in — sessions.mdx §4), via getUserConfig/updateUserConfig. It is VIEW
// state, not security state: it never gates access and never derives identity.
import type { TableView } from "@lfb/shared";
import { TableViewSchema } from "@lfb/shared";
import { getUserConfig, updateUserConfig } from "./user-config.service.js";

/** Every table view the user has saved, keyed by table id. A fresh user reads back {} (never an error),
 *  so the frontend can load the whole map once and hand each table its own slot. */
export function loadTableViews(email: string): Record<string, TableView> {
  return getUserConfig(email).tables.views;
}

/** Persist one table's view (debounced by the frontend). The input is a PATCH: it is merged onto the
 *  table's STORED view, then re-parsed through the schema so every field lands defaulted and a malformed
 *  body can never corrupt the config. Merges on both axes — writing one table's view never clobbers
 *  another table's, and sending one field never clobbers that table's other fields. Stamps `updated_at`.
 *
 *  The merge is deliberate, not cosmetic. Not every writer sends the whole view: FullPathsPage persists
 *  only `file_filter`, and a DataTable omits the keys for facets its surface doesn't carry. Re-parsing a
 *  partial on its own would default every absent key — silently wiping that table's saved sort, search,
 *  and hidden columns on the next write. Merge first, parse second.
 *
 *  Read-modify-write happens INSIDE updateUserConfig's mutate callback so the merge sees the state under
 *  the per-file lock, not a copy read before it. */
export async function saveTableView(
  email: string,
  tableId: string,
  patch: Partial<TableView>,
  nowIso: string,
): Promise<TableView> {
  const updated = await updateUserConfig(email, (c) => {
    const existing = c.tables.views[tableId];
    const next = TableViewSchema.parse({ ...existing, ...patch, updated_at: nowIso });
    c.tables.views = { ...c.tables.views, [tableId]: next };
    return c;
  });
  return updated.tables.views[tableId];
}
