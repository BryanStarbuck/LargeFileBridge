// Per-table view-state persistence hook (tables.mdx — "save the sorts, filters, and which columns are
// shown" per logged-in user). Each DataTable calls useTableView(tableId) to (a) read back the view the
// user last had on that table and (b) get a debounced `save` it calls on every change.
//
// One network read per session: the whole `tables` map is fetched ONCE (deduped by a module-level
// promise) and shared across every table that mounts, so ten tables cost one GET, not ten. Writes are
// debounced 600ms and flushed on unmount; the module cache is updated in place so a table that
// remounts (e.g. OneRepoPage keys its table per tab) restores instantly without a refetch.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TableView } from "@lfb/shared";
import { api, type TableViewPatch } from "./client.js";

const SAVE_DEBOUNCE_MS = 600;

// Module-level shared load: the first table to mount kicks off one GET; everyone else awaits it.
let viewsPromise: Promise<Record<string, TableView>> | null = null;
let viewsCache: Record<string, TableView> = {};

function loadAllViews(): Promise<Record<string, TableView>> {
  if (!viewsPromise) {
    viewsPromise = api
      .tableViews()
      .then((v) => {
        viewsCache = v ?? {};
        return viewsCache;
      })
      // A view-state read hiccup must never break a table — fall back to "no saved views".
      .catch(() => ({}) as Record<string, TableView>);
  }
  return viewsPromise;
}

export interface UseTableView {
  /** The saved view for this table id, or null if none / not yet loaded. */
  view: TableView | null;
  /** True once the shared load has resolved (or immediately when there is no tableId). Tables gate
   *  their own "hydrated" flag on this so they never save defaults over a stored view. */
  loaded: boolean;
  /** Debounced persist of this table's view. No-op when there is no tableId. */
  save: (patch: TableViewPatch) => void;
}

export function useTableView(tableId?: string): UseTableView {
  const [view, setView] = useState<TableView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!tableId) {
      setView(null);
      setLoaded(true);
      return;
    }
    let alive = true;
    setLoaded(false);
    loadAllViews().then((all) => {
      if (!alive) return;
      setView(all[tableId] ?? null);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [tableId]);

  // Debounced writer. The pending patch carries its own tableId so a late flush after the table
  // unmounts/navigates still lands on the right key.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ tableId: string; patch: TableViewPatch } | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    // Keep the shared cache in sync so a remount restores the just-saved view without a refetch.
    viewsCache = { ...viewsCache, [p.tableId]: { ...(viewsCache[p.tableId] ?? {}), ...p.patch } as TableView };
    // Best-effort: a persist failure is a background nicety, not a user-facing error.
    void api.saveTableView(p.tableId, p.patch).catch(() => {});
  }, []);

  const save = useCallback(
    (patch: TableViewPatch) => {
      if (!tableId) return;
      pending.current = { tableId, patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [tableId, flush],
  );

  // Flush any pending write when the table unmounts so a quick change right before navigation persists.
  useEffect(() => flush, [flush]);

  // …and when the PAGE goes away. Unmount alone only covers in-app navigation: closing the tab, hitting
  // reload, or quitting the browser tears the page down without ever unmounting a component, so a change
  // made inside the last 600 ms was dropped on the floor — the exact "I changed it, then restarted, and
  // it was gone" case. `visibilitychange → hidden` is the reliable signal (it fires before teardown on
  // every platform, unlike `beforeunload` on mobile Safari); `pagehide` covers the bfcache path.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [flush]);

  return { view, loaded, save };
}
