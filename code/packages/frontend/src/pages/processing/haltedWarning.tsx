// ONE banner, not 1,440 cards (to_fix.mdx §2.4 / 2_2_do row A12).
//
// When a provider's account dies mid-batch the queue opens a circuit and DRAINS every pending task for that
// provider, marking each `halted` — never attempted, never failed (jobqueue.service.ts haltDoomedTasks()).
// On 2026-07-15 that was 1,440 files. The user must be told ONCE, in prose they can act on — "AI descriptions
// stopped — Gemini credits are depleted. Top up at ai.studio, then Resume." — not 1,440 times.
//
// So the halted rows keep their per-item truth in the table (their own "Not attempted" group, §7.3) and this
// module folds them into a single WarningDef per open circuit — the standard educate-and-fix surface
// (warnings.mdx §3/§4: warn/amber banner + blue arrow → popup carrying the fix). A circuit is per PROVIDER,
// so "one banner per distinct reason" IS one banner in the case this exists to serve.
import type { FailedItemView, ProgressKind } from "@lfb/shared";
import { api } from "@/api/client";
import type { WarningDef } from "@/components/ui/warnings/registry";
import { clientLog } from "../../lib/clientLog.js";

// The providers whose circuits can halt work (backend adapters.ts ProviderId). The reason string the backend
// writes leads with the provider id ("gemini credits are depleted — …"), which is what we match on.
const PROVIDERS = ["gemini", "grok", "openai"] as const;
type ProviderId = (typeof PROVIDERS)[number];

/** The provider a halt reason is about, or null when the prose doesn't name one (then there is nothing to
 *  Resume and the banner stays informational — warnings.mdx §2). */
function providerFromReason(reason: string): ProviderId | null {
  const lower = reason.toLowerCase();
  return PROVIDERS.find((p) => new RegExp(`\\b${p}\\b`).test(lower)) ?? null;
}

// "AI descriptions" / "Transcriptions" — the plural NOUN for what stopped, per the spec's message shape.
const STOPPED_NOUN: Partial<Record<ProgressKind, string>> = {
  describe: "AI descriptions",
  transcribe: "Transcriptions",
  compress: "Compression",
};
function stoppedNoun(op: ProgressKind): string {
  return STOPPED_NOUN[op] ?? "Background work";
}

function sentenceCase(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** One halted group: the reason + every item the circuit dropped for it. */
export interface HaltedGroup {
  key: string;
  reason: string;
  op: ProgressKind;
  items: FailedItemView[];
}

/** Fold the halted slice of recentFailures into one group per distinct reason (to_fix.mdx §2.4). */
export function groupHalted(recentFailures: FailedItemView[]): HaltedGroup[] {
  const groups = new Map<string, HaltedGroup>();
  for (const f of recentFailures) {
    if (f.state !== "halted") continue; // a real, attempted failure — the table owns it, not this banner
    const key = `${f.op}::${f.reason}`;
    const g = groups.get(key) ?? { key, reason: f.reason, op: f.op, items: [] };
    g.items.push(f);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * The WarningDef for one halted group (warnings.mdx §8). `warn`/amber, not `bad`/red: nothing is broken —
 * the files are untouched and the work is still owed. This is a "needs your action" state (§2).
 */
export function haltedWarningDef(g: HaltedGroup, onResumed?: () => void): WarningDef {
  const n = g.items.length;
  const noun = stoppedNoun(g.op);
  const provider = providerFromReason(g.reason);
  const files = `${n} file${n === 1 ? "" : "s"}`;

  const def: WarningDef = {
    id: `halted-${g.op}-${provider ?? "provider"}`,
    state: "warn",
    scope: "global",
    // The spec's message shape (§2.4): what stopped — why — what to do. The reason is the backend's own
    // actionable prose, shown verbatim so the banner can never drift from the fault.
    headline: `${noun} stopped — ${sentenceCase(g.reason)}`,
    sub: `${files} were queued but never attempted — they were not tried and did not fail.`,
  };

  // No provider named in the reason ⇒ nothing to Resume. Stay informational (no arrow, no popup) rather than
  // offering a button that cannot do anything.
  if (!provider) return def;

  def.popup = {
    whatThisIs: `The AI provider stopped accepting work part-way through, so Large File Bridge halted the rest of the batch instead of sending ${files} it already knew would be rejected. ${sentenceCase(
      g.reason,
    )}`,
    whyItMatters: `These ${files} were never attempted. Nothing was uploaded, nothing was changed, and none of your files are damaged — the work is simply still owed. Fix the account above, then Resume so Large File Bridge will accept this work again, and re-run the action to queue those files.`,
    actionLabel: "Resume",
    apply: async () => {
      try {
        await api.describeResume(provider);
      } catch (e) {
        // The Resume route may not be live on this backend yet (to_fix.mdx §2.4 is landing in pieces). Never
        // let that read as "Resume is broken" — tell the user the one thing that always works.
        const status = (e as { response?: { status?: number } })?.response?.status;
        clientLog.error("processing.halted.resume", e);
        if (status === 404 || status === 405) {
          throw new Error(
            `Resume isn't available in this version of Large File Bridge yet. Once the account is fixed, re-run the action to queue these ${files} again.`,
          );
        }
        throw e instanceof Error ? e : new Error(String(e));
      }
      onResumed?.();
    },
  };
  return def;
}
