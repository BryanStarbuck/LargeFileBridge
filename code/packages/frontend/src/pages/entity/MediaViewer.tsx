// The shared, viewer-first layout for View-one-image (/image), View-one-video (/video), and
// View-one-audio (/audio) — the "View one file" experience for playable media (media_viewer.mdx §3).
// It renders as a vertical stack, top → bottom (media_viewer.mdx §3):
//   1. full path (muted, monospaced)      2. file NAME (large page title)
//   3. the FULL-WIDTH overflow action bar (buttons that don't fit fold into "More" — §4.1)
//   4. the property grid (~4–5 cols × 2–3 rows)
//   5. the media surface (the star — a bounded, aspect-fit stage)
//   6. the analysis tabs: Transcription · AI description (§6)
//
// The media plays/loads off local disk via the backend stream — never file:// — through a short-lived
// signed grant (GET /api/media/grant) that the <img>/<video>/<audio> element loads from /api/media/raw.
// Video/audio seek because that endpoint honors HTTP Range (media_viewer.mdx §1–§2).
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeft, UploadCloud, DownloadCloud, FolderOpen, Copy, FileText, ExternalLink, Zap,
  Move, Trash2, Music, Captions, Sparkles, Monitor, Ban, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import type { EntityView, Decision, MediaKind, PlatformInfo } from "@lfb/shared";
import { formatBytes, mediaKindForName } from "@lfb/shared";
import type { CompressResult } from "@lfb/shared";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { EntityMore, type Action } from "@/components/menu/EntityMenu";
import { OverflowActionBar, type BarItem } from "@/components/menu/OverflowActionBar";
import { runTranscribeFile } from "@/lib/transcribe";
import { runDescribeFile } from "@/lib/describe";
import { runOsOpen } from "@/lib/os";
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
  // Host platform + whether "Open on {label}" hand-off is possible here (os_open.mdx).
  const { data: platform } = useQuery({
    queryKey: ["platform"],
    queryFn: () => api.platform(),
    staleTime: 60 * 60 * 1000,
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
    <div className="flex flex-col">
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

      {/* Band 3 — the FULL-WIDTH overflow action bar (media_viewer.mdx §4). */}
      <ActionBar
        view={v}
        kind={kind}
        grantUrl={grant?.url ?? null}
        ipfsReachable={ipfsReachable}
        platform={platform ?? null}
        decide={decide}
        navigate={navigate}
      />

      {/* Band 4 — the property grid (~4–5 cols × 2–3 rows). */}
      <PropertyGrid view={v} kind={kind} probe={probe ?? null} duration={duration} navigate={navigate} />

      {/* Band 5 — the media surface: the star. Bounded so band 6 (the analysis tabs) sits below it. */}
      <div className="mt-3 h-[58vh] min-h-[340px]">
        <ViewerSurface
          kind={kind}
          src={grant?.url ?? null}
          view={v}
          probeCodec={probe?.codec ?? null}
          onDuration={setDuration}
        />
      </div>

      {/* Band 6 — Transcription · AI description tabs (media_viewer.mdx §6). */}
      <MediaAnalysis view={v} kind={kind} navigate={navigate} />
    </div>
  );
}

