// The dock's A ∪ B merge (webapp.mdx §12), extracted as a pure function so its rules are testable without
// mounting the provider — the same split `linger.ts` uses.
//
// Two sources describe the same work:
//   A. the OPTIMISTIC card this tab added on click — instant, but blind (no counts, no phase);
//   B. the SERVER's registry job — appears one poll later, and is the only one that knows how far the work
//      has got and which step it is on.
//
// THE SUPERSEDE RULE. When an instrumented endpoint is behind the click, both exist, and rendering both is
// not extra information: it is one job listed twice, with the useful copy on the row the user is less
// likely to read (the 2026-08-06 pull-down report). So an optimistic card is HIDDEN while a server job with
// the same kind + target is running. It still covers the window before the server's job registers, and an
// endpoint with no registry job keeps exactly the card it always had.
//
// ORDER IS LOAD-BEARING: this tab's own work leads, because the dock caps its live cards and collapses the
// rest into "+ N more running" — a click made during a mass transcode must not drop into that summary.
import type { ProgressJob } from "@lfb/shared";

const identity = (j: ProgressJob): string => `${j.kind} ${j.target}`;

export function mergeJobs(optimistic: ProgressJob[], server: ProgressJob[]): ProgressJob[] {
  const serverKeys = new Set(server.map(identity));
  const byId = new Map<string, ProgressJob>();
  for (const j of optimistic) {
    if (serverKeys.has(identity(j))) continue; // the server's job for this work says more — let it speak
    byId.set(j.id, j);
  }
  for (const j of server) if (!byId.has(j.id)) byId.set(j.id, j);
  return [...byId.values()];
}
