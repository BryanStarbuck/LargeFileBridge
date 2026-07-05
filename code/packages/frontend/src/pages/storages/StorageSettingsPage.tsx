// Per-storage settings (storage_settings.mdx §7) — reached from the gear on the storage detail header,
// the storage row ⋮ kebab / right-click, and the detail ⋮ more-menu. Two controls: keep the hidden
// .lfbridge/ tracking directory on THIS computer + where it goes (§3), and three independent backing
// locations — a dedicated Git repo (preferred), a Google Drive location, and a Dropbox directory — each
// ON/OFF with its own path (§4). Loads via GET, saves via PATCH; the directories themselves appear on
// the next sync pass (§6). Matches RepoSettingsPage's Section/Toggle styling.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "@tanstack/react-router";
import { ChevronLeft, Info } from "lucide-react";
import { toast } from "sonner";
import type { StorageSettings, StorageSettingsPatch, StorageBackingLocation } from "@lfb/shared";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";

export function StorageSettingsPage() {
  const { storageId } = useParams({ strict: false }) as { storageId: string };
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ["storageSettings", storageId], queryFn: () => api.storageSettings(storageId) });

  const patch = useMutation({
    mutationFn: (p: StorageSettingsPatch) => api.patchStorageSettings(storageId, p),
    onSuccess: (d: StorageSettings) => {
      qc.setQueryData(["storageSettings", storageId], d);
      qc.invalidateQueries({ queryKey: ["storage", storageId] });
      toast.success("Saved");
    },
    onError: (e: Error) => {
      clientLog.error("StorageSettingsPage.patch", e);
      toast.error(e.message);
    },
  });

  if (!s) return <div className="text-black/50">Loading…</div>;

  return (
    <div className="max-w-2xl">
      <Link to="/storages" className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
        <ChevronLeft className="h-4 w-4" /> Storages
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold">{s.name}</h1>
      <div className="mb-6 text-sm text-black/50">
        <span className="font-mono">{s.root}</span> · type: <span className="capitalize">{s.type}</span>
      </div>

      {/* §3 the hidden tracking directory */}
      <Section title="Hidden tracking directory">
        <Toggle
          label="Keep a hidden .lfbridge/ directory for this storage on this computer"
          checked={s.lfbridge.enabled}
          onChange={(v) => patch.mutate({ lfbridge: { enabled: v } })}
        />
        <PathField
          label="Location"
          value={s.lfbridge.path}
          placeholder={s.lfbridge.defaultPath}
          disabled={!s.lfbridge.enabled}
          onCommit={(v) => patch.mutate({ lfbridge: { path: v } })}
        />
      </Section>

      {/* §4 backing locations */}
      <Section title="Backing locations" subtitle="Each is an extra, human-reachable copy of this storage.">
        <BackingRow
          label="Dedicated Git repo"
          badge="preferred"
          loc={s.backing.dedicatedRepo}
          onToggle={(v) => patch.mutate({ backing: { dedicatedRepo: { enabled: v } } })}
          onCommitPath={(v) => patch.mutate({ backing: { dedicatedRepo: { path: v } } })}
        />
        <BackingRow
          label="Google Drive"
          loc={s.backing.googleDrive}
          connectHint="connect Drive first"
          onToggle={(v) => patch.mutate({ backing: { googleDrive: { enabled: v } } })}
          onCommitPath={(v) => patch.mutate({ backing: { googleDrive: { path: v } } })}
        />
        <BackingRow
          label="Dropbox"
          loc={s.backing.dropbox}
          connectHint="connect Dropbox first"
          onToggle={(v) => patch.mutate({ backing: { dropbox: { enabled: v } } })}
          onCommitPath={(v) => patch.mutate({ backing: { dropbox: { path: v } } })}
        />
        <p className="mt-3 flex items-center gap-1.5 text-xs text-black/50">
          <Info className="h-3.5 w-3.5" /> Directories are created and updated on the next sync pass.
        </p>
      </Section>
    </div>
  );
}

// One backing location: a toggle + its path field (greyed with a connect hint when the drive isn't here).
function BackingRow({
  label,
  badge,
  loc,
  connectHint,
  onToggle,
  onCommitPath,
}: {
  label: string;
  badge?: string;
  loc: StorageBackingLocation;
  connectHint?: string;
  onToggle: (v: boolean) => void;
  onCommitPath: (v: string) => void;
}) {
  const unavailable = !loc.available;
  return (
    <div className="mb-3 border-b border-[var(--lfb-border)] pb-3 last:mb-0 last:border-0 last:pb-0">
      <label className="flex items-center gap-2 py-0.5 text-sm">
        <input type="checkbox" checked={loc.enabled} disabled={unavailable || loc.readOnly} onChange={(e) => onToggle(e.target.checked)} />
        <span className="font-medium">{label}</span>
        {badge && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800">{badge}</span>}
        {unavailable && connectHint && <span className="text-xs text-amber-700">({connectHint})</span>}
        {loc.readOnly && <span className="text-xs text-black/40">(is this repo)</span>}
      </label>
      <PathField
        value={loc.path}
        placeholder={loc.proposedDefault}
        disabled={unavailable || loc.readOnly || !loc.enabled}
        onCommit={onCommitPath}
      />
    </div>
  );
}

// A path input that commits on blur / Enter (the placeholder shows LFB's proposed default when unset).
function PathField({
  label,
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  label?: string;
  value: string | null;
  placeholder: string;
  disabled?: boolean;
  onCommit: (v: string) => void;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-2 pl-6">
      {label && <span className="text-xs text-black/50">{label}</span>}
      <input
        type="text"
        defaultValue={value ?? ""}
        key={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded border border-[var(--lfb-border)] px-2 py-1 font-mono text-xs disabled:bg-slate-50 disabled:text-black/30"
        onBlur={(e) => { if (e.target.value !== (value ?? "")) onCommit(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-lg border border-[var(--lfb-border)] p-4">
      <h2 className="font-semibold">{title}</h2>
      {subtitle && <p className="mb-2 text-xs text-black/50">{subtitle}</p>}
      <div className={subtitle ? "" : "mt-2"}>{children}</div>
    </div>
  );
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 py-0.5 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export { StorageSettingsPage as default };
