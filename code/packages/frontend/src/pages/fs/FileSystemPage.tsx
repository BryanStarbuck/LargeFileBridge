// The File System page (directory.mdx) — a Mac-Finder column-view (Miller-column) browser.
// Each column lists one directory level and lazily fetches GET /fs?path=…; clicking a directory
// opens a new column to its right (replacing any columns further right). Every row shows its
// code badges pinned to the far right, plus a ⋯ kebab and right-click that open the shared entity
// action menu (menus.mdx §3/§3.1 — the same catalog as the view-one pages).
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { ChevronRight, File as FileIcon, Folder, Home } from "lucide-react";
import type { FsEntry, FsListing } from "@lfb/shared";
import { viewerRouteForName } from "@lfb/shared";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { EntityKebab, EntityMenuAt, type MenuPos } from "@/components/menu/EntityMenu";
import { useWindowedRows } from "@/components/table/useWindowedRows";
import { formatBytes, middleTruncate } from "@/lib/format";
import { FsTabs } from "./FsTabs";

const FSROW_H = 28; // fixed column-row height the windowing math relies on (px).

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

  // Open on the ?path deep-link if present, else the OS home directory.
  const home = useQuery({ queryKey: ["fs", "home"], queryFn: api.fsHome });
  useEffect(() => {
    if (stack.length > 0) return;
    if (initialPath) setStack([initialPath]);
    else if (home.data) setStack([home.data.home]);
  }, [home.data, initialPath, stack.length]);

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

  return (
    <div className="flex h-full flex-col">
      <FsTabs />
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
      style={{ height: FSROW_H }}
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
      {isDir ? (
        <Folder size={14} className="shrink-0 text-slate-500" />
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
