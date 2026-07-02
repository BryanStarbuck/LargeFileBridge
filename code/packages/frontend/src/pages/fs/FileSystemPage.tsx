// The File System page (directory.mdx) — a Mac-Finder column-view (Miller-column) browser.
// Each column lists one directory level and lazily fetches GET /fs?path=…; clicking a directory
// opens a new column to its right (replacing any columns further right). Every row shows its
// code badges pinned to the far right.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File as FileIcon, Folder, Home } from "lucide-react";
import type { FsEntry, FsListing } from "@lfb/shared";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { formatBytes, middleTruncate } from "@/lib/format";

export default function FileSystemPage() {
  // The column stack: one absolute directory path per column (index 0 is the root/home column).
  const [stack, setStack] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const stripRef = useRef<HTMLDivElement>(null);

  // Open on the OS home directory.
  const home = useQuery({ queryKey: ["fs", "home"], queryFn: api.fsHome });
  useEffect(() => {
    if (home.data && stack.length === 0) setStack([home.data.home]);
  }, [home.data, stack.length]);

  // Auto-scroll to the newest column whenever the stack grows.
  useEffect(() => {
    const el = stripRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [stack.length]);

  function openDir(colIndex: number, path: string) {
    setSelectedFile(null);
    setStack((s) => [...s.slice(0, colIndex + 1), path]);
  }
  function selectFile(path: string) {
    setSelectedFile(path);
  }
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
            root={root}
            showHidden={showHidden}
            openedChild={stack[i + 1] ?? null}
            selectedFile={selectedFile}
            onOpenDir={(p) => openDir(i, p)}
            onSelectFile={selectFile}
          />
        ))}
      </div>
    </div>
  );
}

interface FsColumnProps {
  root: string;
  showHidden: boolean;
  openedChild: string | null; // the child in THIS column that opened the next column (for highlight)
  selectedFile: string | null;
  onOpenDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}

function FsColumn({ root, showHidden, openedChild, selectedFile, onOpenDir, onSelectFile }: FsColumnProps) {
  const q = useQuery<FsListing>({
    queryKey: ["fs", "list", root, showHidden],
    queryFn: () => api.fsList(root, showHidden),
  });

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-r border-[var(--lfb-border)]">
      <div className="overflow-y-auto">
        {q.isLoading && <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>}
        {q.isError && (
          <div className="px-3 py-2 text-xs text-red-600">
            {(q.error as Error)?.message || "Cannot read directory"}
          </div>
        )}
        {q.data?.entries.length === 0 && (
          <div className="px-3 py-2 text-xs text-slate-500">Empty</div>
        )}
        {q.data?.entries.map((e) => (
          <FsRow
            key={e.path}
            entry={e}
            active={e.path === openedChild || e.path === selectedFile}
            onOpenDir={onOpenDir}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </div>
  );
}

function FsRow({
  entry,
  active,
  onOpenDir,
  onSelectFile,
}: {
  entry: FsEntry;
  active: boolean;
  onOpenDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isDir = entry.kind === "dir";
  return (
    <button
      onClick={() => (isDir ? onOpenDir(entry.path) : onSelectFile(entry.path))}
      title={entry.path}
      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] ${
        active ? "bg-[var(--lfb-primary-tint)]" : "hover:bg-slate-100"
      }`}
    >
      {isDir ? (
        <Folder size={14} className="shrink-0 text-slate-500" />
      ) : (
        <FileIcon size={14} className="shrink-0 text-slate-400" />
      )}
      <span className="min-w-0 flex-1 truncate text-black">{middleTruncate(entry.name, 34)}</span>
      {entry.kind === "file" && entry.sizeBytes != null && (
        <span className="shrink-0 text-[10px] tabular-nums text-slate-400">
          {formatBytes(entry.sizeBytes)}
        </span>
      )}
      <Badges badges={entry.badges} />
      {isDir && entry.hasChildren && <ChevronRight size={13} className="shrink-0 text-slate-400" />}
    </button>
  );
}
