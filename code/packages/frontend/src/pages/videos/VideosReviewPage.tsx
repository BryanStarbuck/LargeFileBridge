// The shared body both Videos children mount (videos.mdx §3–§4): one 60/40 review layout, one grouped
// house DataTable, one right review column, one Start-Scan pop-up flow, one live-refresh subscription.
// DuplicatesPage / SubsetsPage are thin wrappers that pass their own endpoints, grouping, and copy —
// the two scans stay fully separate (own status, own staleness clock, own batch kind).
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Gauge, Loader2, RotateCw, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import type { VideosScanStatus } from "@lfb/shared";
import { PageActions, type Action } from "../../components/menu/PageActions.js";
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
  /** The ⛛ filter's match-basis facet vocabulary — duplicates: sha256 · fingerprint (duplicates.mdx
   *  §3.2); subsets: mpeg7 · vpdq (subsets.mdx §3). Value-checkbox model, all checked by default. */
  matchBasisValues: string[];
}

/**
 * The running banner's phase clause (duplicates.mdx §8.3). The engine publishes byte-identical
 * duplicates the moment hashing finishes and perceptual ones as they are found, so naming the phase
 * tells the user whether the groups already on screen are the whole story yet.
 */
function phaseLabel(status: VideosScanStatus): string {
  const counter = status.phaseTotal > 0 ? ` ${status.phaseDone.toLocaleString()}/${status.phaseTotal.toLocaleString()}` : "";
  if (status.phase === "candidates") return " — finding candidate files";
  if (status.phase === "hash") return ` — hashing files${counter}`;
  if (status.phase === "fingerprint") return ` — fingerprinting${counter}`;
  return "";
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
  matchBasisValues,
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

  // The Start-Scan pop-up (duplicates.mdx §5.2 / subsets.mdx §5): opens automatically at most ONCE per
  // page entry, and only when the SERVER says we may interrupt — `promptOnEntry`, which is `recommend`
  // minus the 2-day quiet window. A scan inside two days (complete OR partial) never prompts; the
  // always-visible "Scan for …" action link below is how the user rescans on demand instead.
  const [modalOpen, setModalOpen] = useState(false);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !status) return;
    if (status.promptOnEntry && !status.running) {
      autoOpened.current = true;
      setModalOpen(true);
    }
  }, [status]);
  // Never open (or stay open) while a scan is already running — the page shows the running state instead.
  useEffect(() => {
    if (status?.running) setModalOpen(false);
  }, [status?.running]);

  const navigate = useNavigate();
  const viewProgress = () => void navigate({ to: "/processing" });
  const scanLabel = variant === "duplicates" ? "Duplicate" : "Subset";

  // Fire-and-forget start (duplicates.mdx §5.4, LOCKED): the pop-up closes on the CLICK — never on the
  // response — and the page flips to its running state optimistically, so the app can never look hung
  // while the POST is in flight. The toast (not the modal) is what confirms the click landed.
  const start = useMutation({
    mutationFn: startScan,
    onMutate: () => {
      setModalOpen(false);
      qc.setQueryData<VideosScanStatus>(statusKey, (prev) =>
        prev ? { ...prev, running: true, promptOnEntry: false, phase: "candidates", phaseDone: 0, phaseTotal: 0 } : prev,
      );
    },
    onSuccess: (r) => {
      if (r.started) {
        toast.success(`${scanLabel} scan started — it runs in the background.`, {
          action: { label: "View progress", onClick: viewProgress },
        });
      } else {
        // A coalesced start is a normal outcome, not an error (§5.4 rule 5).
        toast.info(`A ${scanLabel.toLowerCase()} scan is already running`, {
          action: { label: "View progress", onClick: viewProgress },
        });
      }
      void qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (e: Error) => {
      clientLog.error("VideosReviewPage.startScan", e);
      toast.error(e.message);
      void qc.invalidateQueries({ queryKey: statusKey });
    },
  });

  // The page action-links row (duplicates.mdx §5.1) — always visible, never relocated. "Scan for …"
  // shares ONE start path with the pop-up's primary button, and takes no confirm dialog: the scan is
  // read-only and never mutates a file (§8.2).
  // (Rebuilt each render on purpose — PageActions keys its width-fit on the labels, not on identity.)
  const pageActions: Action[] = [
    {
      id: "scan",
      label: `Scan for ${scanNoun}s`,
      icon: <ScanSearch className="h-3.5 w-3.5" />,
      group: "Work",
      disabled: status?.running || start.isPending,
      // A greyed link with no reason is a dead end (menus.mdx) — say why, and point at the next step.
      title: status?.running
        ? `A ${scanLabel.toLowerCase()} scan is already running — see the Processing page`
        : undefined,
      onSelect: () => start.mutate(),
    },
    {
      id: "refresh",
      label: "Refresh results",
      icon: <RotateCw className="h-3.5 w-3.5" />,
      group: "Work",
      // The manual twin of the live-refresh bump: pull in whatever a running phase has published.
      onSelect: () => {
        void qc.invalidateQueries({ queryKey: listKey });
        void qc.invalidateQueries({ queryKey: statusKey });
      },
    },
    {
      id: "view-progress",
      label: "View progress",
      icon: <Gauge className="h-3.5 w-3.5" />,
      group: "Work",
      onSelect: viewProgress,
    },
  ];

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

      {/* The page action-links row (duplicates.mdx §5.1) — directly under the title, on EVERY visit:
          "Scan for duplicates · Refresh results · View progress". It is the durable home of the scan
          control, which is what lets the entry pop-up stay quiet inside the 2-day window (§5.2). */}
      <div className="mb-2 shrink-0">
        <PageActions actions={pageActions} />
      </div>

      {/* Running state (duplicates.mdx §6): the scan is an async batch — the Processing surfaces carry
          the detailed progress; here we name the PHASE, because the engine publishes progressively
          (§8.3) and the table below already holds real results while the run continues. The pop-up
          never shows meanwhile. */}
      {status?.running && (
        <div className="mb-2 flex shrink-0 items-center gap-2 text-sm text-black/60">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            {variant === "duplicates" ? "Duplicate" : "Subset"} scan running{phaseLabel(status)} — results
            appear here as they are found (details on the Processing page).
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
            // The match-basis facet (duplicates.mdx §3.2 / subsets.mdx §3) — group-level, so filtering
            // keeps each group's header + members together.
            extraFacets={[
              {
                id: "match_basis",
                label: "Match basis",
                values: matchBasisValues,
                valueOf: (r) => r.group.matchBasis,
              },
            ]}
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
          onSkip={() => setModalOpen(false)}
          // Fire-and-forget (§5.4): the mutation's onMutate closes this modal on the click itself.
          onStart={() => start.mutate()}
        />
      )}
    </div>
  );
}
