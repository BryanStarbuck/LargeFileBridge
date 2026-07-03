// A bordered, titled card (use_cases.mdx §3.7). Optionally collapsible (advanced groups collapse by
// default). Settings / Repo-settings / entity pages are built from these so they all share one look.
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { healthColor, healthIcon, type Health } from "./health.js";

export function Section({
  title,
  subtitle,
  right,
  state,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode; // right-aligned header content (a health line, a link, a pill)
  state?: Health; // when set, shows the health icon before the title
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = state ? healthIcon(state) : null;
  const HeaderTag = collapsible ? "button" : "div";
  return (
    <section className="mb-4 rounded-lg border border-[var(--lfb-border)] bg-white">
      <HeaderTag
        type={collapsible ? "button" : undefined}
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
        className={`flex w-full items-center gap-2 px-4 py-3 text-left ${collapsible ? "hover:bg-slate-50" : ""}`}
      >
        {collapsible && (
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-black/40 transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
        {Icon && <Icon className="h-4 w-4 shrink-0" style={{ color: healthColor(state!) }} />}
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-black">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-black/60">{subtitle}</p>}
        </div>
        {right && <div className="shrink-0 text-sm">{right}</div>}
      </HeaderTag>
      {open && <div className="border-t border-[var(--lfb-border)] px-4 py-3">{children}</div>}
    </section>
  );
}
