// The per-metric educate-and-fix WarningDefs for the one-repo page (task_tabs.mdx §2.4 / warnings.mdx §11).
//
// Clicking a metric panel opens the SAME educate-and-fix popup the blue arrow button opens elsewhere
// (warnings.mdx §3/§4), scoped to exactly the files the number counts. This module is the single place
// those WarningDefs are BUILT, so both the metric tiles (per metric) and the header "View recommendation"
// primary (the worst-first top one) resolve the identical popup. Previously these lived inline in
// OneRepoPage's RepoVerdict banner; the banner is gone (metric panels replace it, task_tabs.mdx §2.6), so
// the builders moved here where the tiles and the header button can share them.
import { toast } from "sonner";
import type { RepoDetail, FileRow } from "@lfb/shared";
import { formatBytes, mediaKindForName } from "@lfb/shared";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";
import { DESCRIBE_KIND_FILTERS } from "../../lib/describe.js";
import { OCR_KIND_FILTERS, withOcrReady } from "../../lib/ocr.js";
import { withModelReady } from "../../lib/transcribe.js";
import type { WarningDef } from "../../components/ui/warnings/registry.js";
import type { MetricId } from "./metricWarnings.js";

// Scan staleness: a repo scanned longer ago than this (or never) wants a fresh scan before we trust its
// metrics — the header primary becomes "Scan now" until it's re-scanned (one_repo.mdx §3.1 / scan.mdx §2.3).
const SCAN_STALE_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

/** The file's basename (§4.5 ROW 1); the popup row strips the extension for display. */
function basename(p: string): string {
  return p.split("/").pop() || p;
}

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
          name: mf.name,
          sizeText: formatBytes(mf.sizeBytes),
          pathText: `${dir || "(repo root)"} · added by ${mf.addedByDevice ?? "another computer"}`,
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
  // Must mirror the backend count exactly (units.service.ts countDecisions): foreign-pinned rows are NOT
  // undecided-nag targets — their bytes are already pinned here (green state, one_repo.mdx §4.9).
  const undecidedFiles = detail.files.filter((f) => f.decision === "undecided" && !f.pinnedForeign);
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
        name: basename(f.path),
        sizeText: formatBytes(f.sizeBytes),
        pathText: f.path,
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

/** The file's absolute path — FileRow.path is repo-relative, so join it onto the repo root (the same join
 *  OneRepoPage uses for every per-file action). This is what the batch endpoints expect. */
function absPath(detail: RepoDetail, f: FileRow): string {
  return `${detail.path}/${f.path}`;
}

/** Transcribable audio/video with no transcript yet — the "N ready to transcribe" tile's educate-and-fix
 *  popup (Transcribe.mdx / task_tabs.mdx §5). Null when nothing is transcribable. Clicking the Transcribable
 *  tile (or the blue "Transcribe ›" header primary) opens this; Apply hands the checked files to the local,
 *  offline engine as a background job. */
