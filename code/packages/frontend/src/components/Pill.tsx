// Status pills with the LOCKED colors (repos.mdx §4.2, one_repo.mdx §4.6).
// Shape comes from `.lfb-chip` so every pill in the app is the same height and weight; only the tone
// is per-status. Tones are tint + inset ring rather than tint alone — a flat pastel block reads as a
// highlight, a ringed one reads as a status.
import type { RepoStatus, TransferStatus } from "@lfb/shared";

const REPO: Record<RepoStatus, { label: string; cls: string }> = {
  up_to_date: { label: "up to date", cls: "bg-green-50 text-green-800 ring-1 ring-inset ring-green-200" },
  pinning: { label: "pinning", cls: "bg-blue-50 text-blue-800 ring-1 ring-inset ring-blue-200 animate-pulse" },
  behind: { label: "behind", cls: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200" },
  needs_review: {
    label: "needs review",
    cls: "text-[var(--lfb-primary)] ring-1 ring-inset ring-[var(--lfb-primary)]",
  },
  error: { label: "error", cls: "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200" },
  never: { label: "never", cls: "bg-slate-50 text-slate-600 ring-1 ring-inset ring-slate-200" },
};

const TRANSFER: Record<TransferStatus, { label: string; cls: string }> = {
  pinned: { label: "Pinned", cls: "bg-green-50 text-green-800 ring-1 ring-inset ring-green-200" },
  pending: { label: "Pending", cls: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200" },
  fetching: { label: "Fetching", cls: "bg-blue-50 text-blue-800 ring-1 ring-inset ring-blue-200 animate-pulse" },
  pushing: { label: "Pushing", cls: "bg-blue-50 text-blue-800 ring-1 ring-inset ring-blue-200 animate-pulse" },
  missing: { label: "Missing", cls: "text-red-700 ring-1 ring-inset ring-red-300" },
  error: { label: "Error", cls: "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200" },
  na: { label: "—", cls: "text-black/30" },
};

export function RepoStatusPill({ status }: { status: RepoStatus }) {
  const s = REPO[status];
  return <span className={`lfb-chip ${s.cls}`}>{s.label}</span>;
}

export function TransferPill({ status }: { status: TransferStatus }) {
  const s = TRANSFER[status];
  if (status === "na") return <span className="text-black/30">—</span>;
  return <span className={`lfb-chip ${s.cls}`}>{s.label}</span>;
}
