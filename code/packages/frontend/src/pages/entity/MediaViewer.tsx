// The shared, viewer-first layout for View-one-image (/image), View-one-video (/video), and
// View-one-audio (/audio) — the "View one file" experience for playable media (media_viewer.mdx §3).
// It renders as a FIVE-BAND vertical stack, top → bottom (media_viewer.mdx §3):
//   1. full path (muted, monospaced)      2. file NAME (large page title)
//   3. action buttons + the ⋮ more menu   4. the property grid (~4–5 cols × 2–3 rows)
//   5. the media surface (the star — bottom ~70%, auto-fits, keeps aspect ratio)
//
// The medium plays/loads off local disk via the backend stream — never file:// — through a short-lived
// signed grant (GET /api/media/grant) that the <img>/<video>/<audio> element loads from /api/media/raw.
// Video/audio seek because that endpoint honors HTTP Range (media_viewer.mdx §1–§2).
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeft, UploadCloud, DownloadCloud, FolderOpen, Copy, FileText, ExternalLink, Zap,
  Move, Trash2, Music, Captions,
} from "lucide-react";
import { toast } from "sonner";
import type { EntityView, Decision, MediaKind } from "@lfb/shared";
import { formatBytes, mediaKindForName } from "@lfb/shared";
import type { CompressResult } from "@lfb/shared";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { EntityMore } from "@/components/menu/EntityMenu";
import { runTranscribeFile } from "@/lib/transcribe";
import { patchEntityBadges } from "@/lib/patchEntityBadges";
import { EntityHeaderMissing } from "./entityShared";
import { relativeTime, absoluteTime } from "@/lib/format";
import { clientLog } from "../../lib/clientLog.js";

/** The viewer route for a media kind (media_viewer.mdx §1). */
function routeForKind(kind: MediaKind): "/image" | "/video" | "/audio" {
  return kind === "image" ? "/image" : kind === "video" ? "/video" : "/audio";
}

