// A single "here's a thing, here's what it means, here's how to fix it" unit (use_cases.mdx §3.3).
// Header (always visible): health icon · title · optional status pills · optional Fix · chevron.
// Body (chevron): the mechanism — exact values, the manual command, the "why". Starts expanded when
// Broken (they need it now), collapsed otherwise (offer it, don't shove it — §2).
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { healthColor, healthIcon, type Health } from "./health.js";

export function DiagnosticCard({
  state,
  title,
  summary,
  pills,
  fix,
  children,
  defaultOpen,
}: {
  state: Health;
  title: ReactNode;
  summary?: ReactNode; // one-line "what it means for you"
  pills?: ReactNode; // right-aligned status pills
  fix?: ReactNode; // the one-click remedy
  children?: ReactNode; // the mechanism, behind the chevron
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? state === "bad");
  const Icon = healthIcon(state);
  const color = healthColor(state);
  const hasBody = !!children;
  return (
    <div className="rounded-lg border border-[var(--lfb-border)] bg-white">
      <div className="flex items-start gap-3 px-4 py-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0" style={{ color }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-black">{title}</span>
            {pills && <span className="ml-auto flex shrink-0 items-center gap-2">{pills}</span>}
          </div>
          {summary && <div className="mt-0.5 text-sm text-black/60">{summary}</div>}
          {hasBody && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="mt-1.5 flex items-center gap-1 text-xs text-black/50 hover:text-black"
            >
              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? "Hide details" : "Details"}
            </button>
          )}
        </div>
        {fix && <div className="shrink-0">{fix}</div>}
      </div>
      {hasBody && open && (
        <div className="border-t border-[var(--lfb-border)] px-4 py-3 pl-12 text-sm text-black/70">
          {children}
        </div>
      )}
    </div>
  );
}
