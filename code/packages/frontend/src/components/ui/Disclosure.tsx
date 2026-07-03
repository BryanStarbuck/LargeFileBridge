// Generic chevron drill-in (use_cases.mdx §2/§3.4): a clickable summary row that expands to show
// arbitrary children. The workhorse for "surface the answer, push the mechanism deeper." A right
// chevron rotates to down on expand — the app-wide "there's more here, click to go deeper" affordance.
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function Disclosure({
  label,
  meta,
  defaultOpen = false,
  children,
  className,
}: {
  label: ReactNode;
  meta?: ReactNode; // right-aligned summary shown on the closed row (e.g. a count)
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm text-black/70 hover:text-black"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-black/40 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="flex-1 font-medium">{label}</span>
        {meta != null && <span className="shrink-0 text-xs text-black/50">{meta}</span>}
      </button>
      {open && <div className="pl-6 pr-1 pb-2 pt-0.5">{children}</div>}
    </div>
  );
}
