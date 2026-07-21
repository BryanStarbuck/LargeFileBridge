// The per-repo screen (one_repo.mdx + use_cases.mdx §5.4). There is NO warning banner on this page: the
// metrics-panel strip (task_tabs.mdx §2, §2.6) is the ONLY warning surface — each panel is a terse
// Title-Case label over a big number, and clicking a panel whose count is > 0 opens that metric's
// educate-and-fix popup (undecided → decision triage, pull-down → pull peer-pinned files). The files
// table is unchanged; the old status strip lives in a collapsed "Repo details" disclosure below it.
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLiveRefresh, repoTopic } from "../../lib/useLiveRefresh.js";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { RefreshCw, Settings, ChevronLeft, Archive, ChevronRight, Search } from "lucide-react";
import { toast } from "sonner";
import type { FileRow, Decision, RepoDetail, PinCounts, PinNowResult, TaskStatus } from "@lfb/shared";
import { formatBytes, viewerRouteForName, mediaKindForName, fileTypeForName } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { RepoStatusPill } from "../../components/Pill.js";
import { EntityKebab, type Action } from "../../components/menu/EntityMenu.js";
import { useRepoActions } from "../../components/menu/RowKebabs.js";
import { PageActions, producingActions } from "../../components/menu/PageActions.js";
import { compressAllVideos, compressAllImages, gitIgnoreBig } from "../../components/menu/domainActions.js";
import type { ActionScope } from "../../lib/pageActions.js";
import { withModelReady } from "../../lib/transcribe.js";
import { confirmModal } from "../../lib/modals.js";
// The five leading icon control columns share ONE kit (tables.mdx icon-columns): Pin, Ignore, Transcribe,
// AI description, OCR — unique-color box icons with icon-only headers + hover-region explanations.
import { TaskIconCell, TaskIconHeader, TASK_ICON, type TaskIconKind } from "../../components/table/taskIcons.js";
// The §2.11 file filter (tables.mdx §2.11): the TaskStatus → not_yet/done/na row-value mapper.
import { taskRowValue } from "../../components/table/fileFilter.js";
import { CompressStatusIcon } from "../../components/CompressStatusIcon.js";
import { runDescribeFile } from "../../lib/describe.js";
import { runOcrFile } from "../../lib/ocr.js";
import { TaskTabs } from "./TaskTabs.js";
import { TASK_TABS, type TaskTabId } from "./taskTabs.config.js";
import { MetricsStrip, type MetricView } from "./MetricsStrip.js";
import { METRIC_CATALOG, metricCount, type MetricId } from "./metricWarnings.js";
import { buildMetricWarning, topRecommendation, scanIsStale } from "./metricWarningDefs.js";
import { setHoverInfo } from "./HoverInfoRegion.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { WarningPopup } from "../../components/ui/WarningPopup.js";
import type { WarningDef } from "../../components/ui/warnings/registry.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { refetchUntilResolved } from "../../components/ui/warnings/resolveRefetch.js";
import { relativeTime, absoluteTime, middleTruncate } from "../../lib/format.js";
import { clientLog } from "../../lib/clientLog.js";
import { copyText } from "@/lib/clipboard";

// "sync" is the FROZEN wire value for the Add-to-IPFS (pin) decision; it renders as "Add to IPFS (pin)".
const DECISIONS: Decision[] = ["sync", "ignore", "undecided"];
const decisionLabel = (d: Decision): string =>
  d === "sync" ? "Add to IPFS (pin)" : d[0].toUpperCase() + d.slice(1);

// The ROW-level sentence for a remote-only row (one_repo.mdx §4.10) — the row tooltip AND the left-bar
// hover-info text both read exactly this. `addedByDevice` is the peer's nice name from the travelling device
// registry; when there is no usable label we say "another of your computers" and never an id
// (devices.mdx §6.9).
const remoteOnlyTooltip = (f: FileRow): string =>
  `On ${f.addedByDevice ?? "another of your computers"} — not on this computer yet.`;

