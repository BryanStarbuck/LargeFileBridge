// Per-storage settings (storage_settings.mdx §7) — reached from the gear on the storage detail header,
// the storage row ⋮ kebab / right-click, and the detail ⋮ more-menu. Two controls: keep the hidden
// tracking area on THIS computer + where it goes (§3 — the .lfbridge/ checkbox + relocate picker are
// `repo`-ONLY; an SDL has no .lfbridge/ and shows a read-only root line instead), and three independent backing
// locations — a dedicated Git repo (preferred), a Google Drive location, and a Dropbox directory — each
// ON/OFF with its own path (§4). Loads via GET, saves via PATCH; the directories themselves appear on
// the next pin pass (§6). Matches RepoSettingsPage's Section/Toggle styling.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "@tanstack/react-router";
import { ChevronLeft, Info, Plus, X } from "lucide-react";
import { toast } from "sonner";
import type { StorageSettings, StorageSettingsPatch, StorageBackingLocation, MappedDirsView, MappedDir, OwnedReposView, RepoRow } from "@lfb/shared";
import { api } from "../../api/client.js";
// The Owned-repos reassign reuses POST /api/repos/:repoId/owner and reads GET /api/storages/:id/owned-repos.
// Neither has a typed method on `api` (client.ts), so call them through the shared http/unwrap directly.
import { http, unwrap } from "../../api/axios.js";
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

      {/* The IPFS-pinning opt-in — gates whether this storage's mapped-dir bytes are pinned over IPFS. */}
      <Section title="Pin over IPFS (add)" subtitle="When on, this computer adds, pins, and fetches this storage's large files over IPFS, placing each file at its grafted local path. Off by default — LFB never pins content without your say-so.">
        <Toggle
          label="Pin this storage's files over IPFS on this computer"
          checked={s.pinned}
          onChange={(v) => patch.mutate({ pinned: v })}
        />
      </Section>

      {/* §3 the tracking area. The `.lfbridge/` control is `repo`-ONLY: a dedicated Large File Bridge file
          repo (personal / company / community) has NO hidden .lfbridge/ — its root IS the tracking area
          (artifact_placement_policy.mdx §0). So there is nothing to toggle or relocate for one, and offering
          the control would name a folder the user will never find. */}
      {s.type === "repo" ? (
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
      ) : (
        <Section title="Tracking area">
          <div className="text-sm text-neutral-600 dark:text-neutral-400">
            This storage's root <strong>is</strong> its tracking area — a dedicated Large File Bridge file repo
            has no hidden <code>.lfbridge/</code> directory.
          </div>
          <div className="mt-1 font-mono text-sm">{s.root}</div>
        </Section>
      )}

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
          <Info className="h-3.5 w-3.5" /> Directories are created and updated on the next pin pass.
        </p>
      </Section>

      {/* §4a mapped source directories — the hierarchies this company/personal storage covers. Shown
          read-only for a repo storage (its single implicit mapped dir is the working tree). */}
      {(s.type === "company" || s.type === "personal" || s.type === "repo") && <MappedDirsSection storageId={storageId} />}

      {/* §4c owned repos — the repos mapped to this storage, each with a reassign dropdown. Company/Personal
          only (hidden for repo/local/community, which own no other repos). */}
      {(s.type === "company" || s.type === "personal") && <OwnedReposSection storageId={storageId} />}
    </div>
  );
}

// §4c The repos currently mapped to this storage, each with a reassign dropdown (Personal | each company |
// + New company…). Selecting a target reuses POST /api/repos/:repoId/owner — the same endpoint as the
// per-repo Owner control — then refreshes the list; a repo reassigned OFF this storage drops out on refresh.
function OwnedReposSection({ storageId }: { storageId: string }) {
  const qc = useQueryClient();
  const { data: v } = useQuery({
    queryKey: ["storageOwnedRepos", storageId],
    queryFn: () => unwrap<OwnedReposView>(http.get(`/storages/${storageId}/owned-repos`)),
  });
  const reassign = useMutation({
    // target: "personal" | a company storage id. Reuses the per-repo Owner endpoint (no new reassign route).
    mutationFn: ({ repoId, target }: { repoId: string; target: string }) => {
      const body = target === "personal" ? { kind: "personal" } : { kind: "company", companyId: target };
      return unwrap<RepoRow>(http.post(`/repos/${repoId}/owner`, body));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["storageOwnedRepos", storageId] });
      qc.invalidateQueries({ queryKey: ["repos"] });
      toast.success("Reassigned");
    },
    onError: (e: Error) => { clientLog.error("StorageSettingsPage.reassignOwner", e); toast.error(e.message); },
  });

  if (!v) return null;

  return (
    <Section
      title="Owned repos"
      subtitle="The repos mapped to this storage. Use a repo's dropdown to reassign it to Personal or another company. Reassigning moves NO bytes — it only re-targets where that repo's tracking state syncs; moving it to a company that has a sync repo records a travelling assertion so your teammates are notified in Large File Bridge."
    >
      {v.ownedRepos.length === 0 && <p className="text-xs text-black/40">No repos are mapped to this storage yet.</p>}
      {v.ownedRepos.map((r) => (
        <div key={r.repoId} className="mb-3 flex items-center gap-2 border-b border-[var(--lfb-border)] pb-3 last:mb-0 last:border-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <span className="truncate">{r.name}</span>
              {r.owner.source === "auto" && <span className="shrink-0 text-xs text-black/40">(auto-detected)</span>}
            </div>
            {r.path && <div className="truncate font-mono text-xs text-black/40">{r.path}</div>}
          </div>
          <select
            className="shrink-0 rounded border border-[var(--lfb-border)] px-2 py-1 text-xs"
            value={r.owner.kind === "personal" ? "personal" : r.owner.companyId ?? storageId}
            disabled={reassign.isPending}
            onChange={(e) => {
              const target = e.target.value;
              // TODO(repo_company_mapping.mdx §6): "+ New company…" should open a name field that creates
              // the company storage, then reassign to it. Until that inline flow exists, do it from the
              // repo's own settings Owner control. Here we support Personal + existing companies only.
              if (target === "__new__") {
                toast.info("Create a new company from the repo's own settings page, then reassign it here.");
                return;
              }
              reassign.mutate({ repoId: r.repoId, target });
            }}
          >
            <option value="personal">Personal</option>
            {v.companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
            <option value="__new__">+ New company…</option>
          </select>
        </div>
      ))}
    </Section>
  );
}

