// The warning registry data model (warnings.mdx §8). Every warning surfaced by the app is one typed
// WarningDef: its banner state/copy, plus (unless purely informational) a `popup` that educates and
// carries the fix. A def is BUILT FROM LIVE DATA by the owning page (the `ctx` in the spec is the
// repo detail / ipfs status / file list the page already loads), so the banner and popup can never
// disagree with the truth on screen. The §10 catalog documents one WarningDef per canonical warning.
import type { ReactNode } from "react";
import type { ProgressKind } from "@lfb/shared";
import type { Health } from "../health.js";

// A single option in the popup's options region (warnings.mdx §4.3). Radios model a mutually
// exclusive decision (Pin all / Ignore all); checkboxes model independent toggles (remember choice,
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

// The four open-states a per-row action toggle can start in (warnings.mdx §4.5.1). Mirrors the
// decision-toggle grammar (decision_toggles.mdx §1): "on" solid/checked, "recommended" dashed but
// pre-checked (LFBridge's suggestion the user can uncheck), "off" empty/unchecked. An axis KEY absent
// from a target's `axes` ⇒ N/A for that row (no toggle; the slot stays blank so columns align).
export type AxisOpenState = "on" | "recommended" | "off";

// The three per-row action axes (warnings.mdx §4.5.1). A column renders in the pane only when at least
// one target declares that axis (§4.5.1 "columns render only when relevant").
export type WarningTargetAxes = {
  ipfs?: AxisOpenState; // Add to IPFS (pin/get) — any large file
  ignore?: AxisOpenState; // Add to git-ignore (add eventually) — only under a repo
  compress?: AxisOpenState; // Compress — only when the file looks compressible & uncompressed
};

// The three axis ids, in render order (pin → ignore → compress).
export const AXIS_ORDER = ["ipfs", "ignore", "compress"] as const;
export type AxisId = (typeof AXIS_ORDER)[number];

// Media the left pane previews when this row is hovered/keyboard-focused (warnings.mdx §4.5.2). Absent ⇒
// a non-media row (hovering it just restores the educate copy).
export type WarningTargetPreview = {
  kind: "image" | "video" | "audio";
  url: string; // media-serving URL (same /api/media endpoint the media viewer uses)
  width?: number; // pixel dimensions for the caption ("3840×2160")
  height?: number;
};

// One subject the warning is about — a file or directory (warnings.mdx §4.5). Rendered as a row in the
// popup's right-pane subjects list. Two row models (§4.5):
//   1. PER-ROW TOGGLES (§4.5.1) — when `axes` is present, the row leads with up-to-3 action toggles
//      (pin/ignore/compress) pre-set to those open states; the row is "included" when ≥1 axis is ON,
//      and apply() receives each included row's ON axes via its `perRow` argument.
//   2. SINGLE CHECKBOX (§4.5) — when `axes` is absent, the row leads with one include checkbox; apply()
//      receives the checked ids and the left-pane options decide what to do.
export type WarningTarget = {
  id: string; // stable key — usually the absolute path (also what apply() receives)
  label: string; // display name (repo-relative or middle-truncated absolute path)
  sublabel?: string; // size and/or fuller path, shown muted under the label
  defaultChecked?: boolean; // single-checkbox model: default true; false opts the row OUT at open (rare)
  axes?: WarningTargetAxes; // per-row-toggles model (§4.5.1) — present ⇒ row shows up-to-3 axis toggles
  preview?: WarningTargetPreview; // §4.5.2 — media the left pane previews on hover/focus
};

// Per-row map of the axes left ON for each still-included row — apply()'s 3rd argument in the per-row
// model (§4.5.1). Only ON axes and only included rows appear.
export type PerRowAxes = Record<string, { ipfs?: boolean; ignore?: boolean; compress?: boolean }>;

