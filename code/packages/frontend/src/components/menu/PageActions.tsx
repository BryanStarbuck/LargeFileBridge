// The header "Actions ▾" page menu (page_actions.mdx §3) — the consolidated home for actions that operate
// on the WHOLE PAGE's files (or the checked subset), distinct from the row ⋮ kebab (one row) and the entity
// ⋮ "more" menu (one entity, menus.mdx §4). It is always present on a file-list page (not gated on a
// selection): the whole point is acting on "all of them" without selecting first. When rows ARE checked the
// button reads "Actions (N) ▾" so the user knows the next action runs over the checked set.
//
// It reuses the house menu popover (MenuPortal + MenuList) so it groups, divides, and clamps on-screen
// exactly like every other menu. Callers pass the Action[] (built with buildPageActions or by hand) and the
// checked count for the label.
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { MenuPortal, MenuList, type Action, type MenuPos } from "./EntityMenu";
import { clientLog } from "../../lib/clientLog.js";

export function PageActions({ actions, selectedCount = 0 }: { actions: Action[]; selectedCount?: number }) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const run = (fn: () => void | Promise<void>) => async () => {
    setPos(null);
    try {
      await fn();
    } catch (e) {
      clientLog.error("PageActions.action", e);
    }
  };
  if (actions.length === 0) return null;
  const label = selectedCount > 0 ? `Actions (${selectedCount})` : "Actions";
  return (
    <>
      <button
        aria-haspopup="menu"
        title={selectedCount > 0 ? `Actions for the ${selectedCount} checked file${selectedCount === 1 ? "" : "s"}` : "Actions for all files on this page"}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.right, y: r.bottom + 4 });
        }}
        className="flex items-center gap-1 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/70 hover:bg-slate-100"
      >
        {label} <ChevronDown className="h-4 w-4" />
      </button>
      {pos && (
        <MenuPortal pos={pos} onClose={() => setPos(null)}>
          <MenuList actions={actions} run={run} />
        </MenuPortal>
      )}
    </>
  );
}

// ── Shared builders for the two producing actions (page_actions.mdx §4) ─────────────────────────────
import { Captions, Sparkles } from "lucide-react";
import { createTranscriptions, createDescriptions, type ActionScope } from "../../lib/pageActions.js";

/**
 * The two producing page actions every file-list page carries (Create Transcriptions / Create AI
 * descriptions). `scope()` is evaluated at click time so it always reflects the CURRENT checked set: return
 * `{ paths }` for the checked subset, or `{ root }` to walk the page's root recursively when nothing is
 * checked (page_actions.mdx §1.1).
 */
export function producingActions(scope: () => ActionScope): Action[] {
  return [
    {
      id: "create-transcriptions",
      label: "Create Transcriptions",
      icon: <Captions className="h-4 w-4" />,
      group: "Create",
      onSelect: () => createTranscriptions(scope()),
    },
    {
      id: "create-descriptions",
      label: "Create AI descriptions",
      icon: <Sparkles className="h-4 w-4" />,
      group: "Create",
      onSelect: () => createDescriptions(scope()),
    },
  ];
}
