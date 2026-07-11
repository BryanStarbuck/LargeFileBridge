// The blue arrow button that opens a warning's educate-and-fix popup (warnings.mdx §3).
// A solid brand-blue circle with a white right-pointing arrow, sitting on the RIGHT of a
// WarningBanner. Severity lives in the banner tint + icon; ACTION lives in blue — so "the thing
// you press to move forward" is the same blue everywhere. Clicking opens the WarningPopup (§4); the
// component owns the open/closed state and restores focus to itself on close.
import { useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { WarningPopup } from "./WarningPopup.js";
import type { WarningDef } from "./warnings/registry.js";

export function WarningArrowButton({
  warning,
  onApplied,
}: {
  warning: WarningDef;
  onApplied?: () => void; // fired after a successful fix so the page can refetch and re-derive state
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // A warning with no popup is informational — render nothing (no arrow). warnings.mdx §2.
  if (!warning.popup) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="dialog"
        aria-label={`Open details and fix: ${warning.headline}`}
        onClick={() => setOpen(true)}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white transition hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ background: "var(--lfb-primary)", outlineColor: "var(--lfb-primary)" }}
      >
        <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
      </button>
      {open && (
        <WarningPopup
          warning={warning}
          onClose={() => {
            setOpen(false);
            btnRef.current?.focus();
          }}
          onApplied={() => {
            onApplied?.();
          }}
        />
      )}
    </>
  );
}
