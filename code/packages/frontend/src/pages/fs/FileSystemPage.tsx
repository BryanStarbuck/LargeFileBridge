// The File System page (directory.mdx) — a Mac-Finder column-view (Miller-column) browser.
// Each column lists one directory level and lazily fetches GET /fs?path=…; clicking a directory
// opens a new column to its right (replacing any columns further right). Every row shows its
// code badges pinned to the far right, plus a ⋯ kebab and right-click that open the shared entity
// action menu (menus.mdx §3/§3.1 — the same catalog as the view-one pages).
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Cloud, File as FileIcon, Folder, Home } from "lucide-react";
import type { FsEntry, FsListing, FileSystemView } from "@lfb/shared";
import { viewerRouteForName } from "@lfb/shared";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { BadgeLegend } from "@/components/fs/BadgeLegend";
import { EntityKebab, EntityMenuAt, type Action, type MenuPos } from "@/components/menu/EntityMenu";
import { PageActions, producingActions } from "@/components/menu/PageActions";
import {
  compressAllVideos,
  compressAllImages,
  gitIgnoreBig,
  trackSyncDir,
} from "@/components/menu/domainActions";
import { folderGlyphStyle, isInteresting } from "@/components/fs/folderInterest";
import { useWindowedRows } from "@/components/table/useWindowedRows";
import { formatBytes, middleTruncate } from "@/lib/format";
import { FsTabs } from "./FsTabs";

const FSROW_H = 28; // fixed column-row height the windowing math relies on (px).
// content-visibility lets the browser skip layout+paint for rows just outside the windowed slice
// (performance.mdx P-25).
const FSROW_STYLE: CSSProperties = {
  height: FSROW_H,
  contentVisibility: "auto",
  containIntrinsicSize: `${FSROW_H}px`,
};

