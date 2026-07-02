// Peers — the user's other computers that pin these files (storage.mdx §11).
import { useQuery } from "@tanstack/react-query";
import type { PeerRow } from "@lfb/shared";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { relativeTime } from "../../lib/format.js";

export function PeersPage() {
  const { data, isLoading } = useQuery({ queryKey: ["peers"], queryFn: api.peers });
  const columns: LfbColumn<PeerRow>[] = [
    { id: "label", header: "Computer", kind: "text", accessor: (p) => p.label,
      cell: (p) => <span className="font-medium">{p.label}</span> },
    { id: "owner", header: "Owner", kind: "text", accessor: (p) => p.owner },
    { id: "peerId", header: "IPFS Peer ID", kind: "text", accessor: (p) => p.ipfsPeerId,
      cell: (p) => <code className="text-xs text-black/60">{p.ipfsPeerId ?? "—"}</code> },
    { id: "lastSeen", header: "Last seen", kind: "timestamp", accessor: (p) => p.lastSeen,
      cell: (p) => relativeTime(p.lastSeen) },
  ];
  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Peers</h1>
      <DataTable data={data ?? []} columns={columns} searchKeys={(p) => `${p.label} ${p.owner}`}
        getRowId={(p) => p.id} itemNoun="peers" loading={isLoading}
        empty={<p className="text-center text-black/60">No peers yet. Your other computers appear here once they join your swarm.</p>} />
    </div>
  );
}
