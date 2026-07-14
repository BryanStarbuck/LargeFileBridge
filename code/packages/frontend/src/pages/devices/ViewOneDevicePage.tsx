// View one device (devices.mdx §6) — the per-computer screen reached by clicking a row in the Devices /
// Peers table. It gathers everything the table can't fit: the full identity (device id, nice name,
// owner, IPFS Peer ID — both copyable in full), the complete hardware fingerprint (§7), how many
// storages carry it, and the actions you can take on it. A "This computer" badge marks the self row;
// a peers.yaml-sourced device can be forgotten from here (never touches remote content or local bytes).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  ChevronLeft,
  Copy,
  FolderOpen,
  Trash2,
  Laptop,
  Monitor,
  Server,
  HardDrive,
} from "lucide-react";
import type { DeviceRow, DeviceHardware } from "@lfb/shared";
import { deviceDescriptor } from "@lfb/shared";
import { api } from "../../api/client.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner } from "../../components/ui/StatusBanner.js";
import { type Health } from "../../components/ui/health.js";
import { relativeTime, absoluteTime } from "../../lib/format.js";
import { confirmModal } from "../../lib/modals.js";
import { clientLog } from "../../lib/clientLog.js";

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
  const cls = "h-5 w-5 text-black/60";
  if (kind === "laptop") return <Laptop className={cls} />;
  if (kind === "server") return <Server className={cls} />;
  if (kind === "desktop") return <Monitor className={cls} />;
  return <HardDrive className={cls} />;
}

function copy(text: string, label: string) {
  navigator.clipboard?.writeText(text).catch((e) => clientLog.warn("ViewOneDevicePage.copy", e));
  toast.success(`${label} copied`);
}

// One label/value row in a definition grid. `copyable` renders the value as a click-to-copy code chip.
function Field({
  label,
  value,
  mono,
  copyable,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
  copyable?: string;
}) {
  const shown = value == null || value === "" ? "—" : String(value);
  return (
    <div className="flex flex-col gap-0.5 border-b border-[var(--lfb-border)] py-2">
      <dt className="text-xs uppercase tracking-wide text-black/40">{label}</dt>
      <dd className={mono ? "font-mono text-sm" : "text-sm"}>
        {copyable ? (
          <button
            className="inline-flex max-w-full items-center gap-1.5 break-all text-left hover:text-[var(--lfb-primary)]"
            title="Click to copy"
            onClick={() => copy(copyable, label)}
          >
            <span className="break-all">{shown}</span>
            <Copy className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </button>
        ) : (
          shown
        )}
      </dd>
    </div>
  );
}

