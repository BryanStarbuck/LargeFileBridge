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
} from "lucide-react";
import type { EntityView, Decision } from "@lfb/shared";
import { api } from "@/api/client";
import { patchEntityBadges } from "@/lib/patchEntityBadges";
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
}

const GROUP_ORDER = ["Open", "IPFS", "Decision", "Work", "Config", "Flag", "Copy", "Danger"];

// ── Position ───────────────────────────────────────────────────────────────────
export interface MenuPos {
  x: number;
  y: number;
}

// The floating menu itself, portaled to <body> and clamped on-screen.
function MenuPortal({ pos, onClose, children }: { pos: MenuPos; onClose: () => void; children: ReactNode }) {
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
  const { data: view, isLoading } = useQuery({
    queryKey: ["entity", path],
    queryFn: () => api.entity(path),
  });

  // After any mutation: patch the affected row's badges into the cached File-System listings in place
  // (performance.mdx P-17) instead of invalidating ["fs"] — which would re-walk EVERY open column (the
  // P-16 endpoint) just to flip one badge. The mutation returns the fresh EntityView, so we already
  // have the authoritative badges. Repo views are cheap (stored status, not a deep walk) → still refresh.
  const applyEntity = (v: EntityView) => {
    qc.setQueryData(["entity", path], v);
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

  const actions = view ? buildActions(view, { navigate, flags, decide }) : [];

  return (
    <MenuPortal pos={pos} onClose={onClose}>
      {isLoading || !view ? (
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
}

function buildActions(v: EntityView, ctx: Ctx): Action[] {
  const a: Action[] = [];
  const parent = v.path.replace(/[/\\][^/\\]*$/, "") || v.path;
  const copy = (text: string, label: string) => () => {
    // clipboard.writeText can reject (permissions / insecure context) — log the floating promise.
    navigator.clipboard?.writeText(text).catch((e) => clientLog.warn("EntityMenu.copy", e));
    toast.success(`${label} copied`);
  };
  const compress = () => {
    if (!window.confirm(`Compress ${v.name}? This is an offer — nothing changes until it runs.`)) return;
    api.compressEntity(v.path).then(() => toast.success("Compression queued")).catch((e) => {
      clientLog.error("EntityMenu.compress", e);
      toast.error(e.message);
    });
  };

  if (v.kind === "file") {
    // Open. A viewable medium opens its viewer first (media_viewer.mdx); properties stay reachable.
    if (v.compressible === "image" || v.compressible === "video") {
      const to = v.compressible === "image" ? "/image" : "/video";
      const label = v.compressible === "image" ? "View image" : "View video";
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

    // IPFS shortcuts (menus.mdx §5.3). Add hidden when Never IPFS on; Remove shown only when syncing.
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
          label: `Set decision: ${d[0].toUpperCase()}${d.slice(1)}`,
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
  } else {
    // Directory
    a.push({ id: "view", label: "View directory", group: "Open", icon: <Folder className="h-4 w-4" />,
      onSelect: () => ctx.navigate({ to: "/dir", search: { path: v.path } }) });
    a.push({ id: "browse", label: "Open in File System", group: "Open", icon: <FolderOpen className="h-4 w-4" />,
      onSelect: () => ctx.navigate({ to: "/fs", search: { path: v.path } }) });
    if (!v.flags.noCompress) {
      a.push({ id: "compress-dir", label: "Compress videos/images inside…", group: "Work", icon: <Zap className="h-4 w-4" />, onSelect: compress });
    }
  }

  // Sticky flags (menus.mdx §6.6) — same on file and directory.
  a.push({
    id: "never-ipfs",
    label: "Never IPFS",
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

  // Danger — stop syncing (never deletes bytes, §6.2).
  if (v.kind === "file" && v.decision === "sync") {
    a.push({
      id: "untrack",
      label: "Stop syncing (untrack / unpin)",
      group: "Danger",
      danger: true,
      icon: <RefreshCw className="h-4 w-4" />,
      onSelect: () => {
        if (window.confirm("Stop syncing this file? It stays on disk — only LFB's tracking is removed.")) {
          ctx.decide.mutate("ignore");
        }
      },
    });
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
