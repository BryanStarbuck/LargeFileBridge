// Text/select fields on the house shape (styles.css `.lfb-input`). The point is the FOCUS signal: every
// field in the app used `outline-none focus:border-[var(--lfb-primary)]`, i.e. a 1px hairline swap that
// a keyboard user can easily miss. `.lfb-input:focus` draws a real ring.
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn("lfb-input w-full", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn("lfb-input w-full", className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={cn("lfb-input w-full cursor-pointer pr-8", className)} {...rest} />;
  },
);

/** A labelled field row: label above, optional hint/error below. Keeps settings forms on one rhythm. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-black">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-[var(--lfb-bad)]">{error}</p>
      ) : (
        hint && <p className="mt-1 text-xs text-black/50">{hint}</p>
      )}
    </div>
  );
}
