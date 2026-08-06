// The house button (styles.css `.lfb-btn*`). Before this, ~60 distinct class strings across the pages
// spelled out what are really four variants and three sizes — with three different disabled opacities
// and a `hover:opacity-90` that washed a solid fill out instead of darkening it.
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/cn.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "lfb-btn-primary",
  secondary: "lfb-btn-secondary",
  ghost: "lfb-btn-ghost",
  danger: "lfb-btn-danger",
};

const SIZE: Record<ButtonSize, string> = { sm: "lfb-btn-sm", md: "", lg: "lfb-btn-lg" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Swaps the leading icon for a spinner and blocks the click — a mutation in flight must not fire twice. */
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn("lfb-btn", VARIANT[variant], SIZE[size], className)}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/** Icon-only button. `label` is required — an unlabeled glyph is invisible to a screen reader. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }
>(function IconButton({ label, active, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      aria-label={label}
      title={rest.title ?? label}
      className={cn("lfb-icon-btn", active && "bg-[var(--lfb-primary-tint)] text-[var(--lfb-primary)]", className)}
      {...rest}
    >
      {children}
    </button>
  );
});
