// The shared body both Videos children mount (videos.mdx §3–§4): one 60/40 review layout, one grouped
// house DataTable, one right review column, one Start-Scan pop-up flow, one live-refresh subscription.
// DuplicatesPage / SubsetsPage are thin wrappers that pass their own endpoints, grouping, and copy —
// the two scans stay fully separate (own status, own staleness clock, own batch kind).
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { VideosScanStatus } from "@lfb/shared";
import { DataTable } from "../../components/table/DataTable.js";
import { useLiveRefresh } from "../../lib/useLiveRefresh.js";
import { clientLog } from "../../lib/clientLog.js";
import { ReviewSplitLayout } from "./ReviewSplitLayout.js";
import { GroupReviewColumn, type ReviewVariant } from "./GroupReviewColumn.js";
import { StartScanModal } from "./StartScanModal.js";
import {
  buildVideoColumns,
  interleaveRows,
  type VideoGroup,
  type VideoMember,
  type VideoTableRow,
} from "./videoGroups.js";

export interface VideosReviewConfig<M extends VideoMember> {
  variant: ReviewVariant;
  title: string;
  tableId: string;
  /** "duplicate" / "subset" — drives the never-scanned empty-state wording (duplicates.mdx §5). */
  scanNoun: string;
  listKey: QueryKey;
  statusKey: QueryKey;
  fetchList: () => Promise<{ rows: M[]; groupCount: number; fileCount: number }>;
  fetchStatus: () => Promise<VideosScanStatus>;
  startScan: () => Promise<{ started: boolean }>;
  buildGroups: (rows: M[]) => VideoGroup<M>[];
  /** Duplicates carries the File-type facet (Videos · Images); Subsets is videos-only (subsets.mdx §3). */
  withFileTypeFacet: boolean;
}

export function VideosReviewPage<M extends VideoMember>({
  variant,
  title,
  tableId,
  scanNoun,
  listKey,
  statusKey,
  fetchList,
  fetchStatus,
  startScan,
  buildGroups,
  withFileTypeFacet,
}: VideosReviewConfig<M>) {
  const qc = useQueryClient();

  // Shell-first: the page skeleton (title + table skeleton via DataTable `loading`) renders immediately;
  // a missing backend (404 while it's still being built) degrades to the empty state — never a crash.
  const { data, isLoading } = useQuery({ queryKey: listKey, queryFn: fetchList, retry: false });
  const { data: status } = useQuery({
    queryKey: statusKey,
    queryFn: fetchStatus,
    retry: false,
    // Progress-style liveness poll ONLY while a scan runs (house rule: no idle polling loops); the
    // completion itself also arrives over the "videos" live-refresh topic below.
    refetchInterval: (q) => (q.state.data?.running ? 4000 : false),
  });

  // A finished scan bumps the "videos" topic — the open page refetches without a reload.
  useLiveRefresh(["videos"], [listKey, statusKey]);

  // The Start-Scan pop-up (duplicates.mdx §5 / subsets.mdx §5): opens automatically ONCE per page entry
  // when the scan is recommended (never run, or 4+ days stale) and not running.
  const [modalOpen, setModalOpen] = useState(false);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !status) return;
    if (status.recommend && !status.running) {
      autoOpened.current = true;
      setModalOpen(true);
    }
  }, [status]);
  // Never open (or stay open) while a scan is already running — the page shows the running state instead.
  useEffect(() => {
    if (status?.running) setModalOpen(false);
  }, [status?.running]);

  const start = useMutation({
    mutationFn: startScan,
    onSuccess: (r) => {
      if (!r.started) toast.info("A scan is already running");
      setModalOpen(false);
      void qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (e: Error) => {
      clientLog.error("VideosReviewPage.startScan", e);
      toast.error(e.message);
    },
  });

  const groups = useMemo(() => buildGroups(data?.rows ?? []), [buildGroups, data]);
  const rows = useMemo(() => interleaveRows(groups), [groups]);
  const columns = useMemo(() => buildVideoColumns<M>(), []);

  // Clicking any member row selects its WHOLE group into the right review column (duplicates.mdx §3.2).
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;

  // Keyboard ↑/↓ moves the selection between groups (§3.2) — inert while typing or playing a preview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (!selectedGroupId || groups.length === 0) return;
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "TEXTAREA", "SELECT", "VIDEO", "AUDIO"].includes(t.tagName)) return;
      const idx = groups.findIndex((g) => g.id === selectedGroupId);
      if (idx < 0) return;
      const next = groups[Math.min(groups.length - 1, Math.max(0, idx + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next && next.id !== selectedGroupId) {
        e.preventDefault();
        setSelectedGroupId(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groups, selectedGroupId]);

  // Empty-state wording: never-scanned offers the inline Start-scan link that reopens the modal (§5);
  // a completed scan with zero groups says so honestly instead.
  const scanned = !!status?.lastRunAt;
  const empty = scanned ? (
    <div className="py-10 text-center text-sm text-black/60">No {scanNoun} groups found.</div>
  ) : (
    <div className="py-10 text-center text-sm text-black/60">
      No {scanNoun} scan yet —{" "}
      <button
        className="text-[var(--lfb-primary)] underline underline-offset-2"
        onClick={() => setModalOpen(true)}
      >
        start one from here
      </button>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex shrink-0 items-center justify-between">
        <h1 className="text-2xl font-bold">{title}</h1>
        {data && (
          <div className="text-sm text-black/50">
            {data.groupCount} groups · {data.fileCount} files
          </div>
        )}
      </div>

      {/* Running state (duplicates.mdx §6): the scan is an async batch — the Processing surfaces carry
          the detailed progress; here we only say it is underway. The pop-up never shows meanwhile. */}
      {status?.running && (
        <div className="mb-2 flex shrink-0 items-center gap-2 text-sm text-black/60">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            {variant === "duplicates" ? "Duplicate" : "Subset"} scan running — results appear here when it
            completes (details on the Processing page).
          </span>
        </div>
      )}

      <ReviewSplitLayout
        table={
          <DataTable<VideoTableRow<M>>
            tableId={tableId}
            data={rows}
            columns={columns}
            searchKeys={(r) =>
              r.kind === "header" ? r.group.searchText : `${r.member.name} ${r.member.fullPath}`
            }
            getRowId={(r) => (r.kind === "header" ? `h:${r.group.id}` : `m:${r.group.id}:${r.member.fullPath}`)}
            onRowClick={(r) => setSelectedGroupId(r.group.id)}
            rowClassName={(r) =>
              r.group.id === selectedGroupId
                ? "bg-[var(--lfb-primary-tint)]"
                : r.kind === "header"
                  ? "bg-slate-50"
                  : ""
            }
            itemNoun="rows"
            // Groups by reclaimable bytes descending — the most disk-winning groups first (§3.2).
            defaultSort={[{ id: "size", desc: true }]}
            loading={isLoading}
            fileTypeFacet={withFileTypeFacet ? { valueOf: (r) => r.group.fileType } : undefined}
            empty={empty}
          />
        }
        review={
          selectedGroup ? (
            <GroupReviewColumn
              variant={variant}
              members={selectedGroup.members}
              onDone={() => setSelectedGroupId(null)}
            />
          ) : (
            <div className="grid h-full place-items-center px-4 text-center text-sm text-black/40">
              Select a file to review its whole group side-by-side.
            </div>
          )
        }
      />

      {modalOpen && !status?.running && (
        <StartScanModal
          variant={variant}
          status={status}
          starting={start.isPending}
          onSkip={() => setModalOpen(false)}
          onStart={() => start.mutate()}
        />
      )}
    </div>
  );
}
