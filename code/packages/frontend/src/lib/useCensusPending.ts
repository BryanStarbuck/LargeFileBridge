// "THIS NUMBER IS NOT FINAL YET" — the one signal every count on screen needs (performance.mdx P-38).
//
// THE FAILURE THIS REMOVES. A user opens a repo and reads `Pull down 0` in a calm green all-clear tile.
// Some minutes later the same tile says 6. Nothing was broken: `Pull down` counts files a PEER computer
// has and this one does not, and that answer only exists after the git backbone has pulled and the
// mirrored manifests have been folded in — work the pin pass does in its own time. But the tile did not
// say "still counting". It said ZERO, in the colour reserved for "there is nothing to do", and a user who
// believes it walks away from six files that were never backed up here.
//
// A count is provisional whenever either is true:
//
//   1. The page's own fetch has not finished — the streamed repo detail carries `partial: true` until the
//      walk completes (performance.mdx P-37). The caller passes this in; it is per-page.
//   2. A BACKGROUND pass that recomputes the census is running — a scan (which rebuilds the candidate
//      list), or a pin pass (which pulls the backbone, folds in peer manifests, and reconciles the
//      pinset). Either one can move any number on a repo screen.
//
// DELIBERATELY OVER-INCLUSIVE. We do not try to work out WHICH repo a running pass will touch: a scan is
// computer-wide, a pin pass can be either, and the job record carries a display target, not an id. Saying
// "still counting" about a number that turns out to be final costs the user a moment's patience. Saying
// "all clear" about a number that is still climbing costs them a file. The bias belongs on the safe side,
// and matching job targets against repo names by string would be a drift waiting to happen.
//
// NO NEW REQUESTS. This reads the job set the progress dock is already polling (ProgressContext) and the
// scan job the global scan bar already owns (["scanStatus"], fed by the event stream). Both are shared
// react-query caches; mounting another observer costs nothing and adds no interval — the locked
// "no background polling" rule (performance.mdx Aspect 6b) stays intact.
import { useQuery } from "@tanstack/react-query";
import type { ProgressKind, ScanJob } from "@lfb/shared";
import { api } from "../api/client.js";
import { useProgress, verb } from "../progress/progress-context.js";

// The kinds whose passes rewrite what a repo screen counts. `scan` rebuilds the candidate census;
// `pin` pulls the backbone, folds in the peers' manifests and reconciles the pinset — between them they
// own every metric tile. The compute kinds (compress/transcribe/describe/ocr) change a file's ANALYSIS
// state, which the To Do tiles read, so they belong here too. `import` lands new units outright.
const CENSUS_KINDS: ReadonlySet<ProgressKind> = new Set<ProgressKind>([
  "scan",
  "pin",
  "import",
  "compress",
  "transcribe",
  "describe",
  "ocr",
  "mixed",
]);

export interface CensusPending {
  /** A background pass that can move the numbers on this screen is running right now. */
  active: boolean;
  /** One short phrase naming it, for a tooltip — "Scanning all", "Pinning every repo…". Null when idle. */
  label: string | null;
}

/**
 * The DECISION, separated from where the inputs come from so it can be pinned without mounting the app
 * shell (useCensusPending.spec.ts). Ordered most-specific first: a named running pass beats a bare "a scan
 * is running" beats "work is queued", because the more specific label is the more useful sentence.
 */
export function censusPendingFrom(input: {
  jobs: ReadonlyArray<{ kind: ProgressKind; target: string }>;
  queued: number;
  scanRunning: boolean;
}): CensusPending {
  const censusJob = input.jobs.find((j) => CENSUS_KINDS.has(j.kind));
  if (censusJob) return { active: true, label: `${verb(censusJob.kind)} ${censusJob.target}` };
  // A scan that is running but has not registered a dock job yet (the discovery phase runs before the
  // per-unit jobs exist) still means every candidate count is mid-rebuild.
  if (input.scanRunning) return { active: true, label: "Scanning this computer" };
  // Work that is queued but not yet started counts too: the numbers are about to move, and a tile that
  // goes green in the gap before the first job starts is the same lie a beat earlier.
  if (input.queued > 0) {
    return { active: true, label: `${input.queued} job${input.queued === 1 ? "" : "s"} waiting to start` };
  }
  return { active: false, label: null };
}

/**
 * Is a background pass recomputing what this screen counts?
 *
 * Implemented in `code/packages/frontend/src/lib/useCensusPending.ts` — `useCensusPending()`; consumed by
 * `pages/repos/MetricsStrip.tsx` (the metric tiles) and `pages/repos/ReposPage.tsx` (the list header).
 */
export function useCensusPending(): CensusPending {
  const { jobs, queued } = useProgress();
  // Shared cache with <ScanProgressBar>, which owns the interval. No `refetchInterval` here on purpose:
  // this observer must never introduce a poll of its own.
  const { data: scan } = useQuery({ queryKey: ["scanStatus"], queryFn: api.scanStatus });
  return censusPendingFrom({
    jobs,
    queued,
    scanRunning: (scan as ScanJob | undefined)?.status === "running",
  });
}