// Why every task icon on a remote-only row is inert. Each of those icons is `na`, and `na` normally means
// "this kind of file can't have one" — which is actively WRONG here: a remote-only .mp4 IS transcribable,
// describable, OCR-able and compressible; its bytes simply aren't here. Without this the icons fall back to
// the column's generic explanation and tell the user something untrue (one_repo.mdx §4.10).
const ABSENT_BYTES_REASON = "The bytes aren't on this computer yet — pull it down first.";

// The row's File-type class (video/image/audio/pdf/other) from its name — used by the §2.11
// compressible_videos / _images / _audio filter fields.
const rowFileType = (f: FileRow) => fileTypeForName(f.path.slice(f.path.lastIndexOf("/") + 1));

/** One-line summary of a file for the hover-info region (task_tabs.mdx §3) — name · size · kind · task state. */
function fileSummary(f: FileRow): string {
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  // A remote-only row leads with WHERE it is: that sentence is the entire actionable content of the row,
  // and it outranks any task state (which is `na` on all four axes anyway).
  if (f.presence === "remote-only") return `${name} · ${formatBytes(f.sizeBytes)} · ${remoteOnlyTooltip(f)}`;
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

// The shared presentation for a leading icon control column (tables.mdx icon-columns): narrow, tight
// padding, an icon-only header (with tooltip + hover-region wiring), and the readable label kept for the
// Sort/Filter/Columns dropdowns. Each column then adds its own id / kind / accessor / cell.
function iconCol(
  kind: TaskIconKind,
): Pick<LfbColumn<FileRow>, "header" | "headerCell" | "tight" | "width" | "minWidth"> {
  // No `width` on purpose: a fixed width would switch the whole table to table-fixed layout and squeeze
  // the File column. Auto-layout sizes an icon column to its ~16px glyph already; `tight` trims the padding
  // and `minWidth` only feeds the responsive drop budget (tables.mdx icon-columns).
  return {
    header: TASK_ICON[kind].label,
    headerCell: <TaskIconHeader kind={kind} />,
    tight: true,
    minWidth: 30,
  };
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

  // LIVE REFRESH (one_repo.mdx §4.11, storage_company.mdx §8.9). While this page is open, a backbone pull
  // on the server can reconcile another of the user's computers' manifests and produce new remote-only rows.
  // Without this the page keeps showing the old list until someone reloads — indistinguishable, from the
  // user's chair, from a sync that is simply broken. A bump on this repo's topic invalidates ["repo",
  // repoId] and nothing broader, so the row appears on its own and sort/filter/scroll are preserved.
  // `jobs` too: a batch settle (transcribe/describe/OCR/compress) flips this page's task icons and
  // Done counts, and those settle without any repo-topic write until the artifact commits.
  useLiveRefresh([repoTopic(repoId), "jobs"], [["repo", repoId]]);

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

  // Pull ONE remote-only file's bytes down over IPFS (storage_company.mdx §8.5). The row is built from a
  // peer's manifest entry, so "pull it down" is the only action it can offer — and the same endpoint the
  // Pull-down popup uses, so one file and a whole batch travel the identical path.
  const pullOne = useMutation({
    mutationFn: (p: string) => api.pull(repoId, [p], { compress: false }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["repo", repoId] });
      toast.success("Pulling it down — the bytes are on their way over IPFS.");
    },
    onError: (e: Error) => {
      clientLog.error("OneRepoPage.pullOne", e);
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

  // OCR status-icon click (ocr.mdx §11.2). "could" reads the text from this one file; "done" opens the
  // viewer, whose Text (OCR) column shows it. "na" is inert.
  const onOcrActivate = (f: FileRow) => {
    if (!detail?.path || f.ocr === "na") return;
    const abs = `${detail.path}/${f.path}`;
    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
    if (f.ocr === "could") {
      runOcrFile(abs, name, { onDone: () => qc.invalidateQueries({ queryKey: ["repo", repoId] }) });
    } else {
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
    else if (id === "ocrable" || id === "ocred") setActiveTab("ocr");
    // addToIpfs / gitIgnore / pullDown / pending all act on the IPFS + decision axes.
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

  // The repo-entity catalog (menus.mdx §5.1) — the SAME catalog as the repos-table row ⋮. This page has
  // ONE "More ▾" menu: the action-links row's, which carries these entity items always plus whatever
  // inline links overflow on a narrow window. (The header's separate entity "More ⌄" is gone — two More
  // menus on one page read as two different things.) Omitted here, so nothing is lost, are the items the
  // action-links row already offers in a richer, selection-aware form: Open repo (you are already here),
  // Rescan, Pin now, and the producing trio (Create Transcriptions / AI descriptions / OCR text).
  const debugTarget = useQuery({ queryKey: ["debugTarget"], queryFn: api.debugExportTarget });
  const repoMoreActions = useRepoActions(
    {
      repoId,
      name: detail?.name ?? "",
      path: detail?.path ?? "",
      pinned: detail?.pinned ?? false,
    },
    {
      omit: ["open", "rescan", "pin", "create-transcriptions", "create-descriptions", "create-ocr-text"],
      debugPath: debugTarget.data ? (debugTarget.data.path ?? null) : undefined,
    },
  );

  const columns: LfbColumn<FileRow>[] = [
    // ── The five leading icon control columns (tables.mdx icon-columns). Immediately right of the row
    // checkbox on EVERY tab, narrow with tight padding and icon-only headers. Pin & Ignore are toggles;
    // the three analysis icons (Transcribe / AI description / OCR) show status AND perform the one-click
    // action. Each owns a unique "done" color and explains itself in the hover-info region on hover.
    {
      ...iconCol("pin"),
      id: "pinned",
      kind: "text",
      sortable: false,
      filterable: false,
      accessor: () => "",
      cell: (f) => {
        const decided = f.decision === "sync";
        // Never-IPFS (decisions.mdx §17): a flagged file may never be pinned, so the pin toggle is disabled.
        const blockedByNeverIpfs = !!f.neverIpfs;
        // THREE STATES (one_repo.mdx §4.9). The state comes from the DECISION (intent) crossed with a LIVE,
        // canonical read of this node's pinset (`f.pinnedHere`, knowledge/ipfs.mdx §5.1):
        //   • not decided        → "could": grey OUTLINE pin (white/not-set) — click adds it to IPFS.
        //   • decided & here      → "done" BLUE filled pin — synced (pinned) on THIS computer.
        //   • decided & NOT here  → "done" RED filled pin — we chose to sync it, but this machine doesn't hold
        //     it yet (the pin pass will pull it). `pinnedHere===false` is a VERIFIED miss; `undefined` means
        //     unverified (IPFS down / not fetched) → we do NOT cry red, we show intent-blue.
        const missingHere = decided && f.pinnedHere === false;
        // FOURTH state (foreign_pin_discovery.mdx §6): an UNDECIDED file whose bytes a background pass
        // discovered are ALREADY pinned on this node under a foreign CID (a bare `ipfs add`, another tool).
        // Reality without intent — rendered as a GREEN filled pin, distinct from intent-blue, so the app
        // never shows "not pinned" for a file the node genuinely holds.
        const foreignPinned = !decided && f.pinnedForeign === true;
        // FIFTH state (storage_company.mdx §8.5): a REMOTE-ONLY row — another of your computers has this
        // file's bytes and this one does not. It is the purest case of the red state (wanted here, not here),
        // so it renders red whatever this computer has decided, and its one action is PULL IT DOWN rather
        // than a decision toggle. Red here means "available, not here yet" — never "lost".
        const remoteOnly = f.presence === "remote-only";
        const state: TaskStatus = decided || foreignPinned || remoteOnly ? "done" : "could";
        const doneColor = missingHere || remoteOnly ? "#dc2626" : foreignPinned ? "#15803d" : undefined;
        // One sentence, one source (§4.10) — the same text the row tooltip and hover-info use.
        const onDevice = remoteOnlyTooltip(f);
        return (
          <TaskIconCell
            kind="pin"
            state={state}
            doneColor={doneColor}
            disabled={ipfsDown || (blockedByNeverIpfs && !remoteOnly)}
            title={
              remoteOnly
                ? `${onDevice} Click to pull it down over IPFS.`
                : blockedByNeverIpfs
                  ? "Add to IPFS is blocked by Never-IPFS"
                  : foreignPinned
                    ? "Pinned locally — this file is already pinned on this computer's IPFS node (by other IPFS software, which is fine). Click to have Large File Bridge sync it across your computers too."
                    : !decided
                      ? "Not set to sync — click to add this file to IPFS"
                      : missingHere
                        ? "Set to sync, but this computer doesn't have it pinned yet — it will pull it on the next pin pass. Click to stop syncing."
                        : "Synced (pinned) on this computer — click to stop syncing this file"
            }
            extraHover={fileSummary(f)}
            // Two-axis write preserving the git-ignore axis (decision_toggles.mdx §2) — except for a
            // remote-only row, whose only meaningful action is to fetch the bytes.
            onActivate={() =>
              remoteOnly
                ? pullOne.mutate(f.path)
                : setAxes.mutate({ paths: [f.path], ipfs: !decided, gitignore: !!f.gitignore })
            }
          />
        );
      },
    },
    {
      ...iconCol("ignore"),
      id: "gitignore",
      kind: "text",
      sortable: false,
      filterable: false,
      accessor: () => "",
      cell: (f) => {
        const on = !!f.gitignore;
        // A rule we must not rewrite (a pattern, or a non-root-.gitignore source) owns this file, so OFF is
        // not ours to perform — show it ON but locked and name the rule (git_ignore.mdx §5.5).
        const locked = !!f.gitignoreLocked;
        // A remote-only row has no bytes on this computer (storage_company.mdx §8.5), so there is nothing
        // here for git to ignore — the toggle is disabled and says why rather than writing a .gitignore line
        // for a path this working tree does not contain.
        const remoteOnly = f.presence === "remote-only";
        const title = remoteOnly
          ? "Not on this computer yet — pull it down first, then you can git-ignore it."
          : locked && f.gitignoreRule
            ? `Git-ignored by ${f.gitignoreRule.source}:${f.gitignoreRule.line} — ${f.gitignoreRule.pattern}. ` +
              `That rule covers more than this file, so Large File Bridge will not rewrite it.`
            : on
              ? "Git-ignored — click to stop ignoring this file"
              : "Add to git ignore";
        return (
          <TaskIconCell
            kind="ignore"
            state={on ? "done" : "could"}
            disabled={locked || remoteOnly}
            title={title}
            extraHover={fileSummary(f)}
            onActivate={() => setAxes.mutate({ paths: [f.path], ipfs: f.decision === "sync", gitignore: !on })}
          />
        );
      },
    },
    {
      ...iconCol("transcribe"),
      id: "transcribe",
      kind: "enum",
      accessor: (f) => f.transcribe ?? "na",
      filterOptions: ["could", "done", "na"],
      // A remote-only row's `na` needs its OWN reason (§4.10) — the column's generic "not audio/video" would
      // be a lie about a file that is perfectly transcribable once its bytes are here.
      cell: (f) => (
        <TaskIconCell kind="transcribe" state={f.transcribe ?? "na"}
          title={f.presence === "remote-only" ? ABSENT_BYTES_REASON : undefined}
          extraHover={fileSummary(f)} onActivate={() => onTranscribeActivate(f)} />
      ),
    },
    {
      ...iconCol("describe"),
      id: "describe",
      kind: "enum",
      accessor: (f) => f.describe ?? "na",
      filterOptions: ["could", "done", "na"],
      cell: (f) => (
        <TaskIconCell kind="describe" state={f.describe ?? "na"}
          title={f.presence === "remote-only" ? ABSENT_BYTES_REASON : undefined}
          extraHover={fileSummary(f)} onActivate={() => onDescribeActivate(f)} />
      ),
    },
    {
      ...iconCol("ocr"),
      id: "ocr",
      kind: "enum",
      accessor: (f) => f.ocr ?? "na",
      filterOptions: ["could", "done", "na"],
      cell: (f) => (
        <TaskIconCell kind="ocr" state={f.ocr ?? "na"}
          title={f.presence === "remote-only" ? ABSENT_BYTES_REASON : undefined}
          extraHover={fileSummary(f)} onActivate={() => onOcrActivate(f)} />
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
            // The ROW tooltip (one_repo.mdx §4.10): a remote-only row leads with "On {device} — not on this
            // computer yet." above its path, so hovering the row's own name says where the file actually is.
            title={f.presence === "remote-only" ? `${remoteOnlyTooltip(f)}\n${f.path}` : f.path}
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
    { id: "peers", header: "Peers", kind: "int", align: "right", accessor: (f) => f.peers.length,
      cell: (f) => <span className={f.decision === "sync" && f.cid && f.peers.length === 0 ? "text-red-600" : ""}>{f.peers.length}</span> },
    { id: "cid", header: "CID", kind: "text", accessor: (f) => f.cid,
      cell: (f) => f.cid ? <code className="text-xs text-black/60" title={f.cid} onClick={(e) => { e.stopPropagation(); void copyText(f.cid!, "CID", "OneRepoPage.copyCid"); }}>{middleTruncate(f.cid, 16)}</code> : <span className="text-black/20">—</span> },
    { id: "changed", header: "Changed", kind: "timestamp", accessor: (f) => f.changedAt,
      cell: (f) => <span title={absoluteTime(f.changedAt)}>{relativeTime(f.changedAt)}</span> },
    // ── Task-tab columns (task_tabs.mdx §4). Present in the union; shown only on the tabs that list them.
    // `kind` — the File-type class (video/image/audio/pdf), for the Compress, Transcribe & OCR tabs. Uses
    // `fileTypeForName` (not `mediaKindForName`) so a PDF reads as "pdf" on the OCR tab rather than blank.
    {
      id: "kind",
      header: "Kind",
      kind: "enum",
      accessor: (f) => {
        const t = fileTypeForName(f.path.slice(f.path.lastIndexOf("/") + 1));
        return t === "other" ? "" : t;
      },
      filterOptions: ["video", "image", "audio", "pdf"],
      cell: (f) => {
        const t = fileTypeForName(f.path.slice(f.path.lastIndexOf("/") + 1));
        return <span className="text-xs text-black/60">{t === "other" ? "—" : t}</span>;
      },
    },
    // `compress` — the three-state Compress status icon (task_tabs.mdx §6). Not one of the five standard
    // left icons; it is the Compress tab's own content icon, kept narrow with an icon header for parity.
    // Sort by status ("could" < "done" < "na") puts actionable rows first; filter on the same values.
    {
      id: "compress",
      header: "Compress",
      headerCell: (
        <span className="inline-flex text-black/55" title="Compress — reclaim space on videos and images">
          <Archive className="h-2.5 w-2.5" strokeWidth={2.5} />
        </span>
      ),
      tight: true,
      minWidth: 30,
      kind: "enum",
      accessor: (f) => f.compress ?? "na",
      filterOptions: ["could", "done", "na"],
      cell: (f) => (
        <CompressStatusIcon
          state={f.compress ?? "na"}
          // Same correction as the three analysis icons: the default `na` text ("Not a compressible media
          // type") is wrong for a remote-only .mp4 — it IS one, its bytes just aren't here (§4.10).
          title={f.presence === "remote-only" ? ABSENT_BYTES_REASON : undefined}
          onActivate={() => onCompressActivate(f)}
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
    // Ranked LAST in topRecommendation() (ocr.mdx §12.3) — a search convenience never outranks a backup
    // risk — but when it IS the only outstanding work it is correctly the whole recommendation.
    ocrable: "OCR",
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
        actionsRow={<PageActions actions={repoActions} selectedCount={selected.size} overflow={repoMoreActions} />}
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

      {/* The old compact "N Pin · N Undecided · N Ignore · N Pinned locally" readout lived here. Removed —
          the metrics strip above is this page's decision readout (task_tabs.mdx §2). */}

      <DataTable
        // Keyed by tab so switching re-applies the tab's default sort (task_tabs.mdx §7).
        key={activeTab}
        // Remembered view state is per task tab (each tab projects its own columns/sort).
        tableId={`repo-files:${activeTab}`}
        // Content below the table (the Repo details disclosure) → bounded height, not full-page
        // (one_repo.mdx §4 / repos.mdx §3.3.1).
        fillHeight={false}
        // The active tab projects the columns + filters the rows + sets the default sort (task_tabs.mdx §4).
        data={tabRows}
        columns={visibleColumns}
        defaultSort={tab.defaultSort}
        // The File-type facet classifies each row by name (tables.mdx §2.10); together with the §2.11
        // filter below it lets the user reach a small JPG to OCR.
        fileTypeFacet={{ valueOf: (f) => fileTypeForName(f.path.slice(f.path.lastIndexOf("/") + 1)) }}
        // The §2.11 file filter (tables.mdx §2.11) — this is the full-vocabulary surface: all ten
        // fields. `size` carries the old "Large files only" default (ON everywhere but the OCR tab —
        // ocr.mdx §11.1.1) as its seed expression; the rail checkbox is now its shortcut. The two
        // decision axes stay separate fields (add_to_ipfs = the ledger's intent; git_ignore = live
        // `git check-ignore` — tables.mdx §2.4), and pull_down reads presence (§4e).
        fileFilter={{
          defaultExpr: tab.largeOnlyDefault ? "size = only_large" : "",
          fields: [
            { id: "transcribe", valueOf: (f) => taskRowValue(f.transcribe) },
            { id: "ai_description", valueOf: (f) => taskRowValue(f.describe) },
            { id: "ocr", valueOf: (f) => taskRowValue(f.ocr) },
            { id: "pull_down", valueOf: (f) => (f.presence === "remote-only" ? "not_yet" : "done") },
            { id: "add_to_ipfs", valueOf: (f) => (f.decision === "sync" ? "done" : "not_yet") },
            { id: "git_ignore", valueOf: (f) => (f.gitignore ? "done" : "not_yet") },
            {
              id: "compressible_videos",
              valueOf: (f) => (f.compress === "could" && rowFileType(f) === "video" ? "yes" : "no"),
            },
            {
              id: "compressible_images",
              valueOf: (f) => (f.compress === "could" && rowFileType(f) === "image" ? "yes" : "no"),
            },
            {
              id: "compressible_audio",
              valueOf: (f) => (f.compress === "could" && rowFileType(f) === "audio" ? "yes" : "no"),
            },
            { id: "size", valueOf: (f) => (f.analysisOnly ? "small" : "large") },
          ],
        }}
        // Option-key floating image preview (option_image_preview.mdx §5 / one_repo.mdx §4.12): hovering
        // an image row with Option held floats the preview. Remote-only rows are excluded — their bytes
        // aren't on this computer (§4.10), so a grant could never stream them.
        hoverPreview={(f) => {
          if (!detail?.path || f.presence === "remote-only") return null;
          const name = f.path.slice(f.path.lastIndexOf("/") + 1);
          return fileTypeForName(name) === "image" ? `${detail.path}/${f.path}` : null;
        }}
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
        // The same destination as a URL, so ⌘-click / middle-click open it in a new tab like any link
        // (tables.mdx §4d).
        rowHref={(f) => {
          if (!detail?.path) return "";
          const abs = `${detail.path}/${f.path}`;
          const name = f.path.slice(f.path.lastIndexOf("/") + 1);
          return `${viewerRouteForName(name)}?path=${encodeURIComponent(abs)}`;
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
