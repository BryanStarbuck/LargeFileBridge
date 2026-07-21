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
  Move, Trash2, Music, Captions, Sparkles, TextSelect, Monitor, Ban, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import type { EntityView, Decision, MediaKind, OcrBlock, PlatformInfo } from "@lfb/shared";
import { formatBytes, mediaKindForName } from "@lfb/shared";
import type { CompressResult } from "@lfb/shared";
import { api } from "@/api/client";
import { Badges } from "@/components/fs/Badges";
import { EntityMore, type Action } from "@/components/menu/EntityMenu";
import { OverflowActionBar, type BarItem } from "@/components/menu/OverflowActionBar";
import { useTranscribeFile } from "@/lib/useTranscribeFile";
import { useHotkeys } from "@/lib/hotkeys";
import { TranscribeSetupCard } from "@/components/TranscribeSetupCard";
import { runDescribeFile } from "@/lib/describe";
import { runOcrFile, withOcrReady } from "@/lib/ocr";
import { CredentialsMissingDialog } from "@/components/describe/CredentialsMissingDialog";
import { runOsOpen } from "@/lib/os";
import { confirmModal, promptModal } from "@/lib/modals";
import { patchEntityBadges } from "@/lib/patchEntityBadges";
import { copyText } from "@/lib/clipboard";
import { EntityHeaderMissing } from "./entityShared";
import { relativeTime, absoluteTime } from "@/lib/format";
import { useLiveRefresh, repoTopic } from "@/lib/useLiveRefresh";
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
  // The <video> element itself (band 5), so band 6's timecoded OCR rows can SEEK it (ocr.mdx §7 —
  // "Video rows seek", the §1.2 payoff and the one capability neither sibling column has). The ref lives
  // HERE because the player and the analysis columns are sibling components; neither can reach the other.
  const playerRef = useRef<HTMLVideoElement | null>(null);
  // Seek + play + bring the player back into view: a click near the bottom of band 6 is worthless if the
  // frame it jumped to is scrolled off the top of the page.
  const seekPlayer = (sec: number) => {
    const el = playerRef.current;
    if (!el) return;
    el.currentTime = sec;
    void el.play().catch(() => {}); // autoplay may be refused — the seek still landed, which is the point
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const { data: v, isLoading } = useQuery({
    queryKey: ["entity", path],
    queryFn: () => api.entity(path!),
    enabled: !!path,
  });
  // Live refresh (performance.mdx Aspect 6b): a batch settle (`jobs`) may have just written THIS file's
  // transcript / description / OCR — the open viewer shows it without a reload; the repo topic covers
  // pin/decision changes arriving from a backbone pull.
  useLiveRefresh(
    [v?.repo ? repoTopic(v.repo.repoId) : null, "jobs"],
    [["entity", path], ["transcript", path], ["description", path], ["ocr", path]],
  );
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
            onClick={() => { void copyText(v.path, "Path", "MediaViewer.copyPath"); }}
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
          playerRef={playerRef}
        />
      </div>

      {/* Band 6 — Transcription · AI description tabs (media_viewer.mdx §6). */}
      <MediaAnalysis view={v} kind={kind} navigate={navigate} onSeek={seekPlayer} />
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
  // Async, non-blocking transcription with an instant pending state (Transcribe.mdx §5.1).
  const transcribe = useTranscribeFile(v.path, v.name);

  // Existing OCR text (ocr.mdx §8.1) — drives the OCR / Re-run OCR label, exactly as `transcript` drives
  // Transcribe / Re-transcribe. Same query key as band 6's column, so the two agree and share one fetch.
  const { data: ocrText } = useQuery({
    queryKey: ["ocr", v.path],
    queryFn: () => api.ocr(v.path),
    enabled: kind === "image" || kind === "video",
  });
  // Existing AI description (ai_description.mdx §11) — drives the Describe / Re-describe label, exactly as
  // `transcript` drives Transcribe and `ocrText` drives OCR. Same query key as band 6's AI-description
  // column, so the bar and the column agree and share one fetch.
  const { data: description } = useQuery({
    queryKey: ["description", v.path],
    queryFn: () => api.description(v.path),
    enabled: kind === "image" || kind === "video",
  });
  const [describeBusy, setDescribeBusy] = useState(false);
  // Generate (or regenerate) this file's AI description. Provider-gated inside runDescribeFile, which pops
  // the credentials-missing dialog when no vision key resolves on this machine (ai_credentials.mdx §2).
  const onDescribe = () => {
    setDescribeBusy(true);
    runDescribeFile(v.path, v.name, {
      overwrite: !!description, // an existing description is only replaced on an explicit Re-describe
      onDone: () => qc.invalidateQueries({ queryKey: ["description", v.path] }),
      onSettled: () => setDescribeBusy(false),
    });
  };

  const [ocrBusy, setOcrBusy] = useState(false);
  // Read (or re-read) the text in this file. Gated through the shared readiness gate like every other OCR
  // entry point (ocr.mdx §6) — a pass-through in the common case, so the click still feels instant.
  const onOcr = () => {
    void withOcrReady({
      label: `OCR ${v.name}`,
      run: () => {
        setOcrBusy(true);
        runOcrFile(v.path, v.name, {
          overwrite: !!ocrText, // the one overwrite path (§12.4): an existing artifact is only replaced on Re-run
          onDone: () => qc.invalidateQueries({ queryKey: ["ocr", v.path] }),
          // Clear on EVERY terminal outcome — a failed run never reaches onDone and would leave the button
          // stuck at "OCR'ing…" forever.
          onSettled: () => setOcrBusy(false),
        });
      },
    });
  };

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
  const onCompress = async () => {
    if (!(await confirmModal({ title: `Compress ${v.name}?`, body: "Medium quality, same resolution — the original moves to LFBridge trash (recoverable).", confirmLabel: "Compress" }))) return;
    compress.mutate();
  };
  const onMove = async () => {
    const dest = await promptModal({ title: "Move file", label: "New absolute path:", defaultValue: v.path, confirmLabel: "Move" });
    if (!dest || dest.trim() === v.path) return;
    move.mutate(dest.trim());
  };
  const onDelete = async () => {
    if (!(await confirmModal({ title: `Move ${v.name} to LFBridge trash?`, body: "This is recoverable — the file is moved to the trash folder, not erased.", confirmLabel: "Move to trash" }))) return;
    del.mutate();
  };
  const copyPath = () => { void copyText(v.path, "Path", "MediaViewer.copyPath"); };
  const openRawInBrowser = () => { if (grantUrl) window.open(grantUrl, "_blank", "noopener"); };
  const openFolderInBrowser = () => navigate({ to: "/fs", search: { path: parent } });

  // Page-scoped hotkeys for the viewer (hotkeys.mdx §5). Keys avoid the global nav letters so there's no
  // collision; each is conditional on the action being available for this file/kind.
  const ipfsPin = v.decision === "sync";
  const canToggleIpfs = !!v.repo && !(!ipfsPin && v.flags.neverIpfs);
  useHotkeys("media-viewer", "Media viewer", [
    ...(grantUrl ? [{ keys: "o", label: "Open raw in browser", run: openRawInBrowser }] : []),
    { keys: "y", label: "Copy path", run: copyPath },
    ...(canToggleIpfs ? [{ keys: "p", label: ipfsPin ? "Remove from IPFS" : "Add to IPFS", run: () => decide.mutate(ipfsPin ? "ignore" : "sync") }] : []),
    ...((kind === "image" || kind === "video") && canOfferCompress(v) ? [{ keys: "k", label: "Compress…", run: onCompress }] : []),
    ...((kind === "audio" || kind === "video") ? [{ keys: "t", label: transcript ? "Re-transcribe" : "Transcribe", run: () => transcribe.run(!!transcript) }] : []),
    { keys: "m", label: "Move…", run: onMove },
    { keys: "b", label: "Back", run: () => history.back() },
  ]);

  // ── Build the priority-ordered action items (media_viewer.mdx §4.1). ──
  const items: BarItem[] = [];

  // IPFS primary (Add/Remove) — highest priority. Skipped for a not-pinned file that's flagged Never-IPFS.
  const ipfsNode = <IpfsPrimary view={v} decide={decide} ipfsReachable={ipfsReachable} />;
  if (v.repo && !(v.decision !== "sync" && v.flags.neverIpfs)) {
    const isPin = v.decision === "sync";
    items.push({
      key: "ipfs", priority: 100, bar: ipfsNode,
      menu: [{ id: "ipfs", group: "IPFS", label: isPin ? "Remove from IPFS" : "Add to IPFS",
        icon: isPin ? <DownloadCloud className="h-4 w-4" /> : <UploadCloud className="h-4 w-4" />,
        disabled: !ipfsReachable, onSelect: () => decide.mutate(isPin ? "ignore" : "sync") }],
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

  // Transcribe — audio + video (Transcribe.mdx §2.1). Pending flips the button to a spinner instantly.
  if (kind === "audio" || kind === "video") {
    const label = transcribe.isPending ? "Transcribing…" : transcript ? "Re-transcribe" : "Transcribe…";
    const run = () => transcribe.run(!!transcript);
    items.push({
      key: "transcribe", priority: 60,
      bar: <Btn icon={<Captions className="h-4 w-4" />} label={label} onClick={run} disabled={transcribe.isPending} />,
      menu: [{ id: "transcribe", group: "Work", label, icon: <Captions className="h-4 w-4" />, disabled: transcribe.isPending, onSelect: run }],
    });
  }

  // AI description — image + video (ai_description.mdx §11). This was MISSING from the action bar: the bar
  // offered Transcribe and OCR but never the middle sibling, so on an image or a video the "More" menu had
  // no way to generate an AI description at all — even though band 6 renders the description column right
  // below it. The locked trio order is transcription → AI description → OCR at EVERY scale (ocr.mdx §8.2),
  // so this sits between them: priority 58, under Transcribe (60) and over OCR (55).
  if (kind === "image" || kind === "video") {
    const label = describeBusy ? "Describing…" : description ? "Re-describe" : "Describe…";
    items.push({
      key: "describe", priority: 58,
      bar: <Btn icon={<Sparkles className="h-4 w-4" />} label={label} onClick={onDescribe} disabled={describeBusy} />,
      menu: [{ id: "describe", group: "Work", label, icon: <Sparkles className="h-4 w-4" />, disabled: describeBusy, onSelect: onDescribe }],
    });
  }

  // OCR — image + video (ocr.mdx §8.1; §4.2's shared-actions matrix gains an OCR row: ✓ image, ✓ video,
  // — audio). Ranked just under Transcribe: reading the words on screen is a search convenience, and never
  // outranks the recording's own words. Pending flips the control to a disabled spinner instantly.
  if (kind === "image" || kind === "video") {
    const label = ocrBusy ? "OCR'ing…" : ocrText ? "Re-run OCR" : "OCR…";
    items.push({
      key: "ocr", priority: 55,
      bar: <Btn icon={<TextSelect className="h-4 w-4" />} label={label} onClick={onOcr} disabled={ocrBusy} />,
      menu: [{ id: "ocr", group: "Work", label, icon: <TextSelect className="h-4 w-4" />, disabled: ocrBusy, onSelect: onOcr }],
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
    ...(v.cid ? [{ id: "copy-cid", group: "Copy", label: "Copy CID", icon: <Copy className="h-4 w-4" />, onSelect: () => { void copyText(v.cid!, "CID", "MediaViewer.copyCid"); } }] : []),
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

// ── Band 6: the analysis panels (AI description · Transcription — media_viewer.mdx §6) ──
// Both are shown AT ONCE, side by side — AI description on the left half, Transcription on the right
// half (no tabs/radio to switch between them). A video shows both columns; an image shows only the AI
// description; an audio file shows only the Transcription (each full-width when it's the only one).
function MediaAnalysis({
  view: v,
  kind,
  navigate,
  onSeek,
}: {
  view: EntityView;
  kind: MediaKind;
  navigate: ReturnType<typeof useNavigate>;
  /** Seek the band-5 player — what a timecoded OCR row does when clicked (ocr.mdx §7). Video only. */
  onSeek?: (sec: number) => void;
}) {
  const qc = useQueryClient();
  const canTranscribe = kind === "video" || kind === "audio"; // has (or may have) audio to transcribe
  const canDescribe = kind === "video" || kind === "image"; // AI-describable media
  const canOcr = kind === "video" || kind === "image"; // has PIXELS that may contain text (ocr.mdx §7)
  // The credentials-missing popup (ai_credentials.mdx §2): null = closed, else the honest reason string.
  const [credsReason, setCredsReason] = useState<string | null>(null);

  const { data: transcript } = useQuery({
    queryKey: ["transcript", v.path], queryFn: () => api.transcript(v.path), enabled: canTranscribe,
  });
  const { data: description } = useQuery({
    queryKey: ["description", v.path], queryFn: () => api.description(v.path), enabled: canDescribe,
  });
  const { data: tools, refetch: refetchTools, isFetching: toolsFetching } = useQuery({
    queryKey: ["transcribe-tools"], queryFn: () => api.transcribeTools(), enabled: canTranscribe, staleTime: 60 * 1000,
  });
  const { data: providers } = useQuery({
    queryKey: ["describe-providers"], queryFn: () => api.describeProviders(), enabled: canDescribe, staleTime: 60 * 1000,
  });
  const { data: ocrText } = useQuery({
    queryKey: ["ocr", v.path], queryFn: () => api.ocr(v.path), enabled: canOcr,
  });
  // The OCR engine matrix (ocr.mdx §6). Unlike describe's provider probe this is almost always "ready" —
  // there is no key. The one thing worth knowing up front is whether a VIDEO can run at all: images need no
  // external tool, videos need ffmpeg to sample frames, and that asymmetry must be SAID, not papered over.
  const { data: ocrEngines } = useQuery({
    queryKey: ["ocr-engines"], queryFn: () => api.ocrEngines(), enabled: canOcr, staleTime: 60 * 1000,
  });
  const [ocrBusy, setOcrBusy] = useState(false);
  // Async, non-blocking transcription with an instant pending state (Transcribe.mdx §5.1).
  const transcribe = useTranscribeFile(v.path, v.name);

  if (!canTranscribe && !canDescribe && !canOcr) return null;
  // How many analysis columns this kind actually shows (ocr.mdx §7): audio → 1 (Transcription), image → 2
  // (AI description + Text), video → 3 (all). The band divides evenly among the columns SHOWN, so it never
  // reserves dead space for an inapplicable analysis.
  const columnCount = (canDescribe ? 1 : 0) + (canTranscribe ? 1 : 0) + (canOcr ? 1 : 0);
  const gridCols = columnCount >= 3 ? "grid-cols-1 md:grid-cols-3" : columnCount === 2 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1";

  // Whether we already know (from the providers probe) that no vision key resolves on this machine.
  const noProviderKnown = !!providers && !providers.anyAvailable;
  // Generate/Regenerate a description. When we already know there's no key, open the credentials-missing
  // popup straight away (no wasted call/toast); otherwise run, and still catch a RUNTIME no_provider
  // (e.g. a video when only image-capable keys exist) and pop the same dialog (ai_credentials.mdx §2).
  const onGenerateDescription = (overwrite: boolean) => {
    if (noProviderKnown) {
      setCredsReason(
        kind === "video"
          ? "No AI provider configured for video — a Gemini API key is required (only Gemini describes video)."
          : "No AI provider configured — add a Gemini, Grok, or OpenAI API key.",
      );
      return;
    }
    runDescribeFile(v.path, v.name, {
      overwrite,
      onDone: () => qc.invalidateQueries({ queryKey: ["description", v.path] }),
      onNoProvider: (reason) => setCredsReason(reason),
    });
  };

  // Left column — AI description (video + image).
  const descriptionColumn = canDescribe ? (
    <AnalysisColumn title="AI description" present={!!description}>
      {description ? (
        <AnalysisBody
          body={description.text}
          meta={<>AI description{description.model ? ` · ${description.model}` : ""}{description.generatedAt ? ` · ${relativeTime(description.generatedAt)}` : ""}</>}
          onRegenerate={() => onGenerateDescription(true)}
        />
      ) : (
        <GeneratePane
          icon={<Sparkles className="h-8 w-8 text-black/30" />}
          title="No AI description yet"
          blurb={kind === "video"
            ? "Generate a hyper-detailed description with a vision model. Video is uploaded to the provider (Gemini). Large videos are compressed to a temporary copy for upload — your original file is never changed."
            : "Generate a hyper-detailed description with a vision model. The image is uploaded to the provider. Large images are compressed to a temporary copy for upload — your original file is never changed."}
          // The button stays clickable even with no key: clicking opens the credentials-missing popup
          // (Close / Instructions) rather than dead-ending on a disabled button (ai_credentials.mdx §2).
          hint={noProviderKnown ? "No AI provider is configured — clicking will show how to add a key." : undefined}
          cta="Generate description"
          onGenerate={() => onGenerateDescription(false)}
        />
      )}
    </AnalysisColumn>
  ) : null;

  // Run (or re-run) OCR on this file. No credentials branch — OCR is 100% local (ocr.mdx §4). The only
  // not-ready case worth pre-empting is a video on a machine without ffmpeg, which the pane states as a hint.
  const onRunOcr = (overwrite: boolean) => {
    setOcrBusy(true);
    runOcrFile(v.path, v.name, {
      overwrite,
      onDone: () => qc.invalidateQueries({ queryKey: ["ocr", v.path] }),
      // Clear the pending flag on EVERY terminal outcome, not just success: a failed run never reaches
      // onDone, and the button would stay "Reading…" forever.
      onSettled: () => setOcrBusy(false),
    });
  };

  const videoNeedsFfmpeg = kind === "video" && !!ocrEngines && !ocrEngines.videoToolsPresent;
  const noOcrEngine = !!ocrEngines && !ocrEngines.anyAvailable;

  // The TIMECODED rows of a video's OCR (ocr.mdx §7 / §5.1). `blocks[]` is the structure the artifact
  // carries: normalized bboxes for an IMAGE (no timeline — it renders as flat text), start/end ranges for a
  // VIDEO. Only rows with a real `start` can seek, and an older `.ocr` written before blocks existed has
  // none — in that case we fall back to the flat text rather than rendering an empty column.
  const ocrRows: (OcrBlock & { start: number })[] =
    kind === "video"
      ? (ocrText?.blocks ?? []).filter((b): b is OcrBlock & { start: number } => typeof b.start === "number")
      : [];
  const ocrSeekable = ocrRows.length > 0 && !!onSeek;

  // Third column — Text (OCR) (image + video). ocr.mdx §7.
  const ocrColumn = canOcr ? (
    <AnalysisColumn title="Text (OCR)" present={!!ocrText}>
      {ocrText ? (
        ocrText.text.trim() === "" ? (
          // EMPTY IS A RESULT, NOT A MISSING ARTIFACT (ocr.mdx §2.3). Most images have no text. Showing the
          // generate pane here would invite the user to re-run it forever; the ✓ and this line say "done, and
          // the answer is none".
          <div className="rounded-lg border border-[var(--lfb-border)] p-4 text-sm text-black/50">
            No text found in this {kind}.
            <button className="ml-2 text-[var(--lfb-primary)] hover:underline" onClick={() => onRunOcr(true)} disabled={ocrBusy}>
              Read again
            </button>
          </div>
        ) : (
          <AnalysisBody
            mono
            body={ocrText.text}
            meta={
              <>
                OCR{ocrText.engine ? ` · ${ocrText.engine}` : ""}{ocrText.level ? ` · ${ocrText.level}` : ""}
                {ocrText.framesSampled ? ` · ${ocrText.framesSampled} frames` : ""}
                {ocrText.truncated ? " · truncated" : ""}
                {ocrText.generatedAt ? ` · ${relativeTime(ocrText.generatedAt)}` : ""}
              </>
            }
            busy={ocrBusy}
            onRegenerate={() => onRunOcr(true)}
          >
            {/* A VIDEO renders its blocks as timecoded rows that SEEK; an image (no timeline) and a
                block-less legacy artifact fall through to AnalysisBody's flat `body` text. */}
            {ocrSeekable ? <OcrTimecodedRows rows={ocrRows} onSeek={onSeek!} /> : null}
          </AnalysisBody>
        )
      ) : (
        <GeneratePane
          icon={<TextSelect className="h-8 w-8 text-black/30" />}
          title="No OCR text yet"
          blurb={
            kind === "video"
              ? "Read the words visible on screen — slides, chyrons, signs. A frame is sampled every 15 seconds and read locally; nothing is uploaded and your original file is never changed."
              : "Read the words visible in this image — an error message, a receipt, a sign. It runs entirely on this computer; nothing is uploaded and your original file is never changed."
          }
          hint={
            noOcrEngine
              ? "No OCR engine is available on this computer."
              : videoNeedsFfmpeg
                ? "Reading text from a video needs ffmpeg — install it with `brew install ffmpeg`. Images are unaffected."
                : undefined
          }
          disabled={noOcrEngine || videoNeedsFfmpeg}
          cta="Read text from this file"
          busy={ocrBusy}
          busyLabel="Reading…"
          onGenerate={() => onRunOcr(false)}
        />
      )}
    </AnalysisColumn>
  ) : null;

  // Right column — Transcription (video + audio).
  const transcriptionColumn = canTranscribe ? (
    <AnalysisColumn title="Transcription" present={!!transcript}>
      {transcript ? (
        <AnalysisBody
          mono
          body={transcript.text}
          meta={<>Transcript · <button className="text-[var(--lfb-primary)] hover:underline" onClick={() => navigate({ to: "/file", search: { path: transcript.transcriptPath } })}>open file</button></>}
          busy={transcribe.isPending}
          onRegenerate={() => transcribe.run(true)}
        />
      ) : tools && !tools.whisper ? (
        // Local tools missing — show install commands + a Re-check button so the user can fix it and
        // run again without reloading (Transcribe.mdx §5.2). No credentials/cloud involved.
        <TranscribeSetupCard tools={tools} rechecking={toolsFetching} onRecheck={() => void refetchTools()} />
      ) : (
        <GeneratePane
          icon={<Captions className="h-8 w-8 text-black/30" />}
          title="No transcript yet"
          blurb="Transcribe the audio locally with Whisper — nothing leaves this computer. No account or credentials needed."
          cta="Generate transcript"
          busy={transcribe.isPending}
          busyLabel="Transcribing…"
          onGenerate={() => transcribe.run(false)}
        />
      )}
    </AnalysisColumn>
  ) : null;

  return (
    <>
      <div className={`mt-6 grid gap-6 ${gridCols}`}>
        {/* AI description · Transcription · Text (OCR), SIDE BY SIDE — all shown at once, no tabs and no
            radio buttons (media_viewer.mdx §6, ocr.mdx §7). A video shows all three; an image shows AI
            description + Text; an audio file shows Transcription alone. */}
        {descriptionColumn}
        {transcriptionColumn}
        {ocrColumn}
      </div>
      {/* Credentials-missing popup — Close / Instructions (ai_credentials.mdx §2). */}
      {credsReason !== null && (
        <CredentialsMissingDialog reason={credsReason} onClose={() => setCredsReason(null)} />
      )}
    </>
  );
}

// One analysis half — a titled panel with a ✓ availability marker (green when its content already
// exists on disk, hollow when empty). Both halves render at once (media_viewer.mdx §6).
function AnalysisColumn({ title, present, children }: { title: string; present: boolean; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col">
      <div className="mb-3 flex items-center gap-2 border-b border-[var(--lfb-border)] pb-2">
        <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${present ? "bg-emerald-500 text-white" : "border border-black/20 text-transparent"}`}>✓</span>
        <h2 className="text-sm font-medium text-black">{title}</h2>
      </div>
      {children}
    </section>
  );
}

// The meta line + Regenerate control + the content pane, shared by all three analysis columns. `children`
// is an optional REPLACEMENT for the flat `<pre>` (the OCR column's timecoded rows use it) — the header
// stays identical either way, so there is one pattern here, not two.
function AnalysisBody({ body, meta, mono, onRegenerate, busy, children }: { body: string; meta: React.ReactNode; mono?: boolean; onRegenerate: () => void; busy?: boolean; children?: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-black/45">
        <span>{meta}</span>
        <button
          className="flex items-center gap-1 text-[var(--lfb-primary)] hover:underline disabled:opacity-50"
          onClick={onRegenerate}
          disabled={busy}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Regenerating…" : "Regenerate"}
        </button>
      </div>
      {children ?? (
        <pre className={`max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--lfb-border)] bg-slate-50 px-4 py-3 text-sm text-black/80 ${mono ? "font-mono" : ""}`}>
          {body}
        </pre>
      )}
    </div>
  );
}

// A video's OCR text as TIMECODED, CLICKABLE rows (ocr.mdx §7's diagram: `03:00–06:15 → seek`). This is the
// §1.2 payoff — "find the slide that showed the pricing tier" — and the reason the artifact timecodes its
// blocks at all: reading the words is half the job, LANDING on them is the other half. Each entry is one
// span of screen text after the consecutive-duplicate collapse (§2.2.3), so a slide held for 3 minutes is
// one row with a range, not 12 identical ones.
function OcrTimecodedRows({ rows, onSeek }: { rows: (OcrBlock & { start: number })[]; onSeek: (sec: number) => void }) {
  return (
    <div className="max-h-[50vh] overflow-auto rounded-lg border border-[var(--lfb-border)] bg-slate-50 py-1">
      {rows.map((b, i) => (
        <button
          key={i}
          onClick={() => onSeek(b.start)}
          title={`Jump to ${formatDuration(b.start)}`}
          className="flex w-full gap-3 px-4 py-1.5 text-left hover:bg-black/[0.04]"
        >
          <span className="shrink-0 pt-px font-mono text-xs tabular-nums text-[var(--lfb-primary)]">
            {/* A range only when the text actually persisted across samples; a single-sample hit is one time. */}
            {formatDuration(b.start)}
            {typeof b.end === "number" && b.end > b.start ? `–${formatDuration(b.end)}` : ""}
          </span>
          <span className="min-w-0 whitespace-pre-wrap font-mono text-sm text-black/80">{b.text}</span>
        </button>
      ))}
    </div>
  );
}

function GeneratePane({
  icon, title, blurb, cta, onGenerate, disabled, disabledHint, hint, busy, busyLabel,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  cta: string;
  onGenerate: () => void;
  disabled?: boolean;
  disabledHint?: string;
  /** A muted note shown under an ENABLED button (e.g. "clicking will show how to add a key"). */
  hint?: string;
  busy?: boolean;
  busyLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--lfb-border)] px-6 py-10 text-center">
      {icon}
      <div className="font-medium text-black">{title}</div>
      <div className="max-w-md text-sm text-black/55">{blurb}</div>
      <button
        onClick={onGenerate}
        disabled={disabled || busy}
        className="mt-1 flex items-center gap-2 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {busy ? busyLabel ?? "Working…" : cta}
      </button>
      {busy && <div className="max-w-md text-xs text-black/50">Running locally — this can take a few minutes for a long video. You can leave this tab; progress shows in the dock.</div>}
      {disabled && !busy && disabledHint && <div className="max-w-md text-xs text-amber-700">{disabledHint}</div>}
      {!disabled && !busy && hint && <div className="max-w-md text-xs text-amber-700">{hint}</div>}
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
  if (v.decision) cells.push({ label: "Decision", node: v.decision === "sync" ? <span>Add to IPFS (pin)</span> : <span className="capitalize">{v.decision}</span> });
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
  playerRef,
}: {
  kind: MediaKind;
  src: string | null;
  view: EntityView;
  probeCodec: string | null;
  onDuration: (sec: number | null) => void;
  /** Handed down from the viewer so band 6's OCR rows can seek this player (ocr.mdx §7). */
  playerRef?: React.MutableRefObject<HTMLVideoElement | null>;
}) {
  const [failed, setFailed] = useState(false);
  // Video only: after the native <video> can't decode the file's codec, we retry through the backend
  // transcode stream (/api/media/stream) which pipes a browser-safe H.264/AAC fragmented MP4
  // (codecs.mdx §6). Only if THAT also fails do we surface DecodeFailure.
  const [videoFallback, setVideoFallback] = useState(false);
  const [zoom, setZoom] = useState(false); // image: fit ↔ 100%
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  // Reset transient view state when the source changes.
  useEffect(() => { setFailed(false); setVideoFallback(false); setZoom(false); }, [src]);

  // The backend transcode-stream URL is the grant URL pointed at /stream instead of /raw (same token).
  const streamSrc = src ? src.replace("/api/media/raw", "/api/media/stream") : null;

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
        <>
          <video
            // Remount when we swap native → transcode stream so the element reloads the new source.
            key={videoFallback ? "stream" : "native"}
            ref={playerRef}
            src={videoFallback ? streamSrc ?? src : src}
            controls
            preload="metadata"
            onLoadedMetadata={(e) => onDuration(e.currentTarget.duration || null)}
            onError={() => {
              if (!videoFallback && streamSrc) {
                // Native decode failed (unsupported codec/profile/pixel-format/audio) — retry through the
                // backend transcode stream instead of forcing the user to convert (codecs.mdx §6).
                clientLog.warn("MediaViewer.video.decode", `native failed, trying transcode stream: ${view.name}`);
                setVideoFallback(true);
              } else {
                clientLog.warn("MediaViewer.video.decode", `video load failed (stream too): ${view.name}`);
                setFailed(true);
              }
            }}
            className="max-h-full max-w-full"
          />
          {videoFallback && (
            <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white/85">
              Compatibility mode — streaming a converted copy (seeking may be limited)
            </div>
          )}
        </>
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
  // We reach here only after BOTH native decode AND the backend transcode stream failed (codecs.mdx §6).
  // Charter §6.1: bytes are never altered without an explicit ask — so the fixes are all offers.
  // For a video, offer converting the file on disk to the universal-safe target (H.264 · yuv420p · AAC ·
  // MP4 — codecs.mdx §5), which also makes it upload cleanly to TikTok/X/YouTube/Instagram.
  const offerConvert = kind === "video" && !view.flags.noCompress;
  const noun = kind === "audio" ? "play this audio" : kind === "video" ? "play this file" : "show this image";
  return (
    <div className="max-w-md rounded-lg border border-white/15 bg-black/40 px-5 py-4 text-center text-sm text-white/80">
      <p className="mb-1">
        This browser can't {noun}{codec ? <> ’s codec (<b>{codec}</b>)</> : null}.
      </p>
      {kind === "video" && (
        <p className="mb-3 text-xs text-white/55">
          We also tried streaming a converted copy and it didn't play. Open it in a native app, or convert
          the file to a browser- and upload-friendly H.264 MP4.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md bg-white/10 px-3 py-1.5 text-white hover:bg-white/20"
        >
          <ExternalLink className="h-4 w-4" /> Open raw / hand off to the OS
        </a>
        {offerConvert && (
          <button
            onClick={() => runConvertOffer(view)}
            title="Convert to H.264 MP4 (plays everywhere, uploads to TikTok/X). Nothing changes until you confirm."
            className="inline-flex items-center gap-1 rounded-md bg-amber-500/90 px-3 py-1.5 text-white hover:bg-amber-500"
          >
            <Zap className="h-4 w-4" /> Convert to H.264 (MP4)…
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

/** Convert a browser-incompatible video to the universal-safe H.264 MP4 target (codecs.mdx §5). Forces
 *  the H.264 codec regardless of the user's default video-compression preference, so the result plays in
 *  every browser and uploads to TikTok/X/YouTube/Instagram. Explicit-click + confirm (charter §6.1). */
async function runConvertOffer(v: EntityView): Promise<void> {
  if (!(await confirmModal({ title: `Convert ${v.name} to H.264 MP4?`, body: "This re-encodes to a browser- and upload-friendly copy (same resolution); the original moves to LFBridge trash (recoverable).", confirmLabel: "Convert" }))) return;
  api.compressFile(v.path, { videoCodec: "h264" })
    .then(reportCompress)
    .catch((e: Error) => { clientLog.error("MediaViewer.convertFile", e); toast.error(e.message); });
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
  const isPin = v.decision === "sync";
  // Not-pinned + Never-IPFS → no primary button (the More menu still governs).
  if (!isPin && v.flags.neverIpfs) return null;
  const disabledProps = ipfsReachable
    ? {}
    : { disabled: true, title: "IPFS node unreachable — start your IPFS node to add/remove pins" };
  return isPin ? (
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
