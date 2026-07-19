// The three-state OCR status icon (ocr.mdx §11.2) — the FOURTH skin of the one shared StatusActionIcon,
// in its own VIOLET "done" skin. TextSelect glyph.
//   • done  — a `.ocr` artifact exists → solid violet. This INCLUDES an artifact whose text is empty: most
//             images have no text, and that is a RESULT, not a candidate to re-offer forever (ocr.mdx §2.3).
//             A tree of text-free holiday photos settles at 100% done and stays there.
//   • could — image/video with no artifact yet → orange edge + barely-there wash (click OCRs this one file).
//   • na    — not image/video (audio has no pixels) → white fill, very-thin grey edge (inert).
//
// The glyph is deliberately NOT ScanText — that is DESCRIBE's, and describe/OCR are already the easiest pair
// to confuse (same input kinds, adjacent menu items). TextSelect — a text cursor over glyphs — reads as
// "select the text out of this", which is exactly the feature.
import { TextSelect } from "lucide-react";
import type { TaskStatus } from "@lfb/shared";
import { StatusActionIcon } from "./StatusActionIcon.js";

const OCR_DONE_VIOLET = "var(--lfb-ocr-done, #7c3aed)";

const TITLE: Record<TaskStatus, string> = {
  done: "OCR text ready — click to view",
  could: "No OCR text yet — click to read the text",
  na: "No text to read (not image/video)",
};

export function OcrStatusIcon({
  state,
  onActivate,
  onMouseEnter,
  onMouseLeave,
}: {
  state: TaskStatus;
  onActivate?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <StatusActionIcon
      state={state}
      doneColor={OCR_DONE_VIOLET}
      title={TITLE[state]}
      onActivate={onActivate}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      glyph={<TextSelect className="h-[15px] w-[15px]" strokeWidth={2.5} />}
    />
  );
}
