// The educate-and-fix popup (warnings.mdx §4). Opened by WarningArrowButton (§3). Follows the app's
// hand-rolled modal pattern (ConfirmDialog): fixed overlay, backdrop-click to cancel, inner
// stopPropagation, Esc to cancel — NEVER window.confirm.
//
// TWO LAYOUTS (§4.0), chosen automatically by whether the warning names specific subjects (`targets`):
//   • single-pane (narrow w-[34rem]) — a one-click engine/config/worker fix (Start IPFS, Fix gateway).
//   • two-pane (WIDE, up to 80vw, overlays the left nav) — a file/directory-scoped warning. The LEFT
//     column stacks a ONE-sentence summary with a "More info" chevron (§4.2.1), the options, and — below
//     them — a preview of the row the user CLICKED (§4.5.2, 2026-09-23); the RIGHT column is the SUBJECTS LIST (§4.5): the actual files/dirs,
//     each with a checkbox, all checked at open. Unchecking excludes. The File types dropdown and the
//     search box narrow what is VISIBLE, and Apply runs Task X over exactly the VISIBLE ∩ CHECKED rows
//     (§4.5.4); a LIVE count (§4.6) tracks that set in the list header AND the button label.
// Footer (both layouts): Cancel HYPERLINK left + blue action button (white text + right chevron) right.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, CircleSlash, ExternalLink, FileText, Film, Image as ImageIcon, Music, Pin, Play, Search, Shrink } from "lucide-react";
import { healthColor, healthIcon } from "./health.js";
import { Disclosure } from "./Disclosure.js";
import { useProgress } from "../../progress/progress-context.js";
import { DecisionToggle, type ToggleState } from "../decision/DecisionToggles.js";
import { Popover } from "../table/Popover.js";
import {
  AXIS_ORDER,
  FILE_TYPE_GROUP_LABEL,
  FILE_TYPE_GROUP_ORDER,
  axisColumns,
  fileTypeOptions,
  filterVisibleTargets,
  hasFileTypeFilter,
  hasPerRowAxes,
  initialCheckedTargets,
  initialFileTypesOn,
  initialRowAxisChecks,
  initialSelection,
  pluralizeNoun,
  radiosSatisfied,
  resolveActionLabel,
  summarizeFileTypes,
  type AxisId,
  type PerRowAxes,
  type RowAxisChecks,
  type WarningDef,
  type WarningSelection,
  type WarningTarget,
} from "./warnings/registry.js";

// §4.5.1 — the glyph + human label for each per-row action axis. Same pin / ⊘ marks as the table
// decision toggles (decision_toggles.mdx §1); Compress adds the "shrink" glyph (hotkey K).
const AXIS_META: Record<AxisId, { title: string; glyph: React.ReactNode }> = {
  ipfs: { title: "Add to IPFS (pin)", glyph: <Pin className="h-2.5 w-2.5" strokeWidth={2.5} /> },
  ignore: { title: "Add to git-ignore", glyph: <CircleSlash className="h-2.5 w-2.5" strokeWidth={2.5} /> },
  compress: { title: "Compress", glyph: <Shrink className="h-2.5 w-2.5" strokeWidth={2.5} /> },
};

// §4.5 ROW 1 — strip the trailing file extension for display (callers pass the plain basename).
// Leaves dotfiles (".gitignore") and extensionless names untouched; strips only a final ".ext".
function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// §4.5 — the two preferred display fields, with legacy label/sublabel fallbacks.
function rowName(t: { name?: string; label: string }): string {
  return t.name != null ? stripExt(t.name) : t.label;
}
function rowPath(t: { pathText?: string; sublabel?: string }): string | undefined {
  return t.pathText ?? t.sublabel;
}

// §4.4.1 — the per-row-axes composed label: each axis carries its OWN checked-row count, joined by "·",
// with the IPFS/pin carrier last ("Continue: IPFS Add — N"). Zero-count axes drop out; all-zero ⇒ the
// "Save decision" fallback (a reviewed-but-no-action decision is still valid).
export function composePerRowLabel(columns: AxisId[], counts: Record<AxisId, number>): string {
  const parts: string[] = [];
  if (columns.includes("compress") && counts.compress > 0) parts.push(`Compress ${counts.compress}`);
  if (columns.includes("ignore") && counts.ignore > 0) parts.push(`git-ignore ${counts.ignore}`);
  if (columns.includes("ipfs") && counts.ipfs > 0) parts.push(`Continue: IPFS Add — ${counts.ipfs}`);
  return parts.join(" · ") || "Save decision";
}

// §4.4.1 — Composed action-verb labels. When a popup offers MORE THAN ONE independent "action axis"
// (two-or-more checkboxes that each toggle a *different thing to DO* — e.g. Add-to-IPFS + Compress, or
// Add-to-IPFS + git-ignore), the button label is not one fixed verb: it is spelled out from exactly the
// axes currently CHECKED and rewrites the instant an axis is toggled, like the live count (§4.6).
//
// The axis→verb table. Each recognized DO-action maps to a spelled-out verb plus a fixed `priority`
// (lowest first when joined). The axis carrying `carrierSuffix` is the "primary/continue" axis — its
// noun rides the trailing "Continue: …" clause that stays LAST, right before the chevron.
const ACTION_AXIS_META: Record<string, { priority: number; verb: string; carrierSuffix?: string }> = {
  compress: { priority: 1, verb: "Compress" },
  gitignore: { priority: 2, verb: "Git-ignore" },
  ipfs: { priority: 3, verb: "IPFS Add", carrierSuffix: "IPFS Add" }, // pin — the continue carrier
};

// Fallback verb for an axis we recognize as a DO-action but haven't given bespoke wording.
function fallbackAxisVerb(axis: string): string {
  return axis.charAt(0).toUpperCase() + axis.slice(1);
}

