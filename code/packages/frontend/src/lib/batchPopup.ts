// The UNIFIED batch-confirm popup launchers (dialogs.mdx §5–§6). The "great pop-up" the Transcribable /
// Describable metric tile opens on the View-one-repo page is now the SINGLE surface every producing entry
// point opens — the page action-links row (Create Transcriptions / Create AI descriptions) and the
// directory/file ⋮ kebab / right-click menu item. Those surfaces are NOT inside MetricsStrip (which mounts
// its own WarningPopup for the tiles), so they need a GLOBAL popup host: requestBatchPopup(def) opens the
// app-root-mounted BatchPopupHost. openTranscribeBatch / openDescribeBatch fetch the /plan preview for the
// scope and build the same transcribe/describe WarningDef the tiles use, then open it.
import { toast } from "sonner";
import type { PreviewPlan } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "../api/client.js";
import { clientLog } from "./clientLog.js";
import { requestStorageSetup } from "./setupWizard.js";
import { withModelReady } from "./transcribe.js";
import type { WarningDef } from "../components/ui/warnings/registry.js";

// The page's set for an action (page_actions.mdx §1.1): a non-empty `paths` = the CHECKED subset; otherwise
// `root` is walked recursively. Callers pass one or the other. (Same shape as lib/pageActions ActionScope.)
export interface BatchScope {
  root?: string;
  paths?: string[];
}

// ── The global popup bus (dialogs.mdx §5.3) ─────────────────────────────────────────────────────────
type Listener = (def: WarningDef) => void;
let listener: Listener | null = null;

/** BatchPopupHost registers here; returns an unsubscribe for its effect cleanup. */
export function onBatchPopupRequested(cb: Listener): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

/** Open the app-root batch popup with a built WarningDef. No-op if the host isn't mounted (shouldn't happen). */
export function requestBatchPopup(def: WarningDef): void {
  listener?.(def);
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** Middle-truncate a long absolute path for the target's ROW-2 path line so the popup rows stay readable. */
function labelForPath(p: string): string {
  if (p.length <= 60) return p;
  return `${p.slice(0, 28)}…${p.slice(-30)}`;
}

/** The file's basename (§4.5 ROW 1); the popup row strips the extension for display. */
function basename(p: string): string {
  return p.split("/").pop() || p;
}

// ── Transcribe ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Open the unified batch popup for TRANSCRIPTIONS over a scope (a directory/repo `root`, or a checked
 * `paths` set). Fetches the /plan preview (Rules 1+2, nothing queued), lists the candidates checked by
 * default, and on the solid-blue "Transcribe N files" Confirm runs the model gate + background-enqueues the
 * checked paths (the SAME apply the metric tile uses). An empty preview opens the all-clear popup.
 */
export async function openTranscribeBatch(scope: BatchScope): Promise<void> {
  let plan: PreviewPlan;
  try {
    plan = await api.transcribePlan(scope);
  } catch (e) {
    clientLog.error("batchPopup.transcribePlan", e);
    toast.error(e instanceof Error ? e.message : "Could not scan for transcribable files");
    return;
  }
  const n = plan.files.length;
  const def: WarningDef = {
    id: "batch-transcribe",
    state: "warn",
    scope: "file",
    headline:
      n === 0
        ? "Nothing to transcribe here"
        : `${n} file${n === 1 ? " is" : "s are"} ready to transcribe`,
    sub:
      n === 0
        ? `All ${plan.considered} audio/video file${plural(plan.considered)} here already have a transcript.`
        : "Large File Bridge can generate a text transcript for each locally — nothing runs until you apply.",
    popup: {
      whatThisIs:
        n === 0
          ? "Every audio/video file in this scope already has a transcript, so there is nothing to do here."
          : `Large File Bridge found ${n} audio/video file${n === 1 ? "" : "s"} with no transcript yet. It can transcribe ${n === 1 ? "it" : "them"} on this computer with a local, offline engine — no file ever leaves your machine.`,
      whyItMatters:
        "A transcript makes a recording searchable, quotable, and readable without scrubbing the timeline. It runs in the background and is saved per your transcription placement setting. Review the list on the right and uncheck any you want to skip.",
      targets: plan.files.map((f) => ({
        id: f.path,
        label: labelForPath(f.path),
        name: basename(f.path),
        sizeText: formatBytes(f.sizeBytes),
        pathText: labelForPath(f.path),
      })),
      targetNoun: "file",
      actionLabel: "Transcribe",
      canApply: () => n > 0,
      // Background hand-off (dialogs.mdx §5.1) — the popup closes at once and the dock tracks it; the
      // completion toast is the LOCKED page_actions.mdx §2 wording. Mirrors buildTranscribeWarning.
      progress: {
        kind: "transcribe",
        target: "your files",
        doneLabel: (_sel, count) =>
          count === 1 ? "1 file will have its Transcription created" : `${count} files will have their Transcriptions created`,
        invalidate: [["repos"], ["fs"]],
      },
      // Model-gated on Apply, then BACKGROUND-ENQUEUED (transcribe_engine.mdx §3.6). withModelReady resolves
      // as soon as it decides (it interposes the one-time consent popup first-time, else runs now); the
      // enqueue is fire-and-forget so this never blocks on the multi-GB model download.
      apply: async (_sel, checkedPaths) => {
        await withModelReady({
          label: `transcribe ${checkedPaths.length} file${checkedPaths.length === 1 ? "" : "s"}`,
          run: () => {
            void api
              .transcribeEnqueue({ paths: checkedPaths })
              .then((enq) => {
                if (enq.needsSetup) {
                  requestStorageSetup({
                    mediaPath: enq.setupPath ?? checkedPaths[0] ?? "",
                    actionLabel: "transcribe",
                    retry: () => void openTranscribeBatch({ paths: checkedPaths }),
                  });
                }
              })
              .catch((e) => {
                clientLog.error("batchPopup.transcribeEnqueue", e);
                toast.error(e instanceof Error ? e.message : "Could not queue transcription");
              });
          },
        });
      },
    },
  };
  requestBatchPopup(def);
}

