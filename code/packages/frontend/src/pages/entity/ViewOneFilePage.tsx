// View one file (files.mdx) — the single-entity page for ONE file. Identity + badges + the two sticky
// flag switches + fact cards (Sync / Compression / IPFS / File), with the top-right ⋯ "more" menu
// (menus.mdx §4) rendering the same File catalog as the row kebab.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, UploadCloud, RefreshCw, Image as ImageIcon, Film } from "lucide-react";
import { toast } from "sonner";
import type { EntityView, Decision } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { EntityMore } from "@/components/menu/EntityMenu";
import { FlagSwitches, EntityHeaderMissing } from "./entityShared";
import { TransferPill } from "@/components/Pill";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { type Health } from "@/components/ui/health";
import { relativeTime, absoluteTime, middleTruncate } from "@/lib/format";

export function ViewOneFilePage() {
  const { path } = useSearch({ strict: false }) as { path?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: v, isLoading } = useQuery({
    queryKey: ["entity", path],
    queryFn: () => api.entity(path!),
    enabled: !!path,
  });

  const decide = useMutation({
    mutationFn: (d: Decision) => api.setEntityDecision(path!, d),
    onSuccess: (nv) => qc.setQueryData(["entity", path], nv),
    onError: (e: Error) => toast.error(e.message),
  });

  if (!path) return <p className="text-black/60">No file selected.</p>;
  if (isLoading) return <SkeletonPage />;
  if (!v) return <p className="text-black/60">Could not load this file.</p>;
  if (!v.exists) return <EntityHeaderMissing view={v} navigate={navigate} />;

  const primary = pickPrimary(v, decide);

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <button
            onClick={() => history.back()}
            className="flex items-center gap-1 text-sm text-black/50 hover:text-black"
          >
            <ChevronLeft className="h-4 w-4" /> back
          </button>
          <h1 className="truncate text-xl font-semibold text-black" title={v.name}>{v.name}</h1>
          <div className="truncate font-mono text-xs text-black/50" title={v.path}>{v.path}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <OpenViewer view={v} navigate={navigate} />
          {primary}
          <EntityMore path={v.path} />
        </div>
      </div>

      {/* Badge + flag strip */}
      <div className="my-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-[var(--lfb-border)] px-4 py-2">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-black/40">Badges</span>
          {v.badges.length ? <Badges badges={v.badges} /> : <span className="text-xs text-black/30">none</span>}
        </div>
        <FlagSwitches view={v} />
      </div>

      {/* Cards */}
      <div className="space-y-3">
        <Card title="Sync">
          {v.repo ? (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-1 text-sm">
              <span>
                Decision{" "}
                <select
                  value={v.decision ?? "undecided"}
                  onChange={(e) => decide.mutate(e.target.value as Decision)}
                  className="rounded border border-[var(--lfb-border)] px-1 py-0.5 text-xs"
                >
                  {(["sync", "ignore", "undecided"] as Decision[]).map((d) => (
                    <option key={d} value={d} disabled={d === "sync" && v.flags.neverIpfs}>
                      {d[0].toUpperCase() + d.slice(1)}
                    </option>
                  ))}
                </select>
              </span>
              <span className="flex items-center gap-1">Status {v.transfer && <TransferPill status={v.transfer} />}</span>
              <span>Peers <b className={v.decision === "sync" && v.peers.length === 0 ? "text-red-600" : ""}>{v.peers.length}</b></span>
              {v.cid && (
                <code
                  className="cursor-pointer text-xs text-black/60"
                  title={`${v.cid} — click to copy`}
                  onClick={() => { navigator.clipboard?.writeText(v.cid!); toast.success("CID copied"); }}
                >
                  {middleTruncate(v.cid, 20)}
                </code>
              )}
            </div>
          ) : (
            <NotTracked view={v} navigate={navigate} />
          )}
        </Card>

        <Card title="Compression">
          {v.compressible ? (
            <div className="flex items-center justify-between text-sm">
              <span className="capitalize text-black/70">
                {v.compressible} · {v.compressState === "done" ? "already compressed" : "looks uncompressed"}
                {v.sizeBytes != null && ` · ${formatBytes(v.sizeBytes)}`}
                {v.flags.noCompress && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-black/50">Do not compress</span>}
              </span>
            </div>
          ) : (
            <span className="text-sm text-black/50">Not a compressible media file.</span>
          )}
        </Card>

        <Card title="File">
          <div className="text-sm text-black/70">
            {v.sizeBytes != null && <>{formatBytes(v.sizeBytes)} · </>}
            created {v.createdAt ? absoluteTime(v.createdAt) : "—"} · modified{" "}
            <span title={absoluteTime(v.modifiedAt)}>{relativeTime(v.modifiedAt)}</span>
            {v.repo && <> · inside repo <b>{v.repo.name}</b></>}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** The one link from the properties page to its viewer-first sibling (files.mdx §7). Media only. */
function OpenViewer({ view: v, navigate }: { view: EntityView; navigate: ReturnType<typeof useNavigate> }) {
  if (v.compressible !== "image" && v.compressible !== "video") return null;
  const to = v.compressible === "image" ? "/image" : "/video";
  return (
    <button
      onClick={() => navigate({ to, search: { path: v.path } })}
      className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white"
    >
      {v.compressible === "image" ? <ImageIcon className="h-4 w-4" /> : <Film className="h-4 w-4" />}
      Open {v.compressible} viewer
    </button>
  );
}

function pickPrimary(v: EntityView, decide: { mutate: (d: Decision) => void }) {
  if (!v.repo) return null;
  if (!v.flags.neverIpfs && v.decision !== "sync") {
    return (
      <button
        onClick={() => decide.mutate("sync")}
        className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white"
      >
        <UploadCloud className="h-4 w-4" /> Add to IPFS
      </button>
    );
  }
  if (v.decision === "sync") {
    return (
      <span className="flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/60">
        <RefreshCw className="h-4 w-4" /> Syncing
      </span>
    );
  }
  return null;
}

function NotTracked({ view, navigate }: { view: EntityView; navigate: ReturnType<typeof useNavigate> }) {
  const parent = view.path.replace(/[/\\][^/\\]*$/, "") || view.path;
  return (
    <div className="flex items-center justify-between text-sm text-black/50">
      <span>Not tracked — this file isn't inside a registered repo.</span>
      <button className="text-[var(--lfb-primary)]" onClick={() => navigate({ to: "/fs", search: { path: parent } })}>
        Open containing folder
      </button>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--lfb-border)] px-4 py-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-black/40">{title}</h2>
      {children}
    </section>
  );
}

function SkeletonPage() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-6 w-1/3 rounded bg-slate-100" />
      <div className="h-10 rounded bg-slate-100" />
      <div className="h-20 rounded bg-slate-100" />
      <div className="h-20 rounded bg-slate-100" />
    </div>
  );
}

export { ViewOneFilePage as default };
