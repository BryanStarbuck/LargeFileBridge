// The per-metric educate-and-fix WarningDefs for the one-repo page (task_tabs.mdx §2.4 / warnings.mdx §11).
//
// Clicking a metric panel opens the SAME educate-and-fix popup the blue arrow button opens elsewhere
// (warnings.mdx §3/§4), scoped to exactly the files the number counts. This module is the single place
// those WarningDefs are BUILT, so both the metric tiles (per metric) and the header "View recommendation"
// primary (the worst-first top one) resolve the identical popup. Previously these lived inline in
// OneRepoPage's RepoVerdict banner; the banner is gone (metric panels replace it, task_tabs.mdx §2.6), so
// the builders moved here where the tiles and the header button can share them.
import type { RepoDetail } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import type { WarningDef } from "../../components/ui/warnings/registry.js";
import type { MetricId } from "./metricWarnings.js";

// Scan staleness: a repo scanned longer ago than this (or never) wants a fresh scan before we trust its
// metrics — the header primary becomes "Scan now" until it's re-scanned (one_repo.mdx §3.1 / scan.mdx §2.3).
const SCAN_STALE_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

/** True when the repo has never been scanned, or its last scan is older than the 2-week staleness window. */
export function scanIsStale(detail: RepoDetail, nowMs: number = Date.now()): boolean {
  if (!detail.lastScanAt) return true;
  const t = Date.parse(detail.lastScanAt);
  if (Number.isNaN(t)) return true;
  return nowMs - t > SCAN_STALE_MS;
}

// ── The individual educate-and-fix WarningDef builders ──────────────────────────────────────────────

/** IPFS engine down — the one-click "Start IPFS" popup (warnings.mdx §10.1.2). Not a metric tile; surfaced
 *  as the highest-priority header recommendation so a paused pipe is never silent. */
