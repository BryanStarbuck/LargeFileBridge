// The house table (charter: all tables are TanStack tables). Flat/chromeless, with the standard
// control row (search left; icon-only Filter ⛛ + Sort ⇅ right) and pagination default 500.
//
// Performance (performance.mdx):
//  * P-01 row windowing — the body scrolls inside a bounded container and only the rows intersecting
//    the viewport are in the DOM, so a 500/5000-row page costs ~30 <tr> not 500/5000.
//  * P-03 the selection checkbox column is rendered by hand (leading cell), NOT baked into the TanStack
//    column model, so `tanColumns` no longer depends on the unstable `selection` object.
//  * P-05 the search box is debounced — filtering the dataset runs once per pause, not per keypress.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
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
import { Search, Filter, ArrowUpDown, Columns3 } from "lucide-react";
import { useDebounced } from "../../lib/useDebounced.js";
import { setOptionPreviewTarget } from "../preview/OptionImagePreview.js";
import { useWindowedRows } from "./useWindowedRows.js";
import { useTableView } from "../../api/useTableView.js";
import type { LfbColumn } from "./types.js";
import {
  evalFileFilter,
  parseFileFilter,
  selectionsFromAst,
  setFieldInExpr,
  type FileFilterFieldId,
  type FileFilterRowValue,
  type FilterNode,
} from "./fileFilter.js";
import { FileFilterClauseBar, FileFilterPanel } from "./FileFilterPanel.js";
import { Popover } from "./Popover.js";

interface DataTableProps<T> {
  data: T[];
  columns: LfbColumn<T>[];
  searchKeys: (keyof T & string)[] | ((row: T) => string);
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  // The URL a row "is" (tables.mdx §4d). Supply it alongside `onRowClick` on any table whose rows
  // navigate: ⌘/Ctrl-click, shift-click and middle-click then open it in a new tab/window the way a real
  // link would, instead of being swallowed by the row's JS click handler. Same-tab clicks still go
  // through `onRowClick`, so routing/state behaviour is unchanged.
  rowHref?: (row: T) => string;
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
  // Promoted "Large files only" toggle (tables.mdx §2.9) — rendered on the rail above the table ONLY when
  // provided (file tables pass it; non-file tables omit it). `rowIsLarge` returns FALSE for the small
  // analysis-only rows the toggle hides; `defaultOn` seeds it (per-tab — OCR seeds off, ocr.mdx §11.1.1).
  largeOnly?: { rowIsLarge: (row: T) => boolean; defaultOn: boolean };
  // File-type facet (tables.mdx §2.10) — value-visibility checkboxes over the file's media class
  // (Images/Videos/Audio/PDFs/Other), rendered as a "File type" section INSIDE the Filter ⛛ dropdown.
  // `valueOf` maps a row to its class key. The FOUR common kinds (Images/Videos/Audio/PDFs) are always
  // listed so the user can filter to them without expanding; a "More types…" disclosure reveals the rest
  // (Other). An "All kinds" checkbox clears the filter. Images/Videos/Audio/PDFs start checked; Other unchecked.
  fileTypeFacet?: { valueOf: (row: T) => string };
  // The §2.11 file filter (tables.mdx §2.11) — segmented All/Not-yet/Done controls in a two-column-wide
  // Filter ⛛ dropdown plus the editable boolean clause bar, persisted per user as the ONE expression
  // string. `fields` is this surface's honest subset in display order, each with the row's answer for
  // that axis; `defaultExpr` seeds a fresh view (e.g. "size = only_large" — the §2.9 default; the OCR
  // tab seeds ""). When a `size` field is present the rail "Large files only" checkbox becomes its
  // shortcut (checked ⇔ only_large) instead of the separate `largeOnly` state.
  fileFilter?: {
    fields: { id: FileFilterFieldId; valueOf: (row: T) => FileFilterRowValue }[];
    defaultExpr?: string;
  };
  // Option-key floating image preview (option_image_preview.mdx §5): return the row's ABSOLUTE path when
  // the row is an image whose bytes are on this computer, else null. When provided, hovering a row
  // publishes that target so holding Option floats the image preview; the whole row is the hover surface.
  hoverPreview?: (row: T) => string | null;
  // Optional extra per-row class (e.g. the Videos review tables tint every row of the SELECTED group,
  // duplicates.mdx §3.2, and mute their slim group-header rows). Appended after the base row classes.
  rowClassName?: (row: T) => string;
  // Stable id for this table (tables.mdx — remembered view state). When set, the table's sort, column
  // filters, search, hidden columns, and promoted facet state are persisted per logged-in user (in the
  // per-user config.yaml `tables:` record) and restored on the next visit. Keep it unique per surface —
  // e.g. "repos", "storages", "repo-files:<tab>". Omit it and the table works exactly as before but
  // remembers nothing across visits.
  tableId?: string;
}