export function MediaViewer({ kind }: { kind: MediaKind }) {
  const { path } = useSearch({ strict: false }) as { path?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Duration (seconds) read from the <video>/<audio> element's metadata — fills the grid's Duration cell
  // (media_viewer.mdx §4.3). Probe never computes it (needs a full parse), so the element is the source.
  const [duration, setDuration] = useState<number | null>(null);
  useEffect(() => { setDuration(null); }, [path]);

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
  // Best-effort codec/dimensions — fills the codec/dimension cells; never blocks the viewer.
  const { data: probe } = useQuery({
    queryKey: ["media-probe", path],
    queryFn: () => api.mediaProbe(path!),
    enabled: !!path && !!v?.exists,
  });
  // Cheap IPFS liveness so the IPFS button can disable when the node is down (media_viewer.mdx §5).
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    staleTime: 30 * 1000,
  });
  const ipfsReachable = health?.ipfs !== "unreachable";

  const decide = useMutation({
    mutationFn: (d: Decision) => api.setEntityDecision(path!, d),
    onSuccess: (nv) => {
      qc.setQueryData(["entity", path], nv);
      patchEntityBadges(qc, nv.path, nv.badges);
      qc.invalidateQueries({ queryKey: ["repo"] });
    },
    onError: (e: Error) => {
      clientLog.error("MediaViewer.setEntityDecision", e);
      toast.error(e.message);
    },
  });

  // Route by the file's real kind — from its NAME, so audio (which is not a "compressible" kind on
  // EntityView) still lands on /audio instead of falling through to /file (media_viewer.mdx §5).
  // `replace` so the wrong-kind URL doesn't linger in history and re-bounce on Back.
  useEffect(() => {
    if (!v?.exists) return;
    const actual = mediaKindForName(v.name); // "image" | "video" | "audio" | null
    if (actual === null) navigate({ to: "/file", search: { path: v.path }, replace: true });
    else if (actual !== kind) navigate({ to: routeForKind(actual), search: { path: v.path }, replace: true });
  }, [v, kind, navigate]);

  if (!path) return <p className="text-black/60">No file selected.</p>;
  if (isLoading) return <SkeletonViewer />;
  if (!v) return <p className="text-black/60">Could not load this file.</p>;
  if (!v.exists) return <EntityHeaderMissing view={v} navigate={navigate} />;

  return (
    <div className="flex h-full flex-col">
      {/* Band 1 — full path (the very top line), then band 2 — the file NAME as the large title. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            onClick={() => history.back()}
            className="flex items-center gap-1 text-xs text-black/50 hover:text-black"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> back
          </button>
          <div
            className="mt-0.5 cursor-pointer truncate font-mono text-xs text-black/50 hover:text-black/80"
            title={`${v.path} — click to copy`}
            onClick={() => {
              navigator.clipboard?.writeText(v.path).catch((e) => clientLog.warn("MediaViewer.copyPath", e));
              toast.success("Path copied");
            }}
          >
            {v.path}
          </div>
          <h1 className="truncate text-2xl font-semibold text-black" title={v.name}>{v.name}</h1>
        </div>
        <div className="shrink-0">
          <EntityMore path={v.path} />
        </div>
      </div>

      {/* Band 3 — the per-type action buttons (media_viewer.mdx §4). */}
      <ActionBar
        view={v}
        kind={kind}
        grantUrl={grant?.url ?? null}
        ipfsReachable={ipfsReachable}
        decide={decide}
        navigate={navigate}
      />

      {/* Band 4 — the property grid (~4–5 cols × 2–3 rows). */}
      <PropertyGrid view={v} kind={kind} probe={probe ?? null} duration={duration} navigate={navigate} />

      {/* Band 5 — the media surface: the star, fills all remaining height (~70%). */}
      <div className="mt-3 min-h-0 flex-1">
        <ViewerSurface
          kind={kind}
          src={grant?.url ?? null}
          view={v}
          probeCodec={probe?.codec ?? null}
          onDuration={setDuration}
        />
      </div>
    </div>
  );
}