export function buildTranscribeWarning(detail: RepoDetail, repoId: string): WarningDef | null {
  const files = detail.files.filter((f) => f.transcribe === "could");
  if (files.length === 0) return null;
  const n = files.length;
  return {
    id: "repo-files-transcribable",
    state: "warn",
    scope: "file",
    headline: `${n} file${n === 1 ? " is" : "s are"} ready to transcribe`,
    sub: "Large File Bridge can generate a text transcript for each locally — nothing runs until you apply.",
    popup: {
      whatThisIs: `Large File Bridge found ${n} audio/video file${n === 1 ? "" : "s"} in this repo with no transcript yet. It can transcribe ${n === 1 ? "it" : "them"} on this computer with a local, offline engine — no file ever leaves your machine.`,
      whyItMatters:
        "A transcript makes a recording searchable, quotable, and readable without scrubbing the timeline. It runs in the background and, when done, is saved per your repo's transcription placement setting. Review the list on the right and uncheck any you want to skip.",
      targets: files.map((f) => ({
        id: absPath(detail, f),
        label: f.path,
        name: basename(f.path),
        sizeText: formatBytes(f.sizeBytes),
        pathText: f.path,
      })),
      targetNoun: "file",
      actionLabel: "Transcribe",
      canApply: () => true,
      progress: {
        kind: "transcribe",
        target: detail.name,
        doneLabel: (_sel, count) => `${count} file${count === 1 ? "" : "s"} queued to transcribe`,
        invalidate: [["repo", repoId]],
      },
      // Model-gated on Apply, then BACKGROUND-ENQUEUED (Transcribe.mdx §2.5/§9.1, transcribe_engine.mdx §3.6).
      // We must NOT run api.transcribeBatch here: that transcribes every file inline inside ONE HTTP request,
      // which stays open for minutes on a big repo and dies on a network error / dev restart (the reported
      // "it failed to transcribe" bug). enqueue plans + queues on the server and returns immediately; each
      // file then surfaces its own determinate `transcribe` job on the Processing page / dock.
      apply: async (_sel, checkedPaths) => {
        const label = `transcribe ${checkedPaths.length} file${checkedPaths.length === 1 ? "" : "s"}`;
        await withModelReady({
          label,
          run: () => {
            void api
              .transcribeEnqueue({ paths: checkedPaths })
              .then((plan) => {
                if (plan.needsSetup) {
                  toast.error("Set up Personal storage first — Settings → Storages");
                }
              })
              .catch((e) => {
                clientLog.error("transcribe.enqueue", e);
                toast.error(e instanceof Error ? e.message : "Could not queue transcription");
              });
          },
        });
      },
    },
  };
}

/** Describable images/videos with no AI description yet — the "N describable" tile's educate-and-fix popup
 *  (ai_description.mdx §12 / task_tabs.mdx §4.5). The mirror of buildTranscribeWarning. Null when nothing is
 *  describable. Apply hands the checked files to the configured AI provider as a background `describe` job. */
export function buildDescribeWarning(detail: RepoDetail, repoId: string): WarningDef | null {
  const files = detail.files.filter((f) => f.describe === "could");
  if (files.length === 0) return null;
  const n = files.length;
  return {
    id: "repo-files-describable",
    state: "warn",
    scope: "file",
    headline: `${n} file${n === 1 ? " is" : "s are"} ready for an AI description`,
    sub: "Large File Bridge can generate an AI description for each image/video — nothing runs until you apply.",
    popup: {
      whatThisIs: `Large File Bridge found ${n} image/video file${n === 1 ? "" : "s"} in this repo with no AI description yet. It can generate one for each with your configured AI provider.`,
      whyItMatters:
        "An AI description makes an image or video searchable and captioned without opening it. Each file is sent to your configured AI provider; add a key in Settings → AI credentials first. Use the Videos / Images filter to narrow the list, and uncheck any you want to skip.",
      // ai_description.mdx §12.4.1 — the Videos/Images filter row, same as the unified batch popup: each row
      // carries its media kind, and a kind filtered out of the list is dropped from the batch too.
      kindFilters: DESCRIBE_KIND_FILTERS,
      targets: files.map((f) => ({
        id: absPath(detail, f),
        label: f.path,
        name: basename(f.path),
        kind: mediaKindForName(f.path) ?? undefined,
        sizeText: formatBytes(f.sizeBytes),
        pathText: f.path,
      })),
      targetNoun: "file",
      actionLabel: "Describe",
      canApply: () => true,
      progress: {
        kind: "describe",
        target: detail.name,
        doneLabel: (_sel, count) => `${count} file${count === 1 ? "" : "s"} queued to describe`,
        invalidate: [["repo", repoId]],
      },
      // BACKGROUND-ENQUEUED (ai_description.mdx §12.4, mirror of buildTranscribeWarning above). We must NOT
      // run api.describeBatch here: that describes every file inline inside ONE HTTP request, which stays
      // open for minutes on a long list, dies on a network blip / dev restart, and NEVER surfaces per-file
      // rows on the Processing page (the reported "AI descriptions don't appear in Processing" bug).
      // describeEnqueue plans + queues on the server (op `describe`) and returns immediately; each file then
      // surfaces its own `describe` job on the Processing page / dock (job_queue.mdx §3, processing.mdx §4).
      apply: async (_sel, checkedPaths) => {
        try {
          const plan = await api.describeEnqueue({ paths: checkedPaths });
          if (plan.needsSetup) {
            toast.error("Set up Personal storage first — Settings → Storages");
          }
        } catch (e) {
          clientLog.error("describe.enqueue", e);
          toast.error(e instanceof Error ? e.message : "Could not queue AI descriptions");
        }
      },
    },
  };
}