// The File-type facet vocabulary (tables.mdx §2.10) — labels + the one class that starts UNCHECKED (Other).
// Keys match the shared `fileTypeForName()` classifier.
const FILE_TYPE_LABELS: Record<string, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  pdf: "PDFs",
  other: "Other",
};
const FILE_TYPE_ORDER = ["image", "video", "audio", "pdf", "other"];
// The COMMON kinds always shown in the facet without expanding (product owner's rule): image, video, audio,
// PDF. OCR in particular is "often done with PDFs also", so PDF sits alongside the media kinds up front.
const FILE_TYPE_COMMON = ["image", "video", "audio", "pdf"];
// Everything else lives behind the "More types…" disclosure — today just Other.
const FILE_TYPE_EXTRA = FILE_TYPE_ORDER.filter((t) => !FILE_TYPE_COMMON.includes(t));
const FILE_TYPE_DEFAULT_OFF = ["other"]; // the opt-in "add other types" bucket (product owner's rule)

// Which per-column enum filter a §2.11 field supersedes (the column keeps existing; only its
// duplicate select in the Filter popover is dropped — tables.mdx §2.11).
const FF_COVERED_COLUMN_BY_FIELD: Partial<Record<FileFilterFieldId, string>> = {
  transcribe: "transcribe",
  ai_description: "describe",
  ocr: "ocr",
  // The bare "compressible" field is retired — the per-kind trio covers the compress column instead.
  compressible_videos: "compress",
  compressible_images: "compress",
  compressible_audio: "compress",
};

const PAGE_SIZES = [100, 250, 500]; // P-01: no "All" (Number.MAX_SAFE_INTEGER) footgun.
const ROW_H = 41; // fixed body-row height the windowing math relies on (px).

