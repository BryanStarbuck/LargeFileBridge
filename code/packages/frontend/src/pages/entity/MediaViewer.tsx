// The shared, viewer-first layout for View-one-image (/image) and View-one-video (/video)
// (media_viewer.mdx §3). One <MediaViewer kind> renders a slim header (name + path + the same ⋯ File
// menu as /file), a thin action-button row (IPFS primary · repo chip · compress-state chip · codec
// chip), a LARGE viewer surface (the star), and a compact property strip + action links.
//
// The medium plays/loads off local disk via the backend stream — never file:// — through a short-lived
// signed grant (GET /api/media/grant) that the <img>/<video> element loads from /api/media/raw. Video
// seeks because that endpoint honors HTTP Range (media_viewer.mdx §1–§2).
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, UploadCloud, DownloadCloud, FolderOpen, Copy, FileText, ExternalLink, Zap } from "lucide-react";
import { toast } from "sonner";
import type { EntityView, Decision, MediaKind } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { EntityMore } from "@/components/menu/EntityMenu";
import { patchEntityBadges } from "@/lib/patchEntityBadges";
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
  // Cheap IPFS liveness so the IPFS button can disable when the node is down (media_viewer.mdx §5).
  // Undefined while loading → treat as reachable so the button is never needlessly disabled.
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    staleTime: 30 * 1000,
  });
  const ipfsReachable = health?.ipfs !== "unreachable";

  const decide = useMutation({
    mutationFn: (d: Decision) => api.setEntityDecision(path!, d),
    onSuccess: (nv) => {
      // Patch the fresh badges into cached File-System listings instead of re-walking ["fs"]
      // (performance.mdx P-17). Repo views are cheap stored status → still refresh.
      qc.setQueryData(["entity", path], nv);
      patchEntityBadges(qc, nv.path, nv.badges);
      qc.invalidateQueries({ queryKey: ["repo"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Route by the file's real kind — never leave the wrong viewer mounted (media_viewer.mdx §5).
  // `replace` so the wrong-kind URL doesn't linger in history and re-bounce on Back.
  useEffect(() => {
    if (!v?.exists) return;
    const actual: "image" | "video" | null = v.compressible; // "image" | "video" | null
    if (actual === "image" && kind !== "image") navigate({ to: "/image", search: { path: v.path }, replace: true });
    else if (actual === "video" && kind !== "video") navigate({ to: "/video", search: { path: v.path }, replace: true });
    else if (actual === null) navigate({ to: "/file", search: { path: v.path }, replace: true });
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
        <IpfsPrimary view={v} decide={decide} ipfsReachable={ipfsReachable} />
        <RepoChip view={v} navigate={navigate} />
        <CompressChip view={v} />
        <CodecChip codec={probe?.codec ?? null} container={probe?.container ?? null} />
      </div>

      {/* The viewer surface — the star; takes all remaining height (media_viewer.mdx §3) */}
      <div className="mt-3 min-h-0 flex-1">
        <ViewerSurface kind={kind} src={grant?.url ?? null} view={v} probeCodec={probe?.codec ?? null} />
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
// A checkerboard so real transparency shows through a PNG/WebP (media_viewer.mdx §3). Painted
// BEHIND the image only — an opaque JPEG/frame fully covers it, so it reads only through alpha.
const CHECKERBOARD: React.CSSProperties = {
  backgroundColor: "#1b1b1b",
  backgroundImage:
    "linear-gradient(45deg, #2e2e2e 25%, transparent 25%), linear-gradient(-45deg, #2e2e2e 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #2e2e2e 75%), linear-gradient(-45deg, transparent 75%, #2e2e2e 75%)",
  backgroundSize: "20px 20px",
  backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0",
};

function ViewerSurface({
  kind,
  src,
  view,
  probeCodec,
}: {
  kind: MediaKind;
  src: string | null;
  view: EntityView;
  probeCodec: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false); // image: fit ↔ 100%
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  // Reset transient view state when the source changes.
  useEffect(() => { setFailed(false); setZoom(false); }, [src]);

  // Drag-to-pan a zoomed image (media_viewer.mdx §3). Only active when zoomed-in and overflowing.
  const onPointerDown = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!zoom || !el) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!drag.current || !el) return;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const endDrag = (e: React.PointerEvent) => {
    if (drag.current) scrollRef.current?.releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  return (
    <div
      ref={scrollRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={`relative flex h-full w-full items-center justify-center overflow-auto rounded-lg bg-[#141414] ${
        zoom ? "cursor-grab active:cursor-grabbing" : ""
      }`}
    >
      {!src ? (
        <div className="h-2/3 w-2/3 animate-pulse rounded bg-white/5" />
      ) : failed ? (
        <DecodeFailure kind={kind} codec={probeCodec} src={src} view={view} />
      ) : kind === "image" ? (
        <img
          src={src}
          alt={view.name}
          // Decode off the main thread so a large original doesn't hitch the tab while it paints
          // (performance.mdx P-13); loading="lazy" completes the pair (P-21).
          decoding="async"
          loading="lazy"
          onError={() => setFailed(true)}
          // Click toggles fit ↔ 100%; a pan-drag isn't a click, so suppress the toggle after a drag.
          onClick={() => { if (!drag.current) setZoom((z) => !z); }}
          style={{ imageRendering: "auto", ...CHECKERBOARD }}
          className={
            zoom
              ? "max-w-none"
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

function DecodeFailure({
  kind,
  codec,
  src,
  view,
}: {
  kind: MediaKind;
  codec: string | null;
  src: string;
  view: EntityView;
}) {
  // Charter §6.1: bytes are never altered without an explicit ask. For an uncompressed video whose
  // codec the browser can't decode, offer Compress… as the suggested fix (media_viewer.mdx §5).
  const offerCompress = kind === "video" && canOfferCompress(view);
  return (
    <div className="max-w-md rounded-lg border border-white/15 bg-black/40 px-5 py-4 text-center text-sm text-white/80">
      <p className="mb-3">
        This browser can't play this file{codec ? <> ’s codec (<b>{codec}</b>)</> : null}.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md bg-white/10 px-3 py-1.5 text-white hover:bg-white/20"
        >
          <ExternalLink className="h-4 w-4" /> Open raw / hand off to the OS
        </a>
        {offerCompress && (
          <button
            onClick={() => runCompressOffer(view)}
            title="Offer to compress (nothing changes until it runs)"
            className="inline-flex items-center gap-1 rounded-md bg-amber-500/90 px-3 py-1.5 text-white hover:bg-amber-500"
          >
            <Zap className="h-4 w-4" /> Compress…
          </button>
        )}
      </div>
    </div>
  );
}

// ── Compress offer (charter §6.1 — explicit click, confirm, never automatic) ───────
/** Eligible for a Compress… offer: it "should" compress and the user hasn't opted out. */
function canOfferCompress(v: EntityView): boolean {
  return v.compressState === "should" && !v.flags.noCompress;
}
/** Fire the confirm-gated compress offer. Shared by the action-row chip and the decode-failure card. */
function runCompressOffer(v: EntityView): void {
  if (!window.confirm(`Compress ${v.name}? This is an offer — nothing changes until it runs.`)) return;
  api.compressEntity(v.path).then(() => toast.success("Compression queued")).catch((e: Error) => toast.error(e.message));
}

// ── Action-bar pieces ────────────────────────────────────────────────────────────
function IpfsPrimary({
  view: v,
  decide,
  ipfsReachable,
}: {
  view: EntityView;
  decide: { mutate: (d: Decision) => void };
  ipfsReachable: boolean;
}) {
  if (!v.repo) return null;
  const isSync = v.decision === "sync";
  // Not-in-sync + Never-IPFS → no primary button (the ⋯ menu still governs).
  if (!isSync && v.flags.neverIpfs) return null;
  // Node down → the button stays visible but disabled with a tooltip (parity with one_repo.mdx §5).
  const disabledProps = ipfsReachable
    ? {}
    : { disabled: true, title: "IPFS node unreachable — start your IPFS node to add/remove pins" };
  return isSync ? (
    <button
      {...disabledProps}
      onClick={() => decide.mutate("ignore")}
      className="flex items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/70 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <DownloadCloud className="h-4 w-4" /> Remove from IPFS
    </button>
  ) : (
    <button
      {...disabledProps}
      onClick={() => decide.mutate("sync")}
      className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      <UploadCloud className="h-4 w-4" /> Add to IPFS
    </button>
  );
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
  // A clickable Compress… offer only when it "should" compress and the user hasn't opted out.
  if (canOfferCompress(v)) {
    return (
      <button onClick={() => runCompressOffer(v)} title="Offer to compress (nothing changes until it runs)">
        <Chip tone="warn"><Zap className="h-3 w-3" /> looks uncompressed</Chip>
      </button>
    );
  }
  // Suppressed (Do not compress) collapses to a neutral kind label; else the compressed fact (media_viewer.mdx §4).
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
