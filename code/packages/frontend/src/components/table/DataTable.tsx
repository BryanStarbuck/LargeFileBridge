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
  rightHeader?: ReactNode; // e.g. + Add repo
  selection?: {
    selected: Set<string>;
    onChange: (next: Set<string>) => void;
    bulk?: ReactNode; // ⋮ bulk menu
  };
  loading?: boolean;
  empty?: ReactNode;
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
  rightHeader,
  selection,
  loading,
  empty,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
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

  return (
    <div>
      {/* Control row (repos.mdx §3.1) */}
      <div className="flex items-center gap-2 py-2">
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

      {showSort && (
        <Popover>
          {columns
            .filter((c) => c.sortable ?? true)
            .map((c) => {
              const s = sorting.find((x) => x.id === c.id);
              return (
                <button
                  key={c.id}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-slate-100 rounded"
                  onClick={() => setSorting(s && !s.desc ? [{ id: c.id, desc: true }] : [{ id: c.id, desc: false }])}
                >
                  <span>{c.header}</span>
                  <span className="text-black/50">{s ? (s.desc ? "↓ desc" : "↑ asc") : ""}</span>
                </button>
              );
            })}
          <button className="w-full px-3 py-1.5 text-sm text-[var(--lfb-primary)]" onClick={() => setSorting([])}>
            Clear sort
          </button>
        </Popover>
      )}

      {showFilter && (
        <Popover>
          {columns
            .filter((c) => c.filterable ?? true)
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
        <div ref={scrollRef} className="max-h-[65vh] overflow-auto">
          <table className="w-full text-sm border-collapse">
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
                    return (
                      <th
                        key={h.id}
                        className={`py-2 px-2 font-medium ${align === "right" ? "text-right" : ""}`}
                      >
                        {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
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
                    <td className="text-black/30 pr-2">{onRowClick ? "›" : ""}</td>
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

      {/* Count + pagination (default 500) */}
      <div className="flex items-center justify-between py-2 text-sm text-black/60">
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