export function DataTable<T>({
  data,
  columns,
  searchKeys,
  getRowId,
  onRowClick,
  rowHref,
  itemNoun = "items",
  rowMenu,
  rightHeader,
  selection,
  loading,
  empty,
  fillHeight = true,
  defaultSort,
  largeOnly,
  fileTypeFacet,
  fileFilter,
  hoverPreview,
  rowClassName,
  tableId,
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
  const [showColumns, setShowColumns] = useState(false);
  // Manual show/hide (charter Tables — the Columns ⚏ dropdown): the set of column ids the user turned
  // OFF. Presentation-only and layered ON TOP of the responsive auto-hide: a manually-hidden column is
  // removed before the responsive budget runs; a hidden column can still be sorted/filtered (its row
  // stays in the Sort/Filter dropdowns, which iterate the full `columns`).
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => new Set());
  // Promoted "Large files only" toggle (tables.mdx §2.9). The table remounts per tab (OneRepoPage keys it
  // by tab), so this seed is re-read on every tab switch — OCR opens with it OFF.
  const [largeOnlyOn, setLargeOnlyOn] = useState(() => largeOnly?.defaultOn ?? false);
  // File-type facet (tables.mdx §2.10) — the set of UNCHECKED (hidden) classes. Other starts hidden.
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(() => new Set(FILE_TYPE_DEFAULT_OFF));
  // The "More types…" disclosure inside the Filter dropdown — collapsed by default so only the four common
  // kinds show without expanding (tables.mdx §2.10).
  const [showMoreTypes, setShowMoreTypes] = useState(false);

  // ── The §2.11 file filter (tables.mdx §2.11) ──────────────────────────────────
  // ONE expression string is the whole state: the segmented controls and the clause bar are two views
  // of it, it drives the row predicate, and it is what persists (§2.11.5). Invalid text keeps the LAST
  // VALID expression applied (§2.11.4) — `ffApplied` trails `ffParsed` only on successful parses.
  const ffFieldIds = useMemo<FileFilterFieldId[]>(
    () => (fileFilter ? fileFilter.fields.map((f) => f.id) : []),
    [fileFilter],
  );
  const [fileFilterText, setFileFilterText] = useState(() => fileFilter?.defaultExpr ?? "");
  const ffParsed = useMemo(() => parseFileFilter(fileFilterText, ffFieldIds), [fileFilterText, ffFieldIds]);
  const [ffApplied, setFfApplied] = useState<FilterNode | null>(null);
  useEffect(() => {
    if (ffParsed.ok) setFfApplied(ffParsed.ast);
  }, [ffParsed]);
  // The segmented controls' highlights — from the current text when it parses, else the applied one.
  const ffSelections = useMemo(
    () => selectionsFromAst(ffParsed.ok ? ffParsed.ast : ffApplied),
    [ffParsed, ffApplied],
  );
  // A segmented click rewrites ONLY that field's clause (canonical while canonical, surgical once
  // hand-edited — tables.mdx §2.11.4).
  const setFfField = useCallback(
    (field: FileFilterFieldId, value: string) =>
      setFileFilterText((t) => setFieldInExpr(t, field, value, ffFieldIds)),
    [ffFieldIds],
  );
  const ffValueOf = useMemo(
    () => new Map(fileFilter ? fileFilter.fields.map((f) => [f.id, f.valueOf] as const) : []),
    [fileFilter],
  );
  const ffHasSize = ffFieldIds.includes("size");
  // Per-column enum selects duplicated by a §2.11 field are dropped from the popover's long tail —
  // one control per axis (the enum columns keep filtering via the expression instead).
  const ffCoveredCols = useMemo(
    () =>
      new Set(
        ffFieldIds
          .map((f) => FF_COVERED_COLUMN_BY_FIELD[f])
          .filter((c): c is string => c !== undefined),
      ),
    [ffFieldIds],
  );

  // The file-type classes actually present in the data — only these render as chips (tables.mdx §2.8/§2.10).
  const presentTypes = useMemo(() => {
    if (!fileTypeFacet) return [] as string[];
    const seen = new Set<string>();
    for (const r of data) seen.add(fileTypeFacet.valueOf(r));
    return FILE_TYPE_ORDER.filter((t) => seen.has(t));
  }, [data, fileTypeFacet]);

  // Apply the two promoted rail controls BEFORE TanStack sees the rows (tables.mdx §2.9/§2.10): Large-only
  // hides the analysis-only rows; the file-type facet hides the unchecked classes. Everything downstream
  // (search, column filters, sort, windowing, count) then operates on this narrowed set.
  const shownData = useMemo(() => {
    let d = data;
    if (largeOnly && largeOnlyOn) d = d.filter(largeOnly.rowIsLarge);
    if (fileTypeFacet && hiddenTypes.size > 0)
      d = d.filter((r) => !hiddenTypes.has(fileTypeFacet.valueOf(r)));
    // The §2.11 file-filter expression (tables.mdx §2.11.4) — the last VALID expression, so a
    // half-typed clause in the bar never blanks the table.
    if (fileFilter && ffApplied)
      d = d.filter((r) => evalFileFilter(ffApplied, (fid) => ffValueOf.get(fid)?.(r) ?? "na"));
    return d;
  }, [data, largeOnly, largeOnlyOn, fileTypeFacet, hiddenTypes, fileFilter, ffApplied, ffValueOf]);

  // Toggle a file-type class, honoring the last-value rule (tables.mdx §2.1): the final CHECKED present
  // class can't be unchecked (that would only ever blank the table).
  const toggleType = useCallback(
    (t: string) =>
      setHiddenTypes((prev) => {
        const next = new Set(prev);
        if (next.has(t)) {
          next.delete(t);
          return next;
        }
        const stillVisible = presentTypes.filter((x) => x !== t && !next.has(x));
        if (stillVisible.length === 0) return prev; // last visible class — refuse
        next.add(t);
        return next;
      }),
    [presentTypes],
  );

  // The last PRESENT visible class can't be unchecked (tables.mdx §2.1) — that would only ever blank the
  // table. A common kind that's ABSENT from the data is NOT guarded: unchecking it is a harmless no-op, and
  // forbidding it would confuse (the box would refuse for no visible reason).
  const isLastVisibleType = useCallback(
    (t: string): boolean => {
      if (hiddenTypes.has(t)) return false;
      if (!presentTypes.includes(t)) return false;
      return presentTypes.filter((x) => !hiddenTypes.has(x)).length === 1;
    },
    [presentTypes, hiddenTypes],
  );

  const searchText = useCallback(
    (row: T): string =>
      typeof searchKeys === "function"
        ? searchKeys(row)
        : searchKeys.map((k) => String(row[k] ?? "")).join(" "),
    [searchKeys],
  );

  // Toggle a column's manual visibility (charter Tables — Columns ⚏ dropdown). Honors a last-value rule
  // like the file-type facet: the final visible column can't be hidden (that would only ever blank the
  // table). Turning a column back ON just removes it from the hidden set.
  const toggleCol = useCallback(
    (id: string) =>
      setHiddenCols((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          return next;
        }
        if (columns.length - next.size <= 1) return prev; // last visible column — refuse
        next.add(id);
        return next;
      }),
    [columns.length],
  );

  // ── Remembered view state (tables.mdx) ────────────────────────────────────────
  // When a tableId is set, restore the user's saved sort/filters/search/hidden-columns/facets on mount
  // and persist them (debounced) on every change. `hydrated` gates saving so the first render never
  // writes defaults over a stored view; it flips true only AFTER the stored view is applied, so the
  // follow-up save writes the same values back (idempotent) instead of clobbering them.
  const { view: storedView, loaded: viewLoaded, save: saveView } = useTableView(tableId);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!tableId || !viewLoaded || hydrated) return;
    const v = storedView;
    if (v) {
      const colIds = new Set(columns.map((c) => c.id));
      const sort = (v.sort ?? [])
        .filter((s) => colIds.has(s.col))
        .map((s) => ({ id: s.col, desc: s.dir === "desc" }));
      if (sort.length) setSorting(sort);
      const cf = Object.entries(v.filters ?? {})
        .filter(([id]) => colIds.has(id))
        .map(([id, value]) => ({ id, value }));
      if (cf.length) setColumnFilters(cf);
      if (v.search) setSearch(v.search);
      const hc = (v.hidden_columns ?? []).filter((id) => colIds.has(id));
      if (hc.length) setHiddenCols(new Set(hc));
      if (typeof v.large_only === "boolean") setLargeOnlyOn(v.large_only);
      if (Array.isArray(v.hidden_types)) setHiddenTypes(new Set(v.hidden_types));
      // §2.11.5: a stored "" is a deliberate cleared state and is restored as such; an ABSENT key
      // leaves the surface's seed (defaultExpr) in place — except the one migration below.
      if (typeof v.file_filter === "string") setFileFilterText(v.file_filter);
      // Migration: a view saved before §2.11 has no file_filter but may carry the old promoted
      // "Large files only" boolean — honor it once as the equivalent size clause so nobody's saved
      // "show me the small files too" silently reverts to the seed.
      else if (ffHasSize && typeof v.large_only === "boolean")
        setFileFilterText(v.large_only ? "size = only_large" : "");
    }
    setHydrated(true);
  }, [tableId, viewLoaded, hydrated, storedView, columns, ffHasSize]);

  useEffect(() => {
    if (!tableId || !hydrated) return;
    saveView({
      sort: sorting.map((s) => ({ col: s.id, dir: s.desc ? "desc" : "asc" })),
      filters: Object.fromEntries(columnFilters.map((f) => [f.id, String(f.value)])),
      search,
      hidden_columns: [...hiddenCols],
      ...(largeOnly ? { large_only: largeOnlyOn } : {}),
      ...(fileTypeFacet ? { hidden_types: [...hiddenTypes] } : {}),
      ...(fileFilter ? { file_filter: fileFilterText } : {}),
    });
  }, [
    tableId,
    hydrated,
    sorting,
    columnFilters,
    search,
    hiddenCols,
    largeOnlyOn,
    hiddenTypes,
    largeOnly,
    fileTypeFacet,
    fileFilter,
    fileFilterText,
    saveView,
  ]);

  // Responsive column priority (repos.mdx §3.2.1 / tables.mdx §4a): measure the container and hide the
  // lowest-priority columns until the min-width budget fits — so a cell never wraps to a second line.
  // The BODY/HEAD render from `visibleColumns`; the Sort/Filter dropdowns keep using the full `columns`
  // so a hidden column can still be sorted/filtered.
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerW = useContainerWidth(wrapRef);
  const hiddenCount = columns.filter((c) => c.priority !== undefined).length > 0; // any priorities set?
  // Manual show/hide (Columns ⚏ dropdown) is applied FIRST — the user's explicit "off" wins — then the
  // responsive budget runs over what's left. So a column the user hid never comes back on a wide window,
  // and the responsive layer only ever hides more, never re-shows a manually-hidden column.
  const manualColumns = useMemo(
    () => (hiddenCols.size ? columns.filter((c) => !hiddenCols.has(c.id)) : columns),
    [columns, hiddenCols],
  );
  const visibleColumns = useMemo(
    () => (hiddenCount ? computeVisibleColumns(manualColumns, containerW, !!selection) : manualColumns),
    [manualColumns, containerW, selection, hiddenCount],
  );

  // Column model — selection is NOT part of it (P-03), so this only rebuilds when the caller's
  // logical columns change, never when a checkbox toggles.
  const tanColumns = useMemo<ColumnDef<T>[]>(
    () =>
      visibleColumns.map((c) => ({
        id: c.id,
        // Icon columns render `headerCell` (a glyph) in the <thead>; text columns render their label.
        // TanStack's `header` accepts a string OR a render function (not a bare node), so wrap the node.
        header: c.headerCell != null ? () => c.headerCell : c.header,
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
        meta: { align: c.align, tight: c.tight },
      })),
    [visibleColumns],
  );

  const table = useReactTable({
    data: shownData,
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

  // The filter icon lights when ANY filter is active — column filters OR the promoted rail controls
  // (Large-only on, or any present file-type class unchecked), so the icon stays the single honest
  // "something is filtered" indicator (tables.mdx §2.3/§2.9).
  const facetActive =
    (!!largeOnly && largeOnlyOn) ||
    (!!fileTypeFacet && presentTypes.some((t) => hiddenTypes.has(t))) ||
    (!!fileFilter && ffApplied !== null); // any §2.11 clause lights the icon (tables.mdx §2.11.4)
  const filtersActive = columnFilters.length > 0 || facetActive;
  const sortActive = sorting.length > 0;
  const columnsActive = hiddenCols.size > 0; // the Columns icon lights when any column is hidden

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
  const hasWidths = visibleColumns.some((c) => c.width);

  return (
    // Full-page-height (repos.mdx §3.3.1): fill mode makes this a flex column so the body scroll
    // region below grows to the bottom of the viewport; the control row + footer stay pinned (shrink-0).
    // wrapRef is measured for responsive column hiding (repos.mdx §3.2.1).
    <div ref={wrapRef} className={fillHeight ? "flex min-h-0 flex-1 flex-col" : ""}>
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
            setShowColumns(false);
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
            setShowColumns(false);
          }}
        >
          <Filter className="h-4 w-4" />
        </IconButton>
        {/* Columns ⚏ (charter Tables) — show/hide which columns render; the badge reads shown/total. */}
        <IconButton
          active={columnsActive}
          title="Columns"
          onClick={() => {
            setShowColumns((s) => !s);
            setShowSort(false);
            setShowFilter(false);
          }}
        >
          <Columns3 className="h-4 w-4" />
        </IconButton>
        {rightHeader}
      </div>

      {/* The facet rail (tables.mdx §2.2/§2.9) — the always-visible promoted "Large files only" toggle above
          the table (the File-type facet now lives inside the Filter ⛛ dropdown, §2.10). On a §2.11 table
          the checkbox is the SHORTCUT for the three-way `size` field (checked ⇔ size = only_large,
          unchecked ⇔ All; "Not large" is set from the dropdown/clause bar and renders unchecked here) —
          the state lives in the ONE expression. Off is quiet (muted); on is emphasized. */}
      {(largeOnly || ffHasSize) && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 pb-2 text-sm">
          <label
            className="flex cursor-pointer items-center gap-1.5"
            title="Show only large files. Turn this off to reach smaller files — e.g. a screenshot, PDF, or JPG to OCR."
          >
            <input
              type="checkbox"
              checked={ffHasSize ? ffSelections.size === "only_large" : largeOnlyOn}
              onChange={(e) =>
                ffHasSize
                  ? setFfField("size", e.target.checked ? "only_large" : "all")
                  : setLargeOnlyOn(e.target.checked)
              }
            />
            <span
              className={
                (ffHasSize ? ffSelections.size === "only_large" : largeOnlyOn)
                  ? "text-black/70"
                  : "text-black/40"
              }
            >
              Large files only
            </span>
          </label>
        </div>
      )}

      {/* Multi-level sort dropdown (tables.mdx §3.1): each sortable column shows its asc/desc caret on
          the left and 1st/2nd/3rd priority markers on the right. Clicking a marker inserts the column
          at that slot and cascade-demotes the rest (no two columns share a priority, list capped at 3).
          Clear sort falls back to the caller's defaultSort (§3.2/§3.4). */}
      {showSort && (
        <Popover onClose={() => setShowSort(false)}>
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
        // A §2.11 table's dropdown grows WIDER, not taller (tables.mdx §2.11.3 — the two-column grid).
        // Changes apply live; Apply and any click outside the window both collapse it.
        <Popover wide={!!fileFilter} onClose={() => setShowFilter(false)} showApply>
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
          {/* The §2.11 file filter — the segmented All/Not-yet/Done rows. The boolean clause bar sits
              at the very BOTTOM of this dropdown, right above "Clear filters". */}
          {fileFilter && (
            <>
              <FileFilterPanel fields={ffFieldIds} selections={ffSelections} onSelect={setFfField} />
              <div className="my-1 border-t border-[var(--lfb-border)]" />
            </>
          )}
          {/* The File-type facet (tables.mdx §2.10) — the common kinds up front, an "All kinds" reset, and a
              "More types…" disclosure for the rest. OCR "is often done with PDFs also", so PDFs sit alongside
              Images/Videos/Audio without expanding. Present classes drive the last-visible guard; a common
              kind absent from the data is still listed (unchecking it is a harmless no-op). Laid out as a
              FOUR-COLUMN grid — wider, not taller (product owner, 2026-07-21). */}
          {fileTypeFacet && (
            <>
              <div className="px-3 pb-1 pt-0.5 text-[11px] uppercase tracking-wide text-black/40">File type</div>
              <div className="grid grid-cols-4 gap-x-3 px-3">
                <label className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                  <input
                    type="checkbox"
                    checked={hiddenTypes.size === 0}
                    // A reset affordance: checking it shows everything. It can't be UNCHECKED directly (that
                    // would blank the table) — the user unchecks individual kinds instead.
                    onChange={(e) => {
                      if (e.target.checked) setHiddenTypes(new Set());
                    }}
                  />
                  <span className={hiddenTypes.size === 0 ? "text-black/70" : "text-black/50"}>All kinds</span>
                </label>
                {FILE_TYPE_COMMON.map((t) => (
                  <FileTypeRow
                    key={t}
                    t={t}
                    checked={!hiddenTypes.has(t)}
                    disabled={isLastVisibleType(t)}
                    onToggle={() => toggleType(t)}
                  />
                ))}
                {showMoreTypes &&
                  FILE_TYPE_EXTRA.map((t) => (
                    <FileTypeRow
                      key={t}
                      t={t}
                      checked={!hiddenTypes.has(t)}
                      disabled={isLastVisibleType(t)}
                      onToggle={() => toggleType(t)}
                    />
                  ))}
              </div>
              {FILE_TYPE_EXTRA.length > 0 && (
                <button
                  className="w-full px-3 py-1 text-left text-sm text-[var(--lfb-primary)]"
                  onClick={() => setShowMoreTypes((v) => !v)}
                >
                  {showMoreTypes ? "Fewer types" : "More types…"}
                </button>
              )}
              <div className="my-1 border-t border-[var(--lfb-border)]" />
            </>
          )}
          {columns
            .filter((c) => (c.filterable ?? true) && c.id !== bookmarkColId && !ffCoveredCols.has(c.id))
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
          {/* The boolean clause bar — the very bottom of the dropdown, right above Clear filters
              (product owner, 2026-07-21). */}
          {fileFilter && (
            <>
              <div className="my-1 border-t border-[var(--lfb-border)]" />
              <FileFilterClauseBar
                text={fileFilterText}
                error={ffParsed.ok ? null : ffParsed.error}
                onText={setFileFilterText}
              />
            </>
          )}
          <button
            className="w-full px-3 py-1.5 text-sm text-[var(--lfb-primary)]"
            onClick={() => {
              setColumnFilters([]);
              if (fileFilter) setFileFilterText(""); // "" = the deliberate cleared state (§2.11.5)
            }}
          >
            Clear filters
          </button>
        </Popover>
      )}

      {/* Columns dropdown (charter Tables): one checkbox per column to show/hide it in the table below.
          Hiding is presentation-only and layered on top of the responsive auto-hide — a hidden column
          still appears in the Sort/Filter dropdowns. The last visible column can't be hidden (that would
          only ever blank the table). "Show all columns" clears every manual hide. */}
      {showColumns && (
        <Popover onClose={() => setShowColumns(false)}>
          <div className="flex items-center justify-between px-3 pb-1 pt-0.5 text-[11px] uppercase tracking-wide text-black/40">
            <span>Show columns</span>
            <span>
              {columns.length - hiddenCols.size}/{columns.length}
            </span>
          </div>
          {columns.map((c) => {
            const visible = !hiddenCols.has(c.id);
            const isLast = visible && columns.length - hiddenCols.size === 1;
            return (
              <label
                key={c.id}
                className={`flex items-center gap-2 px-3 py-1 text-sm ${isLast ? "cursor-not-allowed" : "cursor-pointer"}`}
                title={isLast ? "At least one column must stay visible." : undefined}
              >
                <input type="checkbox" checked={visible} disabled={isLast} onChange={() => toggleCol(c.id)} />
                <span className={visible ? "text-black/70" : "text-black/40"}>{c.header}</span>
              </label>
            );
          })}
          <div className="my-1 border-t border-[var(--lfb-border)]" />
          <button
            className="w-full px-3 py-1.5 text-left text-sm text-[var(--lfb-primary)] disabled:opacity-40"
            disabled={hiddenCols.size === 0}
            onClick={() => setHiddenCols(new Set())}
          >
            Show all columns
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
                {visibleColumns.map((c) => (
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
                    const meta = h.column.columnDef.meta as { align?: string; tight?: boolean } | undefined;
                    const align = meta?.align;
                    const padX = meta?.tight ? "px-0.5" : "px-2"; // very-narrow icon columns (tables.mdx icon-columns)
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
                        className={`py-2 ${padX} font-medium ${align === "right" ? "text-right" : ""} ${
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
                    // Standard browser modified-click behaviour (tables.mdx §4d). A row navigates via JS,
                    // not an <a href>, so ⌘-click / Ctrl-click / middle-click used to be SWALLOWED and
                    // navigate in place — the opposite of what every other link on the web does. When the
                    // table supplies `rowHref`, those clicks (and shift-click) open a new tab/window
                    // instead, and the plain click keeps the in-page navigation.
                    onClick={(e) => {
                      const href = rowHref?.(row.original);
                      if (href && (e.metaKey || e.ctrlKey)) {
                        window.open(href, "_blank", "noopener,noreferrer");
                        return;
                      }
                      if (href && e.shiftKey) {
                        window.open(href, "_blank", "noopener,noreferrer");
                        return;
                      }
                      onRowClick?.(row.original);
                    }}
                    // Middle-click (auxiliary button 1) → new background tab, same as a real link.
                    onAuxClick={(e) => {
                      if (e.button !== 1) return;
                      const href = rowHref?.(row.original);
                      if (!href) return;
                      e.preventDefault();
                      window.open(href, "_blank", "noopener,noreferrer");
                    }}
                    // Option-key image preview target (option_image_preview.mdx §1): hovering an image
                    // row publishes it; holding Option floats the preview. Null targets clear.
                    onMouseEnter={
                      hoverPreview
                        ? (e) => setOptionPreviewTarget(hoverPreview(row.original), e.clientX, e.clientY)
                        : undefined
                    }
                    onMouseLeave={hoverPreview ? () => setOptionPreviewTarget(null) : undefined}
                    style={{ height: ROW_H }}
                    className={`border-b border-[var(--lfb-border)] ${onRowClick ? "cursor-pointer hover:bg-slate-100" : ""} ${rowClassName ? rowClassName(row.original) : ""}`}
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
                      const cmeta = cell.column.columnDef.meta as { align?: string; tight?: boolean } | undefined;
                      const align = cmeta?.align;
                      const cellPadX = cmeta?.tight ? "px-0.5" : "px-2"; // very-narrow icon columns (tables.mdx)
                      return (
                        <td
                          key={cell.id}
                          className={`py-2 ${cellPadX} ${align === "right" ? "text-right tabular-nums" : ""}`}
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

// ── Responsive column priority (repos.mdx §3.2.1 / tables.mdx §4a) ──────────────
// Measure a container's live content width with a ResizeObserver (re-runs on window/layout resize).
function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState<number>(Infinity);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

// Default min on-screen width (px) per column kind when a column doesn't set `minWidth` (repos.mdx §3.2.1).
const KIND_MIN: Record<string, number> = { text: 140, timestamp: 96, enum: 100, int: 72, bytes: 84 };
function colMinWidth<T>(c: LfbColumn<T>): number {
  return c.minWidth ?? KIND_MIN[c.kind] ?? 100;
}
// Fixed overhead the data columns share the row with: leading select cell + trailing chevron/kebab cell.
const OVERHEAD_BASE = 56; // trailing chevron/kebab cell + cell-padding slack
const SELECT_W = 32; // leading selection checkbox cell

// Hide the lowest-priority columns until the min-width budget fits the container — so a cell never wraps
// to a second line (repos.mdx §3.2.1). Columns with UNDEFINED `priority` are PINNED (never dropped); the
// rest drop by highest `priority` number first (least important). On-screen order is preserved.
export function computeVisibleColumns<T>(
  columns: LfbColumn<T>[],
  containerW: number,
  hasSelection: boolean,
): LfbColumn<T>[] {
  if (!isFinite(containerW) || containerW <= 0) return columns; // pre-measure → show everything
  const overhead = OVERHEAD_BASE + (hasSelection ? SELECT_W : 0);
  const shown = new Set(columns.map((c) => c.id));
  const budget = () =>
    overhead + columns.filter((c) => shown.has(c.id)).reduce((s, c) => s + colMinWidth(c), 0);
  // Drop the largest-priority-number (least important) column first; never touch pinned (undefined) ones.
  const droppable = columns
    .filter((c) => c.priority !== undefined)
    .sort((a, b) => b.priority! - a.priority!);
  for (const c of droppable) {
    if (budget() <= containerW) break;
    shown.delete(c.id);
  }
  return columns.filter((c) => shown.has(c.id));
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

// One File-type checkbox cell inside the Filter dropdown's four-column grid (tables.mdx §2.10). Disabled
// only when it is the last visible PRESENT class (the last-value rule) — with a title that says why.
function FileTypeRow({
  t,
  checked,
  disabled,
  onToggle,
}: {
  t: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={`flex items-center gap-2 py-1 text-sm ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      title={disabled ? "At least one file type must be shown." : undefined}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <span className={checked ? "text-black/70" : "text-black/40"}>{FILE_TYPE_LABELS[t] ?? t}</span>
    </label>
  );
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
    // data-popover-toggle: the Popover's click-outside close skips these — each icon's own onClick
    // owns opening/closing its window.
    <button
      title={title}
      onClick={onClick}
      data-popover-toggle
      className={`p-1.5 rounded-md hover:bg-slate-100 ${active ? "text-[var(--lfb-primary)]" : "text-black/70"}`}
    >
      {children}
    </button>
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
