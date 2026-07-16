// D2 — NEVER RENDER AN AMBIGUOUS ZERO (crash_recovery.mdx §5).
//
// > "Zero pending is not a state. It is three states wearing the same coat."
//
// On 2026-07-15 an OOM vaporized ~1,290 queued jobs and the Processing page rendered its calm
// "Nothing is processing right now." — a *confident lie*. The queue was empty because the work had been
// destroyed, and the page could not tell that apart from "you never queued anything."
//
// This module owns the derivation ONLY (pure, testable). The page renders what it returns.
//
// THE LOCKED RULE (§5): an empty page may render **Empty** only when the app can AFFIRMATIVELY assert
// that nothing was interrupted. If the last session's outcome is UNKNOWN, it renders **Interrupted**.
// We fail toward telling the user something happened — an honest "we're not sure" beats a confident lie.
import type { SessionView } from "@lfb/shared";

export type EmptyState = "finished" | "empty" | "interrupted";

export interface SessionCopy {
  state: EmptyState;
  headline: string;
  sub?: string;
}

/** A time like `10:13 PM`, or null when the markers cannot supply one. */
export function clockTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Which of the three states is an empty Processing page actually in?
 *
 * @param session       the polled session block (null before boot recorded it — treated as unknown)
 * @param didWorkThisSession  did anything run and finish in THIS session? (recent batches/failures)
 */
export function deriveEmptyState(session: SessionView | null, didWorkThisSession: boolean): EmptyState {
  // Interrupted wins over everything: a restore or an abnormal end is the single most important thing the
  // user could learn from this page, and it stays true even if other work has since finished.
  if (!session) return "interrupted"; // no session block ⇒ we cannot assert innocence ⇒ say so (§5)
  if (session.previousEnded !== "clean") return "interrupted";
  if (session.restored || session.quarantined) return "interrupted";
  if (didWorkThisSession) return "finished";
  return "empty";
}

/** The English for each state. Kept beside the derivation so the copy and the rule cannot drift apart. */
export function sessionCopy(session: SessionView | null, didWorkThisSession: boolean, finishedSummary?: string): SessionCopy {
  const state = deriveEmptyState(session, didWorkThisSession);
  if (state === "empty") {
    return { state, headline: "Nothing is processing right now." };
  }
  if (state === "finished") {
    return { state, headline: finishedSummary ?? "All queued work finished.", sub: "Nothing is waiting." };
  }

  // ── Interrupted ────────────────────────────────────────────────────────────────────────────────────
  const at = clockTime(session?.previousEndedAt);
  const stoppedAt = at ? `Large File Bridge stopped unexpectedly at ${at}.` : "Large File Bridge stopped unexpectedly.";
  const restored = session?.restored ?? 0;
  const skipped = session?.restoreSkipped ?? 0;
  const quarantined = session?.quarantined ?? 0;

  // The honest "we don't know" branch. It reads differently from a known crash on purpose: claiming a
  // crash we cannot prove would be its own kind of lie, just in the opposite direction.
  if (session && session.previousEnded === "unknown" && !restored && !quarantined) {
    return {
      state,
      headline: "Large File Bridge can't confirm how the previous session ended.",
      sub: "Its startup record has aged out of the log, so any unfinished work from before can't be accounted for. Nothing is waiting now.",
    };
  }

  if (restored > 0) {
    const bits = [`${restored.toLocaleString()} ${restored === 1 ? "job was" : "jobs were"} restored and ${restored === 1 ? "is" : "are"} running now`];
    if (skipped > 0) bits.push(`${skipped.toLocaleString()} had already finished`);
    if (quarantined > 0) bits.push(`${quarantined.toLocaleString()} ${quarantined === 1 ? "was" : "were"} not retried because ${quarantined === 1 ? "it" : "they"} crashed the app twice`);
    return { state, headline: `${stoppedAt} ${bits.join(", ")}.`, sub: "You don't need to re-run them." };
  }

  if (quarantined > 0) {
    return {
      state,
      headline: `${stoppedAt} ${quarantined.toLocaleString()} ${quarantined === 1 ? "job was" : "jobs were"} not retried because ${quarantined === 1 ? "it" : "they"} crashed the app twice.`,
      sub: "They're listed below as failed. Retry them explicitly if you want to try again.",
    };
  }

  // Zero restored is STILL a fact (§4.2) — the difference between an app that knows what happened and one
  // that shrugs.
  return { state, headline: `${stoppedAt} No unfinished jobs were pending.`, sub: "Nothing was lost." };
}
