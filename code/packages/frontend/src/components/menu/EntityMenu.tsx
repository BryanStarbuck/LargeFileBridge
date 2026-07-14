// The one entity action menu (menus.mdx §3–§6). ONE component, THREE triggers — the row/entry ⋯
// kebab (EntityKebab), right-click (EntityMenuAt at pointer), and the single-entity page's top-right
// "more" button (EntityMore) — all rendering the SAME per-entity catalog (§5) from the SAME EntityView.
// Charter guardrails hold: compress is an explicit-click OFFER with a confirm; Never IPFS / Do not
// compress are sticky toggles; nothing here ever deletes or alters local bytes.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  MoreVertical,
  FolderOpen,
  FileText,
  Folder,
  UploadCloud,
  DownloadCloud,
  Zap,
  Ban,
  Copy,
  Check,
  RefreshCw,
  Move,
  Trash2,
  Captions,
  Sparkles,
} from "lucide-react";
import type { EntityView, Decision } from "@lfb/shared";
import { mediaKindForName, viewerRouteForName } from "@lfb/shared";
import { api } from "@/api/client";
import { patchEntityBadges } from "@/lib/patchEntityBadges";
import { openTranscribeBatch, openDescribeBatch } from "@/lib/batchPopup";
import { confirmModal, promptModal } from "@/lib/modals";
import { openCompressInside } from "@/lib/compressInside";
import { clientLog } from "../../lib/clientLog.js";

// ── The action model ─────────────────────────────────────────────────────────
// Exported so the non-path row kebabs (repo / peer / pin — RowKebabs.tsx) and page-local kebabs
// (e.g. the directory rollup) build the SAME shape and render through the SAME MenuList.
export interface Action {
  id: string;
  label: string;
  icon?: ReactNode;
  group: string; // Open | IPFS | Decision | Work | Config | Flag | Copy | Danger
  danger?: boolean;
  checked?: boolean; // toggle state (Flag group)
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
  // ── Page action-links row extras (page_actions.mdx §3) — ignored by the popover MenuList ──────────
  // A destructive/irreversible offer opens this confirm modal BEFORE running onSelect (never a one-click
  // mutation). Presence of `confirm` implies the red-tinted, confirm-gated treatment in the links row.
  confirm?: { title: string; body?: ReactNode; confirmLabel?: string };
  // Producing actions (Create Transcriptions / Create AI descriptions) append the checked count to their
  // label when a selection exists, e.g. "Create Transcriptions (12)".
  countWhenSelected?: boolean;
}

// "Create" fronts the page-action menu (page_actions.mdx) — the producing actions (Create Transcriptions /
// Create AI descriptions) sit above the page's Work offers (compress / git-ignore). The rest are the
// per-entity catalog groups (menus.mdx §5).
const GROUP_ORDER = ["Create", "Open", "IPFS", "Decision", "Work", "Config", "Flag", "Copy", "Danger"];

// ── Position ───────────────────────────────────────────────────────────────────
export interface MenuPos {
  x: number;
  y: number;
}

// The floating menu itself, portaled to <body> and clamped on-screen.
export function MenuPortal({ pos, onClose, children }: { pos: MenuPos; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [adj, setAdj] = useState<MenuPos>(pos);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let { x, y } = pos;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
    setAdj({ x, y });
  }, [pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Defer so the opening click/right-click doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      clearTimeout(t);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: adj.x, top: adj.y, zIndex: 60 }}
      className="min-w-[15rem] rounded-lg border border-[var(--lfb-border)] bg-white py-1 shadow-xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

