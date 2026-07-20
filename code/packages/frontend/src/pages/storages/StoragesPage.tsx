// The Storages tab (storages.mdx §2) — the map of every large-file storage this user belongs to:
// Local (settings/config), Personal, one row per Company, the Repos link (routes to the Repos tab, not a
// long list), and the opted-in Communities. Each directory-based storage links to its detail page; a
// detected-but-uninitialized candidate offers an Initialize action (writes storage.yaml + .lfbridge/).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { HardDrive, FolderGit2, User, Building2, Users, Database } from "lucide-react";
import { toast } from "sonner";
import type { StorageRow } from "@lfb/shared";
import { api } from "@/api/client";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataTable } from "@/components/table/DataTable";
import type { LfbColumn } from "@/components/table/types";
import { StorageGear, StorageKebab } from "@/components/menu/RowKebabs";
import { clientLog } from "@/lib/clientLog";

export function StoragesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["storages"], queryFn: api.storages });

  const init = useMutation({
    mutationFn: (id: string) => api.initStorage(id),
    onSuccess: () => { toast.success("Storage initialized"); qc.invalidateQueries({ queryKey: ["storages"] }); },
    onError: (e: Error) => { clientLog.error("StoragesPage.init", e); toast.error(e.message); },
  });

  // Local + Repos are special (not rows in the table); Personal + Companies + Communities are the rows.
  const rows: StorageRow[] = [
    ...(data?.personal ? [data.personal] : []),
    ...(data?.companies ?? []),
    ...(data?.communities ?? []),
  ];

  const columns: LfbColumn<StorageRow>[] = [
    {
      id: "name", header: "Storage", kind: "text", accessor: (s) => s.name,
      cell: (s) => (
        <span className="flex items-center gap-2">
          <TypeIcon type={s.type} />
          <span className="font-medium">{s.name}</span>
          {!s.initialized && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">not set up</span>}
        </span>
      ),
    },
    { id: "type", header: "Type", kind: "enum", accessor: (s) => s.type,
      filterOptions: ["personal", "company", "community"], cell: (s) => <span className="capitalize">{s.type}</span> },
    { id: "detail", header: "Detail", kind: "text", sortable: false, filterable: false, accessor: (s) => s.companyName ?? s.communityId ?? "",
      cell: (s) => <span className="text-black/60">{s.companyName ?? s.communityId ?? "—"}</span> },
    { id: "files", header: "Files", kind: "int", align: "right", accessor: (s) => s.fileCount ?? -1,
      cell: (s) => <span className="text-black/70">{s.fileCount ?? "—"}</span> },
    { id: "root", header: "Root", kind: "text", accessor: (s) => s.root,
      cell: (s) => <span className="font-mono text-xs text-black/50">{s.root}</span> },
    {
      id: "action", header: "", kind: "text", sortable: false, filterable: false, accessor: () => "",
      cell: (s) => (
        <span className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
          {s.initialized ? (
            <button className="text-sm text-[var(--lfb-primary)] hover:underline" onClick={() => navigate({ to: "/storages/$storageId", params: { storageId: s.id } })}>Open</button>
          ) : (
            <button className="rounded-md border border-[var(--lfb-border)] px-2 py-1 text-xs hover:bg-slate-100" disabled={init.isPending} onClick={() => init.mutate(s.id)}>Initialize</button>
          )}
          {/* Gear → per-storage settings, sitting just left of the ⋮ kebab (storage_settings.mdx §1). */}
          <StorageGear storage={s} />
          <StorageKebab storage={s} />
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Storages" subtitle="Every large-file storage you belong to — Personal, your companies, your repos, and the communities you carry." />

      {/* Local + Repos tiles (not table rows) */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Tile
          icon={<Database className="h-5 w-5" />}
          title="Local (this computer)"
          sub="Settings & config — the database replacement. Not pinned by itself."
          onClick={() => navigate({ to: "/settings" })}
        />
        <Tile
          icon={<FolderGit2 className="h-5 w-5" />}
          title={`Repos${data ? ` — ${data.repos.count}` : ""}`}
          sub="Every Git repo LFBridge tracks. Opens the Repos tab (the long list)."
          onClick={() => navigate({ to: "/" })}
        />
      </div>

      <OrganizationProposals />

      <DataTable
        tableId="storages"
        fillHeight={false}
        data={rows}
        columns={columns}
        searchKeys={(s) => `${s.name} ${s.root} ${s.companyName ?? ""} ${s.communityId ?? ""}`}
        getRowId={(s) => s.id}
        onRowClick={(s) => s.initialized && navigate({ to: "/storages/$storageId", params: { storageId: s.id } })}
        // ⌘/Ctrl/middle-click opens the row's destination in a new tab, like any link (tables.mdx §4d).
        // An uninitialized storage has no page, so it has no href either — the row stays inert.
        rowHref={(s) => (s.initialized ? `/storages/${encodeURIComponent(s.id)}` : "")}
        itemNoun="storages"
        loading={isLoading}
        empty={<p className="text-center text-black/60">No Personal / Company / Community storages found yet. Create a directory named <code>*_large_files_bridge</code> (or add a <code>storage.yaml</code>) under a scanner root, then reload.</p>}
      />
    </div>
  );
}

// ── the org → company proposal section (storage_company.mdx §10.3) ───────────────────────────────────
// A company storage IS a forge organization, and the repos already say which org they belong to — so this
// section is Large File Bridge reading that off the disk and OFFERING it. It never creates anything on its
// own: creating a company storage makes a real directory and runs `git init`, so it takes a deliberate
// click. Unchecking a row before the click means no directory is ever made for it.
function OrganizationProposals() {
  const qc = useQueryClient();
  const [showSkipped, setShowSkipped] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const { data, isLoading } = useQuery({ queryKey: ["organizations"], queryFn: api.organizations });

  const create = useMutation({
    mutationFn: (orgs: string[]) => api.createCompanyStorages(orgs),
    onSuccess: ({ created }) => {
      const adopted = created.filter((c) => c.adopted).length;
      toast.success(
        `Large File Bridge set up ${created.length} company ${created.length === 1 ? "storage" : "storages"}` +
          (adopted ? ` (${adopted} adopted an existing storage)` : ""),
      );
      // A brand-new company storage has no git remote yet, and staying quiet about that is the worst
      // failure this product has (§11.2) — a repo that commits forever and never pushes looks healthy.
      const noRemote = created.filter((c) => !c.hasRemote);
      if (noRemote.length) {
        toast.warning(
          `${noRemote.length === 1 ? noRemote[0]!.name : `${noRemote.length} of them`} has no remote yet — nothing is reaching your other computers until you add one.`,
        );
      }
      setChecked({});
      qc.invalidateQueries({ queryKey: ["storages"] });
      qc.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (e: Error) => { clientLog.error("StoragesPage.createCompanies", e); toast.error(e.message); },
  });

  const dismiss = useMutation({
    mutationFn: (org: string) => api.dismissOrganization(org, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["organizations"] }),
    onError: (e: Error) => { clientLog.error("StoragesPage.dismissOrg", e); toast.error(e.message); },
  });

  if (isLoading || !data) return null;

  // Proposals = orgs you belong to that no storage claims yet and that you have not waved away. An org an
  // existing storage already claims was ADOPTED during discovery (its binding recorded), so it is reported
  // rather than offered — that is how ACT3ai lands on the existing Act3 storage instead of a duplicate.
  const proposals = data.organizations.filter((o) => !o.alreadyClaimed && !o.dismissed);
  const adopted = data.organizations.filter((o) => o.alreadyClaimed);
  if (proposals.length === 0 && data.skippedCount === 0) return null;

  const selected = proposals.filter((o) => checked[o.slug]).map((o) => o.org);

  return (
    <section className="mb-4 rounded-lg border border-[var(--lfb-border)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-black">Organizations found in your repos</h2>
          <p className="text-sm text-black/60">
            A company storage is one organization. Large File Bridge read these from your repos&rsquo; git
            remotes — no network, no forge account needed — and kept the ones you have actually committed to.
          </p>
        </div>
        {proposals.length > 0 && (
          <button
            className="shrink-0 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={selected.length === 0 || create.isPending}
            onClick={() => create.mutate(selected)}
          >
            Create company storages{selected.length ? ` (${selected.length})` : ""}
          </button>
        )}
      </div>

      {proposals.length > 0 && (
        <ul className="mt-3 divide-y divide-[var(--lfb-border)]">
          {proposals.map((o) => (
            <li key={o.slug} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={!!checked[o.slug]}
                onChange={(e) => setChecked((c) => ({ ...c, [o.slug]: e.target.checked }))}
              />
              <span className="flex-1">
                <span className="block font-medium text-black">
                  {o.org} <span className="font-normal text-black/50">— {o.repoCount} {o.repoCount === 1 ? "repo" : "repos"} on this computer</span>
                </span>
                <span className="block font-mono text-xs text-black/50">{o.proposedRoot}</span>
              </span>
              <button
                className="text-xs text-black/50 hover:text-black hover:underline"
                title="Don't offer this organization again"
                onClick={() => dismiss.mutate(o.org)}
              >
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      )}

      {adopted.length > 0 && (
        <p className="mt-3 text-sm text-black/60">
          Already set up:{" "}
          {adopted.map((o, i) => (
            <span key={o.slug}>
              {i > 0 && ", "}
              <span className="font-medium text-black/80">{o.org}</span> → {o.claimedByStorageName}
            </span>
          ))}
        </p>
      )}

      {/* §10.2 — "say the number". A silent filter and a bug look identical, so the orgs the membership
          test excluded are counted here and can be listed on demand. */}
      {data.skippedCount > 0 && (
        <p className="mt-3 text-sm text-black/60">
          {data.skippedCount} {data.skippedCount === 1 ? "organization you've" : "organizations you've"} only
          cloned from {data.skippedCount === 1 ? "was" : "were"} ignored — you have not committed to{" "}
          {data.skippedCount === 1 ? "it" : "any of them"} on this computer.{" "}
          <button className="text-[var(--lfb-primary)] hover:underline" onClick={() => setShowSkipped((v) => !v)}>
            {showSkipped ? "Hide them" : "Show them"}
          </button>
          {showSkipped && (
            <span className="mt-1 block font-mono text-xs text-black/50">
              {data.skipped.map((o) => `${o.org} (${o.repoCount})`).join(" · ")}
            </span>
          )}
        </p>
      )}
    </section>
  );
}

function TypeIcon({ type }: { type: StorageRow["type"] }) {
  const cls = "h-4 w-4 text-black/50";
  if (type === "personal") return <User className={cls} />;
  if (type === "company") return <Building2 className={cls} />;
  if (type === "community") return <Users className={cls} />;
  return <HardDrive className={cls} />;
}

function Tile({ icon, title, sub, onClick }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-start gap-3 rounded-lg border border-[var(--lfb-border)] px-4 py-3 text-left hover:border-[var(--lfb-primary)]"
    >
      <span className="mt-0.5 text-black/60">{icon}</span>
      <span>
        <span className="block font-medium text-black">{title}</span>
        <span className="block text-sm text-black/60">{sub}</span>
      </span>
    </button>
  );
}

export { StoragesPage as default };
