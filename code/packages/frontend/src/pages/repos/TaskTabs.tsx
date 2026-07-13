// The task-tab strip in the One-repo header (task_tabs.mdx §1). Sits a little right of center — the
// breadcrumb/name on the left, Pin now + gear on the right. State-driven (not routed): selecting a tab
// re-projects the same loaded file set. Styled like the File System tabs (FsTabs): a 2px primary
// underline under the active tab.
import { TASK_TABS, TASK_TAB_ORDER, type TaskTabId } from "./taskTabs.config.js";

export function TaskTabs({
  active,
  onChange,
}: {
  active: TaskTabId;
  onChange: (id: TaskTabId) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label="Repo task tabs">
      {TASK_TAB_ORDER.map((id) => {
        const t = TASK_TABS[id];
        const Icon = t.icon;
        const isActive = id === active;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-sm ${
              isActive
                ? "border-[var(--lfb-primary)] font-medium text-black"
                : "border-transparent text-black/55 hover:text-black"
            }`}
          >
            <Icon className="h-4 w-4" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
