// Per-repo settings (repo_settings.mdx) — reached via the gear icon on the One-repo screen.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import type { RepoSettings, SizeUnit } from "@lfb/shared";
import { SIZE_UNITS, toBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";

export function RepoSettingsPage() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ["repoSettings", repoId], queryFn: () => api.repoSettings(repoId) });

  const patch = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.patchRepoSettings(repoId, p),
    onSuccess: (d: RepoSettings) => {
      qc.setQueryData(["repoSettings", repoId], d);
      qc.invalidateQueries({ queryKey: ["repo", repoId] });
      toast.success("Saved");
    },
    onError: (e: Error) => {
      clientLog.error("RepoSettingsPage.patch", e);
      toast.error(e.message);
    },
  });

  if (!s) return <div className="text-black/50">Loading…</div>;

  return (
    <div className="max-w-2xl">
      <Link to="/repos/$repoId" params={{ repoId }} className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
        <ChevronLeft className="h-4 w-4" /> Back to {s.name}
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold">Repo settings — {s.name}</h1>
      <div className="mb-6 text-sm text-black/50">{s.path}</div>

      <Section title="Sync">
        <Toggle label="Synced (bridge this repo's big files)" checked={s.synced}
          onChange={(v) => patch.mutate({ synced: v })} />
      </Section>

      <Section title="Big-file threshold override">
        <Toggle label="Override the global big-file threshold for this repo" checked={s.bigFileOverride.enabled}
          onChange={(v) => patch.mutate({ bigFileOverride: { ...s.bigFileOverride, enabled: v } })} />
        {s.bigFileOverride.enabled && (
          <div className="mt-2 flex items-center gap-2">
            <input type="number" value={s.bigFileOverride.value} className="w-28 rounded border border-[var(--lfb-border)] px-2 py-1"
              onChange={(e) => patch.mutate({ bigFileOverride: { ...s.bigFileOverride, value: Number(e.target.value) } })} />
            <select value={s.bigFileOverride.unit} className="rounded border border-[var(--lfb-border)] px-2 py-1"
              onChange={(e) => patch.mutate({ bigFileOverride: { ...s.bigFileOverride, unit: e.target.value as SizeUnit } })}>
              {SIZE_UNITS.map((u) => <option key={u}>{u}</option>)}
            </select>
            <span className="text-xs text-black/50">= {toBytes(s.bigFileOverride.value, s.bigFileOverride.unit).toLocaleString()} bytes</span>
          </div>
        )}
      </Section>

      <Section title="Large-file selection">
        <Toggle label="Follow .gitignore (bridge the git-ignored big files)" checked={s.largeFiles.followGitignore}
          onChange={(v) => patch.mutate({ largeFiles: { ...s.largeFiles, followGitignore: v } })} />
      </Section>

      <Section title="Pinning / fetch policy">
        <Toggle label="Pin locally" checked={s.sync.pinLocally} onChange={(v) => patch.mutate({ sync: { ...s.sync, pinLocally: v } })} />
        <Toggle label="Fetch missing from peers" checked={s.sync.fetchMissing} onChange={(v) => patch.mutate({ sync: { ...s.sync, fetchMissing: v } })} />
        <Toggle label="Publish committed manifest (git carries the list)" checked={s.sync.publishManifest} onChange={(v) => patch.mutate({ sync: { ...s.sync, publishManifest: v } })} />
      </Section>

      <Section title="Sharing">
        <Toggle label="Shared with other allow-listed participants" checked={s.access.shared}
          onChange={(v) => patch.mutate({ access: { ...s.access, shared: v } })} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-lg border border-[var(--lfb-border)] p-4">
      <h2 className="mb-2 font-semibold">{title}</h2>
      {children}
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
