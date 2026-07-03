// View one directory (directories.mdx) — the single-entity page for ONE directory: identity + badges
// + the two sticky flag switches + the charter category rollup table, with the top-right ⋯ "more"
// menu (menus.mdx §4). Distinct from the File System column browser (directory.mdx).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, FolderOpen, Zap, EyeOff, GitBranch, UploadCloud, Ban } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { EntityMore, ActionsKebab, type Action } from "@/components/menu/EntityMenu";
import { DataTable } from "@/components/table/DataTable";
import type { LfbColumn } from "@/components/table/types";
import { FlagSwitches, EntityHeaderMissing } from "./entityShared";
import { relativeTime } from "@/lib/format";

interface RollupRow {
  id: string;
  category: string;
  count: number;
  action: "compress" | "ignore" | "track" | null;
  hidden: boolean; // suppressed by a sticky flag (menus.mdx §6.6)
}

export function ViewOneDirectoryPage() {
  const { path } = useSearch({ strict: false }) as { path?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: v, isLoading } = useQuery({
    queryKey: ["entity", path],
    queryFn: () => api.entity(path!),
    enabled: !!path,
  });

  if (!path) return <p className="text-black/60">No directory selected.</p>;
  if (isLoading) return <SkeletonPage />;
  if (!v) return <p className="text-black/60">Could not load this directory.</p>;
  if (!v.exists) return <EntityHeaderMissing view={v} navigate={navigate} />;

  const r = v.rollup;
  const rows: RollupRow[] = r
    ? [
        { id: "videos", category: "Videos that can be compressed", count: r.videosToCompress, action: "compress", hidden: v.flags.noCompress },
        { id: "images", category: "Images that can be compressed", count: r.imagesToCompress, action: "compress", hidden: v.flags.noCompress },
        { id: "big-open", category: "Big files not git-ignored", count: r.bigNotIgnored, action: "ignore", hidden: false },
        { id: "big-ignored", category: "Big files git-ignored, not tracked", count: r.bigIgnoredNotTracked, action: "track", hidden: v.flags.neverIpfs },
      ]
    : [];

  const compressDir = () => {
    if (!window.confirm(`Compress media inside ${v.name}? This is an offer — nothing changes until it runs.`)) return;
    api.compressEntity(v.path).then(() => toast.success("Compression queued")).catch((e) => toast.error(e.message));
  };

  // The folder-level sticky flags — same state as the strip switches (directories.mdx §8.1).
  const toggleFlag = async (patch: { neverIpfs?: boolean; noCompress?: boolean }) => {
    await api.setEntityFlags(v.path, patch);
    qc.invalidateQueries({ queryKey: ["entity", v.path] });
  };
  const showMatching = () => navigate({ to: "/fs", search: { path: v.path } });

  // The per-row ⋮ kebab for a rollup CATEGORY row (page-local, directories.mdx §8.1): the row's offer
  // (when live) + "Show matching files" + the relevant folder sticky-flag toggle. Every row has one.
  const rollupMenu = (row: RollupRow): Action[] => {
    const a: Action[] = [];
    if (row.action && row.count > 0 && !row.hidden) {
      if (row.action === "compress")
        a.push({ id: "compress", label: "Compress…", group: "Work", icon: <Zap className="h-4 w-4" />, onSelect: compressDir });
      else if (row.action === "ignore")
        a.push({ id: "ignore", label: "Git-ignore…", group: "Work", icon: <EyeOff className="h-4 w-4" />,
          onSelect: () => { toast.message("Git-ignore is offered per file — open in File System to review."); } });
      else
        a.push({ id: "track", label: "Track / Sync", group: "Work", icon: <UploadCloud className="h-4 w-4" />, onSelect: showMatching });
    }
    a.push({ id: "show", label: "Show matching files", group: "Open", icon: <FolderOpen className="h-4 w-4" />, onSelect: showMatching });
    if (row.action === "compress")
      a.push({ id: "no-compress", label: "Do not compress", group: "Flag", icon: <Ban className="h-4 w-4" />,
        checked: v.flags.noCompress, onSelect: () => toggleFlag({ noCompress: !v.flags.noCompress }) });
    if (row.action === "track")
      a.push({ id: "never-ipfs", label: "Never IPFS", group: "Flag", icon: <Ban className="h-4 w-4" />,
        checked: v.flags.neverIpfs, onSelect: () => toggleFlag({ neverIpfs: !v.flags.neverIpfs }) });
    return a;
  };

  const columns: LfbColumn<RollupRow>[] = [
    {
      id: "category",
      header: "What's inside",
      kind: "text",
      accessor: (row) => row.category,
      cell: (row) => (
        <button
          className="text-left hover:text-[var(--lfb-primary)] hover:underline"
          title="Open in File System"
          onClick={() => navigate({ to: "/fs", search: { path: v.path } })}
        >
          {row.category}
        </button>
      ),
    },
    { id: "count", header: "Count", kind: "int", align: "right", accessor: (row) => row.count },
    {
      id: "action",
      header: "Action",
      kind: "text",
      sortable: false,
      filterable: false,
      accessor: (row) => row.action ?? "",
      cell: (row) => {
        if (row.count === 0 || row.hidden || !row.action) return <span className="text-black/25">—</span>;
        if (row.action === "compress")
          return <RowAction icon={<Zap className="h-3.5 w-3.5" />} label="Compress…" onClick={compressDir} />;
        if (row.action === "ignore")
          return <RowAction icon={<EyeOff className="h-3.5 w-3.5" />} label="Git-ignore…" onClick={() => toast.message("Git-ignore is offered per file — open in File System to review.")} />;
        return <RowAction icon={<UploadCloud className="h-3.5 w-3.5" />} label="Track / Sync" onClick={() => navigate({ to: "/fs", search: { path: v.path } })} />;
      },
    },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <button onClick={() => history.back()} className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
            <ChevronLeft className="h-4 w-4" /> back
          </button>
          <h1 className="truncate text-xl font-semibold text-black" title={v.name}>{v.name}</h1>
          <div className="truncate font-mono text-xs text-black/50" title={v.path}>{v.path}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => navigate({ to: "/fs", search: { path: v.path } })}
            className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white"
          >
            <FolderOpen className="h-4 w-4" /> Open in File System
          </button>
          <EntityMore path={v.path} />
        </div>
      </div>

      {/* Badge + flag strip */}
      <div className="my-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-[var(--lfb-border)] px-4 py-2">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-black/40">Badges</span>
          {v.badges.length ? <Badges badges={v.badges} /> : <span className="text-xs text-black/30">none</span>}
        </div>
        <FlagSwitches view={v} />
      </div>

      {/* Category rollup table */}
      <h2 className="mb-1 text-sm font-medium text-black/70">What's inside</h2>
      <DataTable
        // Content below the table (the footer summary) → bounded height, not full-page
        // (directories.mdx §8 / repos.mdx §3.3.1).
        fillHeight={false}
        data={rows}
        columns={columns}
        searchKeys={(row) => row.category}
        getRowId={(row) => row.id}
        rowMenu={(row) => <ActionsKebab actions={rollupMenu(row)} />}
        itemNoun="categories"
        empty={<p className="text-center text-black/60">Nothing here needs attention.</p>}
      />

      {/* Footer summary */}
      <div className="mt-2 flex items-center gap-2 text-xs text-black/50">
        <GitBranch className="h-3.5 w-3.5" />
        Directory{v.repo && <> · inside repo <b>{v.repo.name}</b></>}
        {r && <> · {r.entryCount} entries · scanned {relativeTime(r.scannedAt)}</>}
      </div>
    </div>
  );
}

function RowAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded border border-[var(--lfb-border)] px-2 py-1 text-xs hover:bg-slate-100"
    >
      {icon}
      {label}
    </button>
  );
}

function SkeletonPage() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-6 w-1/3 rounded bg-slate-100" />
      <div className="h-10 rounded bg-slate-100" />
      <div className="h-40 rounded bg-slate-100" />
    </div>
  );
}

export { ViewOneDirectoryPage as default };