/**
 * OCRable — image/video with no OCR text yet (ocr.mdx §12.2, warnings.mdx §11.1.4 `repo-ocrable-work`).
 * The third sibling of buildTranscribeWarning / buildDescribeWarning.
 *
 * Built from the IN-MEMORY `detail.files`, so — unlike the ⋮ / action-link launchers — there is no `/plan`
 * call and therefore NO "Opening window…" spinner (dialogs.mdx §5.4: the spinner is only for scope-walking
 * opens).
 */
export function buildOcrWarning(detail: RepoDetail, repoId: string): WarningDef | null {
  const files = detail.files.filter((f) => f.ocr === "could");
  if (files.length === 0) return null;
  const n = files.length;
  return {
    id: "repo-ocrable-work",
    state: "warn",
    scope: "file",
    headline: `${n} file${n === 1 ? " is" : "s are"} ready to have their text read`,
    sub: "Large File Bridge can read the text out of each image/video on this computer — nothing runs until you apply.",
    popup: {
      whatThisIs: `Large File Bridge found ${n} image/video file${n === 1 ? "" : "s"} in this repo whose on-screen text hasn't been read yet. It reads the words visible in the pixels — a screenshot's error message, a slide's figures, a sign — so you can search for them later.`,
      whyItMatters:
        "OCR text makes the words inside your images and videos searchable without opening them. It runs entirely on this computer — nothing is uploaded, and no API key is needed. Images finish in seconds; each video is sampled every 15 seconds, so it takes about a minute per hour of footage. Use the Videos / Images filter to narrow the list, and uncheck any you want to skip.",
      // ocr.mdx §9.1 — the Videos/Images filter row. More load-bearing here than for describe: the two kinds
      // differ in cost by two orders of magnitude, so "just the screenshots" must be one click.
      kindFilters: OCR_KIND_FILTERS,
      targets: files.map((f) => ({
        id: absPath(detail, f),
        label: f.path,
        name: basename(f.path),
        kind: mediaKindForName(f.path) ?? undefined,
        sizeText: formatBytes(f.sizeBytes),
        pathText: f.path,
      })),
      targetNoun: "file",
      actionLabel: "OCR",
      canApply: () => true,
      progress: {
        kind: "ocr",
        target: detail.name,
        doneLabel: (_sel, count) => `${count} file${count === 1 ? "" : "s"} queued to OCR`,
        invalidate: [["repo", repoId]],
      },
      // BACKGROUND-ENQUEUED (ocr.mdx §9, the locked-closed ai_description.mdx §12.4 defect). Never
      // api.ocrBatch here: that would OCR every file inline inside ONE HTTP request, which stays open for
      // minutes, dies on a blip, and never surfaces per-file rows on the Processing page.
      // Engine-gated like EVERY other OCR producer (ocr.mdx §6: "the viewer button, the ⋮ item, the page
      // action, the popup Apply, and the queue worker all route through the same gate. There is no path
      // that reaches the engine without it."). This tile's Apply was the one path that skipped it, so on a
      // machine with no engine it queued a batch that could only fail, file by file. withOcrReady is a
      // pass-through whenever an engine resolves, so the common case keeps its immediate feel.
      apply: async (_sel, checkedPaths) => {
        await withOcrReady({
          label: `OCR ${checkedPaths.length} file${checkedPaths.length === 1 ? "" : "s"}`,
          run: () => {
            void api
              .ocrEnqueue({ paths: checkedPaths })
              .then((plan) => {
                if (plan.needsSetup) {
                  toast.error("Set up Personal storage first — Settings → Storages");
                }
              })
              .catch((e) => {
                clientLog.error("ocr.enqueue", e);
                toast.error(e instanceof Error ? e.message : "Could not queue OCR");
              });
          },
        });
      },
    },
  };
}

