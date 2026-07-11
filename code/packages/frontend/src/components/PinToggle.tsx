// The one pin control used EVERYWHERE a file/CID that can be pinned appears (ipfs.mdx §3).
// Visual contract (LOCKED so it reads identically across the app):
//   • pinned      → a SOLID pin filled with our dark blue (--lfb-pin)
//   • not pinned  → the same pin as an OUTLINE, no fill, muted (--lfb-pin-muted)
// Click toggles. Purely presentational: the caller wires `onToggle` to whatever "pin" means on
// that surface (pin/unpin a CID on the IPFS page; the pin⇄ignore decision on a repo file).
import { memo } from "react";
import { Pin } from "lucide-react";

export const PinToggle = memo(function PinToggle({
  pinned,
  onToggle,
  disabled = false,
  busy = false,
  size = 16,
  title,
}: {
  pinned: boolean;
  onToggle: () => void;
  disabled?: boolean;
  busy?: boolean;
  size?: number;
  title?: string;
}) {
  const label =
    title ??
    (disabled
      ? "Can't be pinned yet"
      : pinned
        ? "Pinned — click to unpin"
        : "Not pinned — click to pin");
  return (
    <button
      type="button"
      role="switch"
      aria-checked={pinned}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="inline-flex items-center justify-center rounded p-1 transition-colors hover:bg-[var(--lfb-primary-tint)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <Pin
        size={size}
        className={busy ? "animate-pulse" : ""}
        style={{
          color: pinned ? "var(--lfb-pin)" : "var(--lfb-pin-muted)",
          fill: pinned ? "var(--lfb-pin)" : "none",
        }}
      />
    </button>
  );
});
