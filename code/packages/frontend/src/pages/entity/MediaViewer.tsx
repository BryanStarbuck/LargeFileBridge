// The shared, viewer-first layout for View-one-image (/image) and View-one-video (/video)
// (media_viewer.mdx §3). One <MediaViewer kind> renders a slim header (name + path + the same ⋯ File
// menu as /file), a thin action-button row (IPFS primary · repo chip · compress-state chip · codec
// chip), a LARGE viewer surface (the star), and a compact property strip + action links.
//
// The medium plays/loads off local disk via the backend stream — never file:// — through a short-lived
// signed grant (GET /api/media/grant) that the <img>/<video> element loads from /api/media/raw. Video
// seeks because that endpoint honors HTTP Range (media_viewer.mdx §1–§2).
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, UploadCloud, DownloadCloud, FolderOpen, Copy, FileText, ExternalLink, Zap } from "lucide-react";
import { toast } from "sonner";
import type { EntityView, Decision, MediaKind } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { EntityMore } from "@/components/menu/EntityMenu";
import { EntityHeaderMissing } from "./entityShared";
import { relativeTime, absoluteTime } from "@/lib/format";

export function MediaViewer({ kind }: { kind: MediaKind }) {
  const { path } = useSearch({ strict: false }) as { path?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: v, isLoading } = useQuery({
    queryKey: ["entity", path],
    queryFn: () => api.entity(path!),
    enabled: !!path,
  });
  // The signed same-origin URL the media element loads (Range-capable). Refetched per path.
  const { data: grant } = useQuery({
    queryKey: ["media-grant", path],
    queryFn: () => api.mediaGrant(path!),
    enabled: !!path && !!v?.exists,
    staleTime: 5 * 60 * 1000,
  });
  // Best-effort codec/dimensions — fills the codec chip + property strip; never blocks the viewer.
  const { data: probe } = useQuery({
    queryKey: ["media-probe", path],
    queryFn: () => api.mediaProbe(path!),
    enabled: !!path && !!v?.exists,
  });

  const decide = useMutation({
    mutationFn: (d: Decision) => api.setEntityDecision(path!, d),
    onSuccess: (nv) => {
      qc.setQueryData(["entity", path], nv);
      qc.invalidateQueries({ queryKey: ["fs"] });
      qc.invalidateQueries({ queryKey: ["repo"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Route by the file's real kind — never leave the wrong viewer mounted (media_viewer.mdx §5).
  useEffect(() => {
    if (!v?.exists) return;
    const actual: "image" | "video" | null = v.compressible; // "image" | "video" | null
    if (actual === "image" && kind !== "image") navigate({ to: "/image", search: { path: v.path } });
    else if (actual === "video" && kind !== "video") navigate({ to: "/video", search: { path: v.path } });
    else if (actual === null) navigate({ to: "/file", search: { path: v.path } });
  }, [v, kind, navigate]);

  if (!path) return <p className="text-black/60">No file selected.</p>;
  if (isLoading) return <SkeletonViewer />;
  if (!v) return <p className="text-black/60">Could not load this file.</p>;
  if (!v.exists) return <EntityHeaderMissing view={v} navigate={navigate} />;

  const parent = v.path.replace(/[/\\][^/\\]*$/, "") || v.path;
  const dims = probe?.width && probe?.height ? `${probe.width}×${probe.height}` : null;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
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
        <div className="shrink-0">
          <EntityMore path={v.path} />
        </div>
      </div>

      {/* Action-button row (media_viewer.mdx §4) */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <IpfsPrimary view={v} decide={decide} />
        <RepoChip view={v} navigate={navigate} />
        <CompressChip view={v} />
        <CodecChip codec={probe?.codec ?? null} container={probe?.container ?? null} />
      </div>

      {/* The viewer surface — the star; takes all remaining height (media_viewer.mdx §3) */}
      <div className="mt-3 min-h-0 flex-1">
        <ViewerSurface kind={kind} src={grant?.url ?? null} name={v.name} probeCodec={probe?.codec ?? null} />
      </div>

      {/* Property strip + action links */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-[var(--lfb-border)] pt-2 text-xs text-black/60">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {v.sizeBytes != null && <span>{formatBytes(v.sizeBytes)}</span>}
          {dims && <span>· {dims}</span>}
          <span>· modified <span title={absoluteTime(v.modifiedAt)}>{relativeTime(v.modifiedAt)}</span></span>
          {v.badges.length > 0 && (
            <span className="flex items-center gap-1">· <Badges badges={v.badges} /></span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <LinkBtn icon={<FolderOpen className="h-3.5 w-3.5" />} label="Open folder"
            onClick={() => navigate({ to: "/fs", search: { path: parent } })} />
          <LinkBtn icon={<Copy className="h-3.5 w-3.5" />} label="Copy path"
            onClick={() => { navigator.clipboard?.writeText(v.path); toast.success("Path copied"); }} />
          <LinkBtn icon={<FileText className="h-3.5 w-3.5" />} label="View properties"
            onClick={() => navigate({ to: "/file", search: { path: v.path } })} />
          {grant?.url && (
            <a href={grant.url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-[var(--lfb-primary)] hover:underline">
              <ExternalLink className="h-3.5 w-3.5" /> Open raw
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── The viewer surface ──────────────────────────────────────────────────────────
function ViewerSurface({
  kind,
  src,
  name,
  probeCodec,
}: {
  kind: MediaKind;
  src: string | null;
  name: string;
  probeCodec: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false); // image: fit ↔ 100%

  // Reset transient view state when the source changes.
  useEffect(() => { setFailed(false); setZoom(false); }, [src]);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-auto rounded-lg bg-[#141414]">
      {!src ? (
        <div className="h-2/3 w-2/3 animate-pulse rounded bg-white/5" />
      ) : failed ? (
        <DecodeFailure codec={probeCodec} src={src} />
      ) : kind === "image" ? (
        <img
          src={src}
          alt={name}
          onError={() => setFailed(true)}
          onClick={() => setZoom((z) => !z)}
          style={{ imageRendering: "auto" }}
          className={
            zoom
              ? "max-w-none cursor-zoom-out"
              : "max-h-full max-w-full cursor-zoom-in object-contain"
          }
        />
      ) : (
        <video
          src={src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          className="max-h-full max-w-full"
        />
      )}
    </div>
  );
}

function DecodeFailure({ codec, src }: { codec: string | null; src: string }) {
  return (
    <div className="max-w-md rounded-lg border border-white/15 bg-black/40 px-5 py-4 text-center text-sm text-white/80">
      <p className="mb-3">
        This browser can't play this file{codec ? <> ’s codec (<b>{codec}</b>)</> : null}.
      </p>
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 rounded-md bg-white/10 px-3 py-1.5 text-white hover:bg-white/20"
      >
        <ExternalLink className="h-4 w-4" /> Open raw / hand off to the OS
      </a>
    </div>
  );
}

// ── Action-bar pieces ────────────────────────────────────────────────────────────
function IpfsPrimary({ view: v, decide }: { view: EntityView; decide: { mutate: (d: Decision) => void } }) {
  if (!v.repo) return null;
  if (v.decision === "sync") {
    return (
      <button
        onClick={() => decide.mutate("ignore")}
        className="flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/70 hover:bg-slate-100"
      >
        <DownloadCloud className="h-4 w-4" /> Remove from IPFS
      </button>
    );
  }
  if (!v.flags.neverIpfs) {
    return (
      <button
        onClick={() => decide.mutate("sync")}
        className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white"
      >
        <UploadCloud className="h-4 w-4" /> Add to IPFS
      </button>
    );
  }
  return null;
}

function RepoChip({ view: v, navigate }: { view: EntityView; navigate: ReturnType<typeof useNavigate> }) {
  if (!v.repo) return <Chip muted>not in a repo</Chip>;
  return (
    <button
      onClick={() => navigate({ to: "/repos/$repoId", params: { repoId: v.repo!.repoId } })}
      title={`Open repo ${v.repo.name}`}
    >
      <Chip>repo: {v.repo.name}</Chip>
    </button>
  );
}

function CompressChip({ view: v }: { view: EntityView }) {
  if (!v.compressible) return null;
  const done = v.compressState === "done";
  const suppressed = v.flags.noCompress;
  // A clickable Compress… offer only when it "should" compress and the user hasn't opted out.
  if (!done && !suppressed) {
    const compress = () => {
      if (!window.confirm(`Compress ${v.name}? This is an offer — nothing changes until it runs.`)) return;
      api.compressEntity(v.path).then(() => toast.success("Compression queued")).catch((e) => toast.error(e.message));
    };
    return (
      <button onClick={compress} title="Offer to compress (nothing changes until it runs)">
        <Chip tone="warn"><Zap className="h-3 w-3" /> looks uncompressed</Chip>
      </button>
    );
  }
  return <Chip muted>{done ? "already compressed" : v.compressible}</Chip>;
}

function CodecChip({ codec, container }: { codec: string | null; container: string | null }) {
  if (!codec && !container) return null;
  const label = codec && container ? `${codec} · ${container}` : (codec ?? container)!;
  return <Chip muted>{label}</Chip>;
}

function Chip({
  children,
  muted,
  tone,
}: {
  children: React.ReactNode;
  muted?: boolean;
  tone?: "warn";
}) {
  const cls = tone === "warn"
    ? "border-amber-300 bg-amber-50 text-amber-800"
    : muted
      ? "border-[var(--lfb-border)] bg-slate-50 text-black/60"
      : "border-[var(--lfb-border)] bg-white text-black/80 hover:bg-slate-100";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${cls}`}>
      {children}
    </span>
  );
}

function LinkBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 text-[var(--lfb-primary)] hover:underline">
      {icon} {label}
    </button>
  );
}

function SkeletonViewer() {
  return (
    <div className="flex h-full animate-pulse flex-col gap-3">
      <div className="h-6 w-1/3 rounded bg-slate-100" />
      <div className="h-9 w-1/2 rounded bg-slate-100" />
      <div className="min-h-0 flex-1 rounded-lg bg-slate-100" />
    </div>
  );
}
