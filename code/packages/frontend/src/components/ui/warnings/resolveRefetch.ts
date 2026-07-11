// Re-derive a page from FRESH data until a just-fixed warning actually clears (warnings.mdx §5.3.1).
//
// A warning banner is DERIVED from query data: it disappears only when a refetch re-derives the page and
// the detection condition is now false. A single invalidate on success is not always enough, because some
// fixes are EVENTUALLY consistent — e.g. "Start IPFS" returns before the daemon finishes booting, so the
// one refetch fires while the engine is still `unreachable` and the red banner lingers until the user
// manually reloads. This runs a short backoff BURST of invalidations so the banner re-derives on its own
// the moment the fix has genuinely taken — with no user action.
//
// Truth always wins. This never hides a warning optimistically; it only asks the page to re-check the real
// state a few more times. If the fix genuinely did not work, the condition is still true and the warning
// correctly stays. This is the general guarantee for EVERY warning: fix applied → banner leaves the page
// as soon as (and only when) the underlying state clears.
import type { QueryClient } from "@tanstack/react-query";

// t=0 immediate, then out to ~6s — long enough to cover an IPFS daemon boot, short enough to feel instant
// for a fix that lands right away.
const BURST_MS = [0, 700, 1600, 3200, 6000] as const;

export function refetchUntilResolved(qc: QueryClient, keys: readonly unknown[][]): void {
  for (const ms of BURST_MS) {
    const fire = () => {
      for (const key of keys) qc.invalidateQueries({ queryKey: key });
    };
    if (ms === 0) fire();
    else setTimeout(fire, ms);
  }
}