export default function FileSystemPage() {
  const { path: initialPath } = useSearch({ strict: false }) as { path?: string };
  // The column stack: one absolute directory path per column (index 0 is the root/home column).
  const [stack, setStack] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [pathInput, setPathInput] = useState("");
  // Right-click context menu (menus.mdx §3.1).
  const [menu, setMenu] = useState<{ path: string; pos: MenuPos } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Open on the ?path deep-link if present, else the persisted view state (directories.mdx §1.3 — pick
  // up where you left off), else the OS home directory.
  const home = useQuery({ queryKey: ["fs", "home"], queryFn: api.fsHome });
  // The saved view (open column chain + selection) for THIS user, pruned server-side to what still
  // exists on this machine (stale paths dropped). `null` = nothing saved / not applicable.
  const view = useQuery({ queryKey: ["fs", "viewState"], queryFn: api.fsViewState });
  // Once we've chosen the opening columns we must never re-seed (that would fight the user's clicks);
  // it also gates the debounced save so the initial restore can't immediately overwrite itself.
  const restoredRef = useRef(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (restoredRef.current || stack.length > 0) return;
    // A ?path deep-link is explicit intent — it wins over the remembered view.
    if (initialPath) {
      restoredRef.current = true;
      setStack([initialPath]);
      return;
    }
    // Wait for the saved-view lookup to settle before deciding, so we don't flash home then jump.
    if (view.isPending) return;
    const cols = view.data?.columns ?? [];
    if (cols.length > 0) {
      restoredRef.current = true;
      setStack(cols);
      // Restore the last file selection (§1.3) if one was saved; the backend already dropped it if the
      // file is gone. A saved directory selection is already reflected by the column chain.
      const sel = view.data?.selection?.[0];
      if (sel && !cols.includes(sel)) setSelectedFile(sel);
      return;
    }
    if (home.data) {
      restoredRef.current = true;
      setStack([home.data.home]);
    }
  }, [home.data, initialPath, stack.length, view.isPending, view.data]);

  // Debounce-persist the view state on every column / selection change (directories.mdx §1.3), and
  // flush once more on unmount so clicking away to another left-bar tab still saves the last state.
  const latestView = useRef<{ columns: string[]; selection: string[] }>({ columns: [], selection: [] });
  useEffect(() => {
    latestView.current = { columns: stack, selection: selectedFile ? [selectedFile] : [] };
  }, [stack, selectedFile]);
  // Persist to the server AND write the same value straight into the ["fs","viewState"] cache
  // (directories.mdx §1.3 — client cache coherence). Without the cache write the browser keeps serving
  // the stale view-state it read on the FIRST mount, so returning to the page within react-query's
  // cache window restores that old snapshot and silently drops every column the user just opened — the
  // recurring "it never restores" bug. Updating the cache here keeps it equal to the last-saved state,
  // so the one-shot restore on the next mount seeds the correct chain.
  const persistView = useCallback(
    (v: { columns: string[]; selection: string[] }) => {
      queryClient.setQueryData<FileSystemView | null>(["fs", "viewState"], (prev) => ({
        columns: v.columns,
        selection: v.selection,
        filters: prev?.filters ?? { only_large: true, videos: true, images: true, audio: true },
        updated_at: prev?.updated_at ?? "",
      }));
      void api.saveFsViewState(v);
    },
    [queryClient],
  );
  useEffect(() => {
    if (!restoredRef.current || stack.length === 0) return;
    const t = setTimeout(() => persistView(latestView.current), 600);
    return () => clearTimeout(t);
  }, [stack, selectedFile, persistView]);
  useEffect(
    () => () => {
      if (restoredRef.current && latestView.current.columns.length > 0) {
        persistView(latestView.current);
      }
    },
    [persistView],
  );

  // Auto-scroll to the newest column whenever the stack grows.
  useEffect(() => {
    const el = stripRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [stack.length]);

  // Stable callbacks (functional state updates, no deps) so memoized FsRows don't re-render when an
  // unrelated part of the page state changes (performance.mdx P-20).
  const openDir = useCallback((colIndex: number, path: string) => {
    setSelectedFile(null);
    setStack((s) => [...s.slice(0, colIndex + 1), path]);
  }, []);
  const selectFile = useCallback((path: string) => setSelectedFile(path), []);
  const openContextMenu = useCallback((path: string, pos: MenuPos) => setMenu({ path, pos }), []);
  function goHome() {
    if (home.data) {
      setSelectedFile(null);
      setStack([home.data.home]);
    }
  }
  function jumpTo(path: string) {
    const p = path.trim();
    if (p) {
      setSelectedFile(null);
      setStack([p]);
    }
  }

  const deepest = selectedFile ?? stack[stack.length - 1] ?? "";

  // The action-links row (page_actions.mdx §4 / file_system.mdx §4 — File System): producing pair ·
  // Compress all videos… · Compress all images… · Git-ignore big files… · Track / Sync this directory.
  // Scope = the currently-selected column's directory (deepest open column), walked recursively (there
  // is no per-row selection in the column browser, so it is always the whole current directory).
  const currentDir = stack[stack.length - 1];
  const fsActions: Action[] = [
    ...producingActions(() => (currentDir ? { root: currentDir } : {})),
    compressAllVideos(currentDir),
    compressAllImages(currentDir),
    gitIgnoreBig(),
    trackSyncDir(),
  ];

  return (
    <div className="flex h-full flex-col">
      <FsTabs />
      {/* Page action-links row, directly under the tabs/title (page_actions.mdx §3, not a dropdown). */}
      <div className="border-b border-[var(--lfb-border)] px-4 py-2">
        <PageActions actions={fsActions} />
      </div>
      {/* Breadcrumb / controls */}
      <div className="flex items-center gap-2 border-b border-[var(--lfb-border)] px-4 py-2">
        <button
          onClick={goHome}
          title="Home directory"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-black hover:bg-slate-100"
        >
          <Home size={15} /> Home
        </button>
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            jumpTo(pathInput);
          }}
        >
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder={deepest || "Absolute path…"}
            spellCheck={false}
            className="w-full rounded border border-[var(--lfb-border)] px-2 py-1 font-mono text-xs text-black"
          />
        </form>
        <label className="flex items-center gap-1 text-xs text-black select-none">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden
        </label>
      </div>

      <BadgeLegend className="border-b border-[var(--lfb-border)] px-4 py-1" />

      {/* The column strip */}
      <div ref={stripRef} className="flex flex-1 overflow-x-auto">
        {stack.map((root, i) => (
          <FsColumn
            key={`${i}:${root}`}
            colIndex={i}
            root={root}
            showHidden={showHidden}
            openedChild={stack[i + 1] ?? null}
            selectedFile={selectedFile}
            onOpenDir={openDir}
            onSelectFile={selectFile}
            onContextMenu={openContextMenu}
          />
        ))}
      </div>

      {menu && <EntityMenuAt path={menu.path} pos={menu.pos} onClose={() => setMenu(null)} />}
    </div>
  );
}

interface FsColumnProps {
  colIndex: number;
  root: string;
  showHidden: boolean;
  openedChild: string | null; // the child in THIS column that opened the next column (for highlight)
  selectedFile: string | null;
  onOpenDir: (colIndex: number, path: string) => void;
  onSelectFile: (path: string) => void;
  onContextMenu: (path: string, pos: MenuPos) => void;
}

