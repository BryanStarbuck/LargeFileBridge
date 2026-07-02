// The tab strip at the top of the File System area (full_paths.mdx §2): switches between the
// column browser (/fs, directory.mdx) and the flat Full-paths table (/fs/paths). Both tabs keep the
// "File System" left-bar item active.
import { Link, useRouterState } from "@tanstack/react-router";
import { Columns3, ListTree } from "lucide-react";

const TABS = [
  { to: "/fs", label: "Column view", icon: Columns3 },
  { to: "/fs/paths", label: "Full paths", icon: ListTree },
] as const;

export function FsTabs() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="flex items-center gap-1 border-b border-[var(--lfb-border)] px-2">
      {TABS.map((t) => {
        const active = t.to === "/fs" ? path === "/fs" : path.startsWith(t.to);
        const Icon = t.icon;
        return (
          <Link
            key={t.to}
            to={t.to}
            className="-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm"
            style={
              active
                ? { borderColor: "var(--lfb-primary)", color: "var(--lfb-primary)", fontWeight: 500 }
                : { borderColor: "transparent", color: "#000" }
            }
          >
            <Icon className="h-4 w-4" /> {t.label}
          </Link>
        );
      })}
    </div>
  );
}
