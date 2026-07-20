// The Storages tab (storages.mdx §2) — the map of every large-file storage this user belongs to:
// Local (settings/config), Personal, one row per Company, the Repos link (routes to the Repos tab, not a
// long list), and the opted-in Communities. Each directory-based storage links to its detail page; a
// detected-but-uninitialized candidate offers an Initialize action (writes storage.yaml + .lfbridge/).
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
