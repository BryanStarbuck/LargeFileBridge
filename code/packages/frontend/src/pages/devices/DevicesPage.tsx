// Devices / Peers — every computer that carries your files (devices.mdx §6). The row set ALWAYS
// includes THIS computer (auto-seeded by the backend), so the table is never empty; when it's the only
// row we still nudge the user to add a second machine. Each device is identified by its hardware
// fingerprint; the model/screen/chip/RAM/disk facts that used to be their own columns are now rolled
// into the DEVICE cell (a descriptor subtitle under the name), so the table stays narrow and the other
// columns get the width they need (devices.mdx §6). A row click opens that device's "View one device"
// page; the IPFS Peer ID cell copies to the clipboard.
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { DeviceRow } from "@lfb/shared";
import { deviceDescriptor } from "@lfb/shared";
import { Laptop, Monitor, Server, HardDrive } from "lucide-react";
import { api } from "../../api/client.js";
import { DataTable } from "../../components/table/DataTable.js";
import type { LfbColumn } from "../../components/table/types.js";
import { PeerKebab } from "../../components/menu/RowKebabs.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner } from "../../components/ui/StatusBanner.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { healthColor, type Health } from "../../components/ui/health.js";
import { relativeTime, truncatePeerId } from "../../lib/format.js";
import { copyText } from "@/lib/clipboard";

// Recent = green, a bit stale = amber, long gone / never = neutral.
function seenHealth(iso: string | null): Health {
  if (!iso) return "neutral";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "neutral";
  if (ms < 24 * 3600_000) return "ok";
  if (ms < 7 * 24 * 3600_000) return "warn";
  return "neutral";
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "h-4 w-4 text-black/60";
  if (kind === "laptop") return <Laptop className={cls} />;
  if (kind === "server") return <Server className={cls} />;
  if (kind === "desktop") return <Monitor className={cls} />;
  return <HardDrive className={cls} />;
}

// Copy the full Peer ID to the clipboard (the cell only shows a truncated 8…8 form). Stops row-click.
function copyPeerId(id: string) {
  void copyText(id, "Peer ID", "DevicesPage.copyPeerId");
}

export function DevicesPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["devices"], queryFn: api.devices });
  const rows = data ?? [];
  const onlySelf = !isLoading && rows.length === 1 && rows[0]?.isSelf;

  const columns: LfbColumn<DeviceRow>[] = [
    {
      id: "device",
      header: "Device",
      kind: "text",
      width: "28rem",
      accessor: (d) => d.displayLabel,
      cell: (d) => {
        // The removed Model/Year/Screen/Disk/RAM columns now live here as a compact descriptor line so
        // the machine is still recognisable at a glance (devices.mdx §6).
        const descriptor = deviceDescriptor(d.hardware);
        return (
          <span className="flex flex-col">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium">{d.displayLabel}</span>
              {d.isSelf && (
                <span className="shrink-0 rounded-full bg-[var(--lfb-primary)]/10 px-2 py-0.5 text-xs text-[var(--lfb-primary)]">
                  This computer
                </span>
              )}
            </span>
            {descriptor.length > 0 && (
              <span className="truncate text-xs text-black/50">{descriptor.join(" · ")}</span>
            )}
          </span>
        );
      },
    },
    {
      id: "kind",
      header: "Kind",
      kind: "enum",
      width: "8rem",
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
      // Owner = the logged-in OS username of that computer (devices.mdx §6): the fingerprint's `username`
      // (for THIS machine, whoever is signed in here), falling back to the allow-listed email if unknown.
      id: "owner",
      header: "Owner",
      kind: "text",
      width: "12rem",
      accessor: (d) => d.hardware?.username || d.owner || "",
      cell: (d) => <span>{d.hardware?.username || d.owner || "—"}</span>,
    },
    {
      id: "peerId",
      header: "IPFS Peer ID",
      kind: "text",
      width: "12rem",
      accessor: (d) => d.ipfsPeerId ?? "",
      cell: (d) =>
        d.ipfsPeerId ? (
          <code
            title={`${d.ipfsPeerId} — click to copy`}
            onClick={(e) => {
              e.stopPropagation();
              copyPeerId(d.ipfsPeerId!);
            }}
            className="cursor-pointer text-xs text-black/60 hover:text-[var(--lfb-primary)]"
          >
            {truncatePeerId(d.ipfsPeerId)}
          </code>
        ) : (
          <span className="text-black/20">—</span>
        ),
    },
    {
      id: "lastSeen",
      header: "Last seen",
      kind: "timestamp",
      width: "10rem",
      accessor: (d) => d.lastSeen,
      cell: (d) =>
        d.isSelf ? (
          <span style={{ color: healthColor("ok") }}>now</span>
        ) : (
          <span style={{ color: healthColor(seenHealth(d.lastSeen)) }}>{relativeTime(d.lastSeen)}</span>
        ),
    },
  ];

  const others = rows.filter((d) => !d.isSelf);
  const otherCount = others.length;
  // §10.8.1 — the green "backed up" reassurance must NOT fire when every peer is stale/offline. A peer
  // counts as carrying live copies only if it's been seen recently (seenHealth !== "neutral" = within 7d).
  const freshOthers = others.filter((d) => seenHealth(d.lastSeen) !== "neutral").length;

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
        otherCount > 0 &&
        (freshOthers > 0 ? (
          <StatusBanner
            state="ok"
            headline={`${otherCount} other computer${otherCount === 1 ? "" : "s"} keep${otherCount === 1 ? "s" : ""} copies of your files`}
            sub="Your pinned files are backed up across these machines."
          />
        ) : (
          <StatusBanner
            state="warn"
            headline={`${otherCount} other computer${otherCount === 1 ? "" : "s"}, but none seen recently`}
            sub="None of your other computers have checked in lately, so your files may not be backed up right now. Bring one online, or check its Large File Bridge background sync."
          />
        ))
      )}

      <DataTable
        tableId="devices"
        data={rows}
        columns={columns}
        searchKeys={(d) =>
          `${d.displayLabel} ${d.owner ?? ""} ${d.hardware?.marketingName ?? ""} ${d.hardware?.username ?? ""} ${d.ipfsPeerId ?? ""}`
        }
        getRowId={(d) => d.id || d.displayLabel}
        // Row click → the device's "View one device" page (devices.mdx §6). Skip rows with no stable id.
        onRowClick={(d) => {
          if (d.id) navigate({ to: "/device/$deviceId", params: { deviceId: d.id } });
        }}
        // ⌘/Ctrl/middle-click opens the row's destination in a new tab (tables.mdx §4d). A row with no
        // stable id has no page, so it has no href either.
        rowHref={(d) => (d.id ? `/device/${encodeURIComponent(d.id)}` : "")}
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
