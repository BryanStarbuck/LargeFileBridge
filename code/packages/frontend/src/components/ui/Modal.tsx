// The shared modal shell (styles.css `.lfb-scrim` / `.lfb-modal`). The app hand-rolls its dialogs in a
// dozen files and each re-invented the scrim, radius and elevation; this centralizes the LOOK and the
// two behaviours every one of them needs — Escape closes, a backdrop click closes, the panel swallows
// its own clicks. Each caller keeps its own z-index (deliberate layering) via `z`.
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { IconButton } from "./Button.js";

export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  width = "32rem",
  z = 40,
  labelledBy = "lfb-modal-title",
  className,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  /** Omit to make the modal non-dismissable (no Escape, no backdrop click, no ✕). */
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  z?: number;
  labelledBy?: string;
  className?: string;
}) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="lfb-scrim fixed inset-0 grid place-items-center p-4"
      style={{ zIndex: z }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? labelledBy : undefined}
        onClick={(e) => e.stopPropagation()}
        style={{ width, maxWidth: "100%" }}
        className={cn("lfb-modal flex max-h-[85vh] flex-col", className)}
      >
        {title && (
          <div className="flex items-start gap-2 border-b border-[var(--lfb-border)] px-5 py-3.5">
            {icon}
            <h2 id={labelledBy} className="min-w-0 flex-1 text-base font-semibold text-black">
              {title}
            </h2>
            {onClose && (
              <IconButton label="Close" onClick={onClose} className="-mr-1.5 -mt-0.5">
                <X className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--lfb-border)] px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
