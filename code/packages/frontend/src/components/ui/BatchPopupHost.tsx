// The single global batch-popup host (dialogs.mdx §5.3 + §5.4). Mounted ONCE at the app root; it subscribes
// to the batch-popup bus (lib/batchPopup.ts) and renders one of TWO things for whatever a launcher requested:
//   • the "Opening window…" SPINNER modal (dialogs.mdx §5.4) while a slow /plan tree walk runs, so a
//     multi-minute walk (~2 min for ~2k files) never looks hung; and
//   • the WarningPopup for a transcribe/describe WarningDef once the plan resolves (the swap is seamless —
//     same single host slot).
// This is what lets the page action-links row and the ⋮ / right-click menu open the SAME "great pop-up" the
// Transcribable/Describable metric tile opens (the tile mounts its own WarningPopup inside MetricsStrip;
// every other entry point routes through here).
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { onBatchPopupRequested, type BatchPopupState } from "../../lib/batchPopup.js";
import { WarningPopup } from "./WarningPopup.js";

export function BatchPopupHost() {
  const [state, setState] = useState<BatchPopupState>(null);

  useEffect(() => onBatchPopupRequested((next) => setState(next)), []);

  if (!state) return null;

  // dialogs.mdx §5.4 — the "Opening window…" spinner shown while the plan walk runs. Esc / backdrop click
  // cancel it (the launcher's generation guard makes the eventual plan result a no-op).
  if (state.kind === "loading") {
    return <BatchLoadingModal headline={state.headline} sub={state.sub} onCancel={state.onCancel} />;
  }

  return <WarningPopup warning={state.def} onClose={() => setState(null)} />;
}

// A small centered modal: an animated spinner + "Opening window…" + a one-line sub. Mirrors the app's
// hand-rolled modal chrome (fixed overlay, backdrop-click to cancel, Esc to cancel) — never window.* .
function BatchLoadingModal({
  headline,
  sub,
  onCancel,
}: {
  headline: string;
  sub?: string;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="flex w-[26rem] max-w-full flex-col items-center gap-3 rounded-xl bg-white px-6 py-8 text-center shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-live="polite"
      >
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: "var(--lfb-primary)" }} aria-hidden />
        <div className="text-base font-semibold text-black">{headline}</div>
        {sub && <div className="text-sm text-black/60">{sub}</div>}
        <button
          type="button"
          onClick={onCancel}
          className="mt-1 text-sm text-[var(--lfb-primary)] hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
