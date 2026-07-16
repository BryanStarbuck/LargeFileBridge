// The page action-links ROW (page_actions.mdx §0/§3) — the VISIBLE horizontal row of blue text
// hyperlinks that sits directly UNDER the page title and operates on the WHOLE PAGE's files (or the
// checked subset). This REPLACES the earlier "Actions ▾" dropdown: every action is an inline link the
// user clicks in one step, matching the sister-app processing-queue .q-actions row
// (~/BGit/all/marketing/ai/code/ui/Q/page_processing_queue.js — setupActions()/.q-actions CSS).
//
// Anatomy (LOCKED, §3): a flex row (gap:14px) of hyperlinks, each with a leading lucide icon (~14px),
// thin "·" separators between items, underline on hover, red tint (var(--lfb-bad)) for destructive
// offers — which open a small web confirm modal (ConfirmDialog, never window.confirm) before acting.
// Producing items append the checked count to their label when a selection exists. An optional trailing
// "More ▾" overflow renders ONLY when there are overflow items (default: none — all inline).
import { forwardRef, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Action } from "./EntityMenu";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { clientLog } from "../../lib/clientLog.js";

const GAP = 14; // must match the .lfb-actions flex gap (styles.css)

export function PageActions({
  actions,
  selectedCount = 0,
  overflow = [],
}: {
  actions: Action[];
  selectedCount?: number;
  /**
   * Optional MANUAL overflow items — when non-empty, the row renders `actions` inline and these under
   * "More ▾" (the legacy explicit split). When empty (the default), the row is WIDTH-MEASURED (§3.1): it
   * measures what fits and splits `actions` into an inline set + a right-pinned "More ▾" overflow.
   */
  overflow?: Action[];
}) {
  // The pending destructive action awaiting confirmation in the modal.
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const manualOverflow = overflow.length > 0;

  const run = async (a: Action) => {
    try {
      await a.onSelect();
    } catch (e) {
      clientLog.error("PageActions.action", e);
    }
  };

  const activate = (a: Action) => {
    if (a.disabled) return;
    if (a.confirm) setConfirming(a);
    else void run(a);
  };

  const labelFor = (a: Action) =>
    a.countWhenSelected && selectedCount > 0 ? `${a.label} (${selectedCount})` : a.label;

  // ── Width-measured split (§3.1) ──────────────────────────────────────────────────────────────────
  // A hidden off-screen copy of ALL items (identical markup, so the measurement matches the visible row)
  // lets us read each item's right edge and the "More ▾" width, then walk left→right keeping items while
  // they fit — reserving room for "More ▾" — and pushing the rest into overflow. A ResizeObserver re-fits
  // on width changes; the `labelsKey` dep re-fits when a selection-count label grows/shrinks.
  const wrapRef = useRef<HTMLDivElement>(null);
  const segRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const moreRef = useRef<HTMLSpanElement | null>(null);
  const [inlineCount, setInlineCount] = useState(actions.length);
  const labelsKey = actions.map((a) => `${a.id}:${labelFor(a)}`).join("|");

  useLayoutEffect(() => {
    if (manualOverflow) return;
    const fit = () => {
      const wrap = wrapRef.current;
      const n = actions.length;
      if (!wrap || n === 0) {
        setInlineCount(n);
        return;
      }
      const avail = wrap.clientWidth;
      const rightEdge = (i: number) => {
        const el = segRefs.current[i];
        return el ? el.offsetLeft + el.offsetWidth : 0;
      };
      const totalRight = rightEdge(n - 1);
      if (totalRight <= avail) {
        setInlineCount(n); // everything fits — no More ▾
        return;
      }
      // Reserve the "· More ▾" chunk (its leading gap+separator+button), measured off the hidden copy.
      const more = moreRef.current;
      const moreRight = more ? more.offsetLeft + more.offsetWidth : totalRight;
      const moreReserve = Math.max(0, moreRight - totalRight) || GAP;
      const availForItems = avail - moreReserve;
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (rightEdge(i) <= availForItems) count = i + 1;
        else break;
      }
      setInlineCount(count);
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
    // labelsKey captures label changes (selection counts); manualOverflow toggles the whole mode.
  }, [labelsKey, manualOverflow, actions.length]);

  const inline = manualOverflow ? actions : actions.slice(0, inlineCount);
  const overflowItems = manualOverflow ? overflow : actions.slice(inlineCount);

  if (actions.length === 0 && overflow.length === 0) return null;

  return (
    <>
      <div ref={wrapRef} className="relative w-full">
        {/* Hidden measurement layer — ALL items + a "More ▾" sample, off-screen, same markup as the row. */}
        {!manualOverflow && (
          <div
            aria-hidden
            className="lfb-actions pointer-events-none invisible absolute left-0 top-0"
          >
            {actions.map((a, i) => (
              <span key={a.id} className="contents">
                {i > 0 && <span className="sep">·</span>}
                <ActionLink
                  ref={(el) => {
                    segRefs.current[i] = el;
                  }}
                  a={a}
                  label={labelFor(a)}
                  onActivate={() => {}}
                />
              </span>
            ))}
            <span className="sep">·</span>
            <span ref={moreRef} className="inline-flex items-center gap-1 text-[var(--lfb-primary)]">
              More <ChevronDown className="h-3.5 w-3.5" />
            </span>
          </div>
        )}

        {/* The visible, single-line row (overflow clipped; the overflow set lives under More ▾). */}
        <div className="lfb-actions overflow-hidden">
          {inline.map((a, i) => (
            <span key={a.id} className="contents">
              {i > 0 && <span className="sep">·</span>}
              <ActionLink a={a} label={labelFor(a)} onActivate={() => activate(a)} />
            </span>
          ))}

          {/* More ▾ — rendered ONLY when something overflows (§3.1); pinned to the right of the row. */}
          {overflowItems.length > 0 && (
            <span className="relative ml-auto">
              <span className="sep">·</span>{" "}
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((o) => !o)}
                className="inline-flex items-center gap-1 whitespace-nowrap text-[var(--lfb-primary)] hover:underline"
              >
                More <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {moreOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-1 min-w-[13rem] rounded-md border border-[var(--lfb-border)] bg-white py-1 shadow-lg"
                >
                  {overflowItems.map((a) => (
                    <button
                      key={a.id}
                      role="menuitem"
                      disabled={a.disabled}
                      onClick={() => {
                        setMoreOpen(false);
                        activate(a);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-40 ${
                        a.danger || a.confirm ? "text-red-600 hover:bg-red-50" : "text-black hover:bg-slate-100"
                      }`}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-black/50">
                        {a.icon}
                      </span>
                      <span className="flex-1">{labelFor(a)}</span>
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title={confirming.confirm!.title}
          body={confirming.confirm!.body}
          confirmLabel={confirming.confirm!.confirmLabel ?? "Confirm"}
          danger={confirming.danger ?? true}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const a = confirming;
            setConfirming(null);
            void run(a);
          }}
        />
      )}
    </>
  );
}

const ActionLink = forwardRef<
  HTMLAnchorElement,
  { a: Action; label: string; onActivate: () => void }
>(function ActionLink({ a, label, onActivate }, ref) {
  const danger = a.danger || !!a.confirm;
  return (
    <a
      ref={ref}
      role="button"
      tabIndex={0}
      title={label}
      aria-disabled={a.disabled}
      className={`whitespace-nowrap ${danger ? "danger" : ""}`}
      onClick={(e) => {
        e.preventDefault();
        onActivate();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      {a.icon}
      {label}
    </a>
  );
});

// ── Shared builders for the three producing actions (page_actions.mdx §4, ocr.mdx §8.5) ─────────────
import { Captions, Sparkles, TextSelect } from "lucide-react";
import { createTranscriptions, createDescriptions, createOcrText, type ActionScope } from "../../lib/pageActions.js";

/**
 * The three producing page actions every file-list page carries (Create Transcriptions / Create AI
 * descriptions / Create OCR text). `scope()` is evaluated at click time so it always reflects the CURRENT
 * checked set: return `{ paths }` for the checked subset, or `{ root }` to walk the page's root recursively
 * when nothing is checked (page_actions.mdx §1.1). All append the checked count to their label when a
 * selection exists.
 *
 * ORDER IS THE CONTRACT (ocr.mdx §0/§8.2): transcription → AI description → OCR, everywhere, at every scale,
 * so the trio is learnable as one thing. OCR is last, which also makes it the first to overflow into `More ▾`
 * on a narrow page (page_actions.mdx §3.1) — correct, since it is the lowest-priority of the three.
 */
export function producingActions(scope: () => ActionScope): Action[] {
  return [
    {
      id: "create-transcriptions",
      label: "Create Transcriptions",
      icon: <Captions className="h-3.5 w-3.5" />,
      group: "Create",
      countWhenSelected: true,
      onSelect: () => createTranscriptions(scope()),
    },
    {
      id: "create-descriptions",
      label: "Create AI descriptions",
      icon: <Sparkles className="h-3.5 w-3.5" />,
      group: "Create",
      countWhenSelected: true,
      onSelect: () => createDescriptions(scope()),
    },
    {
      id: "create-ocr-text",
      label: "Create OCR text",
      icon: <TextSelect className="h-3.5 w-3.5" />,
      group: "Create",
      countWhenSelected: true,
      onSelect: () => createOcrText(scope()),
    },
  ];
}

// ── A small helper for the not-yet-wired domain offers (page_actions.mdx §4) ────────────────────────
// Several page-level domain actions (compress-all, git-ignore-big, publish-ipfs, etc.) have no batch
// backend endpoint yet. Rather than fabricate a route, we surface a graceful toast in the app's existing
// "not yet wired" style (toast.message, as ViewOneDirectoryPage already does for per-file git-ignore).
export { notWiredToast } from "../../lib/pageActions.js";

export type { Action, ActionScope };
