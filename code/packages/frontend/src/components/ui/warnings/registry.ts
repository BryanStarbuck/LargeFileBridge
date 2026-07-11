// The warning registry data model (warnings.mdx §8). Every warning surfaced by the app is one typed
// WarningDef: its banner state/copy, plus (unless purely informational) a `popup` that educates and
// carries the fix. A def is BUILT FROM LIVE DATA by the owning page (the `ctx` in the spec is the
// repo detail / ipfs status / file list the page already loads), so the banner and popup can never
// disagree with the truth on screen. The §10 catalog documents one WarningDef per canonical warning.
import type { ReactNode } from "react";
import type { Health } from "../health.js";

// A single option in the popup's options region (warnings.mdx §4.3). Radios model a mutually
// exclusive decision (Sync all / Ignore all); checkboxes model independent toggles (remember choice,
// convert PNG→JPEG). A destructive/lossy option upgrades the footer button to the red treatment and
// requires an explicit confirm (§5.4).
export type WarningOption =
  | {
      kind: "radio";
      group: string; // radios sharing a group are mutually exclusive
      value: string;
      label: string;
      helper?: string;
      destructive?: boolean;
      defaultSelected?: boolean;
    }
  | {
      kind: "checkbox";
      name: string;
      label: string;
      helper?: string;
      destructive?: boolean;
      defaultChecked?: boolean;
    };

// The user's live choices in the popup: the picked value per radio group, and each checkbox's state.
export type WarningSelection = {
  radios: Record<string, string>; // group -> chosen value
  checks: Record<string, boolean>; // checkbox name -> checked
};

export type WarningPopupSpec = {
  // §4.2 — the two mandatory education blocks.
  whatThisIs: ReactNode; // "What this is" — plain-English what LFBridge found and what it means
  whyItMatters: ReactNode; // "Why it matters" — the consequence to the user's files
  details?: ReactNode; // optional Disclosure content (the file list, CIDs, the exact command)
  // §4.3 — zero or more options. Empty/omitted = a one-click fix (no options region).
  options?: WarningOption[];
  // §4.4 — the blue action button label; may depend on the chosen options.
  actionLabel: string | ((sel: WarningSelection) => string);
  // True when the chosen options are destructive/lossy → red button + inline confirm (§5.4).
  destructive?: (sel: WarningSelection) => boolean;
  // Gate the action button (default: enabled). Return false while the choice is incomplete (§5.2).
  canApply?: (sel: WarningSelection) => boolean;
  // Improvable OFFERS only may be dismissed "don't offer again" (§5.6). Never for `bad`.
  dismissible?: boolean;
  // THE FIX (§5.2/§5.3). Calls the owning backend module. Resolve = success (popup closes and the
  // page refetches); reject with an Error = the popup stays open and shows the message (§5.5).
  apply: (sel: WarningSelection) => Promise<void>;
};

export type WarningDef = {
  id: string; // stable kebab id, e.g. "files-need-decision"
  state: Health; // "warn" (Improvable) | "bad" (Broken) — drives the banner + popup colors
  headline: string; // count-correct, plural-correct, plain English — same text as the banner
  sub?: string; // one sentence: "what this means for you"
  popup?: WarningPopupSpec; // omit for informational-only (no arrow button, no popup)
};

// Seed a fresh selection from a popup's option defaults (used when the popup mounts).
export function initialSelection(popup?: WarningPopupSpec): WarningSelection {
  const sel: WarningSelection = { radios: {}, checks: {} };
  for (const o of popup?.options ?? []) {
    if (o.kind === "radio") {
      if (o.defaultSelected || sel.radios[o.group] === undefined) {
        if (o.defaultSelected) sel.radios[o.group] = o.value;
        else if (!(o.group in sel.radios)) sel.radios[o.group] = ""; // no default → force a choice
      }
    } else {
      sel.checks[o.name] = !!o.defaultChecked;
    }
  }
  return sel;
}

// Any radio group present but left unchosen blocks Apply (§5.2 — a required choice must be picked).
export function radiosSatisfied(popup: WarningPopupSpec | undefined, sel: WarningSelection): boolean {
  const groups = new Set<string>();
  for (const o of popup?.options ?? []) if (o.kind === "radio") groups.add(o.group);
  for (const g of groups) if (!sel.radios[g]) return false;
  return true;
}

export function resolveActionLabel(popup: WarningPopupSpec, sel: WarningSelection): string {
  return typeof popup.actionLabel === "function" ? popup.actionLabel(sel) : popup.actionLabel;
}
