export { formatBytes } from "@lfb/shared";

export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function absoluteTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleString();
}

export function middleTruncate(s: string, max = 48): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 1) / 2);
  return `${s.slice(0, keep)}…${s.slice(s.length - keep)}`;
}

// A long IPFS Peer ID shown as its first 8 + `…` + last 8 characters (devices.mdx §6): enough to
// recognise both ends while keeping the column narrow. Short ids (≤17 chars) pass through untouched.
export function truncatePeerId(id: string, edge = 8): string {
  if (id.length <= edge * 2 + 1) return id;
  return `${id.slice(0, edge)}…${id.slice(-edge)}`;
}
