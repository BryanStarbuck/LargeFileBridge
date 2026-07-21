// One storage's detail (storages.mdx §2–§6): its descriptor (name/type + type-specific block + clones),
// the per-file fingerprint index (.lfbridge/files.yaml), and the per-storage actions — (re)Index the
// files, and queue media Analysis (transcript / description / visuals-by-time) for a media file.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { ChevronLeft, RefreshCw, Sparkles, Captions, Settings } from "lucide-react";
import { toast } from "sonner";
import type { StorageFileRow } from "@lfb/shared";
import { formatBytes, mediaKindForName, viewerRouteForName } from "@lfb/shared";
import { api } from "@/api/client";
import { runTranscribeFile } from "@/lib/transcribe";
import { runDescribeFile } from "@/lib/describe";
import { runOcrFile } from "@/lib/ocr";
import { PageActions, producingActions } from "@/components/menu/PageActions";
import { compressAllVideos } from "@/components/menu/domainActions";
import type { Action } from "@/components/menu/EntityMenu";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataTable } from "@/components/table/DataTable";
import type { LfbColumn } from "@/components/table/types";
// The shared icon control-column kit (tables.mdx icon-columns) — the Transcribe / AI description / OCR
// status icons, here derived from the storage index's analysis[] + the file's kind.
import { TaskIconCell, TaskIconHeader, analysisTaskStatuses, TASK_ICON, type TaskIconKind } from "@/components/table/taskIcons";
import { taskRowValue } from "@/components/table/fileFilter";
import { relativeTime, absoluteTime } from "@/lib/format";
import { useLiveRefresh } from "@/lib/useLiveRefresh";
import { clientLog } from "@/lib/clientLog";

export function StorageDetailPage() {
  const { storageId } = useParams({ strict: false }) as { storageId: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["storage", storageId], queryFn: () => api.storageDetail(storageId) });
  useLiveRefresh(["storages"], [["storage", storageId]]);

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

  // The click on an analysis icon (tables.mdx icon-columns): "could" runs the analysis for this one file;
  // "done" opens the file's viewer to read the result; "na" is inert. The storage root joins the row's
  // relative path into the absolute path each runner keys off.
  const onAnalysisActivate = (kind: TaskIconKind, f: StorageFileRow, state: string) => {
    if (!s || state === "na") return;
    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
    const abs = `${s.root}/${f.path}`;
    const refresh = () => qc.invalidateQueries({ queryKey: ["storage", storageId] });
    if (state === "done") {
      navigate({ to: viewerRouteForName(name), search: { path: abs } });
      return;
    }
    if (kind === "transcribe") runTranscribeFile(abs, name);
    else if (kind === "describe") runDescribeFile(abs, name, { onDone: refresh });
    else if (kind === "ocr") runOcrFile(abs, name, { onDone: refresh });
  };

  // The row's three analysis statuses, derived once per call site from its analysis[] + name — shared by
  // the icon columns and the §2.11 filter fields.
  const rowAnalysis = (f: StorageFileRow) =>
    analysisTaskStatuses(f.path.slice(f.path.lastIndexOf("/") + 1), f.analysis);

  // One narrow analysis icon column (Transcribe / AI description / OCR) — status derived from analysis[].
  const analysisIconCol = (kind: "transcribe" | "describe" | "ocr"): LfbColumn<StorageFileRow> => ({
    id: kind,
    header: TASK_ICON[kind].label,
    headerCell: <TaskIconHeader kind={kind} />,
    tight: true,
    minWidth: 30,
    kind: "enum",
    filterOptions: ["could", "done", "na"],
    accessor: (f) => analysisTaskStatuses(f.path.slice(f.path.lastIndexOf("/") + 1), f.analysis)[kind],
    cell: (f) => {
      const state = analysisTaskStatuses(f.path.slice(f.path.lastIndexOf("/") + 1), f.analysis)[kind];
      return <TaskIconCell kind={kind} state={state} onActivate={() => onAnalysisActivate(kind, f, state)} />;
    },
  });

  const columns: LfbColumn<StorageFileRow>[] = [
    // Leading analysis icon columns (tables.mdx icon-columns). Storage files aren't the pin/git-ignore
    // surface (that's repos), so only the three analysis icons appear here.
    analysisIconCol("transcribe"),
    analysisIconCol("describe"),
    analysisIconCol("ocr"),
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
        return (
          <span className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
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
          <Fact
            label="Files tracked"
            value={
              <span className="flex items-center gap-1.5">
                {s.fileCount ?? "—"}
                {s.indexDroppedFiles > 0 && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-800">incomplete</span>
                )}
              </span>
            }
          />
          <Fact label="Google Drive clone" value={d?.clones.googleDrive ?? "—"} />
          <Fact label="Dropbox clone" value={d?.clones.dropbox ?? "—"} />
        </div>
      )}

      {/* A truncated index is stated in full, above the table it invalidates (storages.mdx §4.1a). The
          count below — and the compression / big-file rollups derived from it — are an UNDER-report by
          exactly this many files, and those files are not fingerprinted, pinned, or synced anywhere. */}
      {s && s.indexDroppedFiles > 0 && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
          <div className="font-medium">
            This storage&rsquo;s file index is incomplete — {s.indexDroppedFiles.toLocaleString()} large file
            {s.indexDroppedFiles === 1 ? "" : "s"} could not be recorded.
          </div>
          <div className="mt-1 text-red-800">
            Large File Bridge stops recording once an index reaches its size limit, so the file list and count
            below are missing those files. They are not fingerprinted, not pinned, and not synced to your other
            computers. Move some content into its own storage, then use Index files to rebuild.
          </div>
        </div>
      )}

      <DataTable
        tableId="storage-detail"
        fillHeight={false}
        data={data?.files ?? []}
        columns={columns}
        // The §2.11 file filter (tables.mdx §2.11.6 — the Storage-detail subset): the three analysis
        // axes derived from analysis[] + the file's kind, and the compressible family from the index's
        // compressible verdict. No pin/git-ignore fields — a storage row has no per-file decision.
        fileFilter={{
          fields: [
            { id: "transcribe", valueOf: (f) => taskRowValue(rowAnalysis(f).transcribe) },
            { id: "ai_description", valueOf: (f) => taskRowValue(rowAnalysis(f).describe) },
            { id: "ocr", valueOf: (f) => taskRowValue(rowAnalysis(f).ocr) },
            { id: "compressible_videos", valueOf: (f) => (f.compressible === "video" ? "yes" : "no") },
            { id: "compressible_images", valueOf: (f) => (f.compressible === "image" ? "yes" : "no") },
          ],
        }}
        searchKeys={(f) => f.path}
        getRowId={(f) => f.path}
        onRowClick={(f) => s && navigate({ to: "/file", search: { path: `${s.root}/${f.path}` } })}
        // ⌘/Ctrl/middle-click opens the row's destination in a new tab, like any link (tables.mdx §4d).
        rowHref={(f) => (s ? `/file?path=${encodeURIComponent(`${s.root}/${f.path}`)}` : "")}
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
