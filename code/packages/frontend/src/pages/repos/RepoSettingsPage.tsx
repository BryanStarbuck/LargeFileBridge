// Per-repo settings (repo_settings.mdx) — reached via the gear icon on the One-repo screen.
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import type { RepoSettings, SizeUnit, PlacementChoice } from "@lfb/shared";
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

      {s.owner && (
        <Section title="Ownership">
          <div className="text-sm text-black/70">
            This repo maps to{" "}
            {s.owner.kind === "company" ? (
              <>
                the <b>{s.owner.displayName}</b> company
              </>
            ) : (
              <b>Personal</b>
            )}
            {s.owner.source === "auto" && s.owner.kind === "company" && s.owner.host && s.owner.ownerSlug && (
              <span className="text-black/50">
                {" "}
                — auto-detected from {s.owner.host}/{s.owner.ownerSlug}
              </span>
            )}
            {s.owner.source === "auto" && s.owner.kind === "personal" && (
              <span className="text-black/50"> — no organization detected in the git remote</span>
            )}
            .
          </div>
          <p className="mt-2 text-xs text-black/45">
            Company mapping is auto-derived from the git remote. Renaming a company and reassigning a repo
            between a company and Personal arrive with the Storages left-bar company entries
            (repo_company_mapping.mdx §5–§6).
          </p>
        </Section>
      )}

      <Section title="Pin">
        <Toggle label="Pinned (bridge this repo's big files)" checked={s.pinned}
          onChange={(v) => patch.mutate({ pinned: v })} />
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
        <GlobField label="Include globs (force-bridge these even if Git tracks them)"
          placeholder={"one glob per line, e.g.\nrender/**/*.exr"} value={s.largeFiles.includeGlobs}
          onSave={(globs) => patch.mutate({ largeFiles: { ...s.largeFiles, includeGlobs: globs } })} />
        <GlobField label="Exclude globs (never bridge these, even if git-ignored)"
          placeholder={"one glob per line, e.g.\n**/cache/**"} value={s.largeFiles.excludeGlobs}
          onSave={(globs) => patch.mutate({ largeFiles: { ...s.largeFiles, excludeGlobs: globs } })} />
      </Section>

      <Section title="Pinning / fetch policy">
        <Toggle label="Pin locally" checked={s.pin.pinLocally} onChange={(v) => patch.mutate({ pin: { ...s.pin, pinLocally: v } })} />
        <Toggle label="Fetch missing from peers" checked={s.pin.fetchMissing} onChange={(v) => patch.mutate({ pin: { ...s.pin, fetchMissing: v } })} />
        <Toggle label="Publish manifest (kept in Local Storage; travels via the sync repo)" checked={s.pin.publishManifest} onChange={(v) => patch.mutate({ pin: { ...s.pin, publishManifest: v } })} />
      </Section>

      {s.transcription && (
        <PlacementSection
          title="Transcription placement"
          blurb="Where transcripts generated for this repo are written."
          value={s.transcription.placement}
          onChange={(v) => patch.mutate({ transcription: { placement: v } })}
        />
      )}

      {s.aiDescription && (
        <PlacementSection
          title="AI description placement"
          blurb="Where AI descriptions generated for this repo are written — the mirror of transcription."
          value={s.aiDescription.placement}
          onChange={(v) => patch.mutate({ aiDescription: { placement: v } })}
        />
      )}

      {s.syncRepo && (
        <Section title="Company sync repo">
          <Toggle
            label="Sync this repo's tracking state to the company sync repo"
            checked={s.syncRepo.enabled}
            onChange={(v) => patch.mutate({ syncRepo: { enabled: v } })}
          />
          <p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.7 }}>
            Off by default — Large File Bridge keeps this repo's compression, big-file, and git-ignore
            tracking in Local Storage, never in the working repo. Turn this on to also mirror it to the
            owning company or Personal storage's sync repo so it travels to your other computers.
          </p>
        </Section>
      )}

      <Section title="Sharing">
        <Toggle label="Shared with other allow-listed participants" checked={s.access.shared}
          onChange={(v) => patch.mutate({ access: { ...s.access, shared: v } })} />
        {s.access.shared && (
          <GlobField label="Participant emails (their computers also pin this repo)"
            placeholder={"one email per line, e.g.\nfamily@gmail.com"} value={s.access.participants}
            onSave={(emails) => patch.mutate({ access: { ...s.access, participants: emails.map((e) => e.toLowerCase()) } })} />
        )}
      </Section>
    </div>
  );
}

// A newline-separated list editor (globs, participant emails). Local draft, saved on blur so a
// patch fires once per edit rather than per keystroke; blank lines are dropped.
function GlobField({ label, value, placeholder, onSave }: {
  label: string; value: string[]; placeholder: string; onSave: (rows: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join("\n"));
  useEffect(() => { setDraft(value.join("\n")); }, [value]);
  const commit = () => {
    const rows = draft.split("\n").map((r) => r.trim()).filter(Boolean);
    if (rows.join("\n") !== value.join("\n")) onSave(rows);
  };
  return (
    <label className="mt-2 block text-sm">
      <span className="mb-1 block text-black/70">{label}</span>
      <textarea value={draft} placeholder={placeholder} rows={2} onBlur={commit}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full rounded border border-[var(--lfb-border)] px-2 py-1 font-mono text-xs" />
    </label>
  );
}

// The shared 3-way artifact-placement radio (placement_radios.mdx / repo_settings.mdx §4-5). Used by the
// Transcription and AI-descriptions sections. "sync_repo" is disabled until a company state-sync repo is
// configured (that settings surface is a later seam); switching only affects FUTURE artifacts.
const PLACEMENT_OPTIONS: { value: PlacementChoice; label: string; helper: string; disabled?: boolean }[] = [
  {
    value: "lfbridge",
    label: "In this repo's hidden .lfbridge/ folder",
    helper: "Default — path-mirrored inside the repo, travels with it. Written only once the repo has produced its first transcript or AI description.",
  },
  {
    value: "beside",
    label: "Next to the file",
    helper: "Written beside the media in the same folder (not a hidden directory).",
  },
  {
    value: "sync_repo",
    label: "In the company's Large File Bridge state-sync repo",
    helper: "Available once a company state-sync repo is configured.",
    disabled: true,
  },
];

function PlacementSection({ title, blurb, value, onChange }: {
  title: string; blurb: string; value: PlacementChoice; onChange: (v: PlacementChoice) => void;
}) {
  return (
    <Section title={title}>
      <p className="mb-2 text-sm text-black/60">{blurb}</p>
      {PLACEMENT_OPTIONS.map((o) => (
        <label key={o.value} className={`flex items-start gap-2 py-1 text-sm ${o.disabled ? "opacity-50" : "cursor-pointer"}`}>
          <input
            type="radio"
            name={title}
            checked={value === o.value}
            disabled={o.disabled}
            onChange={() => { if (!o.disabled) onChange(o.value); }}
            className="mt-0.5"
          />
          <span>
            <span className="text-black/80">{o.label}</span>
            <span className="block text-xs text-black/50">{o.helper}</span>
          </span>
        </label>
      ))}
    </Section>
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