// ── Band 3: the action bar ─────────────────────────────────────────────────────────
function ActionBar({
  view: v,
  kind,
  grantUrl,
  ipfsReachable,
  decide,
  navigate,
}: {
  view: EntityView;
  kind: MediaKind;
  grantUrl: string | null;
  ipfsReachable: boolean;
  decide: { mutate: (d: Decision) => void };
  navigate: ReturnType<typeof useNavigate>;
}) {
  const qc = useQueryClient();
  const parent = v.path.replace(/[/\\][^/\\]*$/, "") || v.path;

  // Existing transcript (Transcribe.mdx §2.1) — drives the Transcribe/Re-transcribe label + View-transcript link.
  const { data: transcript } = useQuery({
    queryKey: ["transcript", v.path],
    queryFn: () => api.transcript(v.path),
    enabled: kind === "audio" || kind === "video",
  });

  // Move (guarded rename) — on success, re-point the viewer to the new path (media_viewer.mdx §4.4).
  const move = useMutation({
    mutationFn: (dest: string) => api.moveEntity(v.path, dest),
    onSuccess: (r) => {
      toast.success("File moved");
      navigate({ to: routeForKind(kind), search: { path: r.path }, replace: true });
      qc.invalidateQueries({ queryKey: ["repo"] });
      qc.invalidateQueries({ queryKey: ["fs"] });
    },
    onError: (e: Error) => { clientLog.error("MediaViewer.move", e); toast.error(e.message); },
  });
  // Delete (recoverable → LFBridge trash). On success, leave the now-gone page (media_viewer.mdx §4.4).
  const del = useMutation({
    mutationFn: () => api.deleteEntity(v.path),
    onSuccess: () => {
      toast.success("Moved to LFBridge trash");
      qc.invalidateQueries({ queryKey: ["repo"] });
      qc.invalidateQueries({ queryKey: ["fs"] });
      navigate({ to: "/fs", search: { path: parent } });
    },
    onError: (e: Error) => { clientLog.error("MediaViewer.delete", e); toast.error(e.message); },
  });

  // Compress (compression.mdx §8) — runs the real engine; follows a format change (PNG→JPG) to the new path.
  const compress = useMutation({
    mutationFn: () => api.compressFile(v.path),
    onSuccess: (r) => {
      reportCompress(r);
      qc.invalidateQueries({ queryKey: ["entity", v.path] });
      qc.invalidateQueries({ queryKey: ["media-probe", v.path] });
      qc.invalidateQueries({ queryKey: ["repo"] });
      qc.invalidateQueries({ queryKey: ["fs"] });
      if (r.status === "compressed" && r.path !== v.path) {
        const name = r.path.slice(r.path.lastIndexOf("/") + 1);
        navigate({ to: routeForKind(mediaKindForName(name) ?? "image"), search: { path: r.path }, replace: true });
      }
    },
    onError: (e: Error) => { clientLog.error("MediaViewer.compress", e); toast.error(e.message); },
  });
  const onCompress = () => {
    if (!window.confirm(`Compress ${v.name}? Medium quality, same resolution — the original moves to LFBridge trash (recoverable).`)) return;
    compress.mutate();
  };

  const onMove = () => {
    const dest = window.prompt("Move file to (absolute path):", v.path);
    if (!dest || dest.trim() === v.path) return;
    move.mutate(dest.trim());
  };
  const onDelete = () => {
    if (!window.confirm(`Move ${v.name} to LFBridge trash?\nThis is recoverable — the file is moved to the trash folder, not erased.`)) return;
    del.mutate();
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {/* Compress — image + video only (charter; audio is out of scope). Offer, confirm-gated. */}
      {(kind === "image" || kind === "video") && canOfferCompress(v) && (
        <Btn tone="warn" icon={<Zap className="h-4 w-4" />} label="Compress…" onClick={onCompress} disabled={compress.isPending} />
      )}
      {/* Transcribe — audio + video (Transcribe.mdx §2.1). Writes to <storageRoot>/.transcribe/<relpath>.txt. */}
      {(kind === "audio" || kind === "video") && (
        <Btn
          icon={<Captions className="h-4 w-4" />}
          label={transcript ? "Re-transcribe" : "Transcribe…"}
          onClick={() =>
            runTranscribeFile(v.path, v.name, {
              overwrite: !!transcript,
              onDone: () => qc.invalidateQueries({ queryKey: ["transcript", v.path] }),
            })
          }
        />
      )}
      {/* IPFS primary (Add/Remove) — same rule as files.mdx §3. */}
      <IpfsPrimary view={v} decide={decide} ipfsReachable={ipfsReachable} />
      {/* Move + Delete — every type (media_viewer.mdx §4.1). */}
      <Btn icon={<Move className="h-4 w-4" />} label="Move…" onClick={onMove} disabled={move.isPending} />
      <Btn tone="danger" icon={<Trash2 className="h-4 w-4" />} label="Delete…" onClick={onDelete} disabled={del.isPending} />

      {/* Utility links — every type. */}
      <span className="mx-1 h-5 w-px bg-[var(--lfb-border)]" />
      <LinkBtn icon={<FolderOpen className="h-3.5 w-3.5" />} label="Open folder"
        onClick={() => navigate({ to: "/fs", search: { path: parent } })} />
      <LinkBtn icon={<Copy className="h-3.5 w-3.5" />} label="Copy path"
        onClick={() => {
          navigator.clipboard?.writeText(v.path).catch((e) => clientLog.warn("MediaViewer.copyPath", e));
          toast.success("Path copied");
        }} />
      <LinkBtn icon={<FileText className="h-3.5 w-3.5" />} label="View properties"
        onClick={() => navigate({ to: "/file", search: { path: v.path } })} />
      {transcript && (
        <LinkBtn icon={<Captions className="h-3.5 w-3.5" />} label="View transcript"
          onClick={() => navigate({ to: "/file", search: { path: transcript.transcriptPath } })} />
      )}
      {grantUrl && (
        <a href={grantUrl} target="_blank" rel="noreferrer"
          className="flex items-center gap-1 text-sm text-[var(--lfb-primary)] hover:underline">
          <ExternalLink className="h-3.5 w-3.5" /> Open raw
        </a>
      )}
    </div>
  );
}