// ── Band 3: the action bar ─────────────────────────────────────────────────────────
function ActionBar({
  view: v,
  kind,
  grantUrl,
  ipfsReachable,
  platform,
  decide,
  navigate,
}: {
  view: EntityView;
  kind: MediaKind;
  grantUrl: string | null;
  ipfsReachable: boolean;
  platform: PlatformInfo | null;
  decide: { mutate: (d: Decision) => void };
  navigate: ReturnType<typeof useNavigate>;
}) {
  const qc = useQueryClient();
  const parent = v.path.replace(/[/\\][^/\\]*$/, "") || v.path;
  const canOs = platform?.canOpenInOS ?? false;
  const osLabel = platform?.label ?? "Mac";

  // Existing transcript (Transcribe.mdx §2.1) — drives the Transcribe/Re-transcribe label.
  const { data: transcript } = useQuery({
    queryKey: ["transcript", v.path],
    queryFn: () => api.transcript(v.path),
    enabled: kind === "audio" || kind === "video",
  });

  const flags = useMutation({
    mutationFn: (patch: { neverIpfs?: boolean; noCompress?: boolean }) => api.setEntityFlags(v.path, patch),
    onSuccess: (nv) => {
      qc.setQueryData(["entity", v.path], nv);
      patchEntityBadges(qc, nv.path, nv.badges);
      qc.invalidateQueries({ queryKey: ["repo"] });
    },
    onError: (e: Error) => { clientLog.error("MediaViewer.flags", e); toast.error(e.message); },
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
  const copyPath = () => {
    navigator.clipboard?.writeText(v.path).catch((e) => clientLog.warn("MediaViewer.copyPath", e));
    toast.success("Path copied");
  };
  const openRawInBrowser = () => { if (grantUrl) window.open(grantUrl, "_blank", "noopener"); };
  const openFolderInBrowser = () => navigate({ to: "/fs", search: { path: parent } });

  // ── Build the priority-ordered action items (media_viewer.mdx §4.1). ──
  const items: BarItem[] = [];

  // IPFS primary (Add/Remove) — highest priority. Skipped for a not-in-sync file that's flagged Never-IPFS.
  const ipfsNode = <IpfsPrimary view={v} decide={decide} ipfsReachable={ipfsReachable} />;
  if (v.repo && !(v.decision !== "sync" && v.flags.neverIpfs)) {
    const isSync = v.decision === "sync";
    items.push({
      key: "ipfs", priority: 100, bar: ipfsNode,
      menu: [{ id: "ipfs", group: "IPFS", label: isSync ? "Remove from IPFS" : "Add to IPFS",
        icon: isSync ? <DownloadCloud className="h-4 w-4" /> : <UploadCloud className="h-4 w-4" />,
        disabled: !ipfsReachable, onSelect: () => decide.mutate(isSync ? "ignore" : "sync") }],
    });
  }

  // Compress — image + video only (charter; audio out of scope). Offer, confirm-gated.
  if ((kind === "image" || kind === "video") && canOfferCompress(v)) {
    items.push({
      key: "compress", priority: 90,
      bar: <Btn tone="warn" icon={<Zap className="h-4 w-4" />} label="Compress…" onClick={onCompress} disabled={compress.isPending} />,
      menu: [{ id: "compress", group: "Work", label: "Compress…", icon: <Zap className="h-4 w-4" />, onSelect: onCompress }],
    });
  }

  // Open: [in browser] · [on {label}] — the raw bytes in a new browser tab, or the OS default app.
  items.push({
    key: "open", priority: 85,
    bar: (
      <OpenCompound icon={<ExternalLink className="h-4 w-4" />} label="Open"
        browser={grantUrl ? { label: "in browser", onClick: openRawInBrowser } : null}
        os={canOs ? { label: `on ${osLabel}`, onClick: () => runOsOpen(v.path, v.name) } : null} />
    ),
    menu: [
      ...(grantUrl ? [{ id: "open-browser", group: "Open", label: "Open raw in browser", icon: <ExternalLink className="h-4 w-4" />, onSelect: openRawInBrowser }] : []),
      ...(canOs ? [{ id: "open-os", group: "Open", label: `Open on ${osLabel}`, icon: <Monitor className="h-4 w-4" />, onSelect: () => runOsOpen(v.path, v.name) }] : []),
    ],
  });

  // Open folder: [in browser] · [on {label}] — the File System tab, or Finder/Explorer at the directory.
  items.push({
    key: "open-folder", priority: 75,
    bar: (
      <OpenCompound icon={<FolderOpen className="h-4 w-4" />} label="Open folder"
        browser={{ label: "in browser", onClick: openFolderInBrowser }}
        os={canOs ? { label: `on ${osLabel}`, onClick: () => runOsOpen(parent, "folder") } : null} />
    ),
    menu: [
      { id: "folder-browser", group: "Open", label: "Open folder in browser", icon: <FolderOpen className="h-4 w-4" />, onSelect: openFolderInBrowser },
      ...(canOs ? [{ id: "folder-os", group: "Open", label: `Open folder on ${osLabel}`, icon: <Monitor className="h-4 w-4" />, onSelect: () => runOsOpen(parent, "folder") }] : []),
    ],
  });

  // Transcribe — audio + video (Transcribe.mdx §2.1).
  if (kind === "audio" || kind === "video") {
    const label = transcript ? "Re-transcribe" : "Transcribe…";
    const run = () => runTranscribeFile(v.path, v.name, { overwrite: !!transcript, onDone: () => qc.invalidateQueries({ queryKey: ["transcript", v.path] }) });
    items.push({
      key: "transcribe", priority: 60,
      bar: <Btn icon={<Captions className="h-4 w-4" />} label={label} onClick={run} />,
      menu: [{ id: "transcribe", group: "Work", label, icon: <Captions className="h-4 w-4" />, onSelect: run }],
    });
  }

  // Copy path.
  items.push({
    key: "copy-path", priority: 40,
    bar: <LinkBtn icon={<Copy className="h-3.5 w-3.5" />} label="Copy path" onClick={copyPath} />,
    menu: [{ id: "copy-path", group: "Copy", label: "Copy path", icon: <Copy className="h-4 w-4" />, onSelect: copyPath }],
  });

  // View properties.
  items.push({
    key: "view-props", priority: 30,
    bar: <LinkBtn icon={<FileText className="h-3.5 w-3.5" />} label="View properties" onClick={() => navigate({ to: "/file", search: { path: v.path } })} />,
    menu: [{ id: "view-props", group: "Open", label: "View properties", icon: <FileText className="h-4 w-4" />, onSelect: () => navigate({ to: "/file", search: { path: v.path } }) }],
  });

  // Move — lowest priority; overflows first.
  items.push({
    key: "move", priority: 20,
    bar: <Btn icon={<Move className="h-4 w-4" />} label="Move…" onClick={onMove} disabled={move.isPending} />,
    menu: [{ id: "move", group: "Work", label: "Move…", icon: <Move className="h-4 w-4" />, onSelect: onMove }],
  });

  // Extras — never buttons; always live in the "More" menu (media_viewer.mdx §4.1 / §5).
  const extras: Action[] = [
    { id: "never-ipfs", group: "Flag", label: "Never publish via IPFS", icon: <Ban className="h-4 w-4" />, checked: v.flags.neverIpfs, onSelect: () => flags.mutate({ neverIpfs: !v.flags.neverIpfs }) },
    { id: "no-compress", group: "Flag", label: "Do not compress", icon: <Ban className="h-4 w-4" />, checked: v.flags.noCompress, onSelect: () => flags.mutate({ noCompress: !v.flags.noCompress }) },
    ...(v.cid ? [{ id: "copy-cid", group: "Copy", label: "Copy CID", icon: <Copy className="h-4 w-4" />, onSelect: () => { navigator.clipboard?.writeText(v.cid!).catch((e) => clientLog.warn("MediaViewer.copyCid", e)); toast.success("CID copied"); } }] : []),
    { id: "delete", group: "Danger", label: "Delete…", danger: true, icon: <Trash2 className="h-4 w-4" />, onSelect: onDelete },
  ];

  return <OverflowActionBar items={items} extras={extras} />;
}

// A compound "label: [in browser] · [on Mac]" control (media_viewer.mdx §4.2). The label is not
// clickable; each of the one/two sub-actions is. Rendered as one unit in the overflow bar.
function OpenCompound({
  icon, label, browser, os,
}: {
  icon: React.ReactNode;
  label: string;
  browser: { label: string; onClick: () => void } | null;
  os: { label: string; onClick: () => void } | null;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm">
      <span className="flex items-center gap-1 text-black/50">{icon}{label}:</span>
      {browser && (
        <button className="text-[var(--lfb-primary)] hover:underline" onClick={browser.onClick}>{browser.label}</button>
      )}
      {browser && os && <span className="text-black/25">·</span>}
      {os && (
        <button className="text-[var(--lfb-primary)] hover:underline" onClick={os.onClick}>{os.label}</button>
      )}
    </span>
  );
}

// ── Band 6: the analysis tabs (Transcription · AI description — media_viewer.mdx §6) ──
function MediaAnalysis({
  view: v,
  kind,
  navigate,
}: {
  view: EntityView;
  kind: MediaKind;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const qc = useQueryClient();
  const canTranscribe = kind === "video" || kind === "audio"; // has (or may have) audio to transcribe
  const canDescribe = kind === "video" || kind === "image"; // AI-describable media

  const { data: transcript } = useQuery({
    queryKey: ["transcript", v.path], queryFn: () => api.transcript(v.path), enabled: canTranscribe,
  });
  const { data: description } = useQuery({
    queryKey: ["description", v.path], queryFn: () => api.description(v.path), enabled: canDescribe,
  });
  const { data: tools } = useQuery({
    queryKey: ["transcribe-tools"], queryFn: () => api.transcribeTools(), enabled: canTranscribe, staleTime: 60 * 1000,
  });
  const { data: providers } = useQuery({
    queryKey: ["describe-providers"], queryFn: () => api.describeProviders(), enabled: canDescribe, staleTime: 60 * 1000,
  });

  const tabs: Array<{ id: "transcription" | "description"; label: string; present: boolean }> = [
    ...(canTranscribe ? [{ id: "transcription" as const, label: "Transcription", present: !!transcript }] : []),
    ...(canDescribe ? [{ id: "description" as const, label: "AI description", present: !!description }] : []),
  ];

  // Default tab: prefer Transcription when it has content, else the first tab that has content, else the
  // first tab (media_viewer.mdx §6). The user's explicit choice (below) wins once set.
  const [active, setActive] = useState<"transcription" | "description" | null>(null);
  const activeId =
    active && tabs.some((t) => t.id === active)
      ? active
      : tabs.find((t) => t.id === "transcription" && t.present)?.id ??
        tabs.find((t) => t.present)?.id ??
        tabs[0]?.id ??
        null;

  if (tabs.length === 0) return null;

  return (
    <div className="mt-4">
      {/* Tab strip — a ✓ marks a tab that already has content (media_viewer.mdx §6). */}
      <div className="flex items-center gap-1 border-b border-[var(--lfb-border)]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              activeId === t.id
                ? "border-[var(--lfb-primary)] font-medium text-black"
                : "border-transparent text-black/55 hover:text-black"
            }`}
          >
            <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${t.present ? "bg-emerald-500 text-white" : "border border-black/20 text-transparent"}`}>✓</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="py-4">
        {activeId === "transcription" && (
          transcript ? (
            <AnalysisBody
              mono
              body={transcript.text}
              meta={<>Transcript · <button className="text-[var(--lfb-primary)] hover:underline" onClick={() => navigate({ to: "/file", search: { path: transcript.transcriptPath } })}>open file</button></>}
              onRegenerate={() => runTranscribeFile(v.path, v.name, { overwrite: true, onDone: () => qc.invalidateQueries({ queryKey: ["transcript", v.path] }) })}
            />
          ) : (
            <GeneratePane
              icon={<Captions className="h-8 w-8 text-black/30" />}
              title="No transcript yet"
              blurb="Transcribe the audio locally with Whisper — nothing leaves this computer."
              disabled={!!tools && !tools.whisper}
              disabledHint="Whisper isn't installed. Run `pipx install openai-whisper` (and `brew install ffmpeg`), then reload."
              cta="Generate transcript"
              onGenerate={() => runTranscribeFile(v.path, v.name, { onDone: () => qc.invalidateQueries({ queryKey: ["transcript", v.path] }) })}
            />
          )
        )}

        {activeId === "description" && (
          description ? (
            <AnalysisBody
              body={description.text}
              meta={<>AI description{description.model ? ` · ${description.model}` : ""}{description.generatedAt ? ` · ${relativeTime(description.generatedAt)}` : ""}</>}
              onRegenerate={() => runDescribeFile(v.path, v.name, { overwrite: true, onDone: () => qc.invalidateQueries({ queryKey: ["description", v.path] }) })}
            />
          ) : (
            <GeneratePane
              icon={<Sparkles className="h-8 w-8 text-black/30" />}
              title="No AI description yet"
              blurb={kind === "video"
                ? "Generate a hyper-detailed description with a vision model. Video is uploaded to the provider (Gemini)."
                : "Generate a hyper-detailed description with a vision model. The image is uploaded to the provider."}
              disabled={!!providers && !providers.anyAvailable}
              disabledHint="No AI provider is configured. Add a Gemini, Grok, or OpenAI API key in Settings → Tools (or export GEMINI_API_KEY / XAI_API_KEY / OPENAI_API_KEY), then reload."
              cta="Generate description"
              onGenerate={() => runDescribeFile(v.path, v.name, { onDone: () => qc.invalidateQueries({ queryKey: ["description", v.path] }) })}
            />
          )
        )}
      </div>
    </div>
  );
}

function AnalysisBody({ body, meta, mono, onRegenerate }: { body: string; meta: React.ReactNode; mono?: boolean; onRegenerate: () => void }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-black/45">
        <span>{meta}</span>
        <button className="flex items-center gap-1 text-[var(--lfb-primary)] hover:underline" onClick={onRegenerate}>
          <RefreshCw className="h-3.5 w-3.5" /> Regenerate
        </button>
      </div>
      <pre className={`max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--lfb-border)] bg-slate-50 px-4 py-3 text-sm text-black/80 ${mono ? "font-mono" : ""}`}>
        {body}
      </pre>
    </div>
  );
}