// ── The body: fetch the EntityView, build the catalog, render grouped ──────────
export function EntityMenuAt({
  path,
  pos,
  onClose,
}: {
  path: string;
  pos: MenuPos;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Menu-specific fetch: rollup-less (api.entityMenu) so opening the menu never triggers the expensive
  // directory rollup walk, and under its OWN query key so a rollup-less payload never poisons the
  // ["entity", path] cache the single-entity PAGES rely on for the rollup. `retry: 1` keeps a failed
  // open from silently churning three slow retries before the error surfaces.
  const { data: view, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["entity-menu", path],
    queryFn: () => api.entityMenu(path),
    retry: 1,
  });

  // After any mutation: patch the affected row's badges into the cached File-System listings in place
  // (performance.mdx P-17) instead of invalidating ["fs"] — which would re-walk EVERY open column (the
  // P-16 endpoint) just to flip one badge. The mutation returns the fresh EntityView, so we already
  // have the authoritative badges. Repo views are cheap (stored status, not a deep walk) → still refresh.
  const applyEntity = (v: EntityView) => {
    qc.setQueryData(["entity", path], v);
    qc.setQueryData(["entity-menu", path], v); // keep the menu's own key fresh for the next open
    patchEntityBadges(qc, path, v.badges);
    qc.invalidateQueries({ queryKey: ["repo"] });
  };

  const flags = useMutation({
    mutationFn: (patch: { neverIpfs?: boolean; noCompress?: boolean }) =>
      api.setEntityFlags(path, patch),
    onSuccess: applyEntity,
    onError: (e: Error) => {
      clientLog.error("EntityMenu.setFlags", e);
      toast.error(e.message);
    },
  });

  const decide = useMutation({
    mutationFn: (decision: Decision) => api.setEntityDecision(path, decision),
    onSuccess: applyEntity,
    onError: (e: Error) => {
      clientLog.error("EntityMenu.setDecision", e);
      toast.error(e.message);
    },
  });

  const run = (fn: () => void | Promise<void>) => async () => {
    onClose();
    // Central safety net: an action's onSelect may reject (a navigate/mutate/clipboard path). Without
    // this, the rejection is unhandled — log it so it reaches error.err instead of just the console.
    try {
      await fn();
    } catch (e) {
      clientLog.error("EntityMenu.action", e);
    }
  };

  const actions = view ? buildActions(view, { navigate, flags, decide, qc }) : [];

  return (
    <MenuPortal pos={pos} onClose={onClose}>
      {isError ? (
        // Never leave the menu stuck on "Loading…": on a failed/timed-out fetch, show the error and a
        // Retry so the menu is actionable instead of an infinite spinner (the old code had no error
        // branch, so any failure fell through to a permanent "Loading…").
        <div className="px-3 py-2 text-xs text-red-600">
          <div className="mb-1">Couldn’t load actions: {(error as Error)?.message ?? "request failed"}</div>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded px-2 py-1 text-red-700 hover:bg-red-50"
          >
            Retry
          </button>
        </div>
      ) : isLoading || !view ? (
        <div className="px-3 py-2 text-xs text-black/50">Loading…</div>
      ) : (
        <MenuList actions={actions} run={run} />
      )}
    </MenuPortal>
  );
}

