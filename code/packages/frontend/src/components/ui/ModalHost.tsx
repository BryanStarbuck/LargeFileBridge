// The single in-app modal host (dialogs.mdx §2.3). Mounted ONCE at the app root; it subscribes to the
// modals bus (lib/modals.ts) and renders the matching ConfirmDialog / PromptDialog for whatever
// confirmModal()/promptModal() request is active, resolving the caller's promise on the user's choice. This
// is why an imperative click handler anywhere in the app can `await confirmModal(...)` without any local
// React state — the same single-slot provider pattern as FirstTimeStorageWizardProvider / the model-consent
// dialog. Only one modal shows at a time (a new request replaces the current one, resolving it as cancelled).
import { useEffect, useState } from "react";
import { onModalRequested, type ModalRequest } from "../../lib/modals.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { PromptDialog } from "./PromptDialog.js";

export function ModalHost() {
  const [req, setReq] = useState<ModalRequest | null>(null);

  useEffect(
    () =>
      onModalRequested((next) => {
        // Replace any in-flight modal, resolving it as cancelled so its awaiter never hangs.
        setReq((cur) => {
          if (cur) {
            if (cur.kind === "prompt") cur.resolve(null);
            else cur.resolve(false);
          }
          return next;
        });
      }),
    [],
  );

  if (!req) return null;

  if (req.kind === "confirm") {
    return (
      <ConfirmDialog
        title={req.title}
        body={req.body}
        confirmLabel={req.confirmLabel}
        cancelLabel={req.cancelLabel}
        danger={req.danger ?? true}
        onConfirm={() => {
          req.resolve(true);
          setReq(null);
        }}
        onCancel={() => {
          req.resolve(false);
          setReq(null);
        }}
      />
    );
  }

  return (
    <PromptDialog
      title={req.title}
      label={req.label}
      defaultValue={req.defaultValue}
      placeholder={req.placeholder}
      confirmLabel={req.confirmLabel}
      validate={req.validate}
      onConfirm={(value) => {
        req.resolve(value);
        setReq(null);
      }}
      onCancel={() => {
        req.resolve(null);
        setReq(null);
      }}
    />
  );
}
