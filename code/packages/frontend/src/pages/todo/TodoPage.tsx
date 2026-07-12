// The To Do page (to_do.mdx): the aggregated per-storage TO DO Batch slugs. Only batches WITH work
// show; each is a compact card with a blue chevron (open the batch popup) and a red trash (dismiss).
// A header link runs the on-demand "Show what could be transcribed" scan and adds transcribe slugs.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Trash2, ListTodo, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { TodoBatchSummary, TodoBatchDetail, TodoBatchItem, TodoCategory } from "@lfb/shared";
import { formatBytes, mediaKindForName } from "@lfb/shared";
import { api } from "../../api/client.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { WarningPopup } from "../../components/ui/WarningPopup.js";
import type { WarningDef, WarningTarget, WarningTargetAxes } from "../../components/ui/warnings/registry.js";
import { clientLog } from "../../lib/clientLog.js";

const SCOPE_LABEL: Record<string, string> = {
  repo: "repo",
  personal: "Personal",
  company: "Company",
  community: "Community",
  dropbox: "Dropbox",
  gdrive: "Google Drive",
};

const CATEGORY_LABEL: Record<TodoCategory, string> = {
  compress_video: "videos to compress",
  compress_image: "images to compress",
  git_ignore: "big files not git-ignored",
  pin: "files to back up",
  pull_down: "on your other computers",
  transcribe_video: "videos to transcribe",
  transcribe_audio: "audio to transcribe",
};

function count(s: TodoBatchSummary, k: TodoCategory): number {
  return s.totals[k]?.count ?? 0;
}
function reclaimableBytes(s: TodoBatchSummary): number {
  return (s.totals.compress_video?.reclaimableBytes ?? 0) + (s.totals.compress_image?.reclaimableBytes ?? 0);
}
function totalCount(s: TodoBatchSummary): number {
  return Object.values(s.totals).reduce((a, t) => a + (t?.count ?? 0), 0);
}

/** The slug's headline metric (right of the title), chosen by pattern (to_do.mdx §5.1). */
function headlineMetric(s: TodoBatchSummary): string {
  switch (s.pattern) {
    case "pull_down":
      return `${count(s, "pull_down")} on other computers`;
    case "compress":
      return `${formatBytes(reclaimableBytes(s))} reclaimable`;
    case "git_ignore":
      return `${count(s, "git_ignore")} big files`;
    case "pin":
      return `${count(s, "pin")} could be backed up`;
    case "transcribe":
      return `${count(s, "transcribe_video")} videos + ${count(s, "transcribe_audio")} audio`;
    default:
      return `${totalCount(s)} to review`;
  }
}

/** The slug's one-line sentence (to_do.mdx §5). */
function sentence(s: TodoBatchSummary): string {
  switch (s.pattern) {
    case "pull_down":
      return "These files are pinned on your other computers but not on this one yet.";
    case "compress":
      return "These videos and images look uncompressed — compressing reclaims space.";
    case "git_ignore":
      return "These big files aren't a good idea to check into Git.";
    case "pin":
      return "These big files aren't backed up across your computers yet.";
    case "transcribe":
      return "These have no transcription yet — transcribe to make them searchable.";
    default:
      return "Large File Bridge has several recommendations for this storage.";
  }
}

/** The up-to-three detail cells (value/label pairs) for the categories present. */
function detailCells(s: TodoBatchSummary): { value: string; label: string }[] {
  const cells: { value: string; label: string }[] = [];
  for (const k of Object.keys(s.totals) as TodoCategory[]) {
    const c = s.totals[k];
    if (!c) continue;
    cells.push({ value: String(c.count), label: CATEGORY_LABEL[k] });
  }
  return cells.slice(0, 3);
}

