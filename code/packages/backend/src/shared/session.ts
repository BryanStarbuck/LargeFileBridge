// THIS SESSION'S IDENTITY (crash_recovery.mdx §5.1) — the durable answer to "did we crash last time?"
//
// D2's rule: an empty Processing page may only render **Empty** when the app can affirmatively assert that
// nothing was interrupted. That assertion needs one fact that cannot be recomputed later — how the
// PREVIOUS session ended — and it must be captured at boot, before this session's own BOOT marker lands
// and makes every session look clean.
//
// A leaf on purpose: main.ts (the composition root) writes it once at boot; progress.router.ts reads it on
// every poll. Neither imports the other, and this module imports nothing but the ledger's type.
import type { PreviousSession } from "./transactions.js";

let startedAt: string | null = null;
let previous: PreviousSession = { previousEnded: "unknown" };

/** Called ONCE at boot, from main.ts, with the verdict read before txnBoot(). */
export function recordSessionStart(prev: PreviousSession, at = new Date().toISOString()): void {
  previous = prev;
  startedAt = at;
}

export interface SessionState {
  startedAt: string;
  previousEnded: "clean" | "abnormal" | "unknown";
  previousEndedAt?: string;
}

/**
 * This session's state for the poll payload. `null` before boot has recorded it — the router omits the
 * block entirely in that window rather than inventing a default, because a fabricated "clean" here would
 * be the exact confident lie D2 exists to kill.
 */
export function sessionState(): SessionState | null {
  if (!startedAt) return null;
  return { startedAt, previousEnded: previous.previousEnded, previousEndedAt: previous.previousEndedAt };
}