/** Compressible media (video and/or image) — the "N compressible" tile's educate-and-fix popup
 *  (compression.mdx / task_tabs.mdx §6). `kind` narrows to just videos or just images so the videos-tile and
 *  the images-tile each scope to their own files; undefined targets all compressible media (used by the
 *  header primary). Null when nothing matches. Apply queues a background compress pass over the checked files. */
export function buildCompressWarning(
  detail: RepoDetail,
  repoId: string,
  kind?: "video" | "image",
): WarningDef | null {
  const files = detail.files.filter((f) => {
    if (f.compress !== "could") return false;
    if (!kind) return true;
    return mediaKindForName(f.path.slice(f.path.lastIndexOf("/") + 1)) === kind;
  });
  if (files.length === 0) return null;
  const n = files.length;
  const noun = kind ?? "file";
  return {
    id: kind ? `repo-files-compressible-${kind}` : "repo-files-compressible",
    state: "warn",
    scope: "file",
    headline: `${n} ${noun}${n === 1 ? "" : "s"} look${n === 1 ? "s" : ""} uncompressed`,
    sub: "Large File Bridge can compress these to reclaim space — the originals move to LFBridge trash (recoverable).",
    popup: {
      whatThisIs: `Large File Bridge found ${n} ${noun}${n === 1 ? "" : "s"} that look uncompressed and could be made smaller with no meaningful quality loss. Compression runs on this computer; the original moves to the recoverable LFBridge trash.`,
      whyItMatters:
        "Uncompressed media wastes disk and slows every sync over IPFS. Compressing reclaims space while keeping the same resolution. Review the list on the right and uncheck any you want to leave as-is.",
      targets: files.map((f) => ({
        id: absPath(detail, f),
        label: f.path,
        name: basename(f.path),
        sizeText: formatBytes(f.sizeBytes),
        pathText: f.path,
      })),
      targetNoun: noun,
      actionLabel: "Compress",
      canApply: () => true,
      progress: {
        kind: "compress",
        target: detail.name,
        doneLabel: (_sel, count) => `${count} file${count === 1 ? "" : "s"} queued to compress`,
        invalidate: [["repo", repoId]],
      },
      apply: async (_sel, checkedPaths) => {
        await api.compressBatch(checkedPaths);
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
    case "transcribable":
      return buildTranscribeWarning(detail, repoId);
    case "describable":
      return buildDescribeWarning(detail, repoId);
    case "ocrable":
      return buildOcrWarning(detail, repoId);
    case "compressibleVideos":
      return buildCompressWarning(detail, repoId, "video");
    case "compressibleImages":
      return buildCompressWarning(detail, repoId, "image");
    // NOTE `ocred` is deliberately absent → null, like `transcribed` / `described` / `alreadyCompressed`.
    // A DONE metric has nothing to fix, so its tile is inert (ocr.mdx §12.1).
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
  // Then the content-work recommendations (task_tabs.mdx §2.7, ocr.mdx §12.3). The LOCKED worst-first order:
  //
  //   ipfs-down → pull-down → undecided → transcribe → describe → compress → ocr
  //     (bad)      (bad)       (warn)      (warn)       (warn)     (warn)   (warn)
  //
  // OCR RANKS LAST, and the reasoning is worth stating so nobody "promotes" it later: an un-pinned file is a
  // DATA-LOSS risk; an undecided file is an UNMADE DECISION; a missing transcript or description is MISSING
  // CONTENT; an uncompressed video is WASTED DISK. Missing OCR text is a SEARCH CONVENIENCE — the cheapest of
  // the seven to fix and the least costly to lack. It must never outrank a backup problem. On a repo where it
  // is the only outstanding item it is, correctly, the whole recommendation.
  const transcribe = buildTranscribeWarning(detail, repoId);
  if (transcribe) return { metricId: "transcribable", warning: transcribe };
  const describe = buildDescribeWarning(detail, repoId);
  if (describe) return { metricId: "describable", warning: describe };
  const compress = buildCompressWarning(detail, repoId);
  if (compress) return { metricId: "compressibleVideos", warning: compress };
  const ocr = buildOcrWarning(detail, repoId);
  if (ocr) return { metricId: "ocrable", warning: ocr };
  return null;
}