export function buildIpfsDownWarning(_detail: RepoDetail, repoId: string): WarningDef {
  const headline = "Pinning is paused — the IPFS engine on this computer isn't running";
  const sub = "Decisions still save, but no files can move until IPFS starts.";
  return {
    id: "repo-ipfs-down",
    state: "bad",
    headline,
    sub,
    popup: {
      whatThisIs:
        "IPFS is the local peer-to-peer engine Large File Bridge uses to move big files between your own computers. It's set up on this machine but isn't running right now, so no bytes can transfer.",
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
}

/** Files a peer computer pinned that aren't here yet — the two-pane "pull them down" popup
 *  (warnings.mdx §10.8.12). Null when nothing is missing. */
export function buildPullDownWarning(detail: RepoDetail, repoId: string): WarningDef | null {
  const missing = detail.missingPinned ?? [];
  if (missing.length === 0) return null;
  const n = missing.length;
  const device = missing[0]?.addedByDevice ?? "another computer";
  const headline = `${n} file${n === 1 ? " is" : "s are"} pinned on another of your computers but not here yet`;
  const sub = `${device} pinned ${n === 1 ? "it" : "them"} — pull ${n === 1 ? "it" : "them"} down so this computer is a real second copy.`;
  return {
    id: "peer-pinned-files-not-here-pull-down",
    state: "warn",
    scope: "file",
    headline,
    sub,
    popup: {
      whatThisIs: `Another of your computers (${device}) pinned ${n} file${n === 1 ? "" : "s"} that ${n === 1 ? "isn't" : "aren't"} on this computer yet. Large File Bridge can pull ${n === 1 ? "it" : "them"} down over IPFS.`,
      whyItMatters: `Until you pull ${n === 1 ? "it" : "them"} down, this computer is not a real second copy of ${n === 1 ? "that file" : "those files"} — losing the other machine would lose ${n === 1 ? "it" : "them"}. Review the list on the right and uncheck any you don't want.`,
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
      actionLabel: "",
      canApply: () => true,
      targets: missing.map((mf) => {
        const dir = mf.path.includes("/") ? mf.path.slice(0, mf.path.lastIndexOf("/")) : "";
        return {
          id: mf.path,
          label: mf.name,
          sublabel: `${dir || "(repo root)"} · ${formatBytes(mf.sizeBytes)} · added by ${mf.addedByDevice ?? "another computer"}`,
        };
      }),
      targetNoun: "file",
      progress: {
        kind: "pin",
        target: detail.name,
        doneLabel: (_sel, count) => `${count} file${count === 1 ? "" : "s"} pulled`,
        invalidate: [["repo", repoId]],
      },
      apply: async (sel, checkedPaths) => {
        await api.pull(repoId, checkedPaths, { compress: !!sel.checks.compress });
      },
    },
  };
}

/** Undecided files — the two-axis triage popup (Add to IPFS / git-ignore) over the actual undecided files
 *  (warnings.mdx §10.2.7). Null when nothing is undecided. This is the popup the "Undecided N" tile opens. */
export function buildUndecidedWarning(detail: RepoDetail, repoId: string): WarningDef | null {
  const undecided = detail.counts.undecided;
  const undecidedFiles = detail.files.filter((f) => f.decision === "undecided");
  if (undecided === 0 || undecidedFiles.length === 0) return null;
  const headline = `${undecided} file${undecided === 1 ? "" : "s"} need${undecided === 1 ? "s" : ""} a decision`;
  const sub = "Choose Add to IPFS (pin) or Ignore for them in the table below so Large File Bridge knows what to move.";
  // Never-IPFS enforcement (decisions.mdx §17): force the IPFS axis off + a "blocked" helper when EVERY
  // undecided file is flagged; when only some are, keep it enabled and note how many will be skipped.
  const neverIpfsCount = undecidedFiles.filter((f) => f.neverIpfs).length;
  const allNeverIpfs = undecidedFiles.length > 0 && neverIpfsCount === undecidedFiles.length;
  const ipfsHelper = allNeverIpfs
    ? "Blocked by Never-IPFS — these files can't be added to IPFS."
    : neverIpfsCount > 0
      ? `back them up across your computers over IPFS · ${neverIpfsCount} of these ${neverIpfsCount === 1 ? "is" : "are"} Never-IPFS and will be skipped`
      : "back them up across your computers over IPFS";
  return {
    id: "repo-files-need-decision",
    state: "warn",
    scope: "file",
    headline,
    sub,
    popup: {
      whatThisIs: `Large File Bridge found ${undecided} large file${undecided === 1 ? "" : "s"} in this repo that you haven't told it what to do with yet. Choose what to do on two independent axes below — a big file usually wants BOTH: git-ignored so Git never commits it, and pinned so it is backed up across your computers. Your choice is shared with everyone on this repo, so no teammate is asked again. Review the list on the right — uncheck any file you want to leave out.`,
      whyItMatters: (
        <ul className="list-disc space-y-0.5 pl-4">
          <li>A file not added to IPFS is not pinned to your other computers — if this machine dies, it's gone.</li>
          <li>A file not git-ignored may be committed by Git, bloating the repo with big binaries.</li>
          <li>Leaving both off is fine too — it records "reviewed, leave as-is" so this doesn't ask again.</li>
        </ul>
      ),
      options: [
        {
          kind: "checkbox",
          name: "ipfs",
          label: "Add them to IPFS",
          helper: ipfsHelper,
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
      canApply: () => true,
      targets: undecidedFiles.map((f) => ({
        id: f.path,
        label: f.path,
        sublabel: formatBytes(f.sizeBytes),
      })),
      targetNoun: "file",
      actionLabel: "Apply",
      progress: {
        kind: (sel) =>
          !allNeverIpfs && sel.checks.ipfs ? "pin" : sel.checks.gitignore ? "ignore" : "configure",
        target: detail.name,
        doneLabel: (_sel, n) => `${n} file${n === 1 ? "" : "s"} decided`,
        invalidate: [["repo", repoId]],
      },
      apply: async (sel, checkedPaths) => {
        await api.setFileDecisions(repoId, checkedPaths, {
          ipfs: allNeverIpfs ? false : !!sel.checks.ipfs,
          gitignore: !!sel.checks.gitignore,
        });
      },
    },
  };
}

// ── Resolvers used by the tiles + the header primary ────────────────────────────────────────────────

/** The educate-and-fix popup for a specific metric tile, or null when that metric has no popup yet (those
 *  tiles fall back to re-tuning the view to their tab). Only the metrics with a real fix have one today. */
export function buildMetricWarning(id: MetricId, detail: RepoDetail, repoId: string): WarningDef | null {
  switch (id) {
    case "undecided":
      return buildUndecidedWarning(detail, repoId);
    case "pullDown":
      return buildPullDownWarning(detail, repoId);
    default:
      return null;
  }
}

/** The single most important pending recommendation, worst-first, that has an educate-and-fix popup — what
 *  the header "View recommendation" primary opens. Null when there's nothing to recommend (all clear). */
export function topRecommendation(
  detail: RepoDetail,
  repoId: string,
): { metricId?: MetricId; warning: WarningDef } | null {
  if (detail.ipfs === "unreachable") return { warning: buildIpfsDownWarning(detail, repoId) };
  const pull = buildPullDownWarning(detail, repoId);
  if (pull) return { metricId: "pullDown", warning: pull };
  const undecided = buildUndecidedWarning(detail, repoId);
  if (undecided) return { metricId: "undecided", warning: undecided };
  return null;
}
