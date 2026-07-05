// Peers — the user's other computers that pin these files (storage.mdx §11 + use_cases.mdx §5.5 +
// UC-8). Empty state is guided (how to add a computer), not a blank table. Last-seen recency is
// colored by the health model so "is this machine still with me?" reads at a glance.
import { useQuery } from "@tanstack/react-query";
import type { PeerRow } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { PeerKebab } from "../../components/menu/RowKebabs.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner } from "../../components/ui/StatusBanner.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { healthColor, type Health } from "../../components/ui/health.js";
import { relativeTime } from "../../lib/format.js";

// Recent = green, a bit stale = amber, long gone / never = neutral.
function seenHealth(iso: string | null): Health {
  if (!iso) return "neutral";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "neutral";
  if (ms < 24 * 3600_000) return "ok";
  if (ms < 7 * 24 * 3600_000) return "warn";
  return "neutral";
}

export function PeersPage() {
  const { data, isLoading } = useQuery({ queryKey: ["peers"], queryFn: api.peers });
  const columns: LfbColumn<PeerRow>[] = [
    { id: "label", header: "Computer", kind: "text", accessor: (p) => p.label,
      cell: (p) => <span className="font-medium">{p.label}</span> },
    { id: "owner", header: "Owner", kind: "text", accessor: (p) => p.owner },
    { id: "peerId", header: "IPFS Peer ID", kind: "text", accessor: (p) => p.ipfsPeerId,
      cell: (p) => <code className="text-xs text-black/60">{p.ipfsPeerId ?? "—"}</code> },
    { id: "lastSeen", header: "Last seen", kind: "timestamp", accessor: (p) => p.lastSeen,
      cell: (p) => (
        <span style={{ color: healthColor(seenHealth(p.lastSeen)) }}>{relativeTime(p.lastSeen)}</span>
      ) },
  ];

  const empty = !isLoading && (data?.length ?? 0) === 0;

  return (
    // Full-page-height (repos.mdx §3.3.1): flex column so the peers table fills to the bottom.
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Peers"
        subtitle="Your other computers that keep copies of these files, so nothing lives on just one machine."
      />

      {empty ? (
        <>
          <StatusBanner
            state="neutral"
            headline="No other computers yet"
            sub="Right now your files live only on this machine. Add a second computer so they're backed up."
          />
          <div className="rounded-lg border border-[var(--lfb-border)] bg-white px-4 py-3">
            <Disclosure label="How to add a computer" defaultOpen>
              <ol className="list-decimal space-y-1 pl-4 text-sm text-black/70">
                <li>Install LargeFileBridge on your other computer (laptop, desktop, studio, or server).</li>
                <li>Sign in there with the <b>same Google account</b> you use here.</li>
                <li>
                  It joins your swarm and starts pinning your files. It then appears in this table, and
                  your synced files show it under their peer count.
                </li>
              </ol>
            </Disclosure>
          </div>
        </>
      ) : (
        <>
          {data && data.length > 0 && (
            <StatusBanner
              state="ok"
              headline={`${data.length} computer${data.length === 1 ? "" : "s"} keep${data.length === 1 ? "s" : ""} copies of your files`}
              sub="Your synced files are backed up across these machines."
            />
          )}
          <DataTable data={data ?? []} columns={columns} searchKeys={(p) => `${p.label} ${p.owner}`}
            getRowId={(p) => p.id} itemNoun="peers" loading={isLoading}
            rowMenu={(p) => <PeerKebab peer={p} />}
            empty={<p className="text-center text-black/60">No peers yet.</p>} />
        </>
      )}
    </div>
  );
}
