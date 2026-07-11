// Full paths (full_paths.mdx) — a FLAT, recursive TanStack table of the LARGE files under a chosen
// root. Lead columns Name + full absolute Path, per-row checkbox, trailing ⋯ kebab. The control row is
// built from three SEGMENTED CONTROLS (compressed / sort / IPFS) plus the house search + sort/filter
// icons; the action row (Select all / IPFS pin / Unpin) drives the one_repo.mdx decision model
// (sync/ignore) via the per-entity endpoint — files outside a registered repo (or with Never IPFS on)
// are reported as skipped, never silently dropped, and no bytes ever move.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  Search,
  Filter,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Home,
  UploadCloud,
  DownloadCloud,
  CheckSquare,
} from "lucide-react";
import { toast } from "sonner";
import type { FsEntry } from "@lfb/shared";
import { api } from "../../api/client.js";
import { Badges } from "../../components/fs/Badges.js";
import { BadgeLegend } from "../../components/fs/BadgeLegend.js";
import { EntityKebab, type Action } from "../../components/menu/EntityMenu.js";
import { PageActions, producingActions } from "../../components/menu/PageActions.js";
import { compressAllVideos, gitIgnoreBig } from "../../components/menu/domainActions.js";
import { notWiredToast, type ActionScope } from "../../lib/pageActions.js";
import { formatBytes, relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";
import { clientLog } from "../../lib/clientLog.js";
import { useDebounced } from "../../lib/useDebounced.js";
import { useWindowedRows } from "../../components/table/useWindowedRows.js";
import { useStreamedFlatListing } from "../../components/table/useStreamedFlatListing.js";
import { FsTabs } from "./FsTabs.js";

const ROW_H = 41; // fixed body-row height the windowing math relies on (px).
// content-visibility lets the browser skip layout+paint for rows scrolled just out of the windowed
// slice, and containIntrinsicSize keeps the scrollbar honest for them (performance.mdx P-25).
const ROW_STYLE: CSSProperties = {
  height: ROW_H,
  contentVisibility: "auto",
  containIntrinsicSize: `${ROW_H}px`,
};

type CompressFilter = "both" | "compressed" | "uncompressed";
type IpfsFilter = "both" | "in" | "not";

const compressStateOf = (e: FsEntry): CompressFilter | "none" =>
  e.badges.includes("compressed") ? "compressed" : e.badges.includes("compress") ? "uncompressed" : "none";
const inIpfs = (e: FsEntry): boolean => e.badges.includes("sync");

// Optimistic badge flip for the pin/unpin action (P-08) — add or remove the "sync" badge without a
// filesystem re-walk. Preserves the backend's rightmost-first ordering closely enough for the chip row.
const withSyncBadge = (badges: FsEntry["badges"], on: boolean): FsEntry["badges"] => {
  const without = badges.filter((b) => b !== "sync");
  return on ? [...without, "sync"] : without;
};

const SORT_COLS = [
  { id: "size", label: "Size" },
  { id: "name", label: "Name" },
  { id: "path", label: "Path" },
] as const;

export function FullPathsPage() {
  const { path: initialPath } = useSearch({ strict: false }) as { path?: string };
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [root, setRoot] = useState<string | null>(initialPath ?? null);
  const [pathInput, setPathInput] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  // Filters
  const [search, setSearch] = useState("");
  const [compressed, setCompressed] = useState<CompressFilter>("both");
  const [ipfs, setIpfs] = useState<IpfsFilter>("both");
  const [minSizeMB, setMinSizeMB] = useState("");
  const [pathContains, setPathContains] = useState("");

  // Shared sort state (segmented control + house sort icon) — Size ▼ (biggest on top) by default.
  const [sorting, setSorting] = useState<SortingState>([{ id: "size", desc: true }]);
  const [showSort, setShowSort] = useState(false);
  const [showFilter, setShowFilter] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState(500);
  const [pageIndex, setPageIndex] = useState(0);

  // Default the root to the OS home directory (like the column browser).
  const home = useQuery({ queryKey: ["fs", "home"], queryFn: api.fsHome });
  useEffect(() => {
    if (root == null && home.data) setRoot(home.data.home);
  }, [home.data, root]);

  // Stream the flat walk progressively instead of one blocking blob (performance.mdx P-22/P-23). The
  // return shape mirrors the old useQuery fields the rest of this page reads, plus setFiles for the
  // optimistic pin patch below.
  const flat = useStreamedFlatListing(root, showHidden);
  const files = flat.files;

  // Debounce the free-text filters so filtering the (up to 5000-row) dataset runs once per pause,
  // not once per keystroke (performance.mdx P-05). The inputs stay instant; only `filtered` trails.
  const searchD = useDebounced(search, 200);
  const pathContainsD = useDebounced(pathContains, 200);
  const minSizeMBD = useDebounced(minSizeMB, 200);

  // Client-side filters (search + the two segmented quick-filters + the icon-dropdown finers).
  const filtered = useMemo(() => {
    const q = searchD.trim().toLowerCase();
    const pc = pathContainsD.trim().toLowerCase();
    const minBytes = minSizeMBD.trim() ? Number(minSizeMBD) * 1024 * 1024 : 0;
    return files.filter((e) => {
      if (q && !(`${e.name} ${e.path}`.toLowerCase().includes(q))) return false;
      if (pc && !e.path.toLowerCase().includes(pc)) return false;
      if (minBytes && (e.sizeBytes ?? 0) < minBytes) return false;
      if (compressed !== "both" && compressStateOf(e) !== compressed) return false;
      if (ipfs === "in" && !inIpfs(e)) return false;
      if (ipfs === "not" && inIpfs(e)) return false;
      return true;
    });
  }, [files, searchD, pathContainsD, minSizeMBD, compressed, ipfs]);

  const columns = useMemo<ColumnDef<FsEntry>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        accessorFn: (r) => r.name,
        cell: ({ row }) => (
          <button
            className="text-left font-semibold text-black hover:text-[var(--lfb-primary)]"
            onClick={() => navigate({ to: "/file", search: { path: row.original.path } })}
          >
            {middleTruncate(row.original.name, 40)}
          </button>
        ),
      },
      {
        id: "path",
        header: "Path",
        accessorFn: (r) => r.path,
        cell: ({ row }) => (
          <button
            className="text-left text-black/50 hover:text-[var(--lfb-primary)]"
            title={row.original.path}
            onClick={() => navigate({ to: "/file", search: { path: row.original.path } })}
          >
            {middleTruncate(row.original.path, 64)}
          </button>
        ),
      },
      {
        id: "size",
        header: "Size",
        accessorFn: (r) => r.sizeBytes ?? 0,
        cell: ({ row }) => formatBytes(row.original.sizeBytes ?? 0),
        meta: { align: "right" },
      },
      {
        id: "changed",
        header: "Changed",
        accessorFn: (r) => r.modifiedAt ?? "",
        cell: ({ row }) => (
          <span title={absoluteTime(row.original.modifiedAt)}>{relativeTime(row.original.modifiedAt)}</span>
        ),
      },
    ],
    [navigate],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, pagination: { pageIndex, pageSize } },
    onSortingChange: setSorting,
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function" ? updater({ pageIndex, pageSize }) : updater;
      setPageIndex(next.pageIndex);
      setPageSize(next.pageSize);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: true,
  });

  const pageRows = table.getRowModel().rows;
  const pagePaths = useMemo(() => pageRows.map((r) => r.original.path), [pageRows]);
  const allPageSelected = pagePaths.length > 0 && pagePaths.every((p) => selected.has(p));

  // Stable selection toggles (P-02) — functional updates so a checkbox never closes over the whole Set.
  const toggleOne = useCallback((p: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      on ? next.add(p) : next.delete(p);
      return next;
    });
  }, []);
  const togglePage = useCallback(
    (on: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const p of pagePaths) on ? next.add(p) : next.delete(p);
        return next;
      });
    },
    [pagePaths],
  );

  // Windowing (P-01): only the rows on screen are in the DOM.
  const scrollRef = useRef<HTMLDivElement>(null);
  const win = useWindowedRows(pageRows.length, ROW_H, scrollRef);
  const visibleRows = pageRows.slice(win.start, win.end);
  const colSpan = 7; // checkbox + name + path + size + changed + badges + kebab

  const setSort = (id: string) =>
    setSorting((prev) => {
      const cur = prev[0];
      if (cur?.id === id) return [{ id, desc: !cur.desc }];
      return [{ id, desc: id === "size" }]; // size defaults biggest-first; name/path A→Z
    });

  const pin = useMutation({
    mutationFn: async (decision: "sync" | "ignore") => {
      const paths = [...selected];
      const results = await Promise.allSettled(paths.map((p) => api.setEntityDecision(p, decision)));
      const okPaths = paths.filter((_, i) => results[i].status === "fulfilled");
      return {
        ok: okPaths.length,
        skipped: results.filter((r) => r.status === "rejected").length,
        okPaths,
      };
    },
    onSuccess: ({ ok, skipped, okPaths }, decision) => {
      const verb = decision === "sync" ? "Pinned" : "Unpinned";
      toast.success(`${verb} ${ok} file${ok === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}`);
      setSelected(new Set());
      // P-08/P-23: DON'T re-walk to flip a badge. Optimistically patch the streamed rows in place —
      // add/remove the "sync" badge on the affected rows. The next scheduled scan reconciles truth.
      const done = new Set(okPaths);
      flat.setFiles((prev) =>
        prev.map((f) =>
          done.has(f.path) ? { ...f, badges: withSyncBadge(f.badges, decision === "sync") } : f,
        ),
      );
      // Repo counts change — that endpoint reads status YAML (no filesystem walk), so it's cheap.
      qc.invalidateQueries({ queryKey: ["repos"] });
    },
    onError: (e: Error) => { clientLog.error("FullPathsPage.pin", e); toast.error(e.message); },
  });

  const rootError = flat.error;

  // The action-links row (page_actions.mdx §4 — Full paths): producing pair · Compress all videos… ·
  // Git-ignore big files… · IPFS pin · Unpin. Scope = the checked rows, else the whole root recursively.
  // IPFS pin/Unpin reuse the page's existing per-path decision mutation over the current selection.
  const pinScope = (verb: "sync" | "ignore") => () => {
    if (selected.size === 0) {
      notWiredToast(
        verb === "sync" ? "Select files to pin" : "Select files to unpin",
        "check the rows you want, then click again",
      );
      return;
    }
    pin.mutate(verb);
  };
  const fullPathsActions: Action[] = [
    ...producingActions((): ActionScope =>
      selected.size > 0 ? { paths: [...selected] } : root ? { root } : {},
    ),
    compressAllVideos(root ?? undefined),
    gitIgnoreBig(selected.size > 0 ? { paths: [...selected] } : root ? { root } : {}),
    {
      id: "ipfs-pin",
      label: "IPFS pin",
      icon: <UploadCloud className="h-3.5 w-3.5" />,
      group: "Work",
      disabled: pin.isPending,
      onSelect: pinScope("sync"),
    },
    {
      id: "ipfs-unpin",
      label: "Unpin",
      icon: <DownloadCloud className="h-3.5 w-3.5" />,
      group: "Work",
      disabled: pin.isPending,
      onSelect: pinScope("ignore"),
    },
  ];

  return (
    // Full-page-height (full_paths.mdx §4 / repos.mdx §3.3.1): flex column so the table body flexes to
    // the bottom of the viewport; the bars above and the pager below stay pinned (shrink-0).
    <div className="flex min-h-0 flex-1 flex-col">
      <FsTabs />

      {/* Page action-links row, directly under the tabs/title (page_actions.mdx §3, not a dropdown). */}
      <div className="shrink-0 py-2">
        <PageActions actions={fullPathsActions} selectedCount={selected.size} />
      </div>

      {/* Root bar */}
      <div className="flex shrink-0 items-center gap-2 py-2">
        <button
          onClick={() => home.data && setRoot(home.data.home)}
          title="Home directory"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-black hover:bg-slate-100"
        >
          <Home size={15} /> Home
        </button>
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            const p = pathInput.trim();
            if (p) setRoot(p);
          }}
        >
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder={root ?? "Absolute path to a folder…"}
            spellCheck={false}
            className="w-full rounded border border-[var(--lfb-border)] px-2 py-1 font-mono text-xs text-black"
          />
        </form>
        <label className="flex items-center gap-1 text-xs text-black select-none">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden
        </label>
      </div>

      <BadgeLegend className="shrink-0 py-1" />

      {/* Control row — segmented controls + house search / sort / filter icons */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 py-1">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-black/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search name or path…"
            className="w-full rounded-md border border-[var(--lfb-border)] py-1.5 pl-8 pr-2 text-sm outline-none focus:border-[var(--lfb-primary)]"
          />
        </div>

        <Segmented
          value={compressed}
          onChange={setCompressed}
          options={[
            { value: "both", label: "Both" },
            { value: "compressed", label: "Compressed" },
            { value: "uncompressed", label: "Uncompressed" },
          ]}
        />

        {/* Sort segmented control — shares state with the sort icon below */}
        <div className="inline-flex items-center gap-1.5">
          <span className="text-xs text-black/50">Sort:</span>
          <div className="inline-flex overflow-hidden rounded-md border border-[var(--lfb-border)]">
            {SORT_COLS.map((c) => {
              const active = sorting[0]?.id === c.id;
              const desc = sorting[0]?.desc;
              return (
                <button
                  key={c.id}
                  onClick={() => setSort(c.id)}
                  className={`flex items-center gap-1 px-2.5 py-1 text-xs ${
                    active ? "bg-[var(--lfb-primary)] text-white" : "bg-white text-black/70 hover:bg-slate-100"
                  }`}
                >
                  {c.label}
                  {active ? (
                    desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />
                  ) : (
                    <ArrowUpDown className="h-3 w-3 opacity-40" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <Segmented
          value={ipfs}
          onChange={setIpfs}
          options={[
            { value: "in", label: "In IPFS" },
            { value: "not", label: "Not" },
            { value: "both", label: "Both" },
          ]}
        />

        <div className="flex-1" />

        <IconButton active={sorting.length > 0} title="Sort" onClick={() => { setShowSort((s) => !s); setShowFilter(false); }}>
          <ArrowUpDown className="h-4 w-4" />
        </IconButton>
        <IconButton
          active={!!minSizeMB || !!pathContains}
          title="Filter"
          onClick={() => { setShowFilter((s) => !s); setShowSort(false); }}
        >
          <Filter className="h-4 w-4" />
        </IconButton>
      </div>

      {showSort && (
        <Popover>
          {SORT_COLS.map((c) => {
            const active = sorting[0]?.id === c.id;
            return (
              <button
                key={c.id}
                className="flex w-full items-center justify-between rounded px-3 py-1.5 text-sm hover:bg-slate-100"
                onClick={() => setSort(c.id)}
              >
                <span>{c.label}</span>
                <span className="text-black/50">{active ? (sorting[0]?.desc ? "↓ desc" : "↑ asc") : ""}</span>
              </button>
            );
          })}
        </Popover>
      )}

      {showFilter && (
        <Popover>
          <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="w-24 shrink-0 text-black/70">Min size (MB)</span>
            <input
              className="flex-1 rounded border border-[var(--lfb-border)] px-1 py-0.5"
              placeholder="≥ MB"
              value={minSizeMB}
              onChange={(e) => setMinSizeMB(e.target.value.replace(/[^0-9.]/g, ""))}
            />
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="w-24 shrink-0 text-black/70">Path contains</span>
            <input
              className="flex-1 rounded border border-[var(--lfb-border)] px-1 py-0.5"
              placeholder="contains…"
              value={pathContains}
              onChange={(e) => setPathContains(e.target.value)}
            />
          </div>
          <button
            className="w-full px-3 py-1.5 text-sm text-[var(--lfb-primary)]"
            onClick={() => { setMinSizeMB(""); setPathContains(""); }}
          >
            Clear filters
          </button>
        </Popover>
      )}

      {/* Selection helper row — "Select all" is a selection utility (not a catalog action); the IPFS
          pin/Unpin offers now live in the action-links row under the title (page_actions.mdx §4). */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 py-2">
        <button
          onClick={() => setSelected(new Set(filtered.map((f) => f.path)))}
          className="flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          <CheckSquare className="h-4 w-4" /> Select all
        </button>
        {selected.size > 0 && <span className="text-sm text-black/60">{selected.size} selected</span>}
      </div>

      {flat.truncated && (
        <div className="mb-2 shrink-0 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Showing the first {files.length} files (walk capped) — narrow the root to see everything.
        </div>
      )}
      {rootError && (
        <div className="mb-2 shrink-0 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {rootError}
        </div>
      )}

      {/* The flat, chromeless table. While the stream is still arriving with nothing matching yet,
          keep the skeleton up; only show the empty state once the walk is DONE (P-23). */}
      {filtered.length === 0 && (flat.loading || !flat.done) ? (
        <SkeletonRows />
      ) : filtered.length === 0 ? (
        <EmptyState
          hasFiles={files.length > 0}
          root={root}
          onClear={() => { setCompressed("both"); setIpfs("both"); setSearch(""); setMinSizeMB(""); setPathContains(""); }}
        />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-white">
              <tr className="border-b border-[var(--lfb-border)] text-left text-black/60">
                <th className="w-8 py-2 px-2">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={(e) => togglePage(e.target.checked)}
                  />
                </th>
                {table.getHeaderGroups()[0].headers.map((h) => {
                  const align = (h.column.columnDef.meta as { align?: string } | undefined)?.align;
                  // Header-click sort (full_paths.mdx §4 / repos.mdx §3.1): shares the SAME `setSort`
                  // and `sorting` state as the Size·Name·Path segmented control (§3.2), so clicking a
                  // header and picking the segment stay in lock-step; click again toggles asc ↔ desc.
                  const canSort = h.column.getCanSort();
                  const active = sorting[0]?.id === h.column.id;
                  return (
                    <th
                      key={h.id}
                      onClick={canSort ? () => setSort(h.column.id) : undefined}
                      aria-sort={active ? (sorting[0]?.desc ? "descending" : "ascending") : undefined}
                      className={`py-2 px-2 font-medium ${align === "right" ? "text-right" : ""} ${
                        canSort ? "cursor-pointer select-none hover:text-black" : ""
                      }`}
                    >
                      <span className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {active && (
                          <span className="text-[var(--lfb-primary)]" aria-hidden>
                            {sorting[0]?.desc ? "↓" : "↑"}
                          </span>
                        )}
                      </span>
                    </th>
                  );
                })}
                <th className="py-2 px-2" />
                <th className="w-8 py-2" />
              </tr>
            </thead>
            <tbody>
              {win.padTop > 0 && (
                <tr aria-hidden style={{ height: win.padTop }}>
                  <td colSpan={colSpan} />
                </tr>
              )}
              {visibleRows.map((row) => {
                const e = row.original;
                return (
                  <tr
                    key={row.id}
                    style={ROW_STYLE}
                    className="group border-b border-[var(--lfb-border)] hover:bg-slate-100"
                  >
                    <td className="px-2">
                      <input
                        type="checkbox"
                        checked={selected.has(e.path)}
                        onChange={(ev) => toggleOne(e.path, ev.target.checked)}
                      />
                    </td>
                    {row.getVisibleCells().map((cell) => {
                      const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align;
                      return (
                        <td key={cell.id} className={`py-2 px-2 ${align === "right" ? "text-right tabular-nums" : ""}`}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                    <td className="py-2 px-2 text-right">
                      <span className="inline-flex justify-end">
                        <Badges badges={e.badges} />
                      </span>
                    </td>
                    <td className="pr-2 text-right opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                      <EntityKebab path={e.path} />
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

      {/* Count + pagination (default 500) */}
      {filtered.length > 0 && (
        <div className="flex shrink-0 items-center justify-between py-2 text-sm text-black/60">
          <span>{filtered.length} files</span>
          <div className="flex items-center gap-3">
            <span>
              page {table.getState().pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())}
            </span>
            <div className="flex gap-1">
              <button
                className="rounded border border-[var(--lfb-border)] px-2 py-0.5 disabled:opacity-40"
                disabled={!table.getCanPreviousPage()}
                onClick={() => table.previousPage()}
              >
                ‹
              </button>
              <button
                className="rounded border border-[var(--lfb-border)] px-2 py-0.5 disabled:opacity-40"
                disabled={!table.getCanNextPage()}
                onClick={() => table.nextPage()}
              >
                ›
              </button>
            </div>
            <select
              className="rounded border border-[var(--lfb-border)] px-1 py-0.5"
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPageIndex(0); }}
            >
              {[100, 250, 500].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small building blocks ──────────────────────────────────────────────────────
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-[var(--lfb-border)]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-xs ${
            value === o.value ? "bg-[var(--lfb-primary)] text-white" : "bg-white text-black/70 hover:bg-slate-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
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
    <button
      title={title}
      onClick={onClick}
      className={`rounded-md p-1.5 hover:bg-slate-100 ${active ? "text-[var(--lfb-primary)]" : "text-black/70"}`}
    >
      {children}
    </button>
  );
}

function Popover({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <div className="absolute right-0 z-10 mt-1 w-72 rounded-lg border border-[var(--lfb-border)] bg-white py-1 shadow-lg">
        {children}
      </div>
    </div>
  );
}

function EmptyState({
  hasFiles,
  root,
  onClear,
}: {
  hasFiles: boolean;
  root: string | null;
  onClear: () => void;
}) {
  if (hasFiles) {
    return (
      <div className="py-10 text-center text-black/60">
        No files match these filters.{" "}
        <button className="text-[var(--lfb-primary)] underline" onClick={onClear}>
          Clear filters
        </button>
      </div>
    );
  }
  return (
    <div className="py-10 text-center text-black/60">
      No files at or above the big-file threshold under{" "}
      <span className="font-mono text-xs">{root ?? "this folder"}</span>. Lower the threshold in Settings
      or pick another folder.
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex gap-2 border-b border-[var(--lfb-border)] py-2">
          {Array.from({ length: 5 }).map((__, j) => (
            <div key={j} className="h-4 flex-1 rounded bg-slate-100" />
          ))}
        </div>
      ))}
    </div>
  );
}
