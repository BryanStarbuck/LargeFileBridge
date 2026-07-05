// The Communities page (communities.mdx). A community is a publisher of large PUBLIC files a user can
// subscribe to. The page shows a STORAGE HEADER (budget meter, §6) measured from this computer's real
// free disk, then a TanStack table (§7) where each community carries an INTENT (Get and/or Support, §3)
// and a BACKUP MODE (Block · Recommended · Full, §4) bounded by the machine-wide budget (§5).
//
// Charter (§1): Support = pin this publisher's PUBLIC files to add redundancy — an explicit, per-community
// opt-in, never a public gateway/relay. Every community defaults to Block until the user acts.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Users, Download, Radio, HardDrive } from "lucide-react";
import { toast } from "sonner";
import type { CommunityRow, CommunityBackupMode, CommunitySubscriptionPatch } from "@lfb/shared";
import { formatBytes } from "@/lib/format";
import { api } from "@/api/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataTable } from "@/components/table/DataTable";
import type { LfbColumn } from "@/components/table/types";
import { clientLog } from "@/lib/clientLog";

const GIB = 1024 * 1024 * 1024;
const MODES: CommunityBackupMode[] = ["block", "recommended", "full"];
const MODE_LABEL: Record<CommunityBackupMode, string> = { block: "Block", recommended: "Recommended", full: "Full" };

export function CommunitiesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["communities"], queryFn: api.communities });

  // One community's subscription patch (intent / backup mode / bookmark) — invalidates so the budget
  // meter and per-row targets re-plan against the change.
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: CommunitySubscriptionPatch }) => api.patchCommunity(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["communities"] }),
    onError: (e: Error) => { clientLog.error("CommunitiesPage.patch", e); toast.error(e.message); },
  });

  const setBudget = useMutation({
    mutationFn: (bytes: number | null) => api.setCommunityBudget(bytes),
    onSuccess: () => { toast.success("Community budget updated"); qc.invalidateQueries({ queryKey: ["communities"] }); },
    onError: (e: Error) => { clientLog.error("CommunitiesPage.budget", e); toast.error(e.message); },
  });

  const rows = data?.communities ?? [];

  const columns: LfbColumn<CommunityRow>[] = [
    {
      id: "bookmark", header: "Bookmark", kind: "enum", filterOptions: ["yes", "no"],
      accessor: (c) => (c.subscription.bookmarked ? "yes" : "no"),
      cell: (c) => (
        <BookmarkToggle
          on={c.subscription.bookmarked}
          onToggle={() => patch.mutate({ id: c.id, body: { bookmarked: !c.subscription.bookmarked } })}
        />
      ),
    },
    {
      id: "name", header: "Community", kind: "text", accessor: (c) => c.name,
      cell: (c) => (
        <span className="flex flex-col">
          <span className="flex items-center gap-2 font-medium"><Users className="h-4 w-4 text-black/40" />{c.name}</span>
          <span className="text-xs text-black/50">{c.publisher ?? "—"}{c.description ? ` · ${c.description}` : ""}</span>
        </span>
      ),
    },
    {
      id: "library", header: "Library", kind: "bytes", align: "right", accessor: (c) => c.library.totalBytes,
      cell: (c) => (
        <span className="text-black/70">{c.library.videos} videos · {formatBytes(c.library.totalBytes)}</span>
      ),
    },
    {
      id: "intent", header: "Intent", kind: "text", sortable: false, filterable: false, accessor: () => "",
      cell: (c) => (
        <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <IntentToggle
            label="Get" icon={<Download className="h-3.5 w-3.5" />} on={c.subscription.get}
            onToggle={() => patch.mutate({ id: c.id, body: { get: !c.subscription.get } })}
          />
          <IntentToggle
            label="Support" icon={<Radio className="h-3.5 w-3.5" />} on={c.subscription.support}
            onToggle={() => patch.mutate({ id: c.id, body: { support: !c.subscription.support } })}
          />
        </span>
      ),
    },
    {
      id: "mode", header: "Backup mode", kind: "enum", filterOptions: MODES,
      accessor: (c) => c.subscription.backupMode,
      cell: (c) => (
        <span className="inline-flex overflow-hidden rounded-md border border-[var(--lfb-border)]" onClick={(e) => e.stopPropagation()}>
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => patch.mutate({ id: c.id, body: { backupMode: m } })}
              className={`px-2 py-1 text-xs ${c.subscription.backupMode === m ? "bg-[var(--lfb-primary)] text-white" : "hover:bg-slate-100"}`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </span>
      ),
    },
    {
      id: "keeping", header: "Keeping secure", kind: "bytes", align: "right", accessor: (c) => c.keepingSecureBytes,
      cell: (c) => (
        <span className="text-black/70">
          {formatBytes(c.keepingSecureBytes)}<span className="text-black/40"> / {formatBytes(c.targetBytes)}</span>
        </span>
      ),
    },
    {
      id: "redundancy", header: "Redundancy", kind: "int", align: "right", accessor: (c) => c.redundancy ?? -1,
      cell: (c) => <span className="text-black/60">{c.redundancy === null ? "—" : `${c.redundancy} pinners`}</span>,
    },
  ];

  return (
    // Full-page-height (charter Tables): a flex column so the DataTable fills to the bottom. The storage
    // header is ABOVE the table, so it does not trigger the "content below" exception (§6).
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Communities"
        subtitle="Publishers of large public files you can Get (watch) or Support (rebroadcast to keep secure). Support pins a chosen publisher's public files only — never a public gateway."
      />

      {data && <StorageHeader data={data} onApplyBudget={(b) => setBudget.mutate(b)} busy={setBudget.isPending} />}

      <DataTable
        data={rows}
        columns={columns}
        searchKeys={(c) => `${c.name} ${c.publisher ?? ""} ${c.description ?? ""}`}
        getRowId={(c) => c.id}
        itemNoun="communities"
        // Default sort (tables.mdx §3.4): bookmarked first, then community name (communities.mdx §7).
        defaultSort={[
          { id: "bookmark", desc: true },
          { id: "name", desc: false },
        ]}
        loading={isLoading}
        empty={
          <p className="text-center text-black/60">
            No communities yet. A subscribed community materializes as a <code>community</code> storage on disk (see Storages).
          </p>
        }
      />
    </div>
  );
}