// Normalize a checkbox `name` to a canonical action-axis id (or null when the checkbox is NOT a
// DO-action). Options carry no explicit flag, so we key off the DO-action names callers use: "ipfs" /
// "pin", "compress", "gitignore" / "git-ignore" / "ignore". Kept general — not hardcoded to one popup.
export function toActionAxisKey(name: string): string | null {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n.includes("compress")) return "compress";
  if (n.includes("gitignore") || n.includes("ignore")) return "gitignore";
  if (n.includes("ipfs") || n.includes("pin")) return "ipfs";
  return null;
}

function appendCount(phrase: string, checkedCount?: number): string {
  if (checkedCount == null) return phrase;
  return `${phrase} — ${checkedCount} ${checkedCount === 1 ? "file" : "files"}`;
}

// Compose the multi-axis button verb from exactly the CHECKED axes, ordered by the fixed priority above,
// with the primary/continue verb kept last (the chevron is rendered separately by the button, so it is
// NOT part of this string). When a subjects list is present the caller may pass the live checked count,
// which is appended as "— N files"; in the component we instead reuse the existing §4.6 count suffix so
// the noun/pluralization logic is never duplicated. Both-axes-off is a valid recorded decision
// (§10.2.7): the phrase becomes a "reviewed — leave it" verb and the button stays enabled.
export function composeActionLabel(checkedAxes: string[], checkedCount?: number): string {
  const ordered = Array.from(new Set(checkedAxes)).sort(
    (a, b) => (ACTION_AXIS_META[a]?.priority ?? 0) - (ACTION_AXIS_META[b]?.priority ?? 0),
  );
  if (ordered.length === 0) return appendCount("Save decision", checkedCount);

  // Highest-priority checked carrier axis (IPFS/pin) rides the trailing "Continue: …" clause.
  const carrier = [...ordered].reverse().find((a) => ACTION_AXIS_META[a]?.carrierSuffix);
  const continueClause = carrier ? `Continue: ${ACTION_AXIS_META[carrier]!.carrierSuffix}` : "Continue";
  const leadVerbs = ordered
    .filter((a) => a !== carrier)
    .map((a) => ACTION_AXIS_META[a]?.verb ?? fallbackAxisVerb(a));
  return appendCount([...leadVerbs, continueClause].join(" and "), checkedCount);
}

