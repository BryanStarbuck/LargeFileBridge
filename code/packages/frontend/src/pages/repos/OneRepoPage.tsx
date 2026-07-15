// The per-repo screen (one_repo.mdx + use_cases.mdx §5.4). There is NO warning banner on this page: the
// metrics-panel strip (task_tabs.mdx §2, §2.6) is the ONLY warning surface — each panel is a terse
// Title-Case label over a big number, and clicking a panel whose count is > 0 opens that metric's
// educate-and-fix popup (undecided → decision triage, pull-down → pull peer-pinned files). The files
// table is unchanged; the old status strip lives in a collapsed "Repo details" disclosure below it.
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { RefreshCw, Settings, ChevronLeft, Users, Clock, Ban, CircleSlash, ChevronRight, Search } from "lucide-react";
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
import { withModelReady } from "../../lib/transcribe.js";
import { confirmModal } from "../../lib/modals.js";
import { PinToggle } from "../../components/PinToggle.js";
import { DecisionToggle } from "../../components/decision/DecisionToggles.js";
import { TranscribeStatusIcon } from "../../components/TranscribeStatusIcon.js";
import { CompressStatusIcon } from "../../components/CompressStatusIcon.js";
import { DescribeStatusIcon } from "../../components/DescribeStatusIcon.js";
import { runDescribeFile } from "../../lib/describe.js";
import { TaskTabs } from "./TaskTabs.js";
import { TASK_TABS, type TaskTabId } from "./taskTabs.config.js";
import { MetricsStrip, type MetricView } from "./MetricsStrip.js";
import { METRIC_CATALOG, metricCount, type MetricId } from "./metricWarnings.js";
import { buildMetricWarning, topRecommendation, scanIsStale } from "./metricWarningDefs.js";
import { setHoverInfo } from "./HoverInfoRegion.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { WarningPopup } from "../../components/ui/WarningPopup.js";
import type { WarningDef } from "../../components/ui/warnings/registry.js";
import { Tooltip } from "../../components/ui/Tooltip.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { refetchUntilResolved } from "../../components/ui/warnings/resolveRefetch.js";
import { relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";
import { clientLog } from "../../lib/clientLog.js";
import { copyText } from "@/lib/clipboard";

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
  if (f.describe === "could") bits.push("no AI description yet — could be described");
  else if (f.describe === "done") bits.push("AI description ready");
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
  // The educate-and-fix popup the header "View recommendation" primary opens (one_repo.mdx §3.1). The
  // metric tiles host their own popup inside MetricsStrip; this is the header button's separate host.
  const [headerWarning, setHeaderWarning] = useState<WarningDef | null>(null);

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
  const compressSelected = async () => {
    if (!detail?.path) return;
    const paths = detail.files.filter((f) => selected.has(f.fileId)).map((f) => `${detail.path}/${f.path}`);
    if (!paths.length) return;
    if (!(await confirmModal({ title: `Compress ${paths.length} file${paths.length === 1 ? "" : "s"}?`, body: "Medium quality, same resolution — originals move to LFBridge trash (recoverable).", confirmLabel: "Compress" }))) return;
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
  const onTranscribeActivate = async (f: FileRow) => {
    if (!detail?.path || f.transcribe === "na") return;
    const abs = `${detail.path}/${f.path}`;
    if (f.transcribe === "could") {
      // Gate behind the heavyweight-model provisioning flow (transcribe_engine.mdx §3), then run.
      if (await confirmModal({ title: `Transcribe ${f.path}?`, body: "Runs locally in the background.", danger: false, confirmLabel: "Transcribe" })) {
        void withModelReady({ label: `transcribe ${f.path}`, run: () => transcribeOne.mutate(abs) });
      }
    } else {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      navigate({ to: viewerRouteForName(name), search: { path: abs } });
    }
  };

  // The Compress status icon's click (task_tabs.mdx §6): "could" offers compression (confirm → background
  // job); "done" opens the file's viewer; "na" is inert.
  const onCompressActivate = async (f: FileRow) => {
    if (!detail?.path || f.compress === "na") return;
    const abs = `${detail.path}/${f.path}`;
    if (f.compress === "could") {
      if (await confirmModal({ title: `Compress ${f.path}?`, body: "Medium quality, same resolution — the original moves to LFBridge trash (recoverable).", confirmLabel: "Compress" })) compressBatch.mutate([abs]);
    } else {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      navigate({ to: viewerRouteForName(name), search: { path: abs } });
    }
  };

  // The AI-description status icon's click (ai_description.mdx §11), the mirror of onTranscribeActivate:
  // "could" generates an AI description for this one file (provider-gated, background job); "done" opens the
  // file's viewer to read it; "na" is inert.
  const onDescribeActivate = (f: FileRow) => {
    if (!detail?.path || f.describe === "na") return;
    const abs = `${detail.path}/${f.path}`;
    if (f.describe === "could") {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      runDescribeFile(abs, name, { onDone: () => qc.invalidateQueries({ queryKey: ["repo", repoId] }) });
    } else {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      navigate({ to: viewerRouteForName(name), search: { path: abs } });
    }
  };

  // A metric panel with NO educate-and-fix popup (task_tabs.mdx §2.4): re-tune the view to the tab where
  // the user acts on it. Metrics that DO carry a popup (undecided, pullDown) open it instead — the metric
  // panels are this page's only warning surface; there is no separate warning banner (§2.6).
  const openMetric = (id: MetricId) => {
    if (id === "notBackedUp") { navigate({ to: "/devices" }); return; }
    if (id === "compressibleVideos" || id === "compressibleImages" || id === "alreadyCompressed") setActiveTab("compress");
    else if (id === "transcribable" || id === "transcribed") setActiveTab("transcribe");
    else if (id === "describable" || id === "described") setActiveTab("ai-descriptions");
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
  // Compress all images… · Git-ignore big files… · Pin now · Rescan. Pin now moved here from the header —
  // the header primary is now the smart "View recommendation" / "Scan now" button (one_repo.mdx §3.1).
  const rescanRepo = async () => {
    try {
      const r = await api.rescan();
      if (r.started) toast.success("Rescan started");
      else toast.info("A scan is already running");
      // Refresh so lastScanAt updates once the scan lands — flips the header "Scan now" back to
      // "View recommendation" on its own (warnings.mdx §5.3.1).
      refetchUntilResolved(qc, [["repo", repoId]]);
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
    { id: "pin-now", label: "Pin now", icon: <RefreshCw className="h-3.5 w-3.5" />, group: "Work", onSelect: () => pinNow.mutate(undefined) },
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
            // A rule we must not rewrite (a pattern, or a non-root-.gitignore source) owns this file, so
            // OFF is not ours to perform — say so and name the rule rather than offering a dead click
            // (git_ignore.mdx §5.5).
            locked={!!f.gitignoreLocked}
            title={
              f.gitignoreLocked && f.gitignoreRule
                ? `Git-ignored by ${f.gitignoreRule.source}:${f.gitignoreRule.line} — ${f.gitignoreRule.pattern}\n` +
                  `That rule covers more than this file, so Large File Bridge will not rewrite it. Edit ${f.gitignoreRule.source} to change this.`
                : f.gitignore
                  ? "Git-ignored — click to stop ignoring this file"
                  : "Add to git ignore"
            }
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
      cell: (f) => f.cid ? <code className="text-xs text-black/60" title={f.cid} onClick={(e) => { e.stopPropagation(); void copyText(f.cid!, "CID", "OneRepoPage.copyCid"); }}>{middleTruncate(f.cid, 16)}</code> : <span className="text-black/20">—</span> },
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
      // Header-less: an icon-only leading control column, like Pin/IPFS (task_tabs.mdx §4.3/§6). It only
      // appears on the Compress tab, so blanking the title here never affects other tabs.
      header: "",
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
      // Header-less: an icon-only leading control column, like Pin/IPFS (task_tabs.mdx §4.4/§5; the product
      // owner asked to move it left of File and drop the title). It only appears on the Transcribe tab.
      header: "",
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
    // `describe` — the three-state AI-description status icon (ai_description.mdx §11), the mirror of the
    // transcribe column. Header-less leading control column; only appears on the AI descriptions tab.
    {
      id: "describe",
      header: "",
      kind: "enum",
      accessor: (f) => f.describe ?? "na",
      filterOptions: ["could", "done", "na"],
      cell: (f) => (
        <DescribeStatusIcon
          state={f.describe ?? "na"}
          onActivate={() => onDescribeActivate(f)}
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

  // The metric panels for this tab (task_tabs.mdx §2): count from the RepoDetail, tint by health. When the
  // count is > 0 and the metric has an educate-and-fix popup, clicking the panel opens it (§2.4); otherwise
  // the panel re-tunes the view to the acting tab.
  const metricViews: MetricView[] = detail
    ? tab.metrics.map((id) => {
        const def = METRIC_CATALOG[id];
        const count = metricCount(id, detail);
        const warning = count > 0 ? buildMetricWarning(id, detail, repoId) : null;
        return {
          id,
          label: def.label,
          count,
          hint: def.hint,
          positive: def.positive,
          warning: warning ?? undefined,
          onOpen: () => openMetric(id),
        };
      })
    : [];

  const c = detail?.counts;

  // The header primary (one_repo.mdx §3.1). A scan that's overdue (or never run) takes precedence — you
  // can't trust the metrics until the repo is re-scanned, so the button becomes "Scan now". Otherwise it
  // is "View recommendation ›", opening the single most important pending metric's educate-and-fix popup
  // (worst-first: IPFS-down → pull-down → undecided). When there's nothing to recommend and no scan is
  // due, there is no header primary — the metric panels (all green zeros) already say "all clear".
  const scanDue = detail ? scanIsStale(detail) : false;
  const topRec = detail && !scanDue ? topRecommendation(detail, repoId) : null;
  // The header primary's label is per-metric (one_repo.mdx §3.1): a content-work recommendation names its
  // verb ("Transcribe ›" / "Describe ›" / "Compress ›") so the button says exactly what it will do; the
  // triage recommendations (undecided / pull-down / ipfs-down) keep the generic "View recommendation ›".
  const HEADER_PRIMARY_LABEL: Partial<Record<MetricId, string>> = {
    transcribable: "Transcribe",
    describable: "Describe",
    compressibleVideos: "Compress",
    compressibleImages: "Compress",
  };
  const headerPrimaryLabel =
    (topRec?.metricId && HEADER_PRIMARY_LABEL[topRec.metricId]) || "View recommendation";

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
            {/* Task tabs (task_tabs.mdx §1) — a little right of center, before the gear + header primary. */}
            <TaskTabs active={activeTab} onChange={setActiveTab} />
            <button
              onClick={() => navigate({ to: "/repos/$repoId/settings", params: { repoId } })}
              title="Repo settings"
              className="rounded-md border border-[var(--lfb-border)] p-2 hover:bg-slate-100"
            >
              <Settings className="h-4 w-4" />
            </button>
            {/* Header primary (one_repo.mdx §3.1) — the SAME button on all four tabs. "Scan now" when a scan
                is overdue (highest priority), otherwise "View recommendation ›" which opens the most
                important pending metric's popup. No leading circle icon; a trailing right chevron. Nothing
                renders when there's no scan due and nothing to recommend. */}
            {scanDue ? (
              <button
                onClick={rescanRepo}
                title="This repo hasn't been scanned recently — scan it for large files"
                className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white"
              >
                <Search className="h-4 w-4" />
                Scan now
              </button>
            ) : topRec ? (
              <button
                onClick={() => setHeaderWarning(topRec.warning)}
                title="Open the most important recommendation for this repo"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-white"
                style={{ background: topRec.warning.state === "bad" ? "var(--lfb-bad)" : "var(--lfb-primary)" }}
              >
                {headerPrimaryLabel}
                <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
              </button>
            ) : null}
          </>
        }
      />

      {/* The task-tab metrics strip (task_tabs.mdx §2) + the docked hover-info region to its right (§3).
          These panels are this page's ONLY warning surface — no separate warning banner (§2.6). Clicking a
          panel opens that metric's educate-and-fix popup; on apply we re-derive from fresh data in a short
          burst so the panel's count updates as soon as the fix lands (warnings.mdx §5.3.1). */}
      {detail && (
        <MetricsStrip
          metrics={metricViews}
          defaultHint={tab.defaultHint}
          onApplied={() => refetchUntilResolved(qc, [["repo", repoId]])}
        />
      )}

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

      {/* The header "View recommendation" primary's popup host (one_repo.mdx §3.1). Same WarningPopup the
          metric tiles open; on apply we re-derive from fresh data so the button/metrics update as the fix
          lands (warnings.mdx §5.3.1). */}
      {headerWarning && (
        <WarningPopup
          warning={headerWarning}
          onClose={() => setHeaderWarning(null)}
          onApplied={() => refetchUntilResolved(qc, [["repo", repoId]])}
        />
      )}
    </div>
  );
}
