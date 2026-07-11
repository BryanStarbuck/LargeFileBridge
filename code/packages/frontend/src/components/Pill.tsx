// Status pills with the LOCKED colors (repos.mdx §4.2, one_repo.mdx §4.6).
import type { RepoStatus, TransferStatus } from "@lfb/shared";

const REPO: Record<RepoStatus, { label: string; cls: string }> = {
  up_to_date: { label: "up to date", cls: "bg-green-100 text-green-800" },
  pinning: { label: "pinning", cls: "bg-blue-100 text-blue-800 animate-pulse" },
  behind: { label: "behind", cls: "bg-amber-100 text-amber-800" },
  needs_review: { label: "needs review", cls: "border border-[var(--lfb-primary)] text-[var(--lfb-primary)]" },
  error: { label: "error", cls: "bg-red-100 text-red-800" },
  never: { label: "never", cls: "bg-slate-100 text-slate-600" },
};

const TRANSFER: Record<TransferStatus, { label: string; cls: string }> = {
  pinned: { label: "Pinned", cls: "bg-green-100 text-green-800" },
  pending: { label: "Pending", cls: "bg-amber-100 text-amber-800" },
  fetching: { label: "Fetching", cls: "bg-blue-100 text-blue-800 animate-pulse" },
  pushing: { label: "Pushing", cls: "bg-blue-100 text-blue-800 animate-pulse" },
  missing: { label: "Missing", cls: "border border-red-400 text-red-700" },
  error: { label: "Error", cls: "bg-red-100 text-red-800" },
  na: { label: "—", cls: "text-black/30" },
};

export function RepoStatusPill({ status }: { status: RepoStatus }) {
  const s = REPO[status];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${s.cls}`}>{s.label}</span>;
}

export function TransferPill({ status }: { status: TransferStatus }) {
  const s = TRANSFER[status];
  if (status === "na") return <span className="text-black/30">—</span>;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${s.cls}`}>{s.label}</span>;
}
