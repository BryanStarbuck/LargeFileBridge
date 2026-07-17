// The UNIFIED batch-confirm popup launchers (dialogs.mdx §5–§6). The "great pop-up" the Transcribable /
// Describable metric tile opens on the View-one-repo page is now the SINGLE surface every producing entry
// point opens — the page action-links row (Create Transcriptions / Create AI descriptions) and the
// directory/file ⋮ kebab / right-click menu item. Those surfaces are NOT inside MetricsStrip (which mounts
// its own WarningPopup for the tiles), so they need a GLOBAL popup host: requestBatchPopup(def) opens the
// app-root-mounted BatchPopupHost. openTranscribeBatch / openDescribeBatch / openOcrBatch fetch the /plan
// preview for the scope and build the same transcribe/describe/ocr WarningDef the tiles use, then open it.
import { toast } from "sonner";
import type { PreviewPlan } from "@lfb/shared";
import { formatBytes, mediaKindForName, fileTypeForName } from "@lfb/shared";
import { api } from "../api/client.js";
import { clientLog } from "./clientLog.js";
import { DESCRIBE_KIND_FILTERS } from "./describe.js";
import { OCR_KIND_FILTERS, withOcrReady } from "./ocr.js";
import { requestStorageSetup } from "./setupWizard.js";
import { withModelReady } from "./transcribe.js";
import type { WarningDef } from "../components/ui/warnings/registry.js";

// The page's set for an action (page_actions.mdx §1.1): a non-empty `paths` = the CHECKED subset; otherwise
// `root` is walked recursively. Callers pass one or the other. (Same shape as lib/pageActions ActionScope.)
export interface BatchScope {
  root?: string;
  paths?: string[];
}

// ── The global popup bus (dialogs.mdx §5.3 + §5.4) ──────────────────────────────────────────────────
// The bus carries THREE states so the ONE app-root host can show a spinner while a slow plan walk runs and
// then swap to the real popup (dialogs.mdx §5.4 — the "Opening window…" spinner):
//   • { kind: "loading" } — an animated-spinner "Opening window…" modal shown SYNCHRONOUSLY, before the
//     /plan request is even awaited, so a multi-minute tree walk (~2 min for ~2k files) never looks hung.
//   • { kind: "popup" }   — the real batch WarningPopup once the plan resolves.
//   • null                — nothing on screen (closed / cancelled / errored).
export type BatchPopupState =
  | { kind: "loading"; headline: string; sub?: string; onCancel: () => void }
  | { kind: "popup"; def: WarningDef }
  | null;
type Listener = (state: BatchPopupState) => void;
let listener: Listener | null = null;
// The state a launcher asked for while NO host was listening. The bus is a single module-level listener, so
// any window where the host is not registered — the app tree remounting across an auth blip / a "Reconnecting"
// swap, a dev-server module-graph replacement that leaves the click handler holding a different instance of
// this module than the host registered on — turned every producing click into a SILENT no-op: the /plan
// request still went out and the backend still logged it, but no spinner and no popup ever appeared, and
// nothing was written to the fault trail to say why. That is the exact shape of the "Create OCR text does
// nothing" report. Holding the state instead means the click is never lost: the popup opens as soon as a host
// registers, and `emit` records the gap so the trail says it happened.
let pending: BatchPopupState | undefined;
// A monotonically-increasing generation token. Every scope-walking open takes the NEXT gen; if the user
// cancels the spinner (or a newer open starts) the gen advances, so a stale in-flight plan result that
// arrives afterwards is a NO-OP and never pops a window the user already dismissed (dialogs.mdx §5.4).
let openGen = 0;

/** BatchPopupHost registers here; returns an unsubscribe for its effect cleanup. */
export function onBatchPopupRequested(cb: Listener): () => void {
  listener = cb;
  // Deliver whatever was requested while nothing was listening (see `pending`), so a click that landed in
  // that window still opens its window rather than vanishing.
  if (pending !== undefined) {
    const state = pending;
    pending = undefined;
    cb(state);
  }
  return () => {
    // Guard on identity: when the app tree remounts, React registers the NEW host before tearing the old one
    // down, so an unguarded cleanup would null out the live listener and re-open this whole bug.
    if (listener === cb) listener = null;
  };
}

