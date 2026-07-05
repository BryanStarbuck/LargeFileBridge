// The house table (charter: all tables are TanStack tables). Flat/chromeless, with the standard
// control row (search left; icon-only Filter ⛛ + Sort ⇅ right) and pagination default 500.
//
// Performance (performance.mdx):
//  * P-01 row windowing — the body scrolls inside a bounded container and only the rows intersecting
//    the viewport are in the DOM, so a 500/5000-row page costs ~30 <tr> not 500/5000.
//  * P-03 the selection checkbox column is rendered by hand (leading cell), NOT baked into the TanStack
//    column model, so `tanColumns` no longer depends on the unstable `selection` object.
//  * P-05 the search box is debounced — filtering the dataset runs once per pause, not per keypress.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
} from "@tanstack/react-table";
import { Search, Filter, ArrowUpDown } from "lucide-react";
import { useDebounced } from "../../lib/useDebounced.js";
import { useWindowedRows } from "./useWindowedRows.js";
import type { LfbColumn } from "./types.js";

interface DataTableProps<T> {
  data: T[];
  columns: LfbColumn<T>[];
  searchKeys: (keyof T & string)[] | ((row: T) => string);
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  itemNoun?: string;
  // The trailing per-row ⋮ kebab (menus.mdx §3) — EVERY table passes one so EVERY row has it. Returns
  // the row's kebab component (EntityKebab / RepoKebab / PeerKebab / PinKebab / a page-local kebab).
  rowMenu?: (row: T) => ReactNode;
  rightHeader?: ReactNode; // e.g. + Add repo
  selection?: {
    selected: Set<string>;
    onChange: (next: Set<string>) => void;
    bulk?: ReactNode; // ⋮ bulk menu
  };
  loading?: boolean;
  empty?: ReactNode;
  // Full-page-height rule (repos.mdx §3.3.1 / charter Tables): when true (default), the body scroll
  // region flexes to fill down to the bottom of the viewport (no dead white space in a tall window);
  // the page must be a full-height flex column for this to have room. Pass FALSE on any page that
  // renders content BELOW the table (a details disclosure, a footer summary) so that content stays
  // visible — then the body keeps a bounded height instead.
  fillHeight?: boolean;
  // The default multi-level sort (tables.mdx §3.4) — an ordered list of up to three keys applied on
  // first load and restored by "Clear sort". Bookmark-bearing tables pass Bookmarked-desc first, then
  // their natural secondary (e.g. Repos → [{bookmark,desc},{name,asc}]). Omitted → no default sort.
  defaultSort?: SortingState;
}

const PAGE_SIZES = [100, 250, 500]; // P-01: no "All" (Number.MAX_SAFE_INTEGER) footgun.
const ROW_H = 41; // fixed body-row height the windowing math relies on (px).