// §4a The list of source directory hierarchies that belong to this storage. Add/remove rows edit the
// SHARED list (mapped_dirs.yaml); each row's path field edits THIS computer's graft. Everything recursive
// under a mapped directory is in scope; files are tracked in place (never relocated).
function MappedDirsSection({ storageId }: { storageId: string }) {
  const qc = useQueryClient();
  const { data: v } = useQuery({ queryKey: ["storageMappedDirs", storageId], queryFn: () => api.storageMappedDirs(storageId) });
  const patch = useMutation({
    mutationFn: (p: { mapped?: Array<Partial<MappedDir>>; graft?: Record<string, string | null> }) => api.patchStorageMappedDirs(storageId, p),
    onSuccess: (d: MappedDirsView) => {
      qc.setQueryData(["storageMappedDirs", storageId], d);
      toast.success("Saved");
    },
    onError: (e: Error) => { clientLog.error("StorageSettingsPage.mappedDirs", e); toast.error(e.message); },
  });

  if (!v) return null;
  // The full shared list as MappedDir rows — the base we mutate for add/remove/label edits.
  const asMapped = (): Array<Partial<MappedDir>> => v.rows.map((r) => ({ key: r.key, label: r.label, canonical: r.canonical, recursive: r.recursive }));

  return (
    <Section
      title="Mapped source directories"
      subtitle={
        v.editable
          ? "The directories on this computer that belong to this storage. Everything recursive under each is in scope; files are tracked in place and never moved. The list is shared across your computers; each path below is this computer's location."
          : "A repo storage covers exactly one directory — its working tree — shown here read-only."
      }
    >
      {v.rows.length === 0 && <p className="text-xs text-black/40">No directories mapped yet.</p>}
      {v.rows.map((r) => (
        <div key={r.key} className="mb-3 border-b border-[var(--lfb-border)] pb-3 last:mb-0 last:border-0 last:pb-0">
          <div className="flex items-center gap-2">
            <input
              type="text"
              defaultValue={r.label}
              key={`label-${r.key}-${r.label}`}
              placeholder="Label"
              disabled={!v.editable}
              className="w-40 rounded border border-[var(--lfb-border)] px-2 py-1 text-xs disabled:bg-slate-50 disabled:text-black/40"
              onBlur={(e) => {
                if (e.target.value !== r.label) patch.mutate({ mapped: asMapped().map((m) => (m.key === r.key ? { ...m, label: e.target.value } : m)) });
              }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
            <input
              type="text"
              defaultValue={r.localPath ?? ""}
              key={`path-${r.key}-${r.localPath ?? ""}`}
              placeholder="this computer's path for this directory"
              disabled={!v.editable}
              className="w-full rounded border border-[var(--lfb-border)] px-2 py-1 font-mono text-xs disabled:bg-slate-50 disabled:text-black/40"
              onBlur={(e) => {
                if (e.target.value !== (r.localPath ?? "")) patch.mutate({ graft: { [r.key]: e.target.value || null } });
              }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
            {v.editable && (
              <button
                title="Remove this directory"
                className="flex items-center rounded p-1 text-black/40 hover:bg-slate-100 hover:text-red-600"
                onClick={() => patch.mutate({ mapped: asMapped().filter((m) => m.key !== r.key) })}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      ))}
      {v.editable && (
        <button
          className="mt-2 flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/70 hover:bg-slate-100"
          onClick={() => patch.mutate({ mapped: [...asMapped(), { label: "New directory", canonical: null, recursive: true }] })}
        >
          <Plus className="h-4 w-4" /> Add directory
        </button>
      )}
    </Section>
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