// The budget meter (communities.mdx §6): total disk, free outside IPFS, reserved headroom, and the
// editable machine-wide community budget with a used/budget/remaining bar.
function StorageHeader({
  data,
  onApplyBudget,
  busy,
}: {
  data: import("@lfb/shared").CommunitiesPageData;
  onApplyBudget: (bytes: number | null) => void;
  busy: boolean;
}) {
  const { math, communities } = data;
  const [gib, setGib] = useState<string>((math.communityBudgetBytes / GIB).toFixed(1));
  const used = math.usedBytes;
  const budget = math.communityBudgetBytes;
  const usedPct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
  const modeCount = (m: CommunityBackupMode) => communities.filter((c) => c.subscription.backupMode === m).length;

  return (
    <div className="mb-4 shrink-0 rounded-lg border border-[var(--lfb-border)] p-4">
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={<HardDrive className="h-4 w-4" />} label="Total disk" value={formatBytes(math.totalDiskBytes)} />
        <Stat label="Free outside IPFS" value={formatBytes(math.freeOutsideIpfsBytes)} />
        <Stat label="Reserved headroom" value={formatBytes(math.reservedHeadroomBytes)} />
        <Stat label="Community budget" value={formatBytes(budget)} sub={`recommended ${formatBytes(math.recommendedBudgetBytes)}`} />
      </div>

      {/* used vs budget vs remaining (§6) */}
      <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div className="h-full bg-[var(--lfb-primary)]" style={{ width: `${usedPct}%` }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-black/60">
        <span>
          {formatBytes(used)} pinned of {formatBytes(budget)} budget · {modeCount("block")} Block · {modeCount("recommended")} Recommended · {modeCount("full")} Full
        </span>
        <span className="flex items-center gap-1">
          <label className="text-black/60">Budget (GB)</label>
          <input
            type="number" min={0} step={1} value={gib}
            onChange={(e) => setGib(e.target.value)}
            className="w-24 rounded-md border border-[var(--lfb-border)] px-2 py-1 text-right text-black"
          />
          <button
            disabled={busy}
            onClick={() => { const n = Number(gib); onApplyBudget(Number.isFinite(n) ? Math.max(0, n) * GIB : null); }}
            className="rounded-md bg-[var(--lfb-primary)] px-2 py-1 text-white disabled:opacity-60"
          >
            Set
          </button>
        </span>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, sub }: { icon?: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-xs text-black/50">{icon}{label}</div>
      <div className="font-medium text-black">{value}</div>
      {sub && <div className="text-[11px] text-black/40">{sub}</div>}
    </div>
  );
}

// The leading bookmark toggle (tables.mdx §1) — a control cell; the click stops propagation.
function BookmarkToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      aria-pressed={on}
      aria-label={on ? "Bookmarked — click to remove" : "Bookmark this community"}
      title={on ? "Bookmarked" : "Bookmark"}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="grid place-items-center rounded p-0.5 hover:bg-slate-100"
    >
      <Bookmark
        className={`h-4 w-4 ${on ? "text-yellow-500" : "text-black/25 hover:text-yellow-400"}`}
        fill={on ? "currentColor" : "none"}
        strokeWidth={1.5}
      />
    </button>
  );
}

// One intent chip (Get / Support, §3) — both allowed at once.
function IntentToggle({ label, icon, on, onToggle }: { label: string; icon: React.ReactNode; on: boolean; onToggle: () => void }) {
  return (
    <button
      aria-pressed={on}
      onClick={onToggle}
      title={label}
      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${on ? "border-[var(--lfb-primary)] bg-[var(--lfb-primary)]/10 text-[var(--lfb-primary)]" : "border-[var(--lfb-border)] text-black/50 hover:bg-slate-100"}`}
    >
      {icon}{label}
    </button>
  );
}

export { CommunitiesPage as default };
