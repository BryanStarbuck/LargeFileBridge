// A small web-based single-text-input modal (dialogs.mdx §2.2) — NEVER window.prompt. Used when the app
// must collect ONE value (the Move-file destination path). Same shared Modal shell as ConfirmDialog. The
// input is focused + selected on open; Confirm is disabled while the field is empty or fails `validate`;
// Enter submits, Esc/backdrop/Cancel resolve null.
import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal.js";
import { Button } from "./Button.js";
import { Input } from "./Field.js";

export function PromptDialog({
  title,
  label,
  defaultValue = "",
  placeholder,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  validate,
  onConfirm,
  onCancel,
}: {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (v: string) => string | null;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus + select so the user can immediately overtype the default (e.g. the current path).
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const error = validate ? validate(value) : null;
  const canConfirm = value.trim().length > 0 && !error;
  const submit = () => {
    if (canConfirm) onConfirm(value);
  };

  return (
    <Modal
      title={title}
      labelledBy="prompt-dialog-title"
      onClose={onCancel}
      footer={
        <>
          <Button size="lg" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button size="lg" variant="primary" onClick={submit} disabled={!canConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {label && (
        <label htmlFor="lfb-prompt-input" className="mb-1.5 block text-sm text-black/70">
          {label}
        </label>
      )}
      <Input
        id="lfb-prompt-input"
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-invalid={!!error}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      {error && <div className="mt-1.5 text-xs text-[var(--lfb-bad)]">{error}</div>}
    </Modal>
  );
}