// ── Describe ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Open the unified batch popup for AI DESCRIPTIONS over a scope — the mirror of openTranscribeBatch. The
 * provider/model gate is enforced by the enqueue path itself; a missing key surfaces its own toast/dialog.
 */
export async function openDescribeBatch(scope: BatchScope): Promise<void> {
  let plan: PreviewPlan;
  try {
    plan = await api.describePlan(scope);
  } catch (e) {
    clientLog.error("batchPopup.describePlan", e);
    toast.error(e instanceof Error ? e.message : "Could not scan for describable files");
    return;
  }
  const n = plan.files.length;
  const def: WarningDef = {
    id: "batch-describe",
    state: "warn",
    scope: "file",
    headline:
      n === 0
        ? "Nothing to describe here"
        : `${n} file${n === 1 ? " is" : "s are"} ready for an AI description`,
    sub:
      n === 0
        ? `All ${plan.considered} image/video file${plural(plan.considered)} here already have an AI description.`
        : "Large File Bridge can generate an AI description for each image/video — nothing runs until you apply.",
    popup: {
      whatThisIs:
        n === 0
          ? "Every image/video file in this scope already has an AI description, so there is nothing to do here."
          : `Large File Bridge found ${n} image/video file${n === 1 ? "" : "s"} with no AI description yet. It can generate one for each with your configured AI provider.`,
      whyItMatters:
        "An AI description makes an image or video searchable and captioned without opening it. Each file is sent to your configured AI provider; add a key in Settings → AI credentials first. Review the list on the right and uncheck any you want to skip.",
      targets: plan.files.map((f) => ({
        id: f.path,
        label: labelForPath(f.path),
        name: basename(f.path),
        sizeText: formatBytes(f.sizeBytes),
        pathText: labelForPath(f.path),
      })),
      targetNoun: "file",
      actionLabel: "Describe",
      canApply: () => n > 0,
      // Background hand-off (dialogs.mdx §5.1) — popup closes, dock tracks it; completion toast = the LOCKED
      // page_actions.mdx §2 wording. The provider/model gate is enforced server-side by the enqueue path.
      progress: {
        kind: "describe",
        target: "your files",
        doneLabel: (_sel, count) =>
          count === 1 ? "1 file will have its AI description created" : `${count} files will have their AI descriptions created`,
        invalidate: [["repos"], ["fs"]],
      },
      apply: async (_sel, checkedPaths) => {
        // Mirror openTranscribeBatch's enqueue guard: a rejected enqueue must surface a clear message
        // (not the popup host's generic error), and a needsSetup response routes into the storage wizard.
        try {
          const enq = await api.describeEnqueue({ paths: checkedPaths });
          if (enq.needsSetup) {
            requestStorageSetup({
              mediaPath: enq.setupPath ?? checkedPaths[0] ?? "",
              actionLabel: "generate AI descriptions for",
              retry: () => void openDescribeBatch({ paths: checkedPaths }),
            });
          }
        } catch (e) {
          clientLog.error("batchPopup.describeEnqueue", e);
          toast.error(e instanceof Error ? e.message : "Could not queue AI descriptions");
        }
      },
    },
  };
  requestBatchPopup(def);
}
