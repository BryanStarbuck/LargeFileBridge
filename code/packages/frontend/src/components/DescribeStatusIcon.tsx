// The three-state AI-description status icon (ai_description.mdx §11) — the mirror of TranscribeStatusIcon,
// in its own TEAL "done" skin so the two axes read distinctly at a glance. ScanText glyph.
//   • done  — an `.ai_description` sidecar exists → solid teal.
//   • could — image/video with no description yet → orange edge + barely-there orange wash (click queues an
//             AI description for this one file — a background job).
//   • na    — not image/video (audio → transcription) → white fill, very-thin grey edge (inert).
import { ScanText } from "lucide-react";
import type { TaskStatus } from "@lfb/shared";
import { StatusActionIcon } from "./StatusActionIcon.js";

const DESCRIBE_DONE_TEAL = "var(--lfb-describe-done, #0d9488)";

const TITLE: Record<TaskStatus, string> = {
  done: "AI description ready — click to view",
  could: "No AI description yet — click to describe",
  na: "Not describable (not image/video)",
};

export function DescribeStatusIcon({
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
      doneColor={DESCRIBE_DONE_TEAL}
      title={TITLE[state]}
      onActivate={onActivate}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      glyph={<ScanText className="h-[15px] w-[15px]" strokeWidth={2.5} />}
    />
  );
}
