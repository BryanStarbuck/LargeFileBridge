// The per-repo screen (one_repo.mdx + use_cases.mdx §5.4). The StatusBanner here is the UC-2
// diagnosis engine: "a file didn't show up on my other computer" — it names the FIRST real cause
// worst-first (IPFS down → pinned-but-no-peers → undecided → pending) and hands over the one fix,
// so a non-expert never has to guess which of the four it was. The files table is unchanged; the old
// status strip moves into a collapsed "Repo details" disclosure.
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { RefreshCw, Settings, ChevronLeft, Network, Users, Clock, Ban, CircleSlash } from "lucide-react";
import { toast } from "sonner";
import type { FileRow, Decision, RepoDetail, PinCounts, PinNowResult } from "@lfb/shared";
import { formatBytes, viewerRouteForName, mediaKindForName } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { RepoStatusPill, TransferPill } from "../../components/Pill.js";
import { EntityKebab, type Action } from "../../components/menu/EntityMenu.js";
import { PageActions, producingActions } from "../../components/menu/PageActions.js";
import { compressAllVideos, compressAllImages, gitIgnoreBig } from "../../components/menu/domainActions.js";
import type { ActionScope } from "../../lib/pageActions.js";
import { PinToggle } from "../../components/PinToggle.js";
import { DecisionToggle } from "../../components/decision/DecisionToggles.js";
import { TranscribeStatusIcon } from "../../components/TranscribeStatusIcon.js";
import { CompressStatusIcon } from "../../components/CompressStatusIcon.js";
import { TaskTabs } from "./TaskTabs.js";
import { TASK_TABS, type TaskTabId } from "./taskTabs.config.js";
import { MetricsStrip, type MetricView } from "./MetricsStrip.js";
import { METRIC_CATALOG, metricCount, type MetricId } from "./metricWarnings.js";
import { setHoverInfo } from "./HoverInfoRegion.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner, FixButton } from "../../components/ui/StatusBanner.js";
import { Tooltip } from "../../components/ui/Tooltip.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { type Health } from "../../components/ui/health.js";
import type { WarningDef } from "../../components/ui/warnings/registry.js";
import { refetchUntilResolved } from "../../components/ui/warnings/resolveRefetch.js";
import { relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";
import { clientLog } from "../../lib/clientLog.js";

// "sync" is the FROZEN wire value for the Add-to-IPFS (pin) decision; it renders as "Add to IPFS (pin)".
const DECISIONS: Decision[] = ["sync", "ignore", "undecided"];
const decisionLabel = (d: Decision): string =>
  d === "sync" ? "Add to IPFS (pin)" : d[0].toUpperCase() + d.slice(1);

// Decision provenance buckets (one_repo.mdx §4.8 / decisions.mdx §10). These labels double as the exact
// Decision-column filter VALUES — the DataTable enum filter matches `accessor(row) === value`, so the
// bucket accessor must return one of these strings verbatim.
const PROVENANCE_BUCKETS = ["decided by me", "by a teammate", "policy-decided", "undecided"] as const;

// Which provenance bucket a file falls in, given the current user's email (null when unknown). A
// "policy:<email>" sentinel decidedBy is a policy auto-decision; a bare email that equals the viewer is
// "me"; any other set decider (or an anonymous decidedAt with no decidedBy) is a teammate.
function decisionBucket(f: FileRow, selfEmail: string | null): (typeof PROVENANCE_BUCKETS)[number] {
  if (!f.decidedBy && !f.decidedAt) return "undecided";
  if (f.decidedBy?.startsWith("policy:")) return "policy-decided";
  if (f.decidedBy && selfEmail && f.decidedBy === selfEmail) return "decided by me";
  return "by a teammate";
}

// Human name for the decider used in the tooltip: "you" for self, "policy (email)" for a policy
// auto-decision, "a teammate" for an anonymous (attribution-off) decision, else the raw email.
function decidedByLabel(f: FileRow, selfEmail: string | null): string {
  if (!f.decidedBy) return "a teammate";
  if (f.decidedBy.startsWith("policy:")) return `policy (${f.decidedBy.slice("policy:".length)})`;
  if (selfEmail && f.decidedBy === selfEmail) return "you";
  return f.decidedBy;
}

/** One-line summary of a file for the hover-info region (task_tabs.mdx §3) — name · size · kind · task state. */
function fileSummary(f: FileRow): string {
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  const kind = mediaKindForName(name);
  const bits: string[] = [name, formatBytes(f.sizeBytes)];
  if (kind) bits.push(kind);
  if (f.transcribe === "could") bits.push("no transcript yet — could be transcribed");
  else if (f.transcribe === "done") bits.push("transcript ready");
  if (f.compress === "could") bits.push("could be compressed");
  else if (f.compress === "done") bits.push("already compressed");
  return bits.join(" · ");
}

/** Human summary of what a pin run actually did — the honest counts, never a fixed string (pin_process.mdx §6). */
function pinSummary(c: PinCounts): string {
  if (c.eligible === 0) return "Nothing to pin — no files marked Pin";
  const parts: string[] = [];
  if (c.added) parts.push(`${c.added} added`);
  if (c.fetched) parts.push(`${c.fetched} fetched`);
  if (c.skipped) parts.push(`${c.skipped} already up-to-date`);
  if (c.failed) parts.push(`${c.failed} failed`);
  return parts.length ? `Pin done — ${parts.join(", ")}` : "Nothing to pin — no files marked Pin";
}

export function OneRepoPage() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  // The active task tab (task_tabs.mdx §1.3) — ephemeral view state, default "all", never persisted.
  const [activeTab, setActiveTab] = useState<TaskTabId>("all");

  const { data: detail, isLoading } = useQuery({
    queryKey: ["repo", repoId],
    queryFn: () => api.repo(repoId),
  });

  // Current user — shares the AppShell's ["me"] cache (one_repo.mdx §4.8). Drives the "decided by me"
  // vs. "by a teammate" provenance split; null-safe so the glyph/tooltip degrade gracefully if absent.
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me });
  const selfEmail = me?.email ?? null;

  const setDecision = useMutation({
    mutationFn: ({ paths, decision }: { paths: string[]; decision: Decision }) =>
      api.setDecision(repoId, paths, decision),
    onSuccess: (d: RepoDetail) => qc.setQueryData(["repo", repoId], d),
    onError: (e: Error) => {
      clientLog.error("OneRepoPage.setDecision", e);
      toast.error(e.message);
    },
  });

  // Two-axis write for the inline decision toggles (decision_toggles.mdx §2). Flipping ONE axis sends
  // BOTH values so the other axis is preserved (a bare single-axis write would clobber it).
  const setAxes = useMutation({
    mutationFn: ({ paths, ipfs, gitignore }: { paths: string[]; ipfs: boolean; gitignore: boolean }) =>
      api.setFileDecisions(repoId, paths, { ipfs, gitignore }),
    onSuccess: (d: RepoDetail) => qc.setQueryData(["repo", repoId], d),
    onError: (e: Error) => {
      clientLog.error("OneRepoPage.setAxes", e);
      toast.error(e.message);
    },
  });

  const pinNow = useMutation({
    mutationFn: (paths?: string[]) => api.pinNow(repoId, paths),
    onSuccess: (r: PinNowResult) => {
      qc.setQueryData(["repo", repoId], r.detail);
      // Report what the run ACTUALLY did, never a blanket "complete" (pin_process.mdx §6): an honest
      // "nothing to pin" for a no-op, real counts otherwise, and an error toast when only failures occurred.
      const summary = pinSummary(r.counts);
      if (r.counts.failed > 0 && r.counts.added === 0 && r.counts.fetched === 0) toast.error(summary);
      else toast.success(summary);
    },
    onError: (e: Error) => {
      clientLog.error("OneRepoPage.pinNow", e);
      toast.error(e.message);
    },
  });

  // Bulk compress the checked rows (compression.mdx §4). The selection Set holds fileIds; map them back
  // to absolute paths for the batch endpoint.
  const compressBatch = useMutation({
    mutationFn: (paths: string[]) => api.compressBatch(paths),
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.status === "compressed").length;
      const blocked = r.results.filter((x) => x.status === "blocked").length;
      toast.success(`Compressed ${ok}/${r.results.length}${blocked ? ` · ${blocked} blocked (alpha/resolution)` : ""}`);
      qc.invalidateQueries({ queryKey: ["repo", repoId] });
      setSelected(new Set());
    },
    onError: (e: Error) => { clientLog.error("OneRepoPage.compressBatch", e); toast.error(e.message); },
  });
  const compressSelected = () => {
    if (!detail?.path) return;
    const paths = detail.files.filter((f) => selected.has(f.fileId)).map((f) => `${detail.path}/${f.path}`);
    if (!paths.length) return;
    if (!window.confirm(`Compress ${paths.length} file${paths.length === 1 ? "" : "s"}? Medium quality, same resolution — originals move to LFBridge trash (recoverable).`)) return;
    compressBatch.mutate(paths);
  };

  // Transcribe ONE file — fired by the Transcribe status icon's actionable ("could") state (task_tabs.mdx
  // §5). Local, offline engine; runs in the background. On success the file's `.transcription` sidecar
  // appears, so a repo refetch flips its icon to "done".
  const transcribeOne = useMutation({
    mutationFn: (absPath: string) => api.transcribeFile(absPath),
    onSuccess: () => {
      toast.success("Transcription started");
      qc.invalidateQueries({ queryKey: ["repo", repoId] });
    },
    onError: (e: Error) => { clientLog.error("OneRepoPage.transcribeOne", e); toast.error(e.message); },
  });

  // The Transcribe status icon's click (task_tabs.mdx §5): "could" queues a transcription; "done" opens
  // the file's viewer to read the transcript; "na" is inert.
  const onTranscribeActivate = (f: FileRow) => {
    if (!detail?.path || f.transcribe === "na") return;
    const abs = `${detail.path}/${f.path}`;
    if (f.transcribe === "could") {
      if (window.confirm(`Transcribe ${f.path}? Runs locally in the background.`)) transcribeOne.mutate(abs);
    } else {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      navigate({ to: viewerRouteForName(name), search: { path: abs } });
    }
  };

  // The Compress status icon's click (task_tabs.mdx §6): "could" offers compression (confirm → background
  // job); "done" opens the file's viewer; "na" is inert.
  const onCompressActivate = (f: FileRow) => {
    if (!detail?.path || f.compress === "na") return;
    const abs = `${detail.path}/${f.path}`;
    if (f.compress === "could") {
      if (window.confirm(`Compress ${f.path}? Medium quality, same resolution — the original moves to LFBridge trash (recoverable).`)) compressBatch.mutate([abs]);
    } else {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      navigate({ to: viewerRouteForName(name), search: { path: abs } });
    }
  };

  // A metric panel's chevron (task_tabs.mdx §2.4): re-tune the view to the tab where the user acts on it.
  // (The RepoVerdict banner above surfaces the educate-and-fix popup for the current top issue.)
  const openMetric = (id: MetricId) => {
    if (id === "notBackedUp") { navigate({ to: "/devices" }); return; }
    if (id === "compressibleVideos" || id === "compressibleImages" || id === "alreadyCompressed") setActiveTab("compress");
    else if (id === "transcribable" || id === "transcribed") setActiveTab("transcribe");
    else setActiveTab("ipfs");
  };

  const ipfsDown = detail?.ipfs === "unreachable";

  // The action-links row scope (page_actions.mdx §1.1): checked rows → their absolute paths; nothing
  // checked → the repo root, walked recursively on the server. Evaluated at click time via producingActions.
  const pageScope = (): ActionScope => {
    if (!detail?.path) return {};
    if (selected.size > 0) {
      return { paths: detail.files.filter((f) => selected.has(f.fileId)).map((f) => `${detail.path}/${f.path}`) };
    }
    return { root: detail.path };
  };

  // The action-links row (page_actions.mdx §4 — One repo): producing pair · Compress all videos… ·
  // Compress all images… · Git-ignore big files… · Rescan. Pin now stays the header primary.
  const rescanRepo = async () => {
    try {
      const r = await api.rescan();
      if (r.started) toast.success("Rescan started");
      else toast.info("A scan is already running");
    } catch (e) {
      clientLog.error("OneRepoPage.rescan", e);
      toast.error((e as Error).message);
    }
  };
  const repoActions: Action[] = [
    ...producingActions(pageScope),
    compressAllVideos(detail?.path),
    compressAllImages(detail?.path),
    gitIgnoreBig(pageScope()),
    { id: "rescan", label: "Rescan", icon: <RefreshCw className="h-3.5 w-3.5" />, group: "Work", onSelect: rescanRepo },
  ];

  const columns: LfbColumn<FileRow>[] = [
    {
      // Same toggle pin as everywhere (ipfs.mdx §3): solid dark-blue = pinned (this file is pinned
      // over IPFS), outline = not. Toggling flips the pin⇄ignore decision that governs the pin.
      id: "pinned",
      header: "Pin",
      kind: "text",
      sortable: false,
      filterable: false,
      accessor: () => "",
      cell: (f) => {
        const pinned = f.decision === "sync";
        // Never-IPFS (decisions.mdx §17): a flagged file may never be pinned, so the pin toggle is
        // disabled — you can't flip it into the Add-to-IPFS "sync" decision.
        const blockedByNeverIpfs = !!f.neverIpfs;
        // Control cell — stop the click bubbling to the row's navigate (one_repo.mdx §4.7).
        return (
          <span
            onClick={(e) => e.stopPropagation()}
            title={blockedByNeverIpfs ? "blocked by Never-IPFS" : undefined}
          >
            <PinToggle
              pinned={pinned}
              disabled={ipfsDown || blockedByNeverIpfs}
              // Two-axis write preserving the git-ignore axis (decision_toggles.mdx §2).
              onToggle={() =>
                setAxes.mutate({ paths: [f.path], ipfs: !pinned, gitignore: !!f.gitignore })
              }
            />
          </span>
        );
      },
    },
    {
      // The Add-to-git-ignore (⊘) decision toggle (decision_toggles.mdx / one_repo.mdx §4.5.1). Every row
      // here is under this repo, so the ignore axis always applies (never N/A). Solid orange = git-ignored.
      id: "gitignore",
      header: "Ignore",
      kind: "text",
      sortable: false,
      filterable: false,
      accessor: () => "",
      cell: (f) => (
        <span onClick={(e) => e.stopPropagation()}>
          <DecisionToggle
            state={f.gitignore ? "on" : "off"}
            title="Add to git ignore"
            onToggle={() =>
              setAxes.mutate({ paths: [f.path], ipfs: f.decision === "sync", gitignore: !f.gitignore })
            }
            glyph={<CircleSlash className="h-2.5 w-2.5" strokeWidth={2.5} />}
          />
        </span>
      ),
    },
    {
      id: "path",
      header: "File",
      kind: "text",
      accessor: (f) => f.path,
      cell: (f) => {
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
        const name = f.path.slice(dir.length);
        return (
          <span
            title={f.path}
            onMouseEnter={() => setHoverInfo(fileSummary(f))}
            onMouseLeave={() => setHoverInfo(null)}
          >
            <span className="text-black/40">{middleTruncate(dir, 30)}</span>
            <span className="font-medium">{name}</span>
          </span>
        );
      },
    },
    { id: "size", header: "Size", kind: "bytes", align: "right", accessor: (f) => f.sizeBytes,
      cell: (f) => formatBytes(f.sizeBytes) },
    {
      id: "decision",
      header: "Decision",
      kind: "enum",
      accessor: (f) => f.decision,
      filterOptions: DECISIONS,
      cell: (f) => {
        const bucket = decisionBucket(f, selfEmail);
        // A small glyph flags a file decided by SOMEONE ELSE (one_repo.mdx §4.8): a person for a
        // teammate, a clock for a policy auto-decision. Nothing for "me" or an undecided file.
        const glyph =
          bucket === "policy-decided" ? (
            <Clock className="h-3.5 w-3.5 shrink-0 text-black/40" aria-label="decided by policy" />
          ) : bucket === "by a teammate" ? (
            <Users className="h-3.5 w-3.5 shrink-0 text-black/40" aria-label="decided by a teammate" />
          ) : null;
        // Never-IPFS (decisions.mdx §17): the Add-to-IPFS ("sync") option is disabled so a flagged file
        // can't be pushed into a pin decision; Ignore / Undecided stay selectable. A Ban glyph + title
        // spell out why. Mirrors ViewOneFilePage's per-option `disabled` guard.
        const blockedByNeverIpfs = !!f.neverIpfs;
        const select = (
          <select
            value={f.decision}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDecision.mutate({ paths: [f.path], decision: e.target.value as Decision })}
            title={blockedByNeverIpfs ? "Add to IPFS is blocked by Never-IPFS" : undefined}
            className="rounded border border-[var(--lfb-border)] px-1 py-0.5 text-xs"
          >
            {DECISIONS.map((d) => (
              <option key={d} value={d} disabled={d === "sync" && blockedByNeverIpfs}>
                {decisionLabel(d)}
              </option>
            ))}
          </select>
        );
        const neverHint = blockedByNeverIpfs ? (
          <span title="blocked by Never-IPFS" className="inline-flex text-black/40">
            <Ban className="h-3.5 w-3.5 shrink-0" aria-label="blocked by Never-IPFS" />
          </span>
        ) : null;
        const body = (
          <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {select}
            {glyph}
            {neverHint}
          </span>
        );
        // Non-intrusive tooltip (§4.8) — only when the file actually has an attributed decision.
        if (!f.decidedBy && !f.decidedAt) return body;
        return (
          <Tooltip
            content={`${decisionLabel(f.decision)} · decided by ${decidedByLabel(f, selfEmail)} · ${absoluteTime(f.decidedAt ?? null)}`}
          >
            {body}
          </Tooltip>
        );
      },
    },
    {
      // Provenance WHO — the bucket filter (decided by me / by a teammate / policy-decided / undecided,
      // one_repo.mdx §4.8). enum accessor → the DataTable's exact-match filter dropdown. Not sortable
      // (bucket order is not meaningful); the WHEN column below carries the sort-by-decided-at.
      id: "decidedBy",
      header: "Decided by",
      kind: "enum",
      accessor: (f) => decisionBucket(f, selfEmail),
      filterOptions: [...PROVENANCE_BUCKETS],
      sortable: false,
      priority: 5,
      cell: (f) => {
        const bucket = decisionBucket(f, selfEmail);
        if (bucket === "undecided") return <span className="text-black/20">—</span>;
        const glyph =
          bucket === "policy-decided" ? (
            <Clock className="h-3.5 w-3.5 shrink-0" />
          ) : bucket === "by a teammate" ? (
            <Users className="h-3.5 w-3.5 shrink-0" />
          ) : null;
        return (
          <span className="inline-flex items-center gap-1 text-xs text-black/60">
            {glyph}
            {bucket === "decided by me" ? "me" : decidedByLabel(f, selfEmail)}
          </span>
        );
      },
    },
    {
      // Provenance WHEN — sort-by-decided-at (one_repo.mdx §4.8): most recently triaged first. ISO-8601
      // UTC sorts chronologically as a plain string, so the timestamp accessor needs no transform.
      id: "decidedAt",
      header: "Decided",
      kind: "timestamp",
      accessor: (f) => f.decidedAt ?? null,
      filterable: false,
      priority: 6,
      cell: (f) =>
        f.decidedAt ? (
          <span title={absoluteTime(f.decidedAt)}>{relativeTime(f.decidedAt)}</span>
        ) : (
          <span className="text-black/20">—</span>
        ),
    },
    { id: "status", header: "Status", kind: "enum", accessor: (f) => f.transfer,
      cell: (f) => <TransferPill status={f.transfer} /> },
    { id: "peers", header: "Peers", kind: "int", align: "right", accessor: (f) => f.peers.length,
      cell: (f) => <span className={f.decision === "sync" && f.cid && f.peers.length === 0 ? "text-red-600" : ""}>{f.peers.length}</span> },
    { id: "cid", header: "CID", kind: "text", accessor: (f) => f.cid,
      cell: (f) => f.cid ? <code className="text-xs text-black/60" title={f.cid} onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(f.cid!).catch((err) => clientLog.warn("OneRepoPage.copyCid", err)); toast.success("CID copied"); }}>{middleTruncate(f.cid, 16)}</code> : <span className="text-black/20">—</span> },
    { id: "changed", header: "Changed", kind: "timestamp", accessor: (f) => f.changedAt,
      cell: (f) => <span title={absoluteTime(f.changedAt)}>{relativeTime(f.changedAt)}</span> },
    // ── Task-tab columns (task_tabs.mdx §4). Present in the union; shown only on the tabs that list them.
    // `kind` — video/image/audio, for the Compress & Transcribe tabs.
    {
      id: "kind",
      header: "Kind",
      kind: "enum",
      accessor: (f) => mediaKindForName(f.path.slice(f.path.lastIndexOf("/") + 1)) ?? "",
      filterOptions: ["video", "image", "audio"],
      cell: (f) => {
        const k = mediaKindForName(f.path.slice(f.path.lastIndexOf("/") + 1));
        return <span className="text-xs text-black/60">{k ?? "—"}</span>;
      },
    },
    // `compress` — the three-state Compress status icon (task_tabs.mdx §6). Sort by status ("could" <
    // "done" < "na" alphabetically) puts the actionable rows first; filter on the same three values.
    {
      id: "compress",
      header: "Compress",
      kind: "enum",
      accessor: (f) => f.compress ?? "na",
      filterOptions: ["could", "done", "na"],
      cell: (f) => (
        <CompressStatusIcon
          state={f.compress ?? "na"}
          onActivate={() => onCompressActivate(f)}
          onMouseEnter={() => setHoverInfo(fileSummary(f))}
          onMouseLeave={() => setHoverInfo(null)}
        />
      ),
    },
    // `transcribe` — the three-state Transcribe status icon (task_tabs.mdx §5).
    {
      id: "transcribe",
      header: "Transcribe",
      kind: "enum",
      accessor: (f) => f.transcribe ?? "na",
      filterOptions: ["could", "done", "na"],
      cell: (f) => (
        <TranscribeStatusIcon
          state={f.transcribe ?? "na"}
          onActivate={() => onTranscribeActivate(f)}
          onMouseEnter={() => setHoverInfo(fileSummary(f))}
          onMouseLeave={() => setHoverInfo(null)}
        />
      ),
    },
  ];

  // The active tab's projection (task_tabs.mdx §7): pick + order the columns it lists, and filter the rows
  // to the files that belong to this task. The DataTable is keyed by tab so its default sort re-applies.
  const tab = TASK_TABS[activeTab];
  const byId = useMemo(() => new Map(columns.map((col) => [col.id, col])), [columns]);
  const visibleColumns = tab.columnIds
    .map((id) => byId.get(id))
    .filter((col): col is LfbColumn<FileRow> => Boolean(col));
  const tabRows = (detail?.files ?? []).filter(tab.rowFilter);

  // The metric panels for this tab (task_tabs.mdx §2): count from the RepoDetail, tint by health, chevron
  // re-tunes to the acting tab.
  const metricViews: MetricView[] = detail
    ? tab.metrics.map((id) => {
        const def = METRIC_CATALOG[id];
        return { id, label: def.label, count: metricCount(id, detail), hint: def.hint, positive: def.positive, onOpen: () => openMetric(id) };
      })
    : [];

  const c = detail?.counts;

  return (
    <div>
      <PageHeader
        above={
          <Link to="/" className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
            <ChevronLeft className="h-4 w-4" /> Repos
          </Link>
        }
        title={detail?.name ?? "…"}
        subtitle={detail?.path}
        actionsRow={<PageActions actions={repoActions} selectedCount={selected.size} />}
        actions={
          <>
            {/* Task tabs (task_tabs.mdx §1) — a little right of center, before the gear + Pin now. */}
            <TaskTabs active={activeTab} onChange={setActiveTab} />
            <button
              onClick={() => navigate({ to: "/repos/$repoId/settings", params: { repoId } })}
              title="Repo settings"
              className="rounded-md border border-[var(--lfb-border)] p-2 hover:bg-slate-100"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              onClick={() => pinNow.mutate(undefined)}
              disabled={pinNow.isPending || ipfsDown}
              title={ipfsDown ? "IPFS node unreachable" : "Pin this repo now"}
              className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${pinNow.isPending ? "animate-spin" : ""}`} />
              {pinNow.isPending ? "Pinning…" : "Pin now"}
            </button>
          </>
        }
      />

      {detail && (
        <RepoVerdict
          detail={detail}
          repoId={repoId}
          onPinNow={() => pinNow.mutate(undefined)}
          pinning={pinNow.isPending}
          navigate={navigate}
          // Re-derive from fresh data in a short burst so the banner leaves the page as soon as the fix
          // lands — even for eventually-consistent fixes (warnings.mdx §5.3.1).
          onWarningApplied={() => refetchUntilResolved(qc, [["repo", repoId]])}
        />
      )}

      {/* The task-tab metrics strip (task_tabs.mdx §2) + the docked hover-info region to its right (§3). */}
      {detail && <MetricsStrip metrics={metricViews} defaultHint={tab.defaultHint} />}

      {/* Summary counts — the compact IPFS-decision readout (the richer per-task view is the strip above). */}
      {c && (
        <div className="mb-1 text-sm text-black/70">
          {c.pinned + c.pending} Pin ·{" "}
          <span className={c.undecided > 0 ? "text-[var(--lfb-primary)] font-medium" : ""}>{c.undecided} Undecided</span> ·{" "}
          {c.ignored} Ignore
        </div>
      )}

      <DataTable
        // Keyed by tab so switching re-applies the tab's default sort (task_tabs.mdx §7).
        key={activeTab}
        // Content below the table (the Repo details disclosure) → bounded height, not full-page
        // (one_repo.mdx §4 / repos.mdx §3.3.1).
        fillHeight={false}
        // The active tab projects the columns + filters the rows + sets the default sort (task_tabs.mdx §4).
        data={tabRows}
        columns={visibleColumns}
        defaultSort={tab.defaultSort}
        searchKeys={(f) => f.path}
        getRowId={(f) => f.fileId}
        // Row click → the file's "View one file" experience: media routes to its viewer
        // (/image · /video · /audio), everything else to /file (one_repo.mdx §4.7). The FileRow path is
        // repo-relative, so join it onto the repo root for the absolute path every entity page keys off.
        onRowClick={(f) => {
          if (!detail?.path) return;
          const abs = `${detail.path}/${f.path}`;
          const name = f.path.slice(f.path.lastIndexOf("/") + 1);
          navigate({ to: viewerRouteForName(name), search: { path: abs } });
        }}
        // Trailing ⋮ kebab — the file entity menu (menus.mdx §3), same catalog as View-one-file.
        rowMenu={(f) => (detail?.path ? <EntityKebab path={`${detail.path}/${f.path}`} /> : null)}
        itemNoun="files"
        loading={isLoading}
        selection={{
          selected,
          onChange: setSelected,
          bulk: selected.size > 0 ? (
            <div className="relative">
              <button onClick={() => setBulkOpen((o) => !o)} className="rounded-md border border-[var(--lfb-border)] px-2 py-1 text-sm hover:bg-slate-100">
                ⋮ {selected.size} selected
              </button>
              {bulkOpen && (
                <div className="absolute right-0 z-10 mt-1 w-48 rounded-lg border border-[var(--lfb-border)] bg-white shadow-lg py-1">
                  {DECISIONS.map((d) => (
                    <button key={d} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100"
                      onClick={() => { setDecision.mutate({ paths: [...selected], decision: d }); setBulkOpen(false); }}>
                      {d === "sync" ? "Add to IPFS (pin)" : `Set to ${decisionLabel(d)}`}
                    </button>
                  ))}
                  <button className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100 text-[var(--lfb-primary)]"
                    onClick={() => { pinNow.mutate([...selected]); setBulkOpen(false); }}>
                    Pin now (selected)
                  </button>
                  <button className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-100"
                    disabled={compressBatch.isPending}
                    onClick={() => { compressSelected(); setBulkOpen(false); }}>
                    Compress selected
                  </button>
                </div>
              )}
            </div>
          ) : undefined,
        }}
        empty={<p className="text-center text-black/60">No large files found in this repo.</p>}
      />

      {/* Repo details — the old status strip, now the mechanism a click away. */}
      {detail && (
        <div className="mt-3">
          <Disclosure label="Repo details">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span>Pinned <b>{detail.pinned ? "on" : "off"}</b></span>
              <span className="flex items-center gap-1">Status <RepoStatusPill status={detail.status} /></span>
              <span>Peers <b>{detail.peerCount}</b></span>
              <span>Last pin <b title={absoluteTime(detail.lastPinAt)}>{relativeTime(detail.lastPinAt)}</b></span>
              <span style={{ color: ipfsDown ? "var(--lfb-bad)" : "var(--lfb-ok)" }}>
                IPFS {ipfsDown ? "unreachable" : "ok"}
              </span>
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

// ── UC-2 diagnosis: name the first real cause, worst-first, and hand over the one fix. ──────────
function RepoVerdict({
  detail,
  repoId,
  onPinNow,
  pinning,
  navigate,
  onWarningApplied,
}: {
  detail: RepoDetail;
  repoId: string;
  onPinNow: () => void;
  pinning: boolean;
  navigate: ReturnType<typeof useNavigate>;
  onWarningApplied?: () => void;
}) {
  const ipfsDown = detail.ipfs === "unreachable";
  const { pinned, pending, undecided } = detail.counts;
  // Files set to pin that ALREADY pinned (have a CID) but aren't on ANY other computer yet — pinned
  // locally, not backed up. Gate on `cid != null`: a Pin file with NO CID hasn't finished its first
  // pin, so it's "queued to transfer" (the pending branch below), NOT a "not backed up" alarm. Without
  // this gate, the instant you resolve "N files need a decision" by choosing Pin, those freshly-decided
  // (still CID-less) files re-raised this yellow banner — so the warning you just fixed never looked like
  // it left the page. This matches the documented no-peer vs. pending split (warnings.mdx §10.2.6 / §10.2.8).
  const noPeerCount = detail.files.filter((f) => f.decision === "sync" && f.cid != null && f.peers.length === 0).length;

  let state: Health = "ok";
  let headline = "Everything here is pinned and backed up";
  let sub: string | undefined = detail.lastPinAt
    ? `Last pin ${relativeTime(detail.lastPinAt)} · ${detail.peerCount} peer${detail.peerCount === 1 ? "" : "s"}.`
    : undefined;
  let action: React.ReactNode = undefined;
  // The educate-and-fix warning (warnings.mdx §8) that backs the blue arrow → popup on this banner.
  // Wired for the two flagship causes (IPFS-down §10.1.2 / files-need-decision §10.2.7); the other
  // branches keep their inline FixButton until they get their own registry defs.
  let warning: WarningDef | undefined = undefined;

  if (ipfsDown) {
    state = "bad";
    headline = "Pinning is paused — the IPFS engine on this computer isn't running";
    sub = "Decisions still save, but no files can move until IPFS starts.";
    warning = {
      id: "repo-ipfs-down",
      state: "bad",
      headline,
      sub,
      popup: {
        whatThisIs:
          "IPFS is the local peer-to-peer engine LFBridge uses to move big files between your own computers. It's set up on this machine but isn't running right now, so no bytes can transfer.",
        whyItMatters:
          "Your Add-to-IPFS (pin) / Ignore decisions still save, but a file that lives only on another computer can't arrive here, and a file only here can't reach the others. Nothing is lost — this is a paused pipe, not a broken file.",
        options: [
          {
            kind: "checkbox",
            name: "autostart",
            label: "Also keep IPFS on after I reboot",
            helper: "Installs the reboot auto-start so pinning survives a restart.",
            defaultChecked: true,
          },
        ],
        actionLabel: "Start IPFS",
        // §5.3 — async: close the popup, show a dock card while the daemon boots, toast on done, and
        // refetch this repo so the "pinning paused" banner clears once IPFS is actually up.
        progress: {
          kind: "configure",
          target: "IPFS engine",
          doneLabel: "IPFS started",
          invalidate: [["repo", repoId]],
        },
        apply: async (sel) => {
          await api.ipfsDaemon({ action: "start", autostart: !!sel.checks.autostart });
        },
      },
    };
  } else if (detail.status === "error") {
    state = "bad";
    headline = "This repo hit an error on its last pin";
    sub = "Open the details below, or try Pin now.";
    action = (
      <FixButton state="bad" onClick={onPinNow} disabled={pinning}>
        <RefreshCw className="h-4 w-4" /> Pin now
      </FixButton>
    );
  } else if (noPeerCount > 0) {
    state = "warn";
    headline = `${noPeerCount} pinned file${noPeerCount === 1 ? " isn't" : "s aren't"} on any other computer yet`;
    sub = "They live only on this machine — not backed up. Open LFBridge on your other computer so it can pull them.";
    action = (
      <FixButton state="warn" onClick={() => navigate({ to: "/devices" })}>
        <Network className="h-4 w-4" /> See devices
      </FixButton>
    );
  } else if ((detail.missingPinned?.length ?? 0) > 0) {
    // Pull-them-down (warnings.mdx §10.8.12) — another of your computers pinned files whose bytes aren't
    // here yet. Slotted BELOW the no-peer alarm (those files are safe elsewhere, just not replicated
    // here) but ABOVE undecided triage. Two-pane popup: pin (fetch) + optional compress over the checked
    // subjects; the composed action label (§4.4.1) is left to compose itself (no explicit actionLabel).
    const missing = detail.missingPinned!;
    const n = missing.length;
    const device = missing[0]?.addedByDevice ?? "another computer";
    state = "warn";
    headline = `${n} file${n === 1 ? " is" : "s are"} pinned on another of your computers but not here yet`;
    sub = `${device} pinned ${n === 1 ? "it" : "them"} — pull ${n === 1 ? "it" : "them"} down so this computer is a real second copy.`;
    warning = {
      id: "peer-pinned-files-not-here-pull-down",
      state: "warn",
      scope: "file",
      headline,
      sub,
      popup: {
        whatThisIs: `Another of your computers (${device}) pinned ${n} file${n === 1 ? "" : "s"} that ${n === 1 ? "isn't" : "aren't"} on this computer yet. Large File Bridge can pull ${n === 1 ? "it" : "them"} down over IPFS.`,
        whyItMatters: `Until you pull ${n === 1 ? "it" : "them"} down, this computer is not a real second copy of ${n === 1 ? "that file" : "those files"} — losing the other machine would lose ${n === 1 ? "it" : "them"}. Review the list on the right and uncheck any you don't want.`,
        // TWO action axes, both default-checked (warnings.mdx §10.8.12(B)). NO explicit actionLabel, so
        // WarningPopup's composeActionLabel spells the button from the checked axes: "Compress and
        // Continue: IPFS Add ›" / "Continue: IPFS Add ›" — plus the live checked-file count.
        options: [
          {
            kind: "checkbox",
            name: "ipfs",
            label: "Add to IPFS (pin)",
            helper: "fetch and pin the bytes down onto this computer",
            defaultChecked: true,
          },
          {
            kind: "checkbox",
            name: "compress",
            label: "Compress",
            helper: "queue a compress pass once the bytes arrive",
            defaultChecked: true,
          },
        ],
        // Empty string = "no explicit label" (WarningPopup treats "" and omitted the same, §4.4.1), so the
        // ≥2-axis label composes itself. The type requires the field, so we can't truly omit it.
        actionLabel: "",
        canApply: () => true, // pinning IS the pull; never block on the axis state (still needs ≥1 subject)
        // Right-pane subjects — bytes are NOT local, so each row is described from the committed manifest +
        // the peer's sidecar identity (§4.5 / §10.8.12(B)): name · target directory · size · added-by.
        // id is the repo-relative path, which POST /pull receives.
        targets: missing.map((mf) => {
          const dir = mf.path.includes("/") ? mf.path.slice(0, mf.path.lastIndexOf("/")) : "";
          return {
            id: mf.path,
            label: mf.name,
            sublabel: `${dir || "(repo root)"} · ${formatBytes(mf.sizeBytes)} · added by ${mf.addedByDevice ?? "another computer"}`,
          };
        }),
        targetNoun: "file",
        // §5.3 — async: hand to the dock as a "pin" job, toast the pulled count, and refetch so the
        // "pull them down" banner leaves the page once the bytes have arrived (§5.3.1).
        progress: {
          kind: "pin",
          target: detail.name,
          doneLabel: (_sel, count) => `${count} file${count === 1 ? "" : "s"} pulled`,
          invalidate: [["repo", repoId]],
        },
        apply: async (sel, checkedPaths) => {
          // Pin each checked CID (fetches its bytes over IPFS); compress after arrival when that axis is on.
          await api.pull(repoId, checkedPaths, { compress: !!sel.checks.compress });
        },
      },
    };
  } else if (undecided > 0) {
    state = "warn";
    headline = `${undecided} file${undecided === 1 ? "" : "s"} need${undecided === 1 ? "s" : ""} a decision`;
    sub = "Choose Add to IPFS (pin) or Ignore for them in the table below so LFBridge knows what to move.";
    // The subjects list (warnings.mdx §4.5): the actual undecided files, each a checkable row with its
    // size, all checked at open. Apply runs the chosen decision over exactly the CHECKED rows.
    const undecidedFiles = detail.files.filter((f) => f.decision === "undecided");
    // Never-IPFS enforcement (decisions.mdx §17): count how many of the undecided files are flagged. When
    // EVERY one is, the Add-to-IPFS axis is blocked — force it off + a "blocked by Never-IPFS" helper (the
    // git-ignore axis stays). When only SOME are, keep the box enabled (the backend rejects ipfs:true only
    // for the flagged paths) but note how many will be skipped. (WarningOption has no `disabled` field, so
    // "forced off" is defaultChecked:false + an apply-time override rather than a truly disabled control.)
    const neverIpfsCount = undecidedFiles.filter((f) => f.neverIpfs).length;
    const allNeverIpfs = undecidedFiles.length > 0 && neverIpfsCount === undecidedFiles.length;
    const ipfsHelper = allNeverIpfs
      ? "Blocked by Never-IPFS — these files can't be added to IPFS."
      : neverIpfsCount > 0
        ? `back them up across your computers over IPFS · ${neverIpfsCount} of these ${neverIpfsCount === 1 ? "is" : "are"} Never-IPFS and will be skipped`
        : "back them up across your computers over IPFS";
    warning = {
      id: "repo-files-need-decision",
      state: "warn",
      scope: "file",
      headline,
      sub,
      popup: {
        whatThisIs: `LFBridge found ${undecided} large file${undecided === 1 ? "" : "s"} in this repo that you haven't told it what to do with yet. Choose what to do on two independent axes below — a big file usually wants BOTH: git-ignored so Git never commits it, and pinned so it is backed up across your computers. Your choice is shared with everyone on this repo, so no teammate is asked again. Review the list on the right — uncheck any file you want to leave out.`,
        whyItMatters: (
          <ul className="list-disc space-y-0.5 pl-4">
            <li>A file not added to IPFS is not pinned to your other computers — if this machine dies, it's gone.</li>
            <li>A file not git-ignored may be committed by Git, bloating the repo with big binaries.</li>
            <li>Leaving both off is fine too — it records "reviewed, leave as-is" so this doesn't ask again.</li>
          </ul>
        ),
        // TWO INDEPENDENT CHECKBOXES (decisions.mdx §1) — not a radio group. Both default checked (the
        // recommended git-ignore-AND-pin outcome); the user may turn either or both off, and BOTH-OFF is a
        // valid recorded decision (canApply below is always true — no required choice).
        options: [
          {
            kind: "checkbox",
            name: "ipfs",
            label: "Add them to IPFS",
            helper: ipfsHelper,
            // Forced off when every subject is Never-IPFS (§17); otherwise the recommended default.
            defaultChecked: !allNeverIpfs,
          },
          {
            kind: "checkbox",
            name: "gitignore",
            label: "Add to git ignore",
            helper: "keep Git from committing these big files",
            defaultChecked: true,
          },
        ],
        canApply: () => true, // both-off is a valid decision (decisions.mdx §1); never block Apply
        // Right-pane subjects — id is the repo-RELATIVE path (what `apply` receives and hands to
        // api.setDecision). It MUST be relative: the backend keys `cfg.decisions` by repo-relative path
        // and composeFileRows reads it back by relative path, exactly like the table's per-row Decision
        // control (setDecision.mutate({ paths: [f.path] })). Bugfix: ids were previously ABSOLUTE
        // (`${detail.path}/${f.path}`), so the fix wrote decisions under a key nobody reads — the HTTP
        // call (and success toast) succeeded, but the file stayed "undecided" and this banner never left
        // the page. See warnings.mdx §5.3.1 and §10.2.7.
        targets: undecidedFiles.map((f) => ({
          id: f.path,
          label: f.path,
          sublabel: formatBytes(f.sizeBytes),
        })),
        targetNoun: "file",
        actionLabel: "Apply",
        // §5.3 — async: hand off to the dock (verb reflects the chosen axes), toast on done, and refetch
        // this repo so the "N files need a decision" banner disappears — and STAYS gone, because the
        // decision is now a shared, sticky record (decisions.mdx §2).
        progress: {
          // When Never-IPFS blocks the whole set, the IPFS axis is forced off, so the dock verb reflects
          // the git-ignore/none outcome rather than "pin".
          kind: (sel) =>
            !allNeverIpfs && sel.checks.ipfs ? "pin" : sel.checks.gitignore ? "ignore" : "configure",
          target: detail.name,
          doneLabel: (_sel, n) => `${n} file${n === 1 ? "" : "s"} decided`,
          invalidate: [["repo", repoId]],
        },
        apply: async (sel, checkedPaths) => {
          // Record the full two-axis decision (either/both/neither) — the backend stamps who/when/SID into
          // the team-shared ledger and reconciles the local pin state (decisions.mdx §3/§7). §17: force the
          // IPFS axis off when every subject is Never-IPFS; when only some are, send the user's choice and
          // let the backend reject ipfs:true for just the flagged paths.
          await api.setFileDecisions(repoId, checkedPaths, {
            ipfs: allNeverIpfs ? false : !!sel.checks.ipfs,
            gitignore: !!sel.checks.gitignore,
          });
        },
      },
    };
  } else if (pending > 0) {
    state = "warn";
    headline = `${pending} file${pending === 1 ? " is" : "s are"} queued to transfer`;
    sub = "They'll move on the next scheduled pin, or pin them now.";
    action = (
      <FixButton state="warn" onClick={onPinNow} disabled={pinning}>
        <RefreshCw className="h-4 w-4" /> Pin now
      </FixButton>
    );
  } else if (pinned === 0) {
    state = "neutral";
    headline = "Nothing set to pin in this repo yet";
    sub = "Add files to IPFS (pin) below, or from the File System, to start bridging them.";
  }

  return (
    <StatusBanner
      state={state}
      headline={headline}
      sub={sub}
      action={action}
      warning={warning}
      onWarningApplied={onWarningApplied}
    />
  );
}