function FsColumn({ colIndex, root, showHidden, openedChild, selectedFile, onOpenDir, onSelectFile, onContextMenu }: FsColumnProps) {
  const q = useQuery<FsListing>({
    queryKey: ["fs", "list", root, showHidden],
    queryFn: () => api.fsList(root, showHidden),
  });

  // Windowing (performance.mdx P-15): a directory can hold thousands of entries; render only the
  // rows intersecting the scroll viewport so an N-entry column costs ~30 <FsRow> not N.
  const scrollRef = useRef<HTMLDivElement>(null);
  const entries = q.data?.entries ?? [];
  const win = useWindowedRows(entries.length, FSROW_H, scrollRef);
  const visible = entries.slice(win.start, win.end);

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-r border-[var(--lfb-border)]">
      {q.data?.truncated && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1 text-[11px] text-amber-800">
          Narrowed — showing first {entries.length.toLocaleString()}. Open a subfolder to see the rest.
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {q.isLoading && <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>}
        {q.isError && (
          <div className="px-3 py-2 text-xs text-red-600">
            {(q.error as Error)?.message || "Cannot read directory"}
          </div>
        )}
        {q.data && entries.length === 0 && (
          <div className="px-3 py-2 text-xs text-slate-500">Empty</div>
        )}
        {win.padTop > 0 && <div aria-hidden style={{ height: win.padTop }} />}
        {visible.map((e) => (
          <FsRow
            key={e.path}
            entry={e}
            active={e.path === openedChild || e.path === selectedFile}
            colIndex={colIndex}
            onOpenDir={onOpenDir}
            onSelectFile={onSelectFile}
            onContextMenu={onContextMenu}
          />
        ))}
        {win.padBottom > 0 && <div aria-hidden style={{ height: win.padBottom }} />}
      </div>
    </div>
  );
}

// Memoized (performance.mdx P-20): with stable callbacks from the page, opening a child column or
// selecting a file re-renders only the rows whose `active` actually flips — not the whole column.
const FsRow = memo(function FsRow({
  entry,
  active,
  colIndex,
  onOpenDir,
  onSelectFile,
  onContextMenu,
}: {
  entry: FsEntry;
  active: boolean;
  colIndex: number;
  onOpenDir: (colIndex: number, path: string) => void;
  onSelectFile: (path: string) => void;
  onContextMenu: (path: string, pos: MenuPos) => void;
}) {
  const isDir = entry.kind === "dir";
  const navigate = useNavigate();
  // Clicking a directory opens its column; clicking a FILE opens its viewer/properties page
  // (media_viewer.mdx / files.mdx): image → /image, video → /video, anything else → /file.
  const openFile = () => {
    onSelectFile(entry.path); // keep the row highlighted as we leave
    navigate({ to: viewerRouteForName(entry.name), search: { path: entry.path } });
  };
  return (
    <div
      role="button"
      tabIndex={0}
      style={FSROW_STYLE}
      onClick={() => (isDir ? onOpenDir(colIndex, entry.path) : openFile())}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(entry.path, { x: e.clientX, y: e.clientY });
      }}
      title={entry.path}
      className={`group flex w-full cursor-pointer items-center gap-1.5 px-3 text-left text-[13px] ${
        active ? "bg-[var(--lfb-primary-tint)]" : "hover:bg-slate-100"
      }`}
    >
      {entry.cloud ? (
        // Surfaced cloud-storage root (file_system.mdx §6): a Dropbox / Google Drive / iCloud mount
        // lifted to the top of the home column. Draw a cloud glyph so it reads as a special shortcut,
        // tinted by the same interest level when its subtree holds big files/videos, else a sky accent.
        (() => {
          const interesting = isInteresting(entry.interest);
          const { color, fill } = folderGlyphStyle(entry.interest);
          return (
            <Cloud
              size={14}
              className={`shrink-0 ${interesting ? "" : "text-sky-600"}`}
              style={interesting ? { color, fill } : undefined}
            />
          );
        })()
      ) : isDir ? (
        // Interesting-directory folder coloring (file_system.mdx §2/§3): when `entry.interest` is set,
        // drive the glyph's outline (color/stroke) and fill from the shared helper and drop the default
        // slate; keep the plain text-slate-500 glyph when interest is null/undefined.
        (() => {
          const interesting = isInteresting(entry.interest);
          const { color, fill } = folderGlyphStyle(entry.interest);
          return (
            <Folder
              size={14}
              className={`shrink-0 ${interesting ? "" : "text-slate-500"}`}
              style={interesting ? { color, fill } : undefined}
            />
          );
        })()
      ) : (
        <FileIcon size={14} className="shrink-0 text-slate-400" />
      )}
      <span className="min-w-0 flex-1 truncate text-black">{middleTruncate(entry.name, 30)}</span>
      {entry.kind === "file" && entry.sizeBytes != null && (
        <span className="shrink-0 text-[10px] tabular-nums text-slate-400">
          {formatBytes(entry.sizeBytes)}
        </span>
      )}
      <Badges badges={entry.badges} />
      {/* ⋯ kebab — appears on hover; opens the same entity menu as right-click (menus.mdx §3). */}
      <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <EntityKebab path={entry.path} />
      </span>
      {isDir && entry.hasChildren && <ChevronRight size={13} className="shrink-0 text-slate-400" />}
    </div>
  );
});
