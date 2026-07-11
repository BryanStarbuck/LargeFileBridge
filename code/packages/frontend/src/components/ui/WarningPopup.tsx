// The educate-and-fix popup (warnings.mdx §4). Opened by WarningArrowButton (§3). Follows the app's
// hand-rolled modal pattern (ConfirmDialog): fixed overlay, backdrop-click to cancel, inner
// stopPropagation, Esc to cancel — NEVER window.confirm. Anatomy top→bottom (§4):
//   • Header  — state icon + title + close (×)
//   • Body    — "What this is" + "Why it matters" education, optional "Details" disclosure
//   • Options — radios (mutually-exclusive decision) / checkboxes (independent toggles)
//   • Footer  — Cancel HYPERLINK on the LEFT + blue action button (white text + right chevron) on the RIGHT
// Lifecycle (§5): choose → Apply (pending) → success (close + page refetch) | error (stay open, show it).
// Destructive/lossy choices (§5.4) turn the button red and require a one-tap inline confirm first.
import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { healthColor, healthIcon } from "./health.js";
import { Disclosure } from "./Disclosure.js";
import {
  initialSelection,
  radiosSatisfied,
  resolveActionLabel,
  type WarningDef,
  type WarningSelection,
} from "./warnings/registry.js";

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
  const [sel, setSel] = useState<WarningSelection>(() => initialSelection(popup));
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false); // second tap needed for a destructive apply

  const Icon = healthIcon(warning.state);
  const color = healthColor(warning.state);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const destructive = popup.destructive?.(sel) ?? false;
  const canApply =
    !applying &&
    radiosSatisfied(popup, sel) &&
    (popup.canApply ? popup.canApply(sel) : true);

  useEffect(() => {
    // Focus the first option, or the action button if there are none — but for a destructive default,
    // focus Cancel so a stray Enter never fires a lossy action (§6, mirrors ConfirmDialog).
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
  const setCheck = (name: string, checked: boolean) => {
    setConfirming(false);
    setSel((s) => ({ ...s, checks: { ...s.checks, [name]: checked } }));
  };

  const doApply = async () => {
    if (!canApply) return;
    if (destructive && !confirming) {
      setConfirming(true); // §5.4 — require an explicit second tap for a lossy/destructive fix
      return;
    }
    setApplying(true);
    setError(null);
    try {
      await popup.apply(sel);
      onApplied?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setApplying(false);
      setConfirming(false);
    }
  };

  const actionBg = destructive ? "var(--lfb-bad)" : "var(--lfb-primary)";
  const label = confirming ? `Confirm — ${resolveActionLabel(popup, sel)}` : resolveActionLabel(popup, sel);

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

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[34rem] max-w-full flex-col overflow-hidden rounded-xl bg-white shadow-xl"
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

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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

          {/* Options */}
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

        {/* Footer — Cancel hyperlink LEFT, action button RIGHT (white text + right chevron) */}
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
