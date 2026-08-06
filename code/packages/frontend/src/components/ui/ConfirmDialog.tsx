// A small web-based confirmation modal (page_actions.mdx §3, menus.mdx §6.1) — NEVER window.confirm.
// Destructive / irreversible page actions (Compress…, Git-ignore…, Delete…) open this before acting.
// Built on the shared Modal shell (scrim, Esc, backdrop click); focuses the Cancel button on open so a
// destructive confirm is never one stray Enter away.
import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal.js";
import { Button } from "./Button.js";

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
  }, []);

  return (
    <Modal
      title={title}
      labelledBy="confirm-dialog-title"
      icon={danger ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--lfb-bad)]" /> : undefined}
      onClose={onCancel}
      footer={
        <>
          <Button ref={cancelRef} size="lg" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button size="lg" variant={danger ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <div className="text-sm leading-relaxed text-black/70">{body}</div>}
    </Modal>
  );
}