function GeneratePane({
  icon, title, blurb, cta, onGenerate, disabled, disabledHint,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  cta: string;
  onGenerate: () => void;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--lfb-border)] px-6 py-10 text-center">
      {icon}
      <div className="font-medium text-black">{title}</div>
      <div className="max-w-md text-sm text-black/55">{blurb}</div>
      <button
        onClick={onGenerate}
        disabled={disabled}
        className="mt-1 flex items-center gap-2 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Sparkles className="h-4 w-4" /> {cta}
      </button>
      {disabled && disabledHint && <div className="max-w-md text-xs text-amber-700">{disabledHint}</div>}
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
  // than stretch the grid — it must stay ~2–3 rows so the media keeps its stage.
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
  // Not-in-sync + Never-IPFS → no primary button (the More menu still governs).
  if (!isSync && v.flags.neverIpfs) return null;
  const disabledProps = ipfsReachable
    ? {}
    : { disabled: true, title: "IPFS node unreachable — start your IPFS node to add/remove pins" };
  return isSync ? (
    <button
      {...disabledProps}
      onClick={() => decide.mutate("ignore")}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--lfb-border)] px-3 py-1.5 text-sm text-black/70 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <DownloadCloud className="h-4 w-4" /> Remove from IPFS
    </button>
  ) : (
    <button
      {...disabledProps}
      onClick={() => decide.mutate("sync")}
      className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
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
      className={`flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {icon} {label}
    </button>
  );
}

function LinkBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex shrink-0 items-center gap-1 text-sm text-[var(--lfb-primary)] hover:underline">
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