export function MenuList({
  actions,
  run,
}: {
  actions: Action[];
  run: (fn: () => void | Promise<void>) => () => Promise<void>;
}) {
  const groups = GROUP_ORDER.filter((g) => actions.some((a) => a.group === g));
  return (
    <>
      {groups.map((g, gi) => (
        <div key={g}>
          {gi > 0 && <div className="my-1 border-t border-[var(--lfb-border)]" />}
          {actions
            .filter((a) => a.group === g)
            .map((a) => (
              <button
                key={a.id}
                role="menuitem"
                disabled={a.disabled}
                onClick={run(a.onSelect)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-40 ${
                  a.danger ? "text-red-600 hover:bg-red-50" : "text-black hover:bg-slate-100"
                }`}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-black/50">
                  {a.checked ? <Check className="h-4 w-4 text-[var(--lfb-primary)]" /> : a.icon}
                </span>
                <span className="flex-1">{a.label}</span>
              </button>
            ))}
        </div>
      ))}
    </>
  );
}

// ── The catalog (menus.mdx §5.2 directory / §5.3 file) — single source of truth ─
interface Ctx {
  navigate: ReturnType<typeof useNavigate>;
  flags: { mutate: (p: { neverIpfs?: boolean; noCompress?: boolean }) => void };
  decide: { mutate: (d: Decision) => void };
  qc: ReturnType<typeof useQueryClient>;
}

function buildActions(v: EntityView, ctx: Ctx): Action[] {
  const a: Action[] = [];
  const parent = v.path.replace(/[/\\][^/\\]*$/, "") || v.path;
  const copy = (text: string, label: string) => () => {
    // clipboard.writeText can reject (permissions / insecure context) — log the floating promise.
    navigator.clipboard?.writeText(text).catch((e) => clientLog.warn("EntityMenu.copy", e));
    toast.success(`${label} copied`);
  };
  const compress = async () => {
    if (!(await confirmModal({ title: `Compress ${v.name}?`, body: "Medium quality, same resolution — the original moves to LFBridge trash (recoverable).", confirmLabel: "Compress" }))) return;
    api.compressFile(v.path)
      .then((r) => {
        if (r.status === "compressed") toast.success(`Compressed → ${r.codec ?? "smaller"}`);
        else if (r.status === "blocked") toast.error(`Blocked: ${r.reason ?? "unsafe"}`);
        else if (r.status === "skipped") toast(`Not compressed: ${r.reason ?? "no gain"}`);
        else toast.error(`Failed: ${r.reason ?? "error"}`);
        refreshLists();
        ctx.qc.invalidateQueries({ queryKey: ["entity", v.path] });
      })
      .catch((e) => { clientLog.error("EntityMenu.compress", e); toast.error(e.message); });
  };
  const refreshLists = () => {
    ctx.qc.invalidateQueries({ queryKey: ["fs"] });
    ctx.qc.invalidateQueries({ queryKey: ["repo"] });
  };
  // Move… (menus.mdx §5.3 Work) — guarded rename; on success re-point to the file's viewer at its new path.
  const move = async () => {
    const dest = await promptModal({ title: "Move file", label: "New absolute path:", defaultValue: v.path, confirmLabel: "Move" });
    if (!dest || dest.trim() === v.path) return;
    api.moveEntity(v.path, dest.trim()).then((r) => {
      toast.success("File moved");
      refreshLists();
      const name = r.path.slice(r.path.lastIndexOf("/") + 1);
      ctx.navigate({ to: viewerRouteForName(name), search: { path: r.path } });
    }).catch((e) => { clientLog.error("EntityMenu.move", e); toast.error(e.message); });
  };
  // Delete… (menus.mdx §5.3 Danger) — RECOVERABLE: moves to LFBridge trash, never unlinks.
  const del = async () => {
    if (!(await confirmModal({ title: `Move ${v.name} to LFBridge trash?`, body: "This is recoverable — the file is moved to the trash folder, not erased.", confirmLabel: "Move to trash" }))) return;
    api.deleteEntity(v.path).then(() => {
      toast.success("Moved to LFBridge trash");
      refreshLists();
      ctx.navigate({ to: "/fs", search: { path: parent } });
    }).catch((e) => { clientLog.error("EntityMenu.delete", e); toast.error(e.message); });
  };

  if (v.kind === "file") {
    // Open. A viewable medium opens its viewer first (media_viewer.mdx) by KIND (image/video/audio);
    // properties stay reachable. Audio isn't a "compressible" kind, so route from the name, not compressible.
    const mkind = mediaKindForName(v.name); // "image" | "video" | "audio" | null
    if (mkind) {
      const to = mkind === "image" ? "/image" : mkind === "video" ? "/video" : "/audio";
      const label = mkind === "image" ? "View image" : mkind === "video" ? "View video" : "View audio";
      a.push({ id: "view", label, group: "Open", icon: <FileText className="h-4 w-4" />,
        onSelect: () => ctx.navigate({ to, search: { path: v.path } }) });
      a.push({ id: "view-props", label: "View properties", group: "Open", icon: <FileText className="h-4 w-4" />,
        onSelect: () => ctx.navigate({ to: "/file", search: { path: v.path } }) });
    } else {
      a.push({ id: "view", label: "View file", group: "Open", icon: <FileText className="h-4 w-4" />,
        onSelect: () => ctx.navigate({ to: "/file", search: { path: v.path } }) });
    }
    a.push({ id: "reveal", label: "Open containing folder", group: "Open", icon: <FolderOpen className="h-4 w-4" />,
      onSelect: () => ctx.navigate({ to: "/fs", search: { path: parent } }) });

    // IPFS shortcuts (menus.mdx §5.3). Add hidden when Never IPFS on; Remove shown only when pinned.
    if (v.repo && v.decision !== "sync" && !v.flags.neverIpfs) {
      a.push({ id: "add-ipfs", label: "Add to IPFS", group: "IPFS", icon: <UploadCloud className="h-4 w-4" />,
        onSelect: () => ctx.decide.mutate("sync") });
    }
    if (v.repo && v.decision === "sync") {
      a.push({ id: "rm-ipfs", label: "Remove from IPFS", group: "IPFS", icon: <DownloadCloud className="h-4 w-4" />,
        onSelect: () => ctx.decide.mutate("ignore") });
    }

    // Full decision submenu (flat) — only meaningful inside a repo.
    if (v.repo) {
      (["sync", "ignore", "undecided"] as Decision[]).forEach((d) =>
        a.push({
          id: `dec-${d}`,
          label: `Set decision: ${d === "sync" ? "Add to IPFS (pin)" : `${d[0].toUpperCase()}${d.slice(1)}`}`,
          group: "Decision",
          checked: v.decision === d,
          disabled: d === "sync" && v.flags.neverIpfs,
          onSelect: () => ctx.decide.mutate(d),
        }),
      );
    }

    // Work
    if (v.compressible && v.compressState !== "done" && !v.flags.noCompress) {
      a.push({ id: "compress", label: "Compress…", group: "Work", icon: <Zap className="h-4 w-4" />, onSelect: compress });
    }
    // Create Transcription — audio/video only. Opens the UNIFIED batch popup (dialogs.mdx §5/§6.4) with this
    // one file as the sole checked candidate — the education + an explicit "Transcribe 1 file" confirm, never
    // a bare window.confirm. The SAME popup the Transcribable metric tile + the page action-links row open.
    if (mkind === "audio" || mkind === "video") {
      a.push({ id: "create-transcription", label: "Create Transcription", group: "Create", icon: <Captions className="h-4 w-4" />,
        onSelect: () => openTranscribeBatch({ paths: [v.path] }) });
    }
    // Create AI description — image/video only. Same popup, provider/model-gated (dialogs.mdx §5/§6.4).
    if (mkind === "image" || mkind === "video") {
      a.push({ id: "create-description", label: "Create AI description", group: "Create", icon: <Sparkles className="h-4 w-4" />,
        onSelect: () => openDescribeBatch({ paths: [v.path] }) });
    }
    // Move… — guarded rename of the file (media_viewer.mdx §4.4). Explicit; relocates real bytes.
    a.push({ id: "move", label: "Move…", group: "Work", icon: <Move className="h-4 w-4" />, onSelect: move });
  } else {
    // Directory
    a.push({ id: "view", label: "View directory", group: "Open", icon: <Folder className="h-4 w-4" />,
      onSelect: () => ctx.navigate({ to: "/dir", search: { path: v.path } }) });
    a.push({ id: "browse", label: "Open in File System", group: "Open", icon: <FolderOpen className="h-4 w-4" />,
      onSelect: () => ctx.navigate({ to: "/fs", search: { path: v.path } }) });
    if (!v.flags.noCompress) {
      // Opens the Compress-inside pop-over dialog (compress_inside.mdx) — a darkened-backdrop modal with
      // Images/Videos/recursive checkboxes + the Originals radio — NOT a window.confirm, and NOT a
      // compressFile() on the directory path (which the old handler wrongly did).
      a.push({ id: "compress-dir", label: "Compress videos/images inside…", group: "Work", icon: <Zap className="h-4 w-4" />,
        onSelect: () => openCompressInside(v.path, { images: true, videos: true }) });
    }
    // Create Transcriptions / Create AI descriptions over this directory's subtree — the UNIFIED batch popup
    // (dialogs.mdx §5/§6.4, menus.mdx §5.2), scoped downward-only to `{ root: <dir> }`. The SAME "great
    // pop-up" the metric tile + the page action-links row open; never a window.confirm / fire-and-forget.
    a.push({ id: "create-transcriptions", label: "Create Transcriptions", group: "Create", icon: <Captions className="h-4 w-4" />,
      onSelect: () => openTranscribeBatch({ root: v.path }) });
    a.push({ id: "create-descriptions", label: "Create AI descriptions", group: "Create", icon: <Sparkles className="h-4 w-4" />,
      onSelect: () => openDescribeBatch({ root: v.path }) });
  }

  // Sticky flags (menus.mdx §6.6) — same on file and directory.
  a.push({
    id: "never-ipfs",
    label: "Never publish via IPFS",
    group: "Flag",
    icon: <Ban className="h-4 w-4" />,
    checked: v.flags.neverIpfs,
    onSelect: () => ctx.flags.mutate({ neverIpfs: !v.flags.neverIpfs }),
  });
  a.push({
    id: "no-compress",
    label: "Do not compress",
    group: "Flag",
    icon: <Ban className="h-4 w-4" />,
    checked: v.flags.noCompress,
    onSelect: () => ctx.flags.mutate({ noCompress: !v.flags.noCompress }),
  });

  // Copy
  if (v.cid) a.push({ id: "copy-cid", label: "Copy CID", group: "Copy", icon: <Copy className="h-4 w-4" />, onSelect: copy(v.cid, "CID") });
  a.push({ id: "copy-path", label: "Copy path", group: "Copy", icon: <Copy className="h-4 w-4" />, onSelect: copy(v.path, "Path") });

  // Danger — stop pinning (never deletes bytes, §6.2).
  if (v.kind === "file" && v.decision === "sync") {
    a.push({
      id: "untrack",
      label: "Stop pinning (untrack / unpin)",
      group: "Danger",
      danger: true,
      icon: <RefreshCw className="h-4 w-4" />,
      onSelect: async () => {
        if (await confirmModal({ title: "Stop pinning this file?", body: "It stays on disk — only Large File Bridge's tracking is removed.", confirmLabel: "Stop pinning" })) {
          ctx.decide.mutate("ignore");
        }
      },
    });
  }
  // Delete… — RECOVERABLE (moves to LFBridge trash, never unlink — menus.mdx §5.3 / media_viewer.mdx §4.4).
  if (v.kind === "file") {
    a.push({ id: "delete", label: "Delete…", group: "Danger", danger: true, icon: <Trash2 className="h-4 w-4" />, onSelect: del });
  }

  return a;
}

// ── The vertical ⋮ kebab button (menus.mdx §3 — LOCKED: always vertical, never horizontal ⋯) ──────
// The shared trigger used by every row/entry kebab. Clicking it stops row-click propagation and
// opens `menu` (a render prop given the anchor position + a close callback) as a portaled popover.
export function KebabButton({
  menu,
  title = "Actions",
  className,
}: {
  menu: (pos: MenuPos, onClose: () => void) => ReactNode;
  title?: string;
  className?: string;
}) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  return (
    <>
      <button
        aria-haspopup="menu"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.right - 4, y: r.bottom + 4 });
        }}
        className={`rounded p-1 text-black/50 hover:bg-slate-200 hover:text-black ${className ?? ""}`}
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {pos && menu(pos, () => setPos(null))}
    </>
  );
}

// A kebab over a PREBUILT action list (repo / peer / pin / rollup rows — the row data is already in
// hand, so no async EntityView fetch is needed). Renders the same grouped MenuList as the path kebab.
export function ActionsKebab({
  actions,
  title,
  className,
}: {
  actions: Action[];
  title?: string;
  className?: string;
}) {
  const run = (fn: () => void | Promise<void>) => async () => {
    // Safety net for prebuilt actions (repo/peer/pin/rollup) whose onSelect awaits api.* — surface any
    // rejection to error.err rather than leaving it an unhandled promise rejection.
    try {
      await fn();
    } catch (e) {
      clientLog.error("EntityMenu.action", e);
    }
  };
  return (
    <KebabButton
      title={title}
      className={className}
      menu={(pos, onClose) => (
        <MenuPortal pos={pos} onClose={onClose}>
          <MenuList
            actions={actions}
            run={(fn) => async () => {
              onClose();
              await run(fn)();
            }}
          />
        </MenuPortal>
      )}
    />
  );
}

// ── Trigger 1: the row/entry ⋮ kebab for a file/dir PATH (menus.mdx §3) ─────────
// Fetches the EntityView lazily when opened (file/dir catalog, §5.2/§5.3).
export function EntityKebab({ path, className }: { path: string; className?: string }) {
  return (
    <KebabButton
      className={className}
      menu={(pos, onClose) => <EntityMenuAt path={path} pos={pos} onClose={onClose} />}
    />
  );
}

// ── Trigger 2: the single-entity page "more" button (menus.mdx §4) ─────────────
export function EntityMore({ path }: { path: string }) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  return (
    <>
      <button
        aria-haspopup="menu"
        title="More actions"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.right - 4, y: r.bottom + 4 });
        }}
        className="rounded-md border border-[var(--lfb-border)] p-2 hover:bg-slate-100"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {pos && <EntityMenuAt path={path} pos={pos} onClose={() => setPos(null)} />}
    </>
  );
}