export function WarningPopup({
  warning,
  onClose,
  onApplied,
  resolvePreviewUrl,
}: {
  warning: WarningDef;
  onClose: () => void;
  onApplied?: () => void;
  // §4.5.2 — optional lazy resolver for a target's preview bytes. When a target's `preview.url` is empty
  // the popup calls this for the SELECTED row only (e.g. to mint a short-lived media grant) instead of
  // pre-fetching every file. Kept generic: the caller injects the media API; the popup never imports it.
  // Falls back to the warning's own `popup.resolvePreviewUrl`.
  resolvePreviewUrl?: (target: WarningTarget) => Promise<string | null>;
}) {
  const popup = warning.popup!;
  const resolveUrl = resolvePreviewUrl ?? popup.resolvePreviewUrl;
  const targets = popup.targets ?? [];
  const hasTargets = targets.length > 0;
  const noun = popup.targetNoun ?? "file";

  // §4.5.1 — per-row-toggles model: rows carry up-to-3 axis toggles instead of one include checkbox.
  const perRowMode = hasPerRowAxes(popup);
  const columns = useMemo(() => axisColumns(popup), [popup]);

  const [sel, setSel] = useState<WarningSelection>(() => initialSelection(popup));
  const [checked, setChecked] = useState<Set<string>>(() => initialCheckedTargets(popup));
  const [rowChecks, setRowChecks] = useState<RowAxisChecks>(() => initialRowAxisChecks(popup));
  const [touched, setTouched] = useState<Set<string>>(() => new Set()); // "id:axis" the user has flipped
  // §4.5.4 — the File types filter: one entry per extension found in the subjects, grouped by kind. Only the
  // video (and audio) types open checked; every other type is listed but starts unchecked, so its rows start
  // hidden — and a hidden row is never acted on. Hiding a type never unchecks its rows, so re-showing it
  // restores them exactly as the user left them.
  const typeOptions = useMemo(() => fileTypeOptions(targets), [targets]);
  const showTypeFilter = hasFileTypeFilter(typeOptions);
  const [typesOn, setTypesOn] = useState<Set<string>>(() => initialFileTypesOn(typeOptions));
  const [typesOpen, setTypesOpen] = useState(false); // the File types dropdown
  const typesOpenRef = useRef(false); // read by the once-registered Esc handler below
  typesOpenRef.current = typesOpen;
  const [typeQuery, setTypeQuery] = useState(""); // the dropdown's own find-a-type box
  const [query, setQuery] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false); // second tap needed for a destructive apply
  const [previewId, setPreviewId] = useState<string | null>(null); // §4.5.2 — the clicked/arrow-selected row
  const [playing, setPlaying] = useState(false); // §4.5.2 — the selected video left its poster and is playing
  const [explainOpen, setExplainOpen] = useState(false); // §4.2.1 — "More info ▾" expands the educate copy
  const { run } = useProgress(); // §5.3 — async fixes hand off to the bottom Progress dock
  const mediaRef = useRef<HTMLMediaElement | null>(null); // previewed <video>/<audio> element (§4.5.3)
  const listRef = useRef<HTMLDivElement>(null); // the subjects list — arrow moves scroll the selection into view

  const Icon = healthIcon(warning.state);
  const color = healthColor(warning.state);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // §4.5.4 — the rows the File types filter AND the search box currently SHOW. This is not cosmetic: it is
  // the apply gate. A row the user cannot see is never acted on, so every count, Select all / Clear, and the
  // apply set below intersect with it. (The search box used to be a "transient view" Apply ignored:
  // searching down to 3 rows and pressing Apply acted on every checked row, hidden or not — 2026-09-10.)
  const visibleTargets = useMemo(
    () => filterVisibleTargets(targets, showTypeFilter ? typesOn : null, query),
    [targets, showTypeFilter, typesOn, query],
  );

  // Per-row derived state (§4.5.1): a row is "included" when ≥1 of its axes is checked; each axis carries
  // its own checked-row count for the composed label (§4.4.1). Filtered-out rows are excluded (§4.5.4).
  const includedIds = perRowMode
    ? visibleTargets.filter((t) => AXIS_ORDER.some((a) => rowChecks[t.id]?.[a])).map((t) => t.id)
    : [];
  // §4.5.4 — THE apply set in the single-checkbox model: visible ∩ checked. Also the live count (§4.6).
  const effectiveChecked = useMemo(
    () => visibleTargets.filter((t) => checked.has(t.id)).map((t) => t.id),
    [visibleTargets, checked],
  );
  const axisCounts: Record<AxisId, number> = { ipfs: 0, ignore: 0, compress: 0 };
  if (perRowMode) {
    for (const t of visibleTargets) for (const a of AXIS_ORDER) if (rowChecks[t.id]?.[a]) axisCounts[a]++;
  }

  const destructive = popup.destructive?.(sel) ?? false;
  // §5.2 — need ≥1 checked subject to apply (per-row: ≥1 row with an ON axis; single: ≥1 checked box).
  // Both counts are VISIBLE-only (§4.5.4), so filtering every type out disables Confirm rather than
  // committing rows the user can no longer see.
  const targetsOk = perRowMode ? includedIds.length > 0 : !hasTargets || effectiveChecked.length > 0;
  const canApply =
    !applying && radiosSatisfied(popup, sel) && targetsOk && (popup.canApply ? popup.canApply(sel) : true);

  useEffect(() => {
    if (destructive && !popup.options?.length) cancelRef.current?.focus();
    else if (popup.options?.length) firstFieldRef.current?.focus();
    else actionRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the File types dropdown first; only a second Esc closes the popup.
      if (typesOpenRef.current) setTypesOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setRadio = (group: string, value: string) => {
    setConfirming(false);
    setSel((s) => ({ ...s, radios: { ...s.radios, [group]: value } }));
  };
  const setCheck = (name: string, on: boolean) => {
    setConfirming(false);
    setSel((s) => ({ ...s, checks: { ...s.checks, [name]: on } }));
  };
  const toggleTarget = (id: string) => {
    setConfirming(false);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // §4.5.4 — "all" means all of what the user is LOOKING AT: the rows the File types filter and the search
  // box leave visible. Rows hidden by either are left exactly as they were.
  const selectAll = () => {
    setConfirming(false);
    setChecked((prev) => new Set([...prev, ...visibleTargets.map((t) => t.id)]));
  };
  const clearAll = () => {
    setConfirming(false);
    setChecked((prev) => {
      const next = new Set(prev);
      for (const t of visibleTargets) next.delete(t.id);
      return next;
    });
  };

  // §4.5.1 — flip ONE axis on ONE row. Marks it "touched" so a pre-checked RECOMMENDED axis loses its
  // dashed look once the user has confirmed/denied it.
  const toggleRowAxis = (id: string, axis: AxisId) => {
    setConfirming(false);
    setTouched((prev) => new Set(prev).add(`${id}:${axis}`));
    setRowChecks((prev) => {
      const row = { ...(prev[id] ?? {}) };
      row[axis] = !row[axis];
      return { ...prev, [id]: row };
    });
  };
  // §4.5.1 — a column header flips a whole axis across every VISIBLE row (§4.5.4). If all applicable rows
  // are already ON, turn them all OFF; otherwise turn them all ON.
  const toggleColumn = (axis: AxisId) => {
    setConfirming(false);
    const applicable = visibleTargets.filter((t) => t.axes?.[axis] !== undefined);
    const allOn = applicable.every((t) => rowChecks[t.id]?.[axis]);
    setTouched((prev) => {
      const next = new Set(prev);
      for (const t of applicable) next.add(`${t.id}:${axis}`);
      return next;
    });
    setRowChecks((prev) => {
      const next = { ...prev };
      for (const t of applicable) next[t.id] = { ...(next[t.id] ?? {}), [axis]: !allOn };
      return next;
    });
  };

  // §4.5.2 — CLICKING a row selects it for the preview below the options (hover no longer swaps it —
  // 2026-09-23). Read-only: selecting never checks or unchecks anything. A new row stops the old video.
  const selectPreview = (id: string) => {
    if (id === previewId) return;
    setPlaying(false);
    setPreviewId(id);
  };

  // §4.5.2 — open already showing something: when nothing is selected (or the selection was filtered out of
  // view), select the first VISIBLE media row. A deliberately clicked non-media row stays selected.
  useEffect(() => {
    if (previewId && visibleTargets.some((t) => t.id === previewId)) return;
    const first = visibleTargets.find((t) => t.preview)?.id ?? null;
    if (first !== previewId) {
      setPlaying(false);
      setPreviewId(first);
    }
  }, [visibleTargets, previewId]);

  // §4.5.1 — the per-row "All / None" affordance: set every applicable axis on/off across all VISIBLE rows (§4.5.4).
  const setAllRows = (on: boolean) => {
    setConfirming(false);
    setTouched((prev) => {
      const next = new Set(prev);
      for (const t of visibleTargets) for (const a of AXIS_ORDER) if (t.axes?.[a] !== undefined) next.add(`${t.id}:${a}`);
      return next;
    });
    setRowChecks((prev) => {
      const next = { ...prev };
      for (const t of visibleTargets) {
        if (!t.axes) continue;
        const row = { ...(next[t.id] ?? {}) };
        for (const a of AXIS_ORDER) if (t.axes[a] !== undefined) row[a] = on;
        next[t.id] = row;
      }
      return next;
    });
  };

  const doApply = async () => {
    if (!canApply) return;
    if (destructive && !confirming) {
      setConfirming(true); // §5.4 — explicit second tap for a lossy/destructive fix
      return;
    }
    // The checked subjects, and — in per-row mode — each included row's ON axes (§4.5.1) handed to apply().
    // Both are the VISIBLE set (§4.5.4): a row hidden by the File types filter or the search box is never handed to apply().
    const ids = perRowMode ? includedIds : effectiveChecked;
    let perRow: PerRowAxes | undefined;
    if (perRowMode) {
      perRow = {};
      for (const id of includedIds) {
        const row: PerRowAxes[string] = {};
        for (const a of AXIS_ORDER) if (rowChecks[id]?.[a]) row[a] = true;
        perRow[id] = row;
      }
    }

    // ASYNC PATH (§5.2/§5.3) — when the warning declares `progress`, the fix runs as a background job:
    // close the popup at once, hand off to the Progress dock (spinner card), and let run() fire the
    // completion toast + refetch the `invalidate` keys so the banner re-derives and the warning
    // disappears once the work is actually done. Errors surface as run()'s red toast (§5.5).
    if (popup.progress) {
      const p = popup.progress;
      const kind = typeof p.kind === "function" ? p.kind(sel) : p.kind;
      const target = typeof p.target === "function" ? p.target(sel, ids) : p.target;
      const batchLabel = typeof p.doneLabel === "function" ? p.doneLabel(sel, ids.length) : p.doneLabel;
      onClose(); // async hand-off — do not block the popup
      await run(
        [
          {
            kind,
            target,
            task: async () => {
              await popup.apply(sel, ids, perRow);
              onApplied?.();
            },
          },
        ],
        { invalidate: p.invalidate, batchLabel },
      );
      return;
    }

    // LEGACY BLOCKING PATH — no `progress` metadata: await in-popup and show inline errors.
    setApplying(true);
    setError(null);
    try {
      await popup.apply(sel, ids, perRow);
      onApplied?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setApplying(false);
      setConfirming(false);
    }
  };

  // §4.4.1 — detect the popup's independent ACTION AXES (checkboxes whose `name` is a DO-action) and
  // gather the ones currently CHECKED. When there are ≥2 axes and the caller did NOT supply an explicit
  // actionLabel (empty string / omitted), the button verb is COMPOSED from the checked axes and rewrites
  // reactively as they toggle. If the caller DID supply an actionLabel (string or function), respect it
  // (back-compat); single-axis and radio-only popups are therefore unchanged.
  let actionAxisCount = 0;
  const checkedAxisKeys: string[] = [];
  for (const o of popup.options ?? []) {
    if (o.kind !== "checkbox") continue;
    const key = toActionAxisKey(o.name);
    if (!key) continue;
    actionAxisCount++;
    if (sel.checks[o.name]) checkedAxisKeys.push(key);
  }
  const explicitActionLabel =
    typeof popup.actionLabel === "function" ||
    (typeof popup.actionLabel === "string" && popup.actionLabel.trim() !== "");
  const useComposedLabel = actionAxisCount >= 2 && !explicitActionLabel;

  // Live count (§4.6): the button carries "— {n} {noun}s" when the warning has subjects. For a composed
  // multi-axis label we reuse this SAME count suffix (do not pass checkedCount into composeActionLabel).
  // Per-row mode composes a per-AXIS count label (§4.4.1); otherwise use the composed-axis or plain
  // label plus the single trailing "— N files" checked-subject count.
  const base = perRowMode
    ? composePerRowLabel(columns, axisCounts)
    : useComposedLabel
      ? composeActionLabel(checkedAxisKeys)
      : resolveActionLabel(popup, sel);
  const countSuffix =
    !perRowMode && hasTargets
      ? ` — ${effectiveChecked.length} ${pluralizeNoun(noun, effectiveChecked.length)}`
      : "";
  const label = confirming ? `Confirm — ${base}${countSuffix}` : `${base}${countSuffix}`;
  const actionBg = destructive ? "var(--lfb-bad)" : "var(--lfb-primary)";

  // Group radios by their group so we can render one fieldset per decision.
  const radioGroups = new Map<string, Extract<NonNullable<typeof popup.options>[number], { kind: "radio" }>[]>();
  const checkboxes: Extract<NonNullable<typeof popup.options>[number], { kind: "checkbox" }>[] = [];
  for (const o of popup.options ?? []) {
    if (o.kind === "radio") {
      const arr = radioGroups.get(o.group) ?? [];
      arr.push(o);
      radioGroups.set(o.group, arr);
    } else checkboxes.push(o);
  }
  let firstFieldAssigned = false;
  const takeFirstRef = () => {
    if (firstFieldAssigned) return undefined;
    firstFieldAssigned = true;
    return firstFieldRef;
  };

  const showSearch = targets.length > 30;
  // §4.5.4 — the File types dropdown's derived view: the options its find-a-type box leaves listed, grouped
  // under their kind, plus the one-line summary the closed button shows.
  const shownTypeOptions = useMemo(() => {
    const q = typeQuery.trim().toLowerCase().replace(/^\./, "");
    if (!q) return typeOptions;
    return typeOptions.filter((o) => o.ext.includes(q) || FILE_TYPE_GROUP_LABEL[o.group].toLowerCase().includes(q));
  }, [typeOptions, typeQuery]);
  const typeGroups = FILE_TYPE_GROUP_ORDER.map((group) => ({
    group,
    options: shownTypeOptions.filter((o) => o.group === group),
  })).filter((g) => g.options.length > 0);
  const hiddenCount = targets.length - visibleTargets.length;
  const setTypes = (exts: string[], on: boolean) => {
    setConfirming(false);
    setTypesOn((prev) => {
      const next = new Set(prev);
      for (const e of exts) {
        if (on) next.add(e);
        else next.delete(e);
      }
      return next;
    });
  };

  const subjectsHeading = `${
    noun === "directory" ? "Directories" : `${noun[0].toUpperCase()}${noun.slice(1)}s`
  } this applies to`;

  // §4.5.2 — the row currently previewed (clicked or keyboard-cursored). Only a target that carries
  // media draws the preview area below the options; a non-media row draws none.
  const previewTarget = previewId ? (targets.find((t) => t.id === previewId) ?? null) : null;
  const previewMedia = previewTarget?.preview ?? null;

  // §4.5.3 — ↑/↓ move a preview cursor down the file list; Space plays/pauses a previewed video/audio.
  const moveCursor = (delta: number) => {
    if (visibleTargets.length === 0) return;
    const cur = visibleTargets.findIndex((t) => t.id === previewId);
    const next = cur < 0 ? 0 : Math.min(visibleTargets.length - 1, Math.max(0, cur + delta));
    const id = visibleTargets[next].id;
    selectPreview(id);
    // §4.5.3 — keep the selected row in view as the cursor walks the list.
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []).find(
      (el) => el.dataset.rowId === id,
    );
    row?.scrollIntoView({ block: "nearest" });
  };
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (!hasTargets) return;
    const el = e.target as HTMLElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (el.closest("input,textarea,[contenteditable=true]")) return; // don't hijack text nav
      e.preventDefault();
      moveCursor(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === " " || e.key === "Spacebar") {
      // Space toggles a focused checkbox/toggle natively — only intercept when focus is NOT on a control
      // and a video/audio is previewed (§4.5.3), then play/pause it.
      if (el.closest("input,textarea,button,[contenteditable=true]")) return;
      if (previewMedia?.kind === "video" && !playing) {
        e.preventDefault();
        setPlaying(true); // leave the poster — the <video> mounts with autoplay (§4.5.2)
        return;
      }
      const media = mediaRef.current;
      if (media && (previewMedia?.kind === "video" || previewMedia?.kind === "audio")) {
        e.preventDefault();
        if (media.paused) void media.play().catch(() => {});
        else media.pause();
      }
    }
  };

  // §4.2 — the three educate blocks. At rest in single-pane; behind "More info ▾" in two-pane (§4.2.1).
  const educateBlocks = (
    <div className="space-y-3 text-sm text-black/70">
      <section>
        <div className="mb-0.5 font-medium text-black">What this is</div>
        <div>{popup.whatThisIs}</div>
      </section>
      <section>
        <div className="mb-0.5 font-medium text-black">Why it matters</div>
        <div>{popup.whyItMatters}</div>
      </section>
      {popup.details && (
        <Disclosure label="Details">
          <div className="text-sm text-black/70">{popup.details}</div>
        </Disclosure>
      )}
    </div>
  );

  return (
    <div className="lfb-scrim fixed inset-0 z-50 grid place-items-center p-4" onClick={onClose}>
      <div
        className={`flex max-h-[85vh] flex-col overflow-hidden lfb-modal ${
          hasTargets ? "w-[80vw] max-w-[80rem] md:min-w-[44rem]" : "w-[34rem] max-w-full"
        }`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="warning-popup-title"
      >
        {/* Header */}
        <div className="flex items-start gap-2 border-b border-[var(--lfb-border)] px-5 py-4">
          <Icon className="mt-0.5 h-5 w-5 shrink-0" style={{ color }} />
          <h2 id="warning-popup-title" className="min-w-0 flex-1 text-lg font-semibold text-black">
            {warning.headline}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 -mt-1 lfb-icon-btn p-1"
          >
            <span aria-hidden className="text-lg leading-none">×</span>
          </button>
        </div>

        {/* Body — one column, or two (educate/options | subjects list) */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* LEFT: single-pane = the full educate copy + options (§4.2/§4.3). Two-pane = ONE sentence + a
              "More info" chevron (§4.2.1), the options, then the preview of the clicked row BELOW them
              (§4.5.2, 2026-09-23) — the preview never replaces the options. */}
          <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-4 ${hasTargets ? "md:w-1/2" : ""}`}>
            {hasTargets ? (
              <div className="text-sm text-black/70">
                <p className="inline">{popup.summary ?? warning.sub ?? popup.whatThisIs}</p>{" "}
                <button
                  type="button"
                  onClick={() => setExplainOpen((o) => !o)}
                  aria-expanded={explainOpen}
                  className="inline-flex items-center gap-0.5 whitespace-nowrap text-xs text-[var(--lfb-primary)] hover:underline"
                >
                  {explainOpen ? "Less" : "More info"}
                  {explainOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                {explainOpen && <div className="mt-3">{educateBlocks}</div>}
              </div>
            ) : (
              educateBlocks
            )}

            {(radioGroups.size > 0 || checkboxes.length > 0) && (
              <div className="mt-4 space-y-3">
                <div className="text-sm font-medium text-black">What do you want to do</div>
                {[...radioGroups.entries()].map(([group, opts]) => (
                  <div key={group} role="radiogroup" className="space-y-1.5">
                    {opts.map((o) => (
                      <label key={o.value} className="flex cursor-pointer items-start gap-2 text-sm">
                        <input
                          ref={takeFirstRef()}
                          type="radio"
                          name={group}
                          checked={sel.radios[group] === o.value}
                          onChange={() => setRadio(group, o.value)}
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className={o.destructive ? "text-[var(--lfb-bad)]" : "text-black"}>{o.label}</span>
                          {o.helper && <span className="block text-xs text-black/50">{o.helper}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
                {checkboxes.map((o) => (
                  <label key={o.name} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      ref={takeFirstRef()}
                      type="checkbox"
                      checked={!!sel.checks[o.name]}
                      onChange={(e) => setCheck(o.name, e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className={o.destructive ? "text-[var(--lfb-bad)]" : "text-black"}>{o.label}</span>
                      {o.helper && <span className="block text-xs text-black/50">{o.helper}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {hasTargets && previewMedia && previewTarget && (
              <div className="mt-4 border-t border-[var(--lfb-border)] pt-4">
                <PreviewPane
                  target={previewTarget}
                  mediaRef={mediaRef}
                  resolveUrl={resolveUrl}
                  playing={playing}
                  onPlay={() => setPlaying(true)}
                />
              </div>
            )}

            {error && (
              <div className="mt-4 text-sm" style={{ color: "var(--lfb-bad)" }}>
                {error}
              </div>
            )}
          </div>

          {/* RIGHT: the subjects list (§4.5) — only when the warning names specific files/dirs */}
          {hasTargets && (
            <div className="flex min-h-0 flex-col border-t border-[var(--lfb-border)] md:w-1/2 md:border-l md:border-t-0">
              <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
                <div className="text-sm font-medium text-black">{subjectsHeading}</div>
                {/* §4.6 live count, over the VISIBLE set (§4.5.4) — unchecking a type or searching drops both
                    numbers; "N hidden" says how many rows the filters are holding back (never acted on) */}
                <div className="text-xs text-black/60" aria-live="polite">
                  {perRowMode ? includedIds.length : effectiveChecked.length} of {visibleTargets.length}{" "}
                  selected
                  {hiddenCount > 0 && <span className="text-black/40"> · {hiddenCount.toLocaleString()} hidden</span>}
                </div>
              </div>

              {/* §4.5.4 — the File types filter: a dropdown listing every extension in the subjects, grouped by
                  kind, each with a checkbox, plus a find-a-type box and Select all / Clear. Videos (and audio)
                  open checked; everything else opens unchecked. An unchecked type hides its rows AND drops them
                  from the batch (the visible list IS the applied set). */}
              {showTypeFilter && (
                <div className="flex items-center gap-2 px-5 pb-2 text-xs">
                  <span className="font-medium text-black/70">File types:</span>
                  <div className="relative min-w-0">
                    <button
                      type="button"
                      data-popover-toggle
                      onClick={() => setTypesOpen((o) => !o)}
                      aria-haspopup="true"
                      aria-expanded={typesOpen}
                      className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--lfb-border)] px-2 py-1 text-black/80 hover:bg-black/5"
                    >
                      <span className="truncate">{summarizeFileTypes(typeOptions, typesOn)}</span>
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-black/50" />
                    </button>
                    {typesOpen && (
                      <div className="absolute left-0 top-full z-20 w-72">
                        <Popover onClose={() => setTypesOpen(false)}>
                          <div className="px-3 pb-1.5 pt-1">
                            <div className="flex items-center gap-1 rounded-md border border-[var(--lfb-border)] px-2 py-1">
                              <Search className="h-3.5 w-3.5 text-black/40" />
                              <input
                                autoFocus
                                value={typeQuery}
                                onChange={(e) => setTypeQuery(e.target.value)}
                                placeholder="Find a type (mp4, image…)"
                                aria-label="Find a file type"
                                className="w-full bg-transparent text-xs outline-none"
                              />
                            </div>
                            <div className="mt-1.5 flex items-center gap-3 text-xs">
                              <button
                                type="button"
                                onClick={() => setTypes(shownTypeOptions.map((o) => o.ext), true)}
                                className="text-[var(--lfb-primary)] hover:underline"
                              >
                                Select all
                              </button>
                              <button
                                type="button"
                                onClick={() => setTypes(shownTypeOptions.map((o) => o.ext), false)}
                                className="text-[var(--lfb-primary)] hover:underline"
                              >
                                Clear
                              </button>
                            </div>
                          </div>
                          <div className="max-h-[40vh] overflow-y-auto border-t border-[var(--lfb-border)] py-1">
                            {typeGroups.map((g) => {
                              const on = g.options.filter((o) => typesOn.has(o.ext)).length;
                              const total = g.options.reduce((sum, o) => sum + o.count, 0);
                              return (
                                <div key={g.group} className="py-0.5">
                                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs font-medium text-black">
                                    <input
                                      type="checkbox"
                                      checked={on === g.options.length}
                                      ref={(el) => {
                                        if (el) el.indeterminate = on > 0 && on < g.options.length;
                                      }}
                                      onChange={(e) => setTypes(g.options.map((o) => o.ext), e.target.checked)}
                                    />
                                    {FILE_TYPE_GROUP_LABEL[g.group]}
                                    <span className="ml-auto font-normal tabular-nums text-black/40">
                                      {total.toLocaleString()}
                                    </span>
                                  </label>
                                  {g.options.map((o) => (
                                    <label
                                      key={o.ext}
                                      className="flex cursor-pointer items-center gap-2 py-0.5 pl-8 pr-3 text-xs text-black/70"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={typesOn.has(o.ext)}
                                        onChange={(e) => setTypes([o.ext], e.target.checked)}
                                      />
                                      {o.ext || o.label}
                                      <span className="ml-auto tabular-nums text-black/40">{o.count.toLocaleString()}</span>
                                    </label>
                                  ))}
                                </div>
                              );
                            })}
                            {typeGroups.length === 0 && (
                              <div className="px-3 py-2 text-xs text-black/50">No matching types.</div>
                            )}
                          </div>
                        </Popover>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-3 px-5 pb-2 text-xs">
                {perRowMode ? (
                  <>
                    <button type="button" onClick={() => setAllRows(true)} className="text-[var(--lfb-primary)] hover:underline">
                      All
                    </button>
                    <button type="button" onClick={() => setAllRows(false)} className="text-[var(--lfb-primary)] hover:underline">
                      None
                    </button>
                    {columns.length > 1 && (
                      <span className="flex items-center gap-2 text-black/50">
                        {columns.map((axis) => (
                          <button
                            key={axis}
                            type="button"
                            onClick={() => toggleColumn(axis)}
                            title={`Toggle all — ${AXIS_META[axis].title}`}
                            aria-label={`Toggle all — ${AXIS_META[axis].title}`}
                            className="inline-grid h-4 w-4 place-items-center rounded-[3px] hover:text-black"
                            style={{ border: "1px solid #9ca3af", color: "#9ca3af" }}
                          >
                            {AXIS_META[axis].glyph}
                          </button>
                        ))}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <button type="button" onClick={selectAll} className="text-[var(--lfb-primary)] hover:underline">
                      Select all
                    </button>
                    <button type="button" onClick={clearAll} className="text-[var(--lfb-primary)] hover:underline">
                      Clear
                    </button>
                  </>
                )}
                {showSearch && (
                  <div className="ml-auto flex items-center gap-1 rounded-md border border-[var(--lfb-border)] px-2 py-1">
                    <Search className="h-3.5 w-3.5 text-black/40" />
                    <input
                      value={query}
                      onChange={(e) => {
                        setConfirming(false);
                        setQuery(e.target.value);
                      }}
                      placeholder="Filter…"
                      // NOT `.lfb-input` — the wrapper above already draws the border and padding, so
                      // the house field shape would render a box inside a box.
                      className="w-28 bg-transparent text-xs outline-none"
                    />
                  </div>
                )}
              </div>
              <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                {visibleTargets.map((t) => {
                  const isPreview = t.id === previewId;
                  return (
                    <div
                      key={t.id}
                      data-row-id={t.id}
                      // §4.5.2 — clicking anywhere on the row selects it for the preview (read-only).
                      onClick={() => selectPreview(t.id)}
                      aria-selected={isPreview}
                      className={`flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm ${
                        isPreview ? "bg-[color-mix(in_srgb,var(--lfb-primary)_8%,transparent)]" : "hover:bg-black/[0.03]"
                      }`}
                    >
                      {perRowMode ? (
                        <span className="inline-flex items-center gap-1.5 shrink-0">
                          {columns.map((axis) => {
                            const st = t.axes?.[axis];
                            if (st === undefined)
                              return <DecisionToggle key={axis} state="na" glyph={null} title="" onToggle={() => {}} />;
                            const isChecked = !!rowChecks[t.id]?.[axis];
                            const wasRecommended = st === "recommended";
                            const display: ToggleState = !isChecked
                              ? "off"
                              : wasRecommended && !touched.has(`${t.id}:${axis}`)
                                ? "recommended"
                                : "on";
                            return (
                              <DecisionToggle
                                key={axis}
                                state={display}
                                glyph={AXIS_META[axis].glyph}
                                title={`${AXIS_META[axis].title} — ${t.label}`}
                                onToggle={() => toggleRowAxis(t.id, axis)}
                              />
                            );
                          })}
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          checked={checked.has(t.id)}
                          onChange={() => toggleTarget(t.id)}
                          aria-label={t.label}
                          className="shrink-0"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        {/* §4.5 ROW 1 — name (left) · size (right, muted, tabular) */}
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-black">{rowName(t)}</span>
                          {t.sizeText && (
                            <span className="shrink-0 text-xs tabular-nums text-black/50">{t.sizeText}</span>
                          )}
                        </span>
                        {/* §4.5 ROW 2 — path, light gray, smaller font */}
                        {rowPath(t) && <span className="block truncate text-xs text-black/40">{rowPath(t)}</span>}
                      </span>
                      {t.preview && (
                        <span className="shrink-0 text-black/30" aria-hidden>
                          {t.preview.kind === "video" ? (
                            <Film className="h-3.5 w-3.5" />
                          ) : t.preview.kind === "audio" ? (
                            <Music className="h-3.5 w-3.5" />
                          ) : t.preview.kind === "pdf" ? (
                            <FileText className="h-3.5 w-3.5" />
                          ) : (
                            <ImageIcon className="h-3.5 w-3.5" />
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
                {visibleTargets.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-black/50">
                    {hiddenCount > 0 ? "Nothing matches the file types and search above." : "No matches."}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer — Cancel hyperlink LEFT, action button RIGHT (white text + live count + right chevron) */}
        <div className="flex items-center justify-between border-t border-[var(--lfb-border)] px-5 py-4">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="text-sm text-[var(--lfb-primary)] hover:underline"
          >
            Cancel
          </button>
          <button
            ref={actionRef}
            type="button"
            onClick={doApply}
            disabled={!canApply}
            className="inline-flex items-center gap-1 rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: actionBg }}
          >
            {applying ? "Applying…" : label}
            {!applying && <ChevronRight className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// §4.5.2 — the left-pane media preview, drawn BELOW the options (revision 2026-09-23). Aspect-ratio preserved,
// best-fit (object-contain, never stretched/cropped) — the same fit rule as the media viewer
// (media_viewer.mdx §3.2) — capped at ~45vh so a portrait video never pushes the caption away. A video
// shows its cached POSTER frame (the /api/media/poster render, which also covers HEVC/ProRes) under a big
// ▶; clicking it mounts the real <video> with autoplay + native controls. An image the browser can't decode
// (HEIC, TIFF) falls back to that same poster render. Keyed by url so switching rows remounts (and stops) it.
function PreviewPane({
  target,
  mediaRef,
  resolveUrl,
  playing,
  onPlay,
}: {
  target: WarningTarget;
  mediaRef: React.RefObject<HTMLMediaElement | null>;
  resolveUrl?: (target: WarningTarget) => Promise<string | null>;
  playing: boolean;
  onPlay: () => void;
}) {
  const p = target.preview!;
  const dims = p.width && p.height ? `${p.width}×${p.height}` : null;
  // §4.5.2 caption — file name · pixel dimensions · size
  const caption = [target.name ?? target.label, dims, target.sizeText ?? target.sublabel]
    .filter(Boolean)
    .join(" · ");

  // Use the target's direct url, else lazily resolve one (e.g. a media grant) for this selected row (§4.5.2).
  // `failed` distinguishes "still loading" from "no bytes to show" so a missing grant never spins forever.
  const [url, setUrl] = useState<string | null>(p.url || null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (p.url) {
      setUrl(p.url);
      return;
    }
    let alive = true;
    setUrl(null);
    if (!resolveUrl) {
      setFailed(true);
      return;
    }
    resolveUrl(target)
      .then((u) => {
        if (!alive) return;
        setUrl(u);
        if (!u) setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id, p.url]);

  // The poster render rides the same signed grant: /api/media/raw?… → /api/media/poster?…&w=960.
  const posterUrl = url && url.includes("/api/media/raw") ? `${url.replace("/api/media/raw", "/api/media/poster")}&w=960` : null;
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [posterBroken, setPosterBroken] = useState(false);
  useEffect(() => {
    setImgSrc(url);
    setPosterBroken(false);
  }, [url]);

  // The click that left the poster is still a fresh user gesture, so start playback explicitly the moment
  // the <video> mounts. The `autoplay` attribute alone was not honored for a freshly mounted element
  // (it sat at readyState 0, never fetching), while an explicit play() starts it at once.
  useEffect(() => {
    if (!playing || p.kind !== "video" || !url) return;
    void mediaRef.current?.play().catch(() => {});
  }, [playing, url, p.kind, mediaRef]);

  const box = "flex w-full items-center justify-center overflow-hidden";
  const fit = "max-h-[45vh] max-w-full rounded object-contain";

  return (
    <div className="flex flex-col items-center gap-2">
      {url == null ? (
        <div className={`${box} h-40 text-xs text-black/40`}>{failed ? "No preview available" : "Loading preview…"}</div>
      ) : p.kind === "image" ? (
        <div className={box}>
          <img
            key={imgSrc ?? url}
            src={imgSrc ?? url}
            alt={target.label}
            className={fit}
            // HEIC/TIFF etc. — the browser can't decode the raw bytes; retry once with the poster JPEG render.
            onError={() => {
              if (posterUrl && imgSrc !== posterUrl) setImgSrc(posterUrl);
            }}
          />
        </div>
      ) : p.kind === "video" ? (
        <div className={box}>
          {playing ? (
            <video
              key={url}
              ref={mediaRef as React.Ref<HTMLVideoElement>}
              src={url}
              poster={posterUrl && !posterBroken ? posterUrl : undefined}
              controls
              autoPlay
              playsInline
              aria-label={target.label}
              className={fit}
            />
          ) : (
            <button
              type="button"
              onClick={onPlay}
              aria-label={`Play ${target.name ?? target.label}`}
              title="Click to play"
              className="group relative inline-flex max-w-full items-center justify-center rounded"
            >
              {posterUrl && !posterBroken ? (
                <img
                  key={posterUrl}
                  src={posterUrl}
                  alt=""
                  className={fit}
                  onError={() => setPosterBroken(true)}
                />
              ) : (
                <span className="flex h-48 w-80 max-w-full items-center justify-center rounded bg-black/80" />
              )}
              <span className="absolute inset-0 grid place-items-center">
                <span className="grid h-14 w-14 place-items-center rounded-full bg-black/55 text-white shadow-lg transition group-hover:scale-105 group-hover:bg-black/70">
                  <Play className="ml-0.5 h-7 w-7" fill="currentColor" />
                </span>
              </span>
            </button>
          )}
        </div>
      ) : p.kind === "pdf" ? (
        // §4.5.2 rev 2026-09-24 — the browser's own inline PDF viewer (scrollable, first page on top), same
        // ≤45vh box. The raw route serves .pdf as application/pdf + inline, so the frame renders the document.
        <iframe key={url} src={url} title={target.label} className="h-[45vh] w-full rounded border border-black/10 bg-white" />
      ) : (
        <div className="flex w-full flex-col items-center gap-3 px-6">
          <Music className="h-12 w-12 text-black/30" aria-hidden />
          <audio
            key={url}
            ref={mediaRef as React.Ref<HTMLAudioElement>}
            src={url}
            controls
            aria-label={target.label}
            className="w-full"
          />
        </div>
      )}
      <div className="w-full text-center text-xs text-black/60">
        <div className="flex items-center justify-center gap-2">
          <span className="truncate">{caption}</span>
          {/* §4.5.2 rev 2026-09-24 — the full viewer, in a NEW tab so the popup and its checkboxes survive. */}
          {p.openHref && (
            <a
              href={p.openHref}
              target="_blank"
              rel="noopener"
              title="Open in the full viewer (new tab)"
              className="inline-flex shrink-0 items-center gap-0.5 text-[var(--lfb-primary)] hover:underline"
            >
              Open <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
        </div>
        {p.kind === "video" && !playing && url != null && (
          <div className="mt-0.5 text-black/40">Click the video (or press Space) to play ▸</div>
        )}
        {p.kind === "audio" && <div className="mt-0.5 text-black/40">Space to play ▸</div>}
      </div>
    </div>
  );
}
