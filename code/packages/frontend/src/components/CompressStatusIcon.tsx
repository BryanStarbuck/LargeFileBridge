// The three-state Compress status icon (task_tabs.mdx §6). Archive glyph, GREEN "done" fill.
//   • done  — already compressed (already-lossy extension / LFBcompressed marker) → solid green.
//   • could — a video/image that looks uncompressed → orange edge + 99%-white/1%-orange fill (click
//             offers compression — an explicit-click confirm then a background job).
//   • na    — not a compressible media kind (audio is never compressible) → white fill, hairline edge.
import { Archive } from "lucide-react";
import type { TaskStatus } from "@lfb/shared";
import { StatusActionIcon } from "./StatusActionIcon.js";

const COMPRESS_DONE_GREEN = "var(--lfb-ok, #16a34a)";

const TITLE: Record<TaskStatus, string> = {
  done: "Already compressed",
  could: "Could be compressed — click to compress",
  na: "Not a compressible media type",
};

export function CompressStatusIcon({
  state,
  title,
  onActivate,
  onMouseEnter,
  onMouseLeave,
}: {
  state: TaskStatus;
  /** Override the tooltip when "na" has a DIFFERENT reason than "not a compressible media type" — a
   *  remote-only row (storage_company.mdx §8.5) is `na` on a `.mp4`, where the default text is actively
   *  wrong: the file IS compressible, its bytes just aren't on this computer yet. */
  title?: string;
  onActivate?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <StatusActionIcon
      state={state}
      doneColor={COMPRESS_DONE_GREEN}
      title={title ?? TITLE[state]}
      onActivate={onActivate}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      glyph={<Archive className="h-[15px] w-[15px]" strokeWidth={2.5} />}
    />
  );
}