export function DataTable<T>({
  data,
  columns,
  searchKeys,
  getRowId,
  onRowClick,
  itemNoun = "items",
  rowMenu,
  rightHeader,
  selection,
  loading,
  empty,
  fillHeight = true,
  defaultSort,
}: DataTableProps<T>) {
  // Multi-level sort (tables.mdx §3): the TanStack `sorting` array IS the ordered primary/secondary/
  // tertiary list — index 0 = primary. The dropdown priority slots and header clicks both drive it.
  const [sorting, setSorting] = useState<SortingState>(() => defaultSort ?? []);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [search, setSearch] = useState(""); // controlled input value (instant)
  const globalFilter = useDebounced(search, 200); // what the table actually filters on (P-05)
  const [pageSize, setPageSize] = useState(500);
  const [showSort, setShowSort] = useState(false);
  const [showFilter, setShowFilter] = useState(false);

  const searchText = useCallback(
    (row: T): string =>
      typeof searchKeys === "function"
        ? searchKeys(row)
        : searchKeys.map((k) => String(row[k] ?? "")).join(" "),
    [searchKeys],
  );

  // Column model — selection is NOT part of it (P-03), so this only rebuilds when the caller's
  // logical columns change, never when a checkbox toggles.
  const tanColumns = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((c) => ({
        id: c.id,
        header: c.header,
        accessorFn: (row) => c.accessor(row),
        enableSorting: c.sortable ?? true,
        filterFn: (row, _id, value) => {
          if (value == null || value === "") return true;
          const v = c.accessor(row.original);
          if (c.kind === "enum") return String(v) === String(value);
          if (c.kind === "int" || c.kind === "bytes") return Number(v) >= Number(value);
          return String(v ?? "").toLowerCase().includes(String(value).toLowerCase());
        },
        cell: ({ row }) => (c.cell ? c.cell(row.original) : String(c.accessor(row.original) ?? "")),
        meta: { align: c.align },
      })),
    [columns],
  );

  const table = useReactTable({
    data,
    columns: tanColumns,
    state: { sorting, columnFilters, globalFilter, pagination: { pageIndex: 0, pageSize } },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    globalFilterFn: (row, _id, filterValue) =>
      searchText(row.original).toLowerCase().includes(String(filterValue).toLowerCase()),
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: true,
  });

  const filtersActive = columnFilters.length > 0;
  const sortActive = sorting.length > 0;

  // Promoted "Bookmarked only" filter (tables.mdx §2): if the caller declares a leading `bookmark`
  // column (enum yes/no, as Repos does), the filter dropdown pins a "Bookmarked only" checkbox at the
  // very top. Turning it on ANDs a `bookmark === "yes"` column filter; the column is then hidden from
  // the per-column filter list below (no duplicate control). Absent that column, nothing changes.
  const bookmarkColId = columns.find((c) => c.id === "bookmark")?.id;
  const bookmarkOnly = !!bookmarkColId && columnFilters.some((f) => f.id === bookmarkColId && f.value === "yes");
  const setBookmarkOnly = (on: boolean) =>
    setColumnFilters((prev) => {
      const rest = prev.filter((f) => f.id !== bookmarkColId);
      return on ? [...rest, { id: bookmarkColId!, value: "yes" }] : rest;
    });
  const rowCount = table.getFilteredRowModel().rows.length;
  const pageRows = table.getRowModel().rows;

  // Selection — stable callbacks so toggling a row never closes over the whole Set (P-02).
  const sel = selection?.selected;
  const onSelChange = selection?.onChange;
  const toggleOne = useCallback(
    (id: string, on: boolean) => {
      if (!sel || !onSelChange) return;
      const next = new Set(sel);
      on ? next.add(id) : next.delete(id);
      onSelChange(next);
    },
    [sel, onSelChange],
  );
  const pageIds = useMemo(() => pageRows.map((r) => getRowId(r.original)), [pageRows, getRowId]);
  const allOnPage = !!sel && pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const toggleAll = useCallback(
    (on: boolean) => {
      if (!sel || !onSelChange) return;
      const next = new Set(sel);
      for (const id of pageIds) on ? next.add(id) : next.delete(id);
      onSelChange(next);
    },
    [sel, onSelChange, pageIds],
  );

  // Windowing (P-01): render only the rows on screen inside a bounded scroll container.
  const scrollRef = useRef<HTMLDivElement>(null);
  const win = useWindowedRows(pageRows.length, ROW_H, scrollRef);
  const visibleRows = pageRows.slice(win.start, win.end);

  // select cell + data cells + trailing chevron cell
  const colSpan = (selection ? 1 : 0) + tanColumns.length + 1;

  // Fixed column widths (charter Tables / devices.mdx §6): when any column declares a `width`, switch to
  // a fixed table layout and emit a <colgroup> so wide-enough columns keep their width instead of being
  // squeezed. Columns with no width share what's left. The leading select + trailing kebab get their own.
  const hasWidths = columns.some((c) => c.width);

  return (
    // Full-page-height (repos.mdx §3.3.1): fill mode makes this a flex column so the body scroll
    // region below grows to the bottom of the viewport; the control row + footer stay pinned (shrink-0).
    <div className={fillHeight ? "flex min-h-0 flex-1 flex-col" : ""}>
      {/* Control row (repos.mdx §3.1) */}
      <div className="flex shrink-0 items-center gap-2 py-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-black/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search…"
            className="w-full pl-8 pr-2 py-1.5 rounded-md border border-[var(--lfb-border)] text-sm outline-none focus:border-[var(--lfb-primary)]"
          />
        </div>
        <div className="flex-1" />
        {selection?.bulk}
        <IconButton
          active={sortActive}
          title="Sort"
          onClick={() => {
            setShowSort((s) => !s);
            setShowFilter(false);
          }}
        >
          <ArrowUpDown className="h-4 w-4" />
        </IconButton>
        <IconButton
          active={filtersActive}
          title="Filter"
          onClick={() => {
            setShowFilter((s) => !s);
            setShowSort(false);
          }}
        >
          <Filter className="h-4 w-4" />
        </IconButton>
        {rightHeader}
      </div>

      {/* Multi-level sort dropdown (tables.mdx §3.1): each sortable column shows its asc/desc caret on
          the left and 1st/2nd/3rd priority markers on the right. Clicking a marker inserts the column
          at that slot and cascade-demotes the rest (no two columns share a priority, list capped at 3).
          Clear sort falls back to the caller's defaultSort (§3.2/§3.4). */}
      {showSort && (
        <Popover>
          <div className="flex items-center justify-between px-3 pb-1 pt-0.5 text-[11px] uppercase tracking-wide text-black/40">
            <span>Column</span>
            <span>Priority</span>
          </div>
          {columns
            .filter((c) => c.sortable ?? true)
            .map((c) => {
              const idx = sorting.findIndex((x) => x.id === c.id);
              const s = idx >= 0 ? sorting[idx] : undefined;
              return (
                <div key={c.id} className="flex w-full items-center gap-2 px-3 py-1 text-sm">
                  <span className="flex-1 truncate">{c.header}</span>
                  <button
                    className={`w-14 shrink-0 text-left ${s ? "text-black/60" : "text-black/25"}`}
                    disabled={!s}
                    onClick={() => setSorting((prev) => toggleDir(prev, c.id))}
                    title={s ? "Toggle ascending / descending" : "Assign a priority first"}
                  >
                    {s ? (s.desc ? "↓ desc" : "↑ asc") : "—"}
                  </button>
                  <div className="flex shrink-0 gap-0.5">
                    {[0, 1, 2].map((slot) => (
                      <button
                        key={slot}
                        onClick={() => setSorting((prev) => assignPriority(prev, c.id, slot, s?.desc ?? false))}
                        className={`rounded px-1.5 py-0.5 text-[11px] ${
                          idx === slot
                            ? "bg-[var(--lfb-primary)] text-white"
                            : "text-black/40 hover:bg-slate-100"
                        }`}
                      >
                        {["1st", "2nd", "3rd"][slot]}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-[var(--lfb-primary)]"
            onClick={() => setSorting(defaultSort ?? [])}
          >
            Clear sort
          </button>
        </Popover>
      )}

      {showFilter && (
        <Popover>
          {bookmarkColId && (
            <>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={bookmarkOnly}
                  onChange={(e) => setBookmarkOnly(e.target.checked)}
                />
                Bookmarked only
              </label>
              <div className="my-1 border-t border-[var(--lfb-border)]" />
            </>
          )}
          {columns
            .filter((c) => (c.filterable ?? true) && c.id !== bookmarkColId)
            .map((c) => {
              const current = columnFilters.find((f) => f.id === c.id)?.value ?? "";
              return (
                <div key={c.id} className="px-3 py-1.5 flex items-center gap-2 text-sm">
                  <span className="w-24 shrink-0 text-black/70">{c.header}</span>
                  {c.kind === "enum" ? (
                    <select
                      className="flex-1 border border-[var(--lfb-border)] rounded px-1 py-0.5"
                      value={String(current)}
                      onChange={(e) => setColumnFilter(setColumnFilters, c.id, e.target.value)}
                    >
                      <option value="">any</option>
                      {(c.filterOptions ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="flex-1 border border-[var(--lfb-border)] rounded px-1 py-0.5"
                      placeholder={c.kind === "int" || c.kind === "bytes" ? "≥ value" : "contains…"}
                      value={String(current)}
                      onChange={(e) => setColumnFilter(setColumnFilters, c.id, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          <button className="w-full px-3 py-1.5 text-sm text-[var(--lfb-primary)]" onClick={() => setColumnFilters([])}>
            Clear filters
          </button>
        </Popover>
      )}

      {/* The flat, chromeless data surface — body scrolls inside a bounded, windowed container. */}
      {loading ? (
        <SkeletonRows cols={tanColumns.length} />
      ) : rowCount === 0 && empty ? (
        <div className="py-10">{empty}</div>
      ) : (
        <div
          ref={scrollRef}
          className={`overflow-auto ${fillHeight ? "min-h-0 flex-1" : "max-h-[65vh]"}`}
        >
          <table className={`w-full text-sm border-collapse ${hasWidths ? "table-fixed" : ""}`}>
            {hasWidths && (
              <colgroup>
                {selection && <col style={{ width: "2rem" }} />}
                {columns.map((c) => (
                  <col key={c.id} style={c.width ? { width: c.width } : undefined} />
                ))}
                <col style={{ width: "3rem" }} />
              </colgroup>
            )}
            <thead className="sticky top-0 z-10 bg-white">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-[var(--lfb-border)] text-left text-black/60">
                  {selection && (
                    <th className="w-8 py-2 px-2">
                      <input
                        type="checkbox"
                        checked={allOnPage}
                        onChange={(e) => toggleAll(e.target.checked)}
                      />
                    </th>
                  )}
                  {hg.headers.map((h) => {
                    const align = (h.column.columnDef.meta as { align?: string } | undefined)?.align;
                    // Header-click sort (repos.mdx §3.1 / tables.mdx §3.3): clicking a header promotes
                    // that column to PRIMARY (1st), cascade-demoting the others; clicking the same header
                    // (already primary) toggles its asc ↔ desc. Same `sorting` state as the Sort dropdown
                    // so the two stay in lock-step. A small caret marks each column in the active sort.
                    const canSort = h.column.getCanSort();
                    const dir = sorting.find((x) => x.id === h.column.id);
                    const toggleSort = () => setSorting((prev) => promoteToPrimary(prev, h.column.id));
                    return (
                      <th
                        key={h.id}
                        onClick={canSort ? toggleSort : undefined}
                        aria-sort={dir ? (dir.desc ? "descending" : "ascending") : undefined}
                        className={`py-2 px-2 font-medium ${align === "right" ? "text-right" : ""} ${
                          canSort ? "cursor-pointer select-none hover:text-black" : ""
                        }`}
                      >
                        {h.isPlaceholder ? null : (
                          <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {dir && (
                              <span className="text-[var(--lfb-primary)]" aria-hidden>
                                {dir.desc ? "↓" : "↑"}
                              </span>
                            )}
                          </span>
                        )}
                      </th>
                    );
                  })}
                  <th />
                </tr>
              ))}
            </thead>
            <tbody>
              {win.padTop > 0 && (
                <tr aria-hidden style={{ height: win.padTop }}>
                  <td colSpan={colSpan} />
                </tr>
              )}
              {visibleRows.map((row) => {
                const id = getRowId(row.original);
                return (
                  <tr
                    key={row.id}
                    onClick={() => onRowClick?.(row.original)}
                    style={{ height: ROW_H }}
                    className={`border-b border-[var(--lfb-border)] ${onRowClick ? "cursor-pointer hover:bg-slate-100" : ""}`}
                  >
                    {selection && (
                      <td className="px-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selection.selected.has(id)}
                          onChange={(e) => toggleOne(id, e.target.checked)}
                        />
                      </td>
                    )}
                    {row.getVisibleCells().map((cell) => {
                      const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align;
                      return (
                        <td
                          key={cell.id}
                          className={`py-2 px-2 ${align === "right" ? "text-right tabular-nums" : ""}`}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                    {/* Trailing control column (menus.mdx §3): the row's ⋮ kebab, right-aligned. The
                        kebab button stops click propagation, so it opens the menu without opening the
                        row; the chevron still reads as "this row navigates". */}
                    <td className="pr-2">
                      <div className="flex items-center justify-end gap-1">
                        {onRowClick && <span className="text-black/30">›</span>}
                        {rowMenu?.(row.original)}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {win.padBottom > 0 && (
                <tr aria-hidden style={{ height: win.padBottom }}>
                  <td colSpan={colSpan} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Count + pagination (default 500) — pinned below the scrolling body in fill mode. */}
      <div className="flex shrink-0 items-center justify-between py-2 text-sm text-black/60">
        <span>
          {rowCount} {itemNoun}
        </span>
        <div className="flex items-center gap-3">
          <span>
            page {table.getState().pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())}
          </span>
          <div className="flex gap-1">
            <button
              className="px-2 py-0.5 border border-[var(--lfb-border)] rounded disabled:opacity-40"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              ‹
            </button>
            <button
              className="px-2 py-0.5 border border-[var(--lfb-border)] rounded disabled:opacity-40"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              ›
            </button>
          </div>
          <select
            className="border border-[var(--lfb-border)] rounded px-1 py-0.5"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

// ── Multi-level sort helpers (tables.mdx §3.2) ──────────────────────────────────
// Assign `id` to priority `slot` (0=1st,1=2nd,2=3rd): drop any existing occurrence of `id`, insert it
// at `slot`, and cap at three — so lower-priority columns cascade down one and no two ever share a
// slot (the user's rule: "demote everything else down one, so there's no duplicate first priority").
function assignPriority(sorting: SortingState, id: string, slot: number, desc: boolean): SortingState {
  const without = sorting.filter((s) => s.id !== id);
  without.splice(slot, 0, { id, desc });
  return without.slice(0, 3);
}

// Toggle asc↔desc for a column already in the sort, keeping its priority slot unchanged.
function toggleDir(sorting: SortingState, id: string): SortingState {
  return sorting.map((s) => (s.id === id ? { ...s, desc: !s.desc } : s));
}

// Header click (tables.mdx §3.3): if the column is already primary, flip its direction; otherwise make
// it primary (slot 0), preserving its direction if it was already in the sort, and cascade-demote.
function promoteToPrimary(sorting: SortingState, id: string): SortingState {
  if (sorting[0]?.id === id) return [{ id, desc: !sorting[0].desc }, ...sorting.slice(1)];
  const existing = sorting.find((s) => s.id === id);
  return assignPriority(sorting, id, 0, existing?.desc ?? false);
}

function setColumnFilter(
  set: React.Dispatch<React.SetStateAction<ColumnFiltersState>>,
  id: string,
  value: string,
) {
  set((prev) => {
    const rest = prev.filter((f) => f.id !== id);
    return value === "" ? rest : [...rest, { id, value }];
  });
}

function IconButton({
  children,
  active,
  title,
  onClick,
}: {
  children: ReactNode;
  active: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`p-1.5 rounded-md hover:bg-slate-100 ${active ? "text-[var(--lfb-primary)]" : "text-black/70"}`}
    >
      {children}
    </button>
  );
}

function Popover({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <div className="absolute right-0 z-10 mt-1 w-72 rounded-lg border border-[var(--lfb-border)] bg-white shadow-lg py-1">
        {children}
      </div>
    </div>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex gap-2 py-2 border-b border-[var(--lfb-border)]">
          {Array.from({ length: cols }).map((__, j) => (
            <div key={j} className="h-4 bg-slate-100 rounded flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
