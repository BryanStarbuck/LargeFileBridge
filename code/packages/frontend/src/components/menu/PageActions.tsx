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
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Action } from "./EntityMenu";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { clientLog } from "../../lib/clientLog.js";

export function PageActions({
  actions,
  selectedCount = 0,
  overflow = [],
}: {
  actions: Action[];
  selectedCount?: number;
  /** Optional overflow items — a trailing "More ▾" popover renders ONLY when this is non-empty (§3). */
  overflow?: Action[];
}) {
  // The pending destructive action awaiting confirmation in the modal.
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

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

  if (actions.length === 0 && overflow.length === 0) return null;

  return (
    <>
      <div className="lfb-actions">
        {actions.map((a, i) => (
          <span key={a.id} className="contents">
            {i > 0 && <span className="sep">·</span>}
            <ActionLink a={a} label={labelFor(a)} onActivate={() => activate(a)} />
          </span>
        ))}

        {/* More ▾ overflow — rendered ONLY when there are overflow items (§3, matches .q-more-wrap). */}
        {overflow.length > 0 && (
          <span className="relative">
            <span className="sep">·</span>{" "}
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((o) => !o)}
              className="inline-flex items-center gap-1 text-[var(--lfb-primary)] hover:underline"
            >
              More <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {moreOpen && (
              <div
                role="menu"
                className="absolute left-0 top-full z-50 mt-1 min-w-[13rem] rounded-md border border-[var(--lfb-border)] bg-white py-1 shadow-lg"
              >
                {overflow.map((a) => (
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

function ActionLink({ a, label, onActivate }: { a: Action; label: string; onActivate: () => void }) {
  const danger = a.danger || !!a.confirm;
  return (
    <a
      role="button"
      tabIndex={0}
      title={label}
      aria-disabled={a.disabled}
      className={danger ? "danger" : undefined}
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
}

// ── Shared builders for the two producing actions (page_actions.mdx §4) ─────────────────────────────
import { Captions, Sparkles } from "lucide-react";
import { createTranscriptions, createDescriptions, type ActionScope } from "../../lib/pageActions.js";

/**
 * The two producing page actions every file-list page carries (Create Transcriptions / Create AI
 * descriptions). `scope()` is evaluated at click time so it always reflects the CURRENT checked set: return
 * `{ paths }` for the checked subset, or `{ root }` to walk the page's root recursively when nothing is
 * checked (page_actions.mdx §1.1). Both append the checked count to their label when a selection exists.
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
  ];
}

// ── A small helper for the not-yet-wired domain offers (page_actions.mdx §4) ────────────────────────
// Several page-level domain actions (compress-all, git-ignore-big, publish-ipfs, etc.) have no batch
// backend endpoint yet. Rather than fabricate a route, we surface a graceful toast in the app's existing
// "not yet wired" style (toast.message, as ViewOneDirectoryPage already does for per-file git-ignore).
export { notWiredToast } from "../../lib/pageActions.js";

export type { Action, ActionScope };
