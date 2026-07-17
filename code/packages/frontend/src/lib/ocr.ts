// OCR launcher (ocr.mdx §6.1) — the third sibling of lib/transcribe.ts and lib/describe.ts. Wraps
// api.ocrFile in a toast.promise so the click is never a no-op and the outcome is honest.
//
// Note what is ABSENT next to describe's launcher: no `onNoProvider`, no credentials popup, no provider
// option. OCR is 100% LOCAL (ocr.mdx §4) — there is no key to be missing. Its one not-ready case worth a
// callback is a VIDEO on a machine without ffmpeg (§6), which is a tool hint, not a credentials flow.
import { toast } from "sonner";
import type { OcrResult } from "@lfb/shared";
import { api } from "@/api/client";
import { clientLog } from "./clientLog.js";
import { requestStorageSetup } from "./setupWizard.js";
import type { WarningKindFilter } from "@/components/ui/warnings/registry";

/**
 * The ONE readiness gate every OCR producer routes through (ocr.mdx §6) — the third sibling of
 * transcribe's `withModelReady` / describe's provider check. The viewer action, the ⋮ item, the page
 * action-link and the popup Apply all call it, so there is no path to the engine that skips it.
 *
 * The deliberate difference from its siblings: OCR gates on almost NOTHING. Both engines are npm
 * dependencies and Vision ships with the OS, so the common case is always ready — and §6 locks that
 * "a ready check that is always true must not cost a dialog". This is therefore a PASS-THROUGH whenever
 * an engine resolves; it only speaks up for the one case that is genuinely dead (`no_engine`), where
 * running would queue work that can only fail. The video/ffmpeg asymmetry (§6) is NOT gated here: an
 * ffmpeg-less machine OCRs every image fine, so the per-file run reports `needs_ffmpeg` honestly rather
 * than blocking a batch that is mostly images.
 */
export async function withOcrReady(opts: { label: string; run: () => void }): Promise<void> {
  let status;
  try {
    status = await api.ocrEngines();
  } catch (e) {
    // Probe unknown → run anyway and let the per-file outcome be the honest answer; a probe that failed
    // is not evidence the engine is missing, and blocking on it would be worse than the real run's toast.
    clientLog.error("ocr.engines", e);
    opts.run();
    return;
  }
  if (status.anyAvailable) {
    opts.run();
    return;
  }
  // The one not-ready case (§6.1): no engine at all. Honest, and still no dialog — there is nothing for
  // the user to consent to or download here, only something to be told.
  toast.error(`Can't ${opts.label} — no OCR engine is available on this computer.`);
}

/**
 * The OCR popup's "Filter:" row (ocr.mdx §9.1 / warnings.mdx §4.5.4). More load-bearing here than for
 * describe: the two kinds differ in cost by TWO ORDERS OF MAGNITUDE — an image is ~250ms, a 40-minute video
 * is a frame-extraction pass plus ~160 recognitions. A user who wants "just the screenshots, now" must not be
 * forced to also commit to every video in the tree. Both open CHECKED, so the default is unchanged.
 * The ids MUST match `mediaKindForName()`'s values — that is what tags each target's `kind`.
 */
export const OCR_KIND_FILTERS: WarningKindFilter[] = [
  { id: "video", label: "Videos" },
  { id: "image", label: "Images" },
  { id: "pdf", label: "PDFs" },
];

/** One-file outcome → a human line (ocr.mdx §18's status set). */
function msgOne(r: OcrResult): string {
  switch (r.status) {
    case "ocred":
      // 0 chars is a REAL, SUCCESSFUL answer — most images have no text (ocr.mdx §2.3). Saying "no text
      // found" rather than a failure is the whole point: the file is done and must not be re-offered.
      return r.chars === 0
        ? "No text found in this file"
        : `Found ${r.chars?.toLocaleString()} characters of text${r.engine ? ` — ${r.engine}` : ""}`;
    case "skipped":
      return "Already has OCR text";
    case "no_engine":
      return r.reason ?? "No OCR engine is available on this computer";
    case "needs_ffmpeg":
      return r.reason ?? "Reading text from a video needs ffmpeg — `brew install ffmpeg`";
    case "unsupported":
      return r.reason ?? "Only images and videos have text to read";
    case "needs_setup":
      return "Set up Personal storage first — Settings → Storages";
    default:
      return `OCR failed: ${r.reason ?? "error"}`;
  }
}

/** Run (or re-run) OCR on ONE media file. The control should flip to a disabled "OCR'ing…" state on click —
 *  the toast is the outcome, not the acknowledgement (Transcribe.mdx §2.1's never-a-no-op rule). */
export function runOcrFile(
  path: string,
  name: string,
  opts?: {
    overwrite?: boolean;
    engine?: "auto" | "vision" | "tesseract";
    onDone?: () => void;
    onNeedsEngine?: (reason: string) => void;
    /** Fires on EVERY terminal outcome — success, engine-missing, or throw. A caller holding a local
     *  "OCR'ing…" pending flag must clear it here and NOT in `onDone`: a failed run never reaches onDone, and
     *  the control would stay disabled forever. */
    onSettled?: () => void;
  },
): void {
  const p = api.ocrFile(path, { overwrite: opts?.overwrite, engine: opts?.engine });
  // Settle the caller's pending state off the REAL promise, so it clears exactly when the work ends —
  // whichever way it ends. (`void` because the outcome is the toast's job, not this handler's.)
  void p.then(
    () => opts?.onSettled?.(),
    () => opts?.onSettled?.(),
  );
  toast.promise(p, {
    loading: `Reading text from ${name}…`,
    success: (r) => {
      if (r.status === "needs_setup") {
        requestStorageSetup({
          mediaPath: path,
          actionLabel: "read the text from",
          retry: () => runOcrFile(path, name, opts),
        });
      } else if (r.status === "no_engine" || r.status === "needs_ffmpeg") {
        opts?.onNeedsEngine?.(r.reason ?? "OCR is not available for this file");
      } else {
        opts?.onDone?.();
      }
      return msgOne(r);
    },
    error: (e) => {
      clientLog.error("ocr.file", e);
      return e instanceof Error ? e.message : "OCR failed";
    },
  });
}