export function ViewOneDevicePage() {
  const { deviceId } = useParams({ strict: false }) as { deviceId: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: device, isLoading, error } = useQuery<DeviceRow>({
    queryKey: ["device", deviceId],
    queryFn: () => api.device(deviceId),
    retry: false,
  });

  const backLink = (
    <Link to="/devices" className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
      <ChevronLeft className="h-4 w-4" /> Devices / Peers
    </Link>
  );

  if (isLoading) {
    return (
      <div>
        <PageHeader above={backLink} title="…" />
        <p className="text-sm text-black/50">Loading device…</p>
      </div>
    );
  }

  if (error || !device) {
    return (
      <div>
        <PageHeader above={backLink} title="Device not found" />
        <StatusBanner
          state="neutral"
          headline="This device is no longer in your registry"
          sub="It may have been removed, or its link is stale. Go back to Devices / Peers to see your current computers."
        />
      </div>
    );
  }

  const hw: DeviceHardware | null = device.hardware;
  const descriptor = deviceDescriptor(hw);
  const removePeer = async () => {
    if (
      !(await confirmModal({
        title: `Forget ${device.name}?`,
        body: "Large File Bridge stops expecting this computer. It removes nothing on that machine and no files here.",
        confirmLabel: "Remove peer",
      }))
    )
      return;
    try {
      await api.removePeer(device.id);
      qc.invalidateQueries({ queryKey: ["peers"] });
      qc.invalidateQueries({ queryKey: ["devices"] });
      toast.success(`Removed ${device.name}`);
      navigate({ to: "/devices" });
    } catch (e) {
      clientLog.error("ViewOneDevicePage.removePeer", e);
      toast.error(e instanceof Error ? e.message : "Couldn't remove peer");
    }
  };

  return (
    <div>
      <PageHeader
        above={backLink}
        title={
          <span className="flex items-center gap-3">
            <KindIcon kind={hw?.kind ?? ""} />
            {device.displayLabel}
            {device.isSelf && (
              <span className="rounded-full bg-[var(--lfb-primary)]/10 px-2 py-0.5 text-xs text-[var(--lfb-primary)]">
                This computer
              </span>
            )}
          </span>
        }
        subtitle={descriptor.length > 0 ? descriptor.join(" · ") : undefined}
        actions={
          <>
            {device.ipfsPeerId && (
              <button
                onClick={() => copy(device.ipfsPeerId!, "Peer ID")}
                className="flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                <Copy className="h-4 w-4" /> Copy Peer ID
              </button>
            )}
            {hw?.homeDir && (
              <button
                onClick={() => navigate({ to: "/fs", search: { path: hw.homeDir } })}
                title={device.isSelf ? "Browse this computer's home in the File System" : "This path is on the other computer"}
                disabled={!device.isSelf}
                className="flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40"
              >
                <FolderOpen className="h-4 w-4" /> Open in File System
              </button>
            )}
            {device.source === "peer" && (
              <button
                onClick={removePeer}
                className="flex items-center gap-1.5 rounded-md border border-[var(--lfb-bad)] px-3 py-1.5 text-sm text-[var(--lfb-bad)] hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" /> Remove peer
              </button>
            )}
          </>
        }
      />

      {/* Last-seen verdict — health-coloured, same recency bands as the table. */}
      <StatusBanner
        state={device.isSelf ? "ok" : seenHealth(device.lastSeen)}
        headline={
          device.isSelf
            ? "This is the computer you're using right now"
            : device.lastSeen
              ? `Last seen ${relativeTime(device.lastSeen)}`
              : "Not seen yet"
        }
        sub={
          device.storageCount > 0
            ? `Carries your files across ${device.storageCount} storage${device.storageCount === 1 ? "" : "s"}.`
            : device.source === "peer"
              ? "Known from your peers list — not yet seen in a pinned storage."
              : undefined
        }
      />

      <div className="mt-4 grid grid-cols-1 gap-x-8 md:grid-cols-2">
        {/* Identity */}
        <section>
          <h2 className="mb-1 text-sm font-semibold text-black/70">Identity</h2>
          <dl>
            <Field label="Nice name" value={device.name} />
            <Field label="Device id" value={device.id} mono copyable={device.id || undefined} />
            <Field label="Owner (OS user)" value={hw?.username || device.owner} />
            <Field
              label="IPFS Peer ID"
              value={device.ipfsPeerId}
              mono
              copyable={device.ipfsPeerId || undefined}
            />
            <Field label="Source" value={sourceLabel(device.source)} />
            <Field label="Storages carrying it" value={device.storageCount} />
            <Field
              label="Last seen"
              value={device.isSelf ? "now" : device.lastSeen ? absoluteTime(device.lastSeen) : "never"}
            />
          </dl>
        </section>

        {/* Hardware fingerprint (§7) */}
        <section>
          <h2 className="mb-1 text-sm font-semibold text-black/70">Hardware fingerprint</h2>
          {hw ? (
            <dl>
              <Field label="Kind" value={hw.kind} />
              <Field label="Model" value={hw.marketingName || hw.modelName} />
              <Field label="Year" value={hw.year} />
              <Field label="Screen" value={hw.screenInches != null ? `${hw.screenInches}″` : null} />
              <Field label="Disk" value={fmtGb(hw.diskTotalGb)} />
              <Field label="RAM" value={fmtGb(hw.ramGb)} />
              <Field label="Chip" value={hw.chip} />
              <Field label="CPU cores" value={hw.cpuCores} />
              <Field label="Architecture" value={hw.arch} />
              <Field label="Platform" value={hw.platform} />
              <Field label="Hostname" value={hw.hostname} mono />
              <Field label="Home directory" value={hw.homeDir} mono />
              <Field label="Model identifier" value={hw.modelIdentifier} mono />
            </dl>
          ) : (
            <p className="py-2 text-sm text-black/50">
              No hardware fingerprint yet — this device is known only from your peers list. It fills in
              once that computer writes itself into a pinned storage.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function sourceLabel(source: DeviceRow["source"]): string {
  if (source === "self") return "This computer (config)";
  if (source === "peer") return "Peers list";
  return "Storage registry";
}