export function TodoPage() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: batches = [], isLoading } = useQuery({
    queryKey: ["todo", "batches"],
    queryFn: api.todoBatches,
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissTodoBatch(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["todo", "batches"] }),
    onError: (e: Error) => {
      clientLog.error("TodoPage.dismiss", e);
      toast.error(e.message);
    },
  });

  const transcribeScan = useMutation({
    mutationFn: () => api.transcribeScan(),
    onSuccess: (r) => {
      toast.success(
        r.candidates > 0
          ? `Found ${r.candidates} file${r.candidates === 1 ? "" : "s"} to transcribe across ${r.batches} storage${r.batches === 1 ? "" : "s"}`
          : "Nothing left to transcribe — everything has a transcript",
      );
      qc.invalidateQueries({ queryKey: ["todo", "batches"] });
    },
    onError: (e: Error) => {
      clientLog.error("TodoPage.transcribeScan", e);
      toast.error(e.message);
    },
  });

  return (
    <div>
      <PageHeader
        title="To Do"
        actions={
          <button
            onClick={() => transcribeScan.mutate()}
            disabled={transcribeScan.isPending}
            className="flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            {transcribeScan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListTodo className="h-4 w-4" />}
            {transcribeScan.isPending ? "Looking…" : "Show what could be transcribed"}
          </button>
        }
      />

      {isLoading ? (
        <p className="mt-6 text-center text-black/50">Loading…</p>
      ) : batches.length === 0 ? (
        <div className="mt-10 rounded-lg border border-[var(--lfb-border)] bg-white p-8 text-center text-black/60">
          Nothing to do. Large File Bridge will list recommendations here after its next scan.
        </div>
      ) : (
        <div className="mt-2">
          {batches.map((s, i) => (
            <div key={s.id}>
              {i > 0 && <div className="border-t" style={{ borderColor: "var(--lfb-border)" }} />}
              <TodoSlug s={s} onOpen={() => setOpenId(s.id)} onDismiss={() => dismiss.mutate(s.id)} />
            </div>
          ))}
        </div>
      )}

      {openId && <BatchPopup id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function TodoSlug({ s, onOpen, onDismiss }: { s: TodoBatchSummary; onOpen: () => void; onDismiss: () => void }) {
  const cells = detailCells(s);
  return (
    <div className="flex items-start gap-4 py-4">
      <div className="min-w-0 flex-1">
        {/* Title row: name + scope tag (left) · headline metric (right) */}
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-black">{s.storageName}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-black/50">{SCOPE_LABEL[s.scope] ?? s.scope}</span>
          </div>
          <span className="shrink-0 text-sm font-medium text-[var(--lfb-primary)]">{headlineMetric(s)}</span>
        </div>
        {/* Sentence row (full width) */}
        <p className="mt-1 text-sm text-black/60">{sentence(s)}</p>
        {/* Detail cells: up to three value/label pairs */}
        {cells.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-sm">
            {cells.map((c, i) => (
              <span key={i}>
                <b className="text-black">{c.value}</b> <span className="text-black/50">{c.label}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {/* Action row: red trash then blue chevron */}
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <button
          onClick={onDismiss}
          title="Dismiss — don't act on these now (never deletes files)"
          className="grid h-8 w-8 place-items-center rounded-md border text-white"
          style={{ background: "var(--lfb-bad)", borderColor: "var(--lfb-bad)" }}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          onClick={onOpen}
          title="Review and apply"
          className="flex h-8 items-center gap-1 rounded-md bg-[var(--lfb-primary)] px-2.5 text-sm text-white"
        >
          Review <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** The recommended-action label for one item (shown in the popup list). */
function recommendLabel(it: TodoBatchItem): string {
  switch (it.category) {
    case "pull_down":
      return `pull down${it.pinnedOn?.length ? ` from ${it.pinnedOn[0]}` : ""} + git-ignore`;
    case "pin":
      return "add to IPFS + git-ignore";
    case "compress_video":
    case "compress_image":
      return "compress";
    case "git_ignore":
      return "git-ignore";
    case "transcribe_video":
    case "transcribe_audio":
      return "transcribe";
  }
}

// The recommended per-row action axes for one batch item (warnings.mdx §4.5.1). Pre-checked ("on") where
// the engine recommends an action (recommend.gitignore ↔ the "ignore" axis); an axis absent ⇒ no toggle
// on that row (N/A). Falls back to a category default so a non-transcribe row always leads with toggles.
function axesForItem(it: TodoBatchItem): WarningTargetAxes | undefined {
  const r = it.recommend ?? {};
  const axes: WarningTargetAxes = {};
  if (r.ipfs) axes.ipfs = "on";
  if (r.gitignore) axes.ignore = "on";
  if (r.compress) axes.compress = "on";
  if (Object.keys(axes).length) return axes;
  switch (it.category) {
    case "pull_down":
    case "pin":
      return { ipfs: "on", ignore: "on" };
    case "git_ignore":
      return { ignore: "on" };
    case "compress_video":
    case "compress_image":
      return { compress: "on" };
    default:
      return undefined;
  }
}

// The To-Do batch popup (to_do.mdx §6/§7) — the wide two-pane WarningPopup: right pane = the file list
// with per-row action toggles (pin/ignore/compress) pre-checked where recommended; left pane educates and
// flips to a full-size media preview on hover (Space plays a previewed video, §4.5.2/§4.5.3).
function BatchPopup({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: batch, isLoading } = useQuery<TodoBatchDetail>({
    queryKey: ["todo", "batch", id],
    queryFn: () => api.todoBatch(id),
  });

  const warning = useMemo<WarningDef | null>(() => {
    if (!batch) return null;
    const isTranscribe = batch.kind === "transcribe";
    const targets: WarningTarget[] = batch.items.map((it) => {
      const kind = mediaKindForName(it.path);
      return {
        id: it.path,
        label: it.path,
        sublabel: `${formatBytes(it.sizeBytes)} · ${recommendLabel(it)}`,
        // Transcribe is a single action → single include checkbox; every other batch → per-row toggles.
        axes: isTranscribe ? undefined : axesForItem(it),
        preview: kind ? { kind, url: "" } : undefined, // url resolved lazily via mediaGrant on hover
      };
    });
    return {
      id: `todo-${id}`,
      state: "warn",
      scope: "storage",
      headline: `${isTranscribe ? "Transcribe" : "Review"} · ${batch.storageName}`,
      popup: {
        whatThisIs: sentence(batch),
        whyItMatters: isTranscribe
          ? "A transcript makes each clip searchable and lets you find spoken words across your library."
          : "These recommendations back up your files across your computers, keep big files out of Git, and reclaim space — you decide, per file, which to apply.",
        targets,
        targetNoun: "file",
        actionLabel: isTranscribe ? "Transcribe" : "Apply",
        apply: async (_sel, ids, perRow) => {
          const r = await api.applyTodoBatch(id, ids, perRow);
          toast.success(
            isTranscribe
              ? `Transcribing ${r.transcribed} file${r.transcribed === 1 ? "" : "s"} in the background`
              : `Applied to ${r.applied} file${r.applied === 1 ? "" : "s"}`,
          );
          qc.invalidateQueries({ queryKey: ["todo", "batches"] });
          qc.invalidateQueries({ queryKey: ["repo"] });
        },
      },
    };
  }, [batch, id, qc]);

  if (isLoading || !warning || !batch) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
        <div className="rounded-xl bg-white px-6 py-5 text-sm text-black/50 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  const root = batch.storageRoot.replace(/\/+$/, "");
  return (
    <WarningPopup
      warning={warning}
      onClose={onClose}
      resolvePreviewUrl={async (t) => {
        try {
          const g = await api.mediaGrant(`${root}/${t.id}`);
          return g.url;
        } catch (e) {
          clientLog.error("TodoPage.preview", e as Error);
          return null;
        }
      }}
    />
  );
}
