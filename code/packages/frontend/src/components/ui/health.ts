// The health model, in exactly ONE place (use_cases.mdx §1/§AC-4). Fixed / Improvable / Broken.
// Every page's colors + icons come from here so the whole app speaks one visual language.
import { CheckCircle2, AlertTriangle, AlertCircle, Circle, type LucideIcon } from "lucide-react";

export type Health = "ok" | "warn" | "bad" | "neutral";

// The rollup rule (§1): Broken beats Improvable beats Fixed beats Neutral. A page's overall state is
// the worst state among its parts.
const RANK: Record<Health, number> = { bad: 3, warn: 2, ok: 1, neutral: 0 };
export function worst(...states: Health[]): Health {
  return states.reduce<Health>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "neutral");
}

export function healthIcon(h: Health): LucideIcon {
  switch (h) {
    case "ok":
      return CheckCircle2;
    case "warn":
      return AlertTriangle;
    case "bad":
      return AlertCircle;
    default:
      return Circle;
  }
}

// Foreground (text/icon) color var for a state.
export function healthColor(h: Health): string {
  switch (h) {
    case "ok":
      return "var(--lfb-ok)";
    case "warn":
      return "var(--lfb-warn)";
    case "bad":
      return "var(--lfb-bad)";
    default:
      return "rgba(0,0,0,0.45)";
  }
}

// Tint background var for a state (used by banners / cards). Neutral = white.
export function healthBg(h: Health): string {
  switch (h) {
    case "ok":
      return "var(--lfb-ok-bg)";
    case "warn":
      return "var(--lfb-warn-bg)";
    case "bad":
      return "var(--lfb-bad-bg)";
    default:
      return "#fff";
  }
}

// A small status dot — the quiet Fixed-state affordance, and the leading mark on banners/cards.
export function healthDotClass(_h: Health): string {
  return "inline-block h-2 w-2 shrink-0 rounded-full";
}
