// One storage's detail (storages.mdx §2–§6): its descriptor (name/type + type-specific block + clones),
// the per-file fingerprint index (.lfbridge/files.yaml), and the per-storage actions — (re)Index the
// files, and queue media Analysis (transcript / description / visuals-by-time) for a media file.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { ChevronLeft, RefreshCw, Sparkles, Captions, Settings } from "lucide-react";
import { toast } from "sonner";
import type { StorageFileRow } from "@lfb/shared";
import { formatBytes, mediaKindForName } from "@lfb/shared";
import { api } from "@/api/client";
import { runTranscribeFile } from "@/lib/transcribe";
import { PageActions, producingActions } from "@/components/menu/PageActions";
import { compressAllVideos } from "@/components/menu/domainActions";
import type { Action } from "@/components/menu/EntityMenu";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataTable } from "@/components/table/DataTable";
import type { LfbColumn } from "@/components/table/types";
import { relativeTime, absoluteTime } from "@/lib/format";
import { clientLog } from "@/lib/clientLog";

export function StorageDetailPage() {
  const { storageId } = useParams({ strict: false }) as { storageId: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["storage", storageId], queryFn: () => api.storageDetail(storageId) });

  const index = useMutation({
    mutationFn: () => api.indexStorage(storageId),
    onSuccess: (r) => { toast.success(`Indexed ${r.indexed} file${r.indexed === 1 ? "" : "s"}`); qc.invalidateQueries({ queryKey: ["storage", storageId] }); },
    onError: (e: Error) => { clientLog.error("StorageDetail.index", e); toast.error(e.message); },
  });
  const analyze = useMutation({
    mutationFn: (path: string) => api.analyzeStorageFile(storageId, path),
    onSuccess: (r) => { toast.success(`Analysis queued: ${r.outputs.join(", ")}`); qc.invalidateQueries({ queryKey: ["storage", storageId] }); },
    onError: (e: Error) => { clientLog.error("StorageDetail.analyze", e); toast.error(e.message); },
  });
  // Scoped "Show what could be transcribed" (transcribe_calc_engine.mdx §1) — scans just THIS storage for
  // transcribable-not-yet-transcribed media and writes its transcribe batch, surfaced on the To Do page.
  const transcribeScan = useMutation({
    mutationFn: () => api.transcribeScan(storageId),
    onSuccess: (r) => {
      toast.success(
        r.candidates > 0
          ? `Found ${r.candidates} file${r.candidates === 1 ? "" : "s"} to transcribe — see the To Do page`
          : "Nothing left to transcribe in this storage — everything has a transcript",
      );
      qc.invalidateQueries({ queryKey: ["todo", "batches"] });
    },
    onError: (e: Error) => { clientLog.error("StorageDetail.transcribeScan", e); toast.error(e.message); },
  });

  const s = data?.storage;
  const d = data?.descriptor;

  // The action-links row (page_actions.mdx §4 — Storage detail): producing pair · Compress all videos… ·
  // Re-index files. Index files stays the header primary.
  const storageActions: Action[] = [
    ...producingActions(() => (s ? { root: s.root } : {})),
    compressAllVideos(s?.root),
    {
      id: "transcribe-scan",
      label: transcribeScan.isPending ? "Looking…" : "Show what could be transcribed",
      icon: <Captions className="h-3.5 w-3.5" />,
      group: "Work",
      disabled: transcribeScan.isPending,
      onSelect: () => transcribeScan.mutate(),
    },
    {
      id: "reindex",
      label: "Re-index files",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      group: "Work",
      disabled: index.isPending,
      onSelect: () => index.mutate(),
    },
  ];

  const columns: LfbColumn<StorageFileRow>[] = [
    { id: "path", header: "File", kind: "text", accessor: (f) => f.path, cell: (f) => <span className="font-medium">{f.path}</span> },
    { id: "size", header: "Size", kind: "bytes", align: "right", accessor: (f) => f.sizeBytes, cell: (f) => formatBytes(f.sizeBytes) },
    { id: "kind", header: "Kind", kind: "enum", accessor: (f) => f.compressible ?? "", cell: (f) => <span className="text-black/60">{mediaKindForName(f.path.slice(f.path.lastIndexOf("/") + 1)) ?? "—"}</span> },
    { id: "analysis", header: "Analysis", kind: "text", sortable: false, accessor: (f) => f.analysis.join(","), cell: (f) => f.analysis.length ? <span className="text-xs text-black/60">{f.analysis.join(" · ")}</span> : <span className="text-black/20">—</span> },
    { id: "modified", header: "Modified", kind: "timestamp", accessor: (f) => f.modifiedAt, cell: (f) => f.modifiedAt ? <span title={absoluteTime(f.modifiedAt)}>{relativeTime(f.modifiedAt)}</span> : "—" },
    {
      id: "act", header: "", kind: "text", sortable: false, filterable: false, accessor: () => "",
      cell: (f) => {
        const media = mediaKindForName(f.path.slice(f.path.lastIndexOf("/") + 1));
        if (!media) return null;
        const name = f.path.slice(f.path.lastIndexOf("/") + 1);
        return (
          <span className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
            {(media === "audio" || media === "video") && s && (
              <button className="flex items-center gap-1 text-sm text-[var(--lfb-primary)] hover:underline" title="Transcribe this file" onClick={() => runTranscribeFile(`${s.root}/${f.path}`, name)}>
                <Captions className="h-3.5 w-3.5" /> Transcribe
              </button>
            )}
            <button className="flex items-center gap-1 text-sm text-[var(--lfb-primary)] hover:underline" title="Queue transcript / description / visuals-by-time" onClick={() => analyze.mutate(f.path)}>
              <Sparkles className="h-3.5 w-3.5" /> Analyze
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        above={<Link to="/storages" className="flex items-center gap-1 text-sm text-black/50 hover:text-black"><ChevronLeft className="h-4 w-4" /> Storages</Link>}
        title={s?.name ?? "…"}
        subtitle={s?.root}
        actionsRow={<PageActions actions={storageActions} />}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => index.mutate()}
              disabled={index.isPending}
              title="Rebuild the fingerprint index"
              className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${index.isPending ? "animate-spin" : ""}`} /> {index.isPending ? "Indexing…" : "Index files"}
            </button>
            {/* Per-storage settings gear (storage_settings.mdx §1) — keep .lfbridge/ + backing locations. */}
            {s && (
              <Link
                to="/storages/$storageId/settings"
                params={{ storageId: s.id }}
                title="Storage settings"
                className="flex items-center rounded-md border border-[var(--lfb-border)] p-1.5 text-black/60 hover:bg-slate-100"
              >
                <Settings className="h-4 w-4" />
              </Link>
            )}
          </div>
        }
      />

      {/* Descriptor summary */}
      {s && (
        <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-[var(--lfb-border)] px-4 py-3 sm:grid-cols-4">
          <Fact label="Type" value={<span className="capitalize">{s.type}</span>} />
          {s.companyName && <Fact label="Company" value={s.companyName} />}
          {s.communityId && <Fact label="Community" value={s.communityId} />}
          <Fact label="Initialized" value={s.initialized ? "yes" : "no"} />
          <Fact label="Files tracked" value={s.fileCount ?? "—"} />
          <Fact label="Google Drive clone" value={d?.clones.googleDrive ?? "—"} />
          <Fact label="Dropbox clone" value={d?.clones.dropbox ?? "—"} />
        </div>
      )}

      <DataTable
        fillHeight={false}
        data={data?.files ?? []}
        columns={columns}
        searchKeys={(f) => f.path}
        getRowId={(f) => f.path}
        onRowClick={(f) => s && navigate({ to: "/file", search: { path: `${s.root}/${f.path}` } })}
        itemNoun="files"
        loading={isLoading}
        empty={<p className="text-center text-black/60">No large files indexed yet. Click <b>Index files</b> to scan this storage.</p>}
      />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-black/40">{label}</div>
      <div className="truncate text-sm text-black/80">{value}</div>
    </div>
  );
}

export { StorageDetailPage as default };
