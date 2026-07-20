// The task-tab strip in the One-repo header (task_tabs.mdx §1). Sits a little right of center — the
// breadcrumb/name on the left, the gear + header primary on the right. State-driven (not routed):
// selecting a tab re-projects the same loaded file set. Styled like the File System tabs (FsTabs): a 2px
// primary underline under the active tab.
//
// OVERFLOW (task_tabs.mdx §1.4). The repo NAME is the biggest, boldest thing on this page and must never
// wrap or be squeezed by the tabs. So the strip is width-measured: it keeps only the tabs that fit and
// moves the rest — always taking from the RIGHT — into a trailing "⌄" overflow menu. The chevron renders
// ONLY when something actually overflows; when every tab fits there is no extra chrome at all. An active
// tab that lands in the overflow is pulled back into the visible set so the current tab is always shown.
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { TASK_TABS, TASK_TAB_ORDER, type TaskTabId } from "./taskTabs.config.js";

export function TaskTabs({
  active,
  onChange,
}: {
  active: TaskTabId;
  onChange: (id: TaskTabId) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const chevronRef = useRef<HTMLSpanElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(TASK_TAB_ORDER.length);
  const [open, setOpen] = useState(false);

  // Width-measured split, the same technique the page action-links row uses (PageActions §3.1): a hidden
  // off-screen copy with identical markup gives each tab's right edge and the chevron's width, so we can
  // walk left→right keeping tabs while they fit — reserving room for the chevron — with no layout thrash.
  useLayoutEffect(() => {
    const fit = () => {
      const wrap = wrapRef.current;
      const n = TASK_TAB_ORDER.length;
      if (!wrap) return;
      const avail = wrap.clientWidth;
      const rightEdge = (i: number) => {
        const el = measureRefs.current[i];
        return el ? el.offsetLeft + el.offsetWidth : 0;
      };
      if (rightEdge(n - 1) <= avail) {
        setVisibleCount(n);
        return;
      }
      const chev = chevronRef.current;
      const reserve = chev ? chev.offsetWidth + 4 : 28;
      const availForTabs = avail - reserve;
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (rightEdge(i) <= availForTabs) count = i + 1;
        else break;
      }
      setVisibleCount(Math.max(1, count));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  let shown = TASK_TAB_ORDER.slice(0, visibleCount);
  let hidden = TASK_TAB_ORDER.slice(visibleCount);
  // The active tab is always visible (task_tabs.mdx §1.3) — if it overflowed, swap it with the last
  // visible tab so the underline is never hidden inside the menu.
  if (hidden.includes(active)) {
    const swapOut = shown[shown.length - 1];
    shown = [...shown.slice(0, -1), active];
    hidden = [swapOut, ...hidden.filter((id) => id !== active)];
  }

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1" role="tablist" aria-label="Repo task tabs">
      {/* Hidden measurement layer — every tab + a chevron sample, same markup as the visible strip. */}
      <div aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-1">
        {TASK_TAB_ORDER.map((id, i) => {
          const t = TASK_TABS[id];
          const Icon = t.icon;
          return (
            <button
              key={id}
              ref={(el) => {
                measureRefs.current[i] = el;
              }}
              className="flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-sm font-medium"
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
        <span ref={chevronRef} className="inline-flex px-1.5 py-1.5">
          <ChevronDown className="h-4 w-4" />
        </span>
      </div>

      <div className="flex items-center justify-end gap-1 overflow-hidden">
        {shown.map((id) => (
          <Tab key={id} id={id} active={active} onChange={onChange} />
        ))}

        {/* The overflow chevron — rendered ONLY when tabs don't fit (task_tabs.mdx §1.4). */}
        {hidden.length > 0 && (
          <span className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={open}
              title={`${hidden.length} more tab${hidden.length === 1 ? "" : "s"}`}
              onClick={() => setOpen((o) => !o)}
              onBlur={() => setTimeout(() => setOpen(false), 120)}
              className="-mb-px flex items-center border-b-2 border-transparent px-1.5 py-1.5 text-black/55 hover:text-black"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
            {open && (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 min-w-[12rem] rounded-md border border-[var(--lfb-border)] bg-white py-1 shadow-lg"
              >
                {hidden.map((id) => {
                  const t = TASK_TABS[id];
                  const Icon = t.icon;
                  return (
                    <button
                      key={id}
                      role="menuitem"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onChange(id);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-black hover:bg-slate-100"
                    >
                      <Icon className="h-4 w-4 text-black/50" />
                      {t.label}
                    </button>
                  );
                })}
              </div>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function Tab({
  id,
  active,
  onChange,
}: {
  id: TaskTabId;
  active: TaskTabId;
  onChange: (id: TaskTabId) => void;
}) {
  const t = TASK_TABS[id];
  const Icon = t.icon;
  const isActive = id === active;
  return (
    <button
      role="tab"
      aria-selected={isActive}
      onClick={() => onChange(id)}
      className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-sm ${
        isActive
          ? "border-[var(--lfb-primary)] font-medium text-black"
          : "border-transparent text-black/55 hover:text-black"
      }`}
    >
      <Icon className="h-4 w-4" />
      {t.label}
    </button>
  );
}
