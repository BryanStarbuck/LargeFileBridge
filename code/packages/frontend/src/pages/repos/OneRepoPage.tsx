// The per-repo screen (one_repo.mdx + use_cases.mdx §5.4). The StatusBanner here is the UC-2
// diagnosis engine: "a file didn't show up on my other computer" — it names the FIRST real cause
// worst-first (IPFS down → pinned-but-no-peers → undecided → pending) and hands over the one fix,
// so a non-expert never has to guess which of the four it was. The files table is unchanged; the old
// status strip moves into a collapsed "Repo details" disclosure.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { RefreshCw, Settings, ChevronLeft, Network } from "lucide-react";
import { toast } from "sonner";
import type { FileRow, Decision, RepoDetail, PinCounts, PinNowResult } from "@lfb/shared";
import { formatBytes, viewerRouteForName } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { RepoStatusPill, TransferPill } from "../../components/Pill.js";
import { EntityKebab, type Action } from "../../components/menu/EntityMenu.js";
import { PageActions, producingActions } from "../../components/menu/PageActions.js";
import { compressAllVideos, compressAllImages, gitIgnoreBig } from "../../components/menu/domainActions.js";
import type { ActionScope } from "../../lib/pageActions.js";
import { PinToggle } from "../../components/PinToggle.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner, FixButton } from "../../components/ui/StatusBanner.js";
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

  const { data: detail, isLoading } = useQuery({
    queryKey: ["repo", repoId],
    queryFn: () => api.repo(repoId),
  });

  const setDecision = useMutation({
    mutationFn: ({ paths, decision }: { paths: string[]; decision: Decision }) =>
      api.setDecision(repoId, paths, decision),
    onSuccess: (d: RepoDetail) => qc.setQueryData(["repo", repoId], d),
    onError: (e: Error) => {
      clientLog.error("OneRepoPage.setDecision", e);
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
        // Control cell — stop the click bubbling to the row's navigate (one_repo.mdx §4.7).
        return (
          <span onClick={(e) => e.stopPropagation()}>
            <PinToggle
              pinned={pinned}
              disabled={ipfsDown}
              onToggle={() =>
                setDecision.mutate({ paths: [f.path], decision: pinned ? "ignore" : "sync" })
              }
            />
          </span>
        );
      },
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
          <span title={f.path}>
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
      cell: (f) => (
        <select
          value={f.decision}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDecision.mutate({ paths: [f.path], decision: e.target.value as Decision })}
          className="rounded border border-[var(--lfb-border)] px-1 py-0.5 text-xs"
        >
          {DECISIONS.map((d) => (
            <option key={d} value={d}>
              {decisionLabel(d)}
            </option>
          ))}
        </select>
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
  ];

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

      {/* Summary counts (quick filters would live here) */}
      {c && (
        <div className="mb-1 text-sm text-black/70">
          {c.pinned + c.pending} Pin ·{" "}
          <span className={c.undecided > 0 ? "text-[var(--lfb-primary)] font-medium" : ""}>{c.undecided} Undecided</span> ·{" "}
          {c.ignored} Ignore
        </div>
      )}

      <DataTable
        // Content below the table (the Repo details disclosure) → bounded height, not full-page
        // (one_repo.mdx §4 / repos.mdx §3.3.1).
        fillHeight={false}
        data={detail?.files ?? []}
        columns={columns}
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
  } else if (undecided > 0) {
    state = "warn";
    headline = `${undecided} file${undecided === 1 ? "" : "s"} need${undecided === 1 ? "s" : ""} a decision`;
    sub = "Choose Add to IPFS (pin) or Ignore for them in the table below so LFBridge knows what to move.";
    // The subjects list (warnings.mdx §4.5): the actual undecided files, each a checkable row with its
    // size, all checked at open. Apply runs the chosen decision over exactly the CHECKED rows.
    const undecidedFiles = detail.files.filter((f) => f.decision === "undecided");
    warning = {
      id: "repo-files-need-decision",
      state: "warn",
      scope: "file",
      headline,
      sub,
      popup: {
        whatThisIs: `LFBridge found ${undecided} large file${undecided === 1 ? "" : "s"} in this repo that you haven't told it what to do with yet. Until you decide, ${
          undecided === 1 ? "it is" : "they are"
        } neither backed up over IPFS nor git-ignored. Review the list on the right — uncheck any file you want to leave out.`,
        whyItMatters: (
          <ul className="list-disc space-y-0.5 pl-4">
            <li>A file left undecided is not pinned to your other computers — if this machine dies, it's gone.</li>
            <li>It also isn't git-ignored, so git may try to commit it.</li>
          </ul>
        ),
        options: [
          {
            kind: "radio",
            group: "decision",
            value: "sync",
            label: "Add the selected files to IPFS (pin) — back them up over IPFS",
            defaultSelected: true,
          },
          {
            kind: "radio",
            group: "decision",
            value: "ignore",
            label: "Ignore the selected files (git-ignore, don't pin)",
          },
        ],
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
        actionLabel: (sel) => (sel.radios.decision === "ignore" ? "Ignore" : "Apply & pin"),
        // §5.3 — async: hand off to the dock (verb tracks the Pin/Ignore choice), toast on done, and
        // refetch this repo so the "N files need a decision" banner disappears once decisions are written.
        progress: {
          kind: (sel) => (sel.radios.decision === "ignore" ? "ignore" : "pin"),
          target: detail.name,
          doneLabel: (sel, n) =>
            `${n} file${n === 1 ? "" : "s"} set to ${sel.radios.decision === "ignore" ? "ignore" : "pin"}`,
          invalidate: [["repo", repoId]],
        },
        apply: async (_sel, checkedPaths) => {
          const decision = (_sel.radios.decision as Decision) || "sync";
          await api.setDecision(repoId, checkedPaths, decision);
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