/** The ONE way this module talks to the host — never `listener?.(…)`, which silently drops when null. */
function emit(state: BatchPopupState): void {
  if (listener) {
    listener(state);
    return;
  }
  // `state === null` (a close/cancel) intentionally BUFFERS as null too: it clears any popup held above
  // rather than resurrecting one the user already dismissed.
  pending = state;
  if (state) {
    clientLog.error(
      "batchPopup.noHost",
      new Error(`batch popup requested with no host mounted (${state.kind}) — buffered until one registers`),
    );
  }
}

/** Show the "Opening window…" spinner and claim a fresh generation token for this open (dialogs.mdx §5.4). */
function beginBatchOpen(headline: string, sub: string): number {
  const gen = ++openGen;
  emit({
    kind: "loading",
    headline,
    sub,
    // Cancel/Esc/backdrop: advance the gen so the pending plan result becomes a no-op, and clear the host.
    onCancel: () => {
      openGen++;
      emit(null);
    },
  });
  return gen;
}

/** True once a newer open started or the user cancelled — the caller must then abandon its result. */
function isStale(gen: number): boolean {
  return gen !== openGen;
}

/** Open the app-root batch popup with a built WarningDef. Ignored if this open was superseded/cancelled
 *  (stale gen). Passing no gen (e.g. a caller that didn't walk a tree) always opens. */
export function requestBatchPopup(def: WarningDef, gen?: number): void {
  if (gen != null && isStale(gen)) return;
  emit({ kind: "popup", def });
}

/** Close whatever the batch host is showing (spinner or popup). Ignored if superseded (stale gen). */
export function closeBatchPopup(gen?: number): void {
  if (gen != null && isStale(gen)) return;
  openGen++;
  emit(null);
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

/**
 * The "already have one — excluded" clause for the popup's sub line (dialogs.mdx §5.2). The /plan preview
 * ALREADY drops files that carry a finished artifact, but the popup used to show only the remainder — so a
 * user who had run the action before could not tell an excluded file from one that was never done, and a
 * large candidate count read as "it is redoing everything". Stating the excluded count makes the skip
 * VISIBLE and the list verifiable. Empty string when nothing was excluded.
 */
function excludedClause(alreadyDone: number, noun: string): string {
  if (alreadyDone <= 0) return "";
  return ` ${alreadyDone} file${plural(alreadyDone)} already ${alreadyDone === 1 ? "has" : "have"} ${noun} and ${alreadyDone === 1 ? "is" : "are"} excluded from this list.`;
}

/** The one-line sub under "Opening window…" (dialogs.mdx §5.4). A recursive `root` walk is the slow case
 *  (it traverses the whole subtree), so it says so; a checked `paths` set is already resolved, so it's brief. */
function openingSub(scope: BatchScope, noun: string): string {
  return scope.root
    ? `Scanning this folder for ${noun} — large folders can take a moment.`
    : `Preparing ${noun}…`;
}

// ── Transcribe ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Open the unified batch popup for TRANSCRIPTIONS over a scope (a directory/repo `root`, or a checked
 * `paths` set). Fetches the /plan preview (Rules 1+2, nothing queued), lists the candidates checked by
 * default, and on the solid-blue "Transcribe N files" Confirm runs the model gate + background-enqueues the
 * checked paths (the SAME apply the metric tile uses). An empty preview opens the all-clear popup.
 */
