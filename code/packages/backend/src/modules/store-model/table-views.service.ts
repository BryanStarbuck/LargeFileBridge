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

/** Persist one table's view (debounced by the frontend). The input is loose (partial); it is re-parsed
 *  through the schema so every field lands defaulted and a malformed body can never corrupt the config.
 *  Merges by key — writing one table's view never clobbers another table's. Stamps `updated_at`. */
export async function saveTableView(
  email: string,
  tableId: string,
  patch: Partial<TableView>,
  nowIso: string,
): Promise<TableView> {
  const next = TableViewSchema.parse({ ...patch, updated_at: nowIso });
  const updated = await updateUserConfig(email, (c) => {
    c.tables.views = { ...c.tables.views, [tableId]: next };
    return c;
  });
  return updated.tables.views[tableId];
}
