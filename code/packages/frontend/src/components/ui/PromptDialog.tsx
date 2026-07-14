// A small web-based single-text-input modal (dialogs.mdx §2.2) — NEVER window.prompt. Used when the app
// must collect ONE value (the Move-file destination path). Same modal shell as ConfirmDialog: fixed
// overlay, backdrop/Esc cancel, inner stopPropagation. The input is focused + selected on open; Confirm is
// disabled while the field is empty or fails `validate`; Enter submits, Esc/backdrop/Cancel resolve null.
import { useEffect, useRef, useState } from "react";

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const error = validate ? validate(value) : null;
  const canConfirm = value.trim().length > 0 && !error;
  const submit = () => {
    if (canConfirm) onConfirm(value);
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="w-[32rem] max-w-full rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
      >
        <h2 id="prompt-dialog-title" className="text-lg font-semibold text-black">
          {title}
        </h2>
        {label && <label className="mt-2 block text-sm text-black/70">{label}</label>}
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          className="mt-2 w-full rounded-md border border-[var(--lfb-border)] px-3 py-2 text-sm text-black outline-none focus:border-[var(--lfb-primary)]"
        />
        {error && <div className="mt-1 text-xs text-[var(--lfb-bad)]">{error}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-[var(--lfb-border)] px-4 py-2 text-sm text-black/70 hover:bg-black/5"
          >
            {cancelLabel}
          </button>
          <button
            onClick={submit}
            disabled={!canConfirm}
            className="rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
