// The ONE reusable Start-Scan pop-up for both Videos children (duplicates.mdx §5 / subsets.mdx §5,
// LOCKED): "Start Duplicate Scan" / "Start Subset Scan". An in-app HTML modal — NEVER a native browser
// dialog (dialogs.mdx §1) — following the app's hand-rolled page-mounted modal pattern (ConfirmDialog /
// AddRepoDialog): fixed overlay, backdrop click + Esc = Skip, inner stopPropagation.
//
// Body: first the status line ("Never scanned." or "Last scanned {absolute} ({relative})."), then the
// recommendation line. Button row: a plain "Skip" HYPERLINK immediately LEFT of the dominant primary
// "Start scan ›" button (label + right chevron).
import { useEffect, useRef } from "react";
import type { VideosScanStatus } from "@lfb/shared";
import { absoluteTime, relativeTime } from "../../lib/format.js";
import type { ReviewVariant } from "./GroupReviewColumn.js";

const COPY: Record<ReviewVariant, { title: string; recommend: string }> = {
  duplicates: {
    title: "Start Duplicate Scan",
    recommend: "We recommend scanning now to find duplicate videos and images.",
  },
  subsets: {
    title: "Start Subset Scan",
    recommend: "We recommend scanning now to find videos that are clips contained inside longer videos.",
  },
};

export function StartScanModal({
  variant,
  status,
  starting,
  onSkip,
  onStart,
}: {
  variant: ReviewVariant;
  status: VideosScanStatus | undefined;
  /** True while the start POST is in flight — disables the primary button. */
  starting?: boolean;
  /** Skip (hyperlink / Esc / backdrop): close and show the page from whatever data exists. */
  onSkip: () => void;
  /** Start scan: POST the scan endpoint, close, stay on the page. */
  onStart: () => void;
}) {
  const copy = COPY[variant];
  const startRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    startRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  const statusLine = status?.lastRunAt
    ? `Last scanned ${absoluteTime(status.lastRunAt)} (${relativeTime(status.lastRunAt)}).`
    : "Never scanned.";

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={onSkip}>
      <div
        className="w-[28rem] max-w-full rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-scan-title"
      >
        <h2 id="start-scan-title" className="text-lg font-semibold text-black">
          {copy.title}
        </h2>
        <div className="mt-2 text-sm text-black/70">
          <p>{statusLine}</p>
          <p className="mt-1">{copy.recommend}</p>
        </div>
        <div className="mt-5 flex items-center justify-end gap-4">
          {/* Skip is a plain text hyperlink, NOT a button — immediately LEFT of the primary (§5). */}
          <button
            onClick={onSkip}
            className="text-sm text-[var(--lfb-primary)] underline-offset-2 hover:underline"
          >
            Skip
          </button>
          <button
            ref={startRef}
            onClick={onStart}
            disabled={starting}
            className="rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Start scan ›
          </button>
        </div>
      </div>
    </div>
  );
}
