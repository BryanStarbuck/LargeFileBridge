// A small web-based confirmation modal (page_actions.mdx §3, menus.mdx §6.1) — NEVER window.confirm.
// Destructive / irreversible page actions (Compress…, Git-ignore…, Delete…) open this before acting.
// Follows the app's hand-rolled modal pattern (ReposPage AddRepoDialog / CredentialsMissingDialog):
// a fixed overlay, backdrop-click to cancel, inner stopPropagation, Esc to cancel, focus the Cancel
// button by default so a destructive confirm is never one stray Enter away.
import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="w-[32rem] max-w-full rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div className={`flex items-center gap-2 ${danger ? "text-red-700" : "text-black"}`}>
          {danger && <AlertTriangle className="h-5 w-5" />}
          <h2 id="confirm-dialog-title" className="text-lg font-semibold">
            {title}
          </h2>
        </div>
        {body && <div className="mt-2 text-sm text-black/70">{body}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-md border border-[var(--lfb-border)] px-4 py-2 text-sm text-black/70 hover:bg-black/5"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-md px-4 py-2 text-sm font-medium text-white hover:opacity-90 ${
              danger ? "bg-[var(--lfb-bad)]" : "bg-[var(--lfb-primary)]"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