export type WarningPopupSpec = {
  // §4.2 — the two mandatory education blocks.
  whatThisIs: ReactNode; // "What this is" — plain-English what LFBridge found and what it means
  whyItMatters: ReactNode; // "Why it matters" — the consequence to the user's files
  details?: ReactNode; // optional Disclosure content (the file list, CIDs, the exact command)
  // §4.3 — zero or more left-column options. Empty/omitted = no options region.
  options?: WarningOption[];
  // §4.5 — THE SUBJECTS LIST: the actual files/directories this warning is about. Present ⇒ the popup
  // renders the WIDE two-pane layout (§4.0) with a right-pane checklist (all checked at open); absent ⇒
  // the narrow single-pane one-click layout.
  targets?: WarningTarget[];
  // Noun for the live count in the header/button ("file" default → "— 4 files"). e.g. "video", "directory".
  targetNoun?: string;
  // §4.4 — the blue action button label; may depend on the chosen options. When `targets` are present
  // the popup appends the LIVE checked count ("— {n} {noun}s"); do NOT bake a count into this string.
  actionLabel: string | ((sel: WarningSelection) => string);
  // True when the chosen options are destructive/lossy → red button + inline confirm (§5.4).
  destructive?: (sel: WarningSelection) => boolean;
  // Extra gate on the action button (default: enabled). Radios-satisfied AND (when targets exist)
  // ≥1 checked subject are enforced implicitly by the popup — this is for anything beyond that (§5.2).
  canApply?: (sel: WarningSelection) => boolean;
  // Improvable OFFERS only may be dismissed "don't offer again" (§5.6). Never for `bad`.
  dismissible?: boolean;
  // ASYNC HAND-OFF (§5.2/§5.3). When present, Apply does NOT block the popup: the popup closes at once
  // and `apply` runs as a BACKGROUND JOB via useProgress().run() — a dock card tracks it, a completion
  // toast fires when it settles (or a red error toast on failure), and the `invalidate` query keys are
  // refetched so the banner re-derives and the warning disappears once the work is actually done. Omit
  // ⇒ legacy in-popup blocking apply (spinner + inline error). New warnings SHOULD supply this.
  progress?: {
    // Dock verb + taxonomy ("pin" | "ignore" | "compress" | "configure" | …). May depend on the chosen
    // options (e.g. the Pin/Ignore radio → "pin" vs "ignore") so the dock verb matches the actual work.
    kind: ProgressKind | ((sel: WarningSelection) => ProgressKind);
    // Dock card text after the verb (repo name, "IPFS engine"); may depend on the choices/checked set.
    target: string | ((sel: WarningSelection, checkedTargetIds: string[]) => string);
    // Completion toast text ("6 files set to pin"); default is the generic "N jobs complete".
    doneLabel?: string | ((sel: WarningSelection, count: number) => string);
    // react-query keys to refetch on SUCCESS (nothing runs on failure) → the warning disappears.
    invalidate?: unknown[][];
  };
  // THE FIX (§5.2/§5.3). Receives the chosen options AND the CHECKED subjects — runs Task X over exactly
  // those (unchecked subjects untouched). `checkedTargetIds` is [] when there are no targets.
  //  • Single-checkbox model: `checkedTargetIds` = the ids whose include box is on.
  //  • Per-row-toggles model (§4.5.1): `perRow` maps each still-included id → the axes left ON, so the fix
  //    can pin/git-ignore/compress each file per its own toggles; `checkedTargetIds` = Object.keys(perRow).
  // With `progress` this IS the background job's task; without it, it is awaited in-popup (resolve =
  // success → popup closes + page refetches; reject with an Error = stay open + show it).
  apply: (sel: WarningSelection, checkedTargetIds: string[], perRow?: PerRowAxes) => Promise<void>;
};

export type WarningScope =
  | "file"
  | "directory"
  | "repo"
  | "ipfs"
  | "device"
  | "storage"
  | "computer"
  | "global";

export type WarningDef = {
  id: string; // stable kebab id, e.g. "files-need-decision"
  state: Health; // "warn" (Improvable) | "bad" (Broken) — drives the banner + popup colors
  scope?: WarningScope; // what the warning is about (warnings.mdx §8); informational/routing only
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

// The set of target ids checked when the popup opens: every target except those explicitly
// defaultChecked:false (§4.5 — "every row is checked by default").
export function initialCheckedTargets(popup?: WarningPopupSpec): Set<string> {
  const s = new Set<string>();
  for (const t of popup?.targets ?? []) if (t.defaultChecked !== false) s.add(t.id);
  return s;
}

// English pluralization for the live count noun ("file" → "files", "1 file"). Handles the common
// LFB nouns (file, directory, video, image); falls back to +s.
export function pluralizeNoun(noun: string, n: number): string {
  if (n === 1) return noun;
  if (noun.endsWith("y")) return noun.slice(0, -1) + "ies"; // directory → directories
  return noun + "s";
}

// PER-ROW-TOGGLES model (warnings.mdx §4.5.1). True when any target declares `axes` — the popup then
// renders up-to-3 per-row action toggles instead of the single include checkbox (§4.5 model 1).
export function hasPerRowAxes(popup?: WarningPopupSpec): boolean {
  return (popup?.targets ?? []).some((t) => t.axes != null);
}

// Which axis columns to render — an axis column shows only when at least ONE target declares it
// (§4.5.1 "columns render only when relevant"), preserving the pin → ignore → compress order.
export function axisColumns(popup?: WarningPopupSpec): AxisId[] {
  const targets = popup?.targets ?? [];
  return AXIS_ORDER.filter((axis) => targets.some((t) => t.axes?.[axis] !== undefined));
}

// The initial CHECKED state per row per axis when the popup opens. "on" and "recommended" open CHECKED
// (recommended is pre-checked so the user only unchecks, §4.5.1); "off" opens unchecked; an absent axis
// is undefined (N/A — no toggle on that row). Keyed by target id → axis → boolean.
export type RowAxisChecks = Record<string, Partial<Record<AxisId, boolean>>>;
export function initialRowAxisChecks(popup?: WarningPopupSpec): RowAxisChecks {
  const out: RowAxisChecks = {};
  for (const t of popup?.targets ?? []) {
    if (!t.axes) continue;
    const row: Partial<Record<AxisId, boolean>> = {};
    for (const axis of AXIS_ORDER) {
      const st = t.axes[axis];
      if (st === undefined) continue; // N/A on this row
      row[axis] = st !== "off"; // "on" | "recommended" → checked
    }
    out[t.id] = row;
  }
  return out;
}
