// The TEXT on a progress card, as pure functions (webapp.mdx §10.2).
//
// A dock card is a ~360px box reporting on names that are routinely longer than that — repo targets like
// "files still waiting from another computer", phase lines like "pulling Scene77_Batch1_Proj_…mp4 · ≈2.5 GB
// of 3.0 GB". Something has to give, and WHICH thing gives is a product decision, not a styling accident:
//
//   • THE COUNT NEVER GIVES. "476 / 687 files" is the answer to "is this moving, and how much is left".
//     Wrapped or clipped, it answers neither, so it renders `shrink-0 whitespace-nowrap` and every pixel of
//     pressure falls on the name beside it.
//   • THE NAME GIVES, AND SAYS SO. It truncates with an ellipsis and carries its full text as a tooltip, so
//     nothing on the card is unreadable — only abbreviated.
//
// These live apart from ProgressDock.tsx so they can be tested without a DOM: this package's vitest runs in
// the node environment and collects `*.spec.ts` only (vitest.config.ts), and importing the component would
// drag in the router and the whole route tree.
import type { ProgressJob } from "@lfb/shared";
import { verb } from "./progress-context.js";

/** The count — "476 / 687 files", "42%", "310 / 734 MB" — or null when the job is indeterminate. */
export function metricText(job: ProgressJob): string | null {
  if (job.total === undefined || job.done === undefined) return null;
  const unit = job.unit ?? "";
  if (unit === "%") return `${Math.round(job.done)}%`;
  if (unit === "MB" || unit === "GB") return `${job.done} / ${job.total} ${unit}`;
  return `${job.done.toLocaleString()} / ${job.total.toLocaleString()} ${unit}`.trim();
}

/**
 * Everything a card shows, with nothing shortened — the hover text for the card as a whole. The phase line
 * goes on its own line because it is a different sentence from the heading, not a continuation of it.
 */
export function cardTooltip(job: ProgressJob): string {
  const head = [`${verb(job.kind)} ${job.target}`.trim(), metricText(job)].filter(Boolean).join(" — ");
  return job.note ? `${head}\n${job.note}` : head;
}
