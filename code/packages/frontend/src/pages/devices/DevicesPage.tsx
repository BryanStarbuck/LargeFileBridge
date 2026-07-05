// Devices / Peers — every computer that carries your files (devices.mdx §6). The row set ALWAYS
// includes THIS computer (auto-seeded by the backend), so the table is never empty; when it's the only
// row we still nudge the user to add a second machine. Each device is identified by its hardware
// fingerprint (model, year, screen, disk, RAM) so two similar Macs are told apart by the "Device" column,
// whose label is disambiguated server-side (device-naming.ts). Last-seen recency is health-coloured.
import { useQuery } from "@tanstack/react-query";
import type { DeviceRow } from "@lfb/shared";
import { Laptop, Monitor, Server, HardDrive } from "lucide-react";
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

// Whole-GB → human size ("512 GB", "1 TB").
function fmtGb(gb: number | null): string {
  if (gb == null) return "—";
  return gb >= 1000 ? `${+(gb / 1000).toFixed(gb % 1000 === 0 ? 0 : 1)} TB` : `${gb} GB`;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "h-4 w-4 text-black/60";
  if (kind === "laptop") return <Laptop className={cls} />;
  if (kind === "server") return <Server className={cls} />;
  if (kind === "desktop") return <Monitor className={cls} />;
  return <HardDrive className={cls} />;
}

export function DevicesPage() {
  const { data, isLoading } = useQuery({ queryKey: ["devices"], queryFn: api.devices });
  const rows = data ?? [];
  const onlySelf = !isLoading && rows.length === 1 && rows[0]?.isSelf;

  const columns: LfbColumn<DeviceRow>[] = [
    {
      id: "device",
      header: "Device",
      kind: "text",
      accessor: (d) => d.displayLabel,
      cell: (d) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{d.displayLabel}</span>
          {d.isSelf && (
            <span className="rounded-full bg-[var(--lfb-primary)]/10 px-2 py-0.5 text-xs text-[var(--lfb-primary)]">
              This computer
            </span>
          )}
        </span>
      ),
    },
    {
      id: "kind",
      header: "Kind",
      kind: "enum",
      accessor: (d) => d.hardware?.kind ?? "",
      filterOptions: ["laptop", "desktop", "server"],
      cell: (d) => (
        <span className="flex items-center gap-1.5 capitalize">
          <KindIcon kind={d.hardware?.kind ?? ""} />
          {d.hardware?.kind || "—"}
        </span>
      ),
    },
    {
      id: "model",
      header: "Model",
      kind: "text",
      accessor: (d) => d.hardware?.marketingName || d.hardware?.modelName || "",
      cell: (d) => <span>{d.hardware?.marketingName || d.hardware?.modelName || "—"}</span>,
    },
    { id: "year", header: "Year", kind: "int", accessor: (d) => d.hardware?.year ?? null,
      cell: (d) => <span>{d.hardware?.year ?? "—"}</span> },
    { id: "screen", header: "Screen", kind: "int", align: "right", accessor: (d) => d.hardware?.screenInches ?? null,
      cell: (d) => <span>{d.hardware?.screenInches != null ? `${d.hardware.screenInches}″` : "—"}</span> },
    { id: "disk", header: "Disk", kind: "int", align: "right", accessor: (d) => d.hardware?.diskTotalGb ?? null,
      cell: (d) => <span>{fmtGb(d.hardware?.diskTotalGb ?? null)}</span> },
    { id: "ram", header: "RAM", kind: "int", align: "right", accessor: (d) => d.hardware?.ramGb ?? null,
      cell: (d) => <span>{fmtGb(d.hardware?.ramGb ?? null)}</span> },
    { id: "owner", header: "Owner", kind: "text", accessor: (d) => d.owner ?? "" },
    { id: "peerId", header: "IPFS Peer ID", kind: "text", accessor: (d) => d.ipfsPeerId ?? "",
      cell: (d) => <code className="text-xs text-black/60">{d.ipfsPeerId ?? "—"}</code> },
    { id: "lastSeen", header: "Last seen", kind: "timestamp", accessor: (d) => d.lastSeen,
      cell: (d) =>
        d.isSelf ? (
          <span style={{ color: healthColor("ok") }}>now</span>
        ) : (
          <span style={{ color: healthColor(seenHealth(d.lastSeen)) }}>{relativeTime(d.lastSeen)}</span>
        ) },
  ];

  const otherCount = rows.filter((d) => !d.isSelf).length;

  return (
    // Full-page-height (repos.mdx §3.3.1): flex column so the devices table fills to the bottom.
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Devices / Peers"
        subtitle="Every computer that carries your files — this Mac, your laptop, a studio tower, a server — pinning one another's files over IPFS."
      />

      {onlySelf ? (
        <StatusBanner
          state="neutral"
          headline="Only this computer so far"
          sub="Your files live only on this machine. Add a second computer so they're backed up across devices."
        />
      ) : (
        otherCount > 0 && (
          <StatusBanner
            state="ok"
            headline={`${otherCount} other computer${otherCount === 1 ? "" : "s"} keep${otherCount === 1 ? "s" : ""} copies of your files`}
            sub="Your synced files are backed up across these machines."
          />
        )
      )}

      <DataTable
        data={rows}
        columns={columns}
        searchKeys={(d) =>
          `${d.displayLabel} ${d.owner ?? ""} ${d.hardware?.marketingName ?? ""} ${d.hardware?.username ?? ""}`
        }
        getRowId={(d) => d.id || d.displayLabel}
        itemNoun="devices"
        loading={isLoading}
        // Only peers.yaml entries can be "removed"; self and registry rows are not forgettable here.
        rowMenu={(d) =>
          d.source === "peer" ? (
            <PeerKebab
              peer={{ id: d.id, label: d.name, ipfsPeerId: d.ipfsPeerId, owner: d.owner ?? "", lastSeen: d.lastSeen }}
            />
          ) : null
        }
        empty={<p className="text-center text-black/60">No devices yet.</p>}
      />

      {onlySelf && (
        <div className="mt-3 rounded-lg border border-[var(--lfb-border)] bg-white px-4 py-3">
          <Disclosure label="How to add a computer" defaultOpen>
            <ol className="list-decimal space-y-1 pl-4 text-sm text-black/70">
              <li>Install LargeFileBridge on your other computer (laptop, desktop, studio, or server).</li>
              <li>Sign in there with the <b>same Google account</b> you use here.</li>
              <li>
                It joins your swarm, starts pinning your files, and appears in this table — identified by
                its own hardware so you can tell your machines apart.
              </li>
            </ol>
          </Disclosure>
        </div>
      )}
    </div>
  );
}