export async function openTranscribeBatch(scope: BatchScope): Promise<void> {
  // dialogs.mdx §5.4 — show the "Opening window…" spinner SYNCHRONOUSLY before awaiting the (possibly
  // multi-minute) tree walk, so the app never looks hung; the gen guards a cancel/supersede.
  const gen = beginBatchOpen("Opening window…", openingSub(scope, "audio & video files"));
  let plan: PreviewPlan;
  try {
    plan = await api.transcribePlan(scope);
  } catch (e) {
    clientLog.error("batchPopup.transcribePlan", e);
    closeBatchPopup(gen);
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
        : `Large File Bridge can generate a text transcript for each locally — nothing runs until you apply.${excludedClause(plan.alreadyDone, "a transcript")}`,
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
  requestBatchPopup(def, gen);
}

// ── Describe ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Open the unified batch popup for AI DESCRIPTIONS over a scope — the mirror of openTranscribeBatch. The
 * provider/model gate is enforced by the enqueue path itself; a missing key surfaces its own toast/dialog.
 */
export async function openDescribeBatch(scope: BatchScope): Promise<void> {
  // dialogs.mdx §5.4 — spinner first, then the walk (mirror of openTranscribeBatch).
  const gen = beginBatchOpen("Opening window…", openingSub(scope, "images & videos"));
  let plan: PreviewPlan;
  try {
    plan = await api.describePlan(scope);
  } catch (e) {
    clientLog.error("batchPopup.describePlan", e);
    closeBatchPopup(gen);
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
        : `Large File Bridge can generate an AI description for each image/video — nothing runs until you apply.${excludedClause(plan.alreadyDone, "an AI description")}`,
    popup: {
      whatThisIs:
        n === 0
          ? "Every image/video file in this scope already has an AI description, so there is nothing to do here."
          : `Large File Bridge found ${n} image/video file${n === 1 ? "" : "s"} with no AI description yet. It can generate one for each with your configured AI provider.`,
      whyItMatters:
        "An AI description makes an image or video searchable and captioned without opening it. Each file is sent to your configured AI provider; add a key in Settings → AI credentials first. Use the Videos / Images filter to narrow the list, and uncheck any you want to skip.",
      // ai_description.mdx §12.4.1 — the Videos/Images filter row. Each row is tagged with its media kind
      // so unchecking a kind hides it AND drops it from the batch (the visible list IS the applied set).
      kindFilters: DESCRIBE_KIND_FILTERS,
      targets: plan.files.map((f) => ({
        id: f.path,
        label: labelForPath(f.path),
        name: basename(f.path),
        kind: mediaKindForName(f.path) ?? undefined,
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
  requestBatchPopup(def, gen);
}

/**
 * Open the unified batch popup for OCR over a scope (ocr.mdx §9) — the THIRD launcher. OCR gets no popup of
 * its own; it fills in this one.
 *
 * Unlike describe there is no provider/account to gate on (ocr.mdx §4), so Apply has no credentials branch —
 * it routes through `withOcrReady` like every other OCR entry point (§6's no-bypass rule), which is a
 * pass-through whenever an engine resolves. "A video without ffmpeg" stays UNGATED on purpose: the per-file
 * jobs report it honestly as Failed rows rather than blocking a batch whose images would all have succeeded.
 */
export async function openOcrBatch(scope: BatchScope): Promise<void> {
  // dialogs.mdx §5.4 — spinner FIRST, synchronously, then the walk. A recursive OCR scope can be thousands of
  // files, and the plan additionally ffprobes video rows for their frame counts.
  const gen = beginBatchOpen("Opening window…", openingSub(scope, "images, videos & PDFs"));
  let plan: PreviewPlan;
  try {
    plan = await api.ocrPlan(scope);
  } catch (e) {
    clientLog.error("batchPopup.ocrPlan", e);
    closeBatchPopup(gen);
    toast.error(e instanceof Error ? e.message : "Could not scan for files to OCR");
    return;
  }
  const n = plan.files.length;
  const videos = plan.files.filter((f) => ocrKindOf(f.path) === "video").length;
  const pdfs = plan.files.filter((f) => ocrKindOf(f.path) === "pdf").length;
  const images = n - videos - pdfs;
  const def: WarningDef = {
    id: "batch-ocr",
    state: "warn",
    scope: "file",
    headline: n === 0 ? "Nothing to read text from here" : `${n} file${n === 1 ? " is" : "s are"} ready to have their text read`,
    sub:
      n === 0
        ? `All ${plan.considered} image, video, and PDF file${plural(plan.considered)} here already have OCR text.`
        : `Large File Bridge can read the text out of each image, video, and PDF locally — nothing runs until you apply.${excludedClause(plan.alreadyDone, "OCR text")}`,
    popup: {
      whatThisIs:
        n === 0
          ? "Every image, video, and PDF file in this scope already has OCR text, so there is nothing to do here."
          : // The per-kind COST asymmetry, stated honestly up front (ocr.mdx §9.1). This is the sentence that
            // lets a user decide to take the images and PDFs now and leave the videos for later.
            `Large File Bridge found ${countsClause(images, videos, pdfs)} with no OCR text yet. It reads the words that are visible on screen — a screenshot's error message, a slide's figures, a contract's clauses — so you can search for them later.`,
      whyItMatters:
        "OCR text makes the words inside your images, videos, and PDFs searchable without opening them. It runs entirely on this computer — nothing is uploaded. Images and PDF pages finish in seconds; each video is sampled every 15 seconds, so it takes about a minute per hour of footage. Use the Videos / Images / PDFs filter to narrow the list, and uncheck any you want to skip.",
      // ocr.mdx §9.1 — the Videos/Images filter row, load-bearing here because of the cost gap above.
      kindFilters: OCR_KIND_FILTERS,
      targets: plan.files.map((f) => {
        const kind = ocrKindOf(f.path);
        // The frame count the plan resolved for a video row (ocr.mdx §9.2) — the one field OCR's plan has
        // that its siblings' don't. It is WHY one row is expensive, shown before the user commits to it.
        const frames = f.frames;
        return {
          id: f.path,
          label: labelForPath(f.path),
          name: basename(f.path),
          kind,
          // The frame count rides ROW 1's right-hand slot, beside the size. It CANNOT go in `sublabel`:
          // that is a LEGACY fallback the row only reads when `pathText` is absent (registry.ts's
          // `rowPath()` = `pathText ?? sublabel`), and this row always sets `pathText` — so the hint
          // rendered nowhere at all. §9.2's whole point is that the user sees WHY a row is expensive
          // BEFORE committing to it, and a hint that never paints does not say anything.
          sizeText:
            kind === "video" && frames
              ? `${formatBytes(f.sizeBytes)} · ${frames} frame${frames === 1 ? "" : "s"}`
              : formatBytes(f.sizeBytes),
          pathText: labelForPath(f.path),
        };
      }),
      targetNoun: "file",
      actionLabel: "OCR",
      canApply: () => n > 0,
      progress: {
        kind: "ocr",
        target: "your files",
        doneLabel: (_sel, count) =>
          count === 1 ? "1 file will have its OCR text created" : `${count} files will have their OCR text created`,
        invalidate: [["repos"], ["fs"]],
      },
      // Engine-gated on Apply, then BACKGROUND-ENQUEUED — the mirror of openTranscribeBatch's model gate
      // (ocr.mdx §6: every entry point gates identically, no bypass). withOcrReady resolves instantly in the
      // common case, so Apply keeps its immediate feel.
      apply: async (_sel, checkedPaths) => {
        await withOcrReady({
          label: `OCR ${checkedPaths.length} file${checkedPaths.length === 1 ? "" : "s"}`,
          run: () => {
            void api
              .ocrEnqueue({ paths: checkedPaths })
              .then((enq) => {
                if (enq.needsSetup) {
                  requestStorageSetup({
                    mediaPath: enq.setupPath ?? checkedPaths[0] ?? "",
                    actionLabel: "read the text from",
                    retry: () => void openOcrBatch({ paths: checkedPaths }),
                  });
                }
              })
              .catch((e) => {
                clientLog.error("batchPopup.ocrEnqueue", e);
                toast.error(e instanceof Error ? e.message : "Could not queue OCR");
              });
          },
        });
      },
    },
  };
  requestBatchPopup(def, gen);
}

/** The OCR kind an OCR target is tagged with (ocr.mdx §9.1) — image | video | pdf, or undefined for anything
 *  the OCR plan would not have queued. Unlike `mediaKindForName` (which returns null for a PDF), this uses the
 *  File-type classifier so a `.pdf` is tagged `pdf` and its filter chip works. */
function ocrKindOf(p: string): "image" | "video" | "pdf" | undefined {
  const t = fileTypeForName(p);
  return t === "image" || t === "video" || t === "pdf" ? t : undefined;
}

/** "1,204 images, 86 videos, and 12 PDFs" / "86 videos" / "1 image" — the honest per-kind count for the OCR
 *  popup's cost sentence (ocr.mdx §9.1). Omits a kind entirely at zero rather than saying "0 videos". */
function countsClause(images: number, videos: number, pdfs: number): string {
  const parts: string[] = [];
  if (images > 0) parts.push(`${images.toLocaleString()} image${images === 1 ? "" : "s"}`);
  if (videos > 0) parts.push(`${videos.toLocaleString()} video${videos === 1 ? "" : "s"}`);
  if (pdfs > 0) parts.push(`${pdfs.toLocaleString()} PDF${pdfs === 1 ? "" : "s"}`);
  if (parts.length === 0) return "0 files";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}