// ── Band 4: the property grid ────────────────────────────────────────────────────────
function PropertyGrid({
  view: v,
  kind,
  probe,
  duration,
  navigate,
}: {
  view: EntityView;
  kind: MediaKind;
  probe: import("@lfb/shared").MediaProbe | null;
  duration: number | null;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const dims = probe?.width && probe?.height ? `${probe.width}×${probe.height}` : null;
  const codec = probe?.codec && probe?.container ? `${probe.codec} · ${probe.container}`
    : probe?.codec ?? probe?.container ?? null;

  // Build the cells in a fixed order; each flexes by type (media_viewer.mdx §4.3). Skip unknowns rather
  // than stretch the grid — it must stay ~2–3 rows so the media keeps its ~70%.
  const cells: Array<{ label: string; node: React.ReactNode }> = [];
  cells.push({ label: "Size", node: v.sizeBytes != null ? formatBytes(v.sizeBytes) : "—" });
  if (kind === "audio") {
    cells.push({ label: "Duration", node: duration != null ? formatDuration(duration) : "—" });
  } else {
    cells.push({ label: "Dimensions", node: dims ?? "—" });
  }
  if (kind !== "image") cells.push({ label: "Codec", node: codec ?? "—" });
  cells.push({
    label: "Repo",
    node: v.repo ? (
      <button className="text-[var(--lfb-primary)] hover:underline"
        onClick={() => navigate({ to: "/repos/$repoId", params: { repoId: v.repo!.repoId } })}>
        {v.repo.name}
      </button>
    ) : <span className="text-black/40">not in a repo</span>,
  });
  cells.push({ label: "Peers", node: <span className={v.decision === "sync" && v.peers.length === 0 ? "text-red-600" : ""}>{v.peers.length}</span> });
  if (v.decision) cells.push({ label: "Decision", node: <span className="capitalize">{v.decision}</span> });
  cells.push({ label: "Modified", node: <span title={absoluteTime(v.modifiedAt)}>{relativeTime(v.modifiedAt)}</span> });
  cells.push({ label: "Created", node: v.createdAt ? absoluteTime(v.createdAt) : "—" });
  if (kind !== "audio" && v.compressible) {
    cells.push({ label: "Compress", node: v.compressState === "done" ? "compressed" : v.flags.noCompress ? "off" : "looks uncompressed" });
  }
  if (v.badges.length) cells.push({ label: "Badges", node: <Badges badges={v.badges} /> });

  return (
    <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-[var(--lfb-border)] px-4 py-3 sm:grid-cols-3 lg:grid-cols-5">
      {cells.map((c) => (
        <div key={c.label} className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-black/40">{c.label}</div>
          <div className="truncate text-sm text-black/80">{c.node}</div>
        </div>
      ))}
    </div>
  );
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// ── Band 5: the viewer surface ──────────────────────────────────────────────────
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
  onDuration,
}: {
  kind: MediaKind;
  src: string | null;
  view: EntityView;
  probeCodec: string | null;
  onDuration: (sec: number | null) => void;
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
        kind === "image" && zoom ? "cursor-grab active:cursor-grabbing" : ""
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
          decoding="async"
          loading="lazy"
          onError={() => { clientLog.warn("MediaViewer.image.decode", `image load failed: ${view.name}`); setFailed(true); }}
          onClick={() => { if (!drag.current) setZoom((z) => !z); }}
          style={{ imageRendering: "auto", ...CHECKERBOARD }}
          className={zoom ? "max-w-none" : "max-h-full max-w-full cursor-zoom-in object-contain"}
        />
      ) : kind === "video" ? (
        <video
          src={src}
          controls
          preload="metadata"
          onLoadedMetadata={(e) => onDuration(e.currentTarget.duration || null)}
          onError={() => { clientLog.warn("MediaViewer.video.decode", `video load failed: ${view.name}`); setFailed(true); }}
          className="max-h-full max-w-full"
        />
      ) : (
        // Audio — a large centered card holding the transport (no visual frame to fit).
        <div className="flex w-full max-w-2xl flex-col items-center gap-4 px-6 text-white/80">
          <Music className="h-16 w-16 text-white/30" />
          <div className="max-w-full truncate text-center text-sm text-white/60" title={view.name}>{view.name}</div>
          <audio
            src={src}
            controls
            preload="metadata"
            onLoadedMetadata={(e) => onDuration(e.currentTarget.duration || null)}
            onError={() => { clientLog.warn("MediaViewer.audio.decode", `audio load failed: ${view.name}`); setFailed(true); }}
            className="w-full"
          />
        </div>
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
  const noun = kind === "audio" ? "play this audio" : kind === "video" ? "play this file" : "show this image";
  return (
    <div className="max-w-md rounded-lg border border-white/15 bg-black/40 px-5 py-4 text-center text-sm text-white/80">
      <p className="mb-3">
        This browser can't {noun}{codec ? <> ’s codec (<b>{codec}</b>)</> : null}.
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
/** Toast the outcome of a real compress (compression.mdx §8/§10). */
function reportCompress(r: CompressResult): void {
  if (r.status === "compressed") {
    const before = r.beforeBytes != null ? formatBytes(r.beforeBytes) : "?";
    const after = r.afterBytes != null ? formatBytes(r.afterBytes) : "?";
    toast.success(`Compressed ${before} → ${after}${r.codec ? ` · ${r.codec}` : ""}`);
  } else if (r.status === "blocked") {
    toast.error(`Compression blocked: ${r.reason ?? "unsafe"}`);
  } else if (r.status === "skipped") {
    toast(`Not compressed: ${r.reason ?? "no gain"}`);
  } else {
    toast.error(`Compression failed: ${r.reason ?? "error"}`);
  }
}

/** Fire the confirm-gated compress offer — runs the real engine (compression.mdx §1). */
function runCompressOffer(v: EntityView): void {
  if (!window.confirm(`Compress ${v.name}? Medium quality, same resolution — the original moves to LFBridge trash (recoverable).`)) return;
  api.compressFile(v.path)
    .then(reportCompress)
    .catch((e: Error) => { clientLog.error("MediaViewer.compressFile", e); toast.error(e.message); });
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

/** A solid action button (band 3). tone: default (neutral) · warn (amber) · danger (red). */
function Btn({
  icon,
  label,
  onClick,
  tone,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "warn" | "danger";
  disabled?: boolean;
}) {
  const cls = tone === "danger"
    ? "border-red-200 text-red-600 hover:bg-red-50"
    : tone === "warn"
      ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
      : "border-[var(--lfb-border)] text-black/70 hover:bg-slate-100";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {icon} {label}
    </button>
  );
}

function LinkBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 text-sm text-[var(--lfb-primary)] hover:underline">
      {icon} {label}
    </button>
  );
}

function SkeletonViewer() {
  return (
    <div className="flex h-full animate-pulse flex-col gap-3">
      <div className="h-6 w-1/3 rounded bg-slate-100" />
      <div className="h-9 w-1/2 rounded bg-slate-100" />
      <div className="h-16 rounded bg-slate-100" />
      <div className="min-h-0 flex-1 rounded-lg bg-slate-100" />
    </div>
  );
}
