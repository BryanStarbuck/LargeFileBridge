// The educate-and-fix popup (warnings.mdx §4). Opened by WarningArrowButton (§3). Follows the app's
// hand-rolled modal pattern (ConfirmDialog): fixed overlay, backdrop-click to cancel, inner
// stopPropagation, Esc to cancel — NEVER window.confirm.
//
// TWO LAYOUTS (§4.0), chosen automatically by whether the warning names specific subjects (`targets`):
//   • single-pane (narrow w-[34rem]) — a one-click engine/config/worker fix (Start IPFS, Fix gateway).
//   • two-pane (WIDE, up to 80vw, overlays the left nav) — a file/directory-scoped warning. The LEFT
//     column educates + options; the RIGHT column is the SUBJECTS LIST (§4.5): the actual files/dirs,
//     each with a checkbox, all checked at open. Unchecking excludes; Apply runs Task X over exactly
//     the CHECKED rows; a LIVE count (§4.6) tracks checked.size in the list header AND the button label.
// Footer (both layouts): Cancel HYPERLINK left + blue action button (white text + right chevron) right.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { healthColor, healthIcon } from "./health.js";
import { Disclosure } from "./Disclosure.js";
import { useProgress } from "../../progress/ProgressContext.js";
import {
  initialCheckedTargets,
  initialSelection,
  pluralizeNoun,
  radiosSatisfied,
  resolveActionLabel,
  type WarningDef,
  type WarningSelection,
} from "./warnings/registry.js";

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
}: {
  warning: WarningDef;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const popup = warning.popup!;
  const targets = popup.targets ?? [];
  const hasTargets = targets.length > 0;
  const noun = popup.targetNoun ?? "file";

  const [sel, setSel] = useState<WarningSelection>(() => initialSelection(popup));
  const [checked, setChecked] = useState<Set<string>>(() => initialCheckedTargets(popup));
  const [query, setQuery] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false); // second tap needed for a destructive apply
  const { run } = useProgress(); // §5.3 — async fixes hand off to the bottom Progress dock

  const Icon = healthIcon(warning.state);
  const color = healthColor(warning.state);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const destructive = popup.destructive?.(sel) ?? false;
  const targetsOk = !hasTargets || checked.size > 0; // §5.2 — need ≥1 checked subject to apply
  const canApply =
    !applying && radiosSatisfied(popup, sel) && targetsOk && (popup.canApply ? popup.canApply(sel) : true);

  useEffect(() => {
    if (destructive && !popup.options?.length) cancelRef.current?.focus();
    else if (popup.options?.length) firstFieldRef.current?.focus();
    else actionRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
  const selectAll = () => {
    setConfirming(false);
    setChecked(new Set(targets.map((t) => t.id))); // whole found set, not just the filtered window (§4.5)
  };
  const clearAll = () => {
    setConfirming(false);
    setChecked(new Set());
  };

  const doApply = async () => {
    if (!canApply) return;
    if (destructive && !confirming) {
      setConfirming(true); // §5.4 — explicit second tap for a lossy/destructive fix
      return;
    }
    const ids = [...checked];

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
              await popup.apply(sel, ids);
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
      await popup.apply(sel, ids);
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
  const base = useComposedLabel ? composeActionLabel(checkedAxisKeys) : resolveActionLabel(popup, sel);
  const countSuffix = hasTargets ? ` — ${checked.size} ${pluralizeNoun(noun, checked.size)}` : "";
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
  const filtered = useMemo(() => {
    if (!query.trim()) return targets;
    const q = query.toLowerCase();
    return targets.filter(
      (t) => t.label.toLowerCase().includes(q) || (t.sublabel ?? "").toLowerCase().includes(q),
    );
  }, [targets, query]);

  const subjectsHeading = `${
    noun === "directory" ? "Directories" : `${noun[0].toUpperCase()}${noun.slice(1)}s`
  } this applies to`;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={`flex max-h-[85vh] flex-col overflow-hidden rounded-xl bg-white shadow-xl ${
          hasTargets ? "w-[80vw] max-w-[80rem] md:min-w-[44rem]" : "w-[34rem] max-w-full"
        }`}
        onClick={(e) => e.stopPropagation()}
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
            className="-mr-1 -mt-1 rounded p-1 text-black/40 hover:bg-black/5 hover:text-black/70"
          >
            <span aria-hidden className="text-lg leading-none">×</span>
          </button>
        </div>

        {/* Body — one column, or two (educate/options | subjects list) */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* LEFT: educate + options */}
          <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-4 ${hasTargets ? "md:w-1/2" : ""}`}>
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
                <div className="text-xs text-black/60" aria-live="polite">
                  {checked.size} of {targets.length} selected
                </div>
              </div>
              <div className="flex items-center gap-3 px-5 pb-2 text-xs">
                <button type="button" onClick={selectAll} className="text-[var(--lfb-primary)] hover:underline">
                  Select all
                </button>
                <button type="button" onClick={clearAll} className="text-[var(--lfb-primary)] hover:underline">
                  Clear
                </button>
                {showSearch && (
                  <div className="ml-auto flex items-center gap-1 rounded-md border border-[var(--lfb-border)] px-2 py-1">
                    <Search className="h-3.5 w-3.5 text-black/40" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Filter…"
                      className="w-28 bg-transparent text-xs outline-none"
                    />
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                {filtered.map((t) => (
                  <label
                    key={t.id}
                    className="flex cursor-pointer items-start gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-black/[0.03]"
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(t.id)}
                      onChange={() => toggleTarget(t.id)}
                      className="mt-0.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-black">{t.label}</span>
                      {t.sublabel && <span className="block truncate text-xs text-black/50">{t.sublabel}</span>}
                    </span>
                  </label>
                ))}
                {filtered.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-black/50">No matches.</div>
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
