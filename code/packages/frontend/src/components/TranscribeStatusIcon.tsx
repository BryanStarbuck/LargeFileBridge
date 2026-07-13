// The three-state Transcribe status icon (task_tabs.mdx §5). Captions glyph, BLUE "done" fill.
//   • done  — a `.transcription` sidecar exists → solid blue.
//   • could — audio/video with no transcript yet → orange edge + 99%-white/1%-orange fill (click queues
//             a transcription for this one file — a background job).
//   • na    — not audio/video → white fill, very-thin very-light-grey edge (inert).
import { Captions } from "lucide-react";
import type { TaskStatus } from "@lfb/shared";
import { StatusActionIcon } from "./StatusActionIcon.js";

const TRANSCRIBE_DONE_BLUE = "var(--lfb-pin, #1d4ed8)";

const TITLE: Record<TaskStatus, string> = {
  done: "Transcript ready — click to view",
  could: "No transcript yet — click to transcribe",
  na: "Not transcribable (not audio/video)",
};

export function TranscribeStatusIcon({
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
      doneColor={TRANSCRIBE_DONE_BLUE}
      title={TITLE[state]}
      onActivate={onActivate}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      glyph={<Captions className="h-2.5 w-2.5" strokeWidth={2.5} />}
    />
  );
}
