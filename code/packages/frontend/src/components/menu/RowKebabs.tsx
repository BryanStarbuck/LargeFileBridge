// The row ⋮ kebabs whose row is NOT a file/dir path (so they don't fetch an EntityView): the REPO
// catalog (menus.mdx §5.1), the PEER catalog (§5.4), and the PIN catalog (§5.5 — a pinned CID with no
// local entity). Each builds the shared Action[] from data already in hand and renders through the
// same grouped popover as EntityKebab. Charter guardrails hold: destructive items confirm and never
// delete local bytes (§6.2); nothing acts silently.
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  FolderOpen,
  FolderGit2,
  Share2,
  RefreshCw,
  UploadCloud,
  DownloadCloud,
  ToggleRight,
  Settings,
  Bookmark,
  Copy,
  Trash2,
  Ban,
  Captions,
  Sparkles,
  TextSelect,
} from "lucide-react";
import { HardDrive } from "lucide-react";
import type { RepoRow, PeerRow, IpfsPinRow, StorageRow } from "@lfb/shared";
import { api } from "@/api/client";
import { ActionsKebab, type Action } from "./EntityMenu";
import { openTranscribeBatch, openDescribeBatch, openOcrBatch } from "@/lib/batchPopup";
import { confirmModal } from "@/lib/modals";
import { copyText } from "@/lib/clipboard";
import { clientLog } from "../../lib/clientLog.js";

// Copy to clipboard with a toast — the shared "copy" action body. Delegates to the one clipboard write
// (lib/clipboard.ts) so the toast reports the REAL outcome, never an optimistic "copied" on a failed write.
function copyToClipboard(text: string, label: string) {
  void copyText(text, label, "RowKebabs.copy");
}

// ── The row settings gear (storage_settings.mdx §1 / repo_settings.mdx §1) ──────
// A small gear button that opens a settings page, shown just LEFT of the row ⋮ kebab so per-storage /
// per-repo settings are one click from the list (the same destination the kebab's "…settings…" item
// reaches). It matches KebabButton's flat icon-button look and stops row-click propagation, so it opens
// settings without also navigating the row.
function SettingsGear({ onOpen, title }: { onOpen: () => void; title: string }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="rounded p-1 text-black/50 hover:bg-slate-200 hover:text-black"
    >
      <Settings className="h-4 w-4" />
    </button>
  );
}

// Gear for a Storages-table row — opens that storage's per-storage settings (storage_settings.mdx §1).
// Company / personal / repo / community storages all land on the same route, scoped by id.
export function StorageGear({ storage }: { storage: StorageRow }) {
  const navigate = useNavigate();
  return (
    <SettingsGear
      title="Storage settings"
      onOpen={() => navigate({ to: "/storages/$storageId/settings", params: { storageId: storage.id } })}
    />
  );
}

// Gear for a Repos-table row — opens that repo's per-repo settings (repo_settings.mdx §1).
export function RepoGear({ repo }: { repo: RepoRow }) {
  const navigate = useNavigate();
  return (
    <SettingsGear
      title="Repo settings"
      onOpen={() => navigate({ to: "/repos/$repoId/settings", params: { repoId: repo.repoId } })}
    />
  );
}

// ── Repo row / One-repo page (menus.mdx §5.1) ──────────────────────────────────
export function RepoKebab({ repo }: { repo: RepoRow }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const refreshRepos = () => qc.invalidateQueries({ queryKey: ["repos"] });

  const actions: Action[] = [
    {
      id: "open",
      label: "Open repo",
      group: "Open",
      icon: <FolderGit2 className="h-4 w-4" />,
      onSelect: () => navigate({ to: "/repos/$repoId", params: { repoId: repo.repoId } }),
    },
    {
      id: "browse",
      label: "Open in File System",
      group: "Open",
      icon: <FolderOpen className="h-4 w-4" />,
      onSelect: () => navigate({ to: "/fs", search: { path: repo.path } }),
    },
    {
      id: "ipfs",
      label: "View pinned on IPFS",
      group: "Open",
      icon: <Share2 className="h-4 w-4" />,
      onSelect: () => navigate({ to: "/ipfs/pins", search: { repo: repo.repoId } }),
    },
    {
      id: "rescan",
      label: "Rescan",
      group: "Work",
      icon: <RefreshCw className="h-4 w-4" />,
      onSelect: async () => {
        try {
          await api.rescan();
          qc.invalidateQueries({ queryKey: ["scanStatus"] });
          toast.success("Rescan started");
        } catch (e) {
          clientLog.error("RowKebabs.rescan", e);
          toast.error(e instanceof Error ? e.message : "Rescan failed");
        }
      },
    },
    {
      id: "pin",
      label: "Pin now",
      group: "Work",
      icon: <UploadCloud className="h-4 w-4" />,
      onSelect: async () => {
        try {
          await api.pinNow(repo.repoId);
          refreshRepos();
          toast.success(`Pinning ${repo.name}`);
        } catch (e) {
          clientLog.error("RowKebabs.pinNow", e);
          toast.error(e instanceof Error ? e.message : "Pin failed");
        }
      },
    },
    {
      id: "create-transcriptions",
      label: "Create Transcriptions",
      group: "Create",
      icon: <Captions className="h-4 w-4" />,
      // Opens the unified batch popup (dialogs.mdx §5/§6) over the repo's working tree, scoped downward-only.
      onSelect: () => openTranscribeBatch({ root: repo.path }),
    },
    {
      id: "create-descriptions",
      label: "Create AI descriptions",
      group: "Create",
      icon: <Sparkles className="h-4 w-4" />,
      // Mirror of Create Transcriptions (dialogs.mdx §6.4 — every producing entry point opens the ONE batch
      // popup). This item was previously missing from the repo-row ⋮, so "Create AI descriptions" was
      // unreachable here; both producing actions must be symmetric on every ⋮/right-click surface.
      onSelect: () => openDescribeBatch({ root: repo.path }),
    },
    {
      id: "create-ocr-text",
      label: "Create OCR text",
      group: "Create",
      icon: <TextSelect className="h-4 w-4" />,
      // The third sibling (ocr.mdx §0's symmetry contract): the trio is adjacent and always in the order
      // transcription → AI description → OCR, at every scale. This surface had gained the first two, so
      // omitting the third repeated — one release later — the exact "unreachable here" bug the comment
      // above records. (ocr.mdx §8.4 says the repo ⋮ carries no producing actions at all; this catalog
      // disagrees with that spec in practice, and the contract's rule for that case is all three or none.)
      onSelect: () => openOcrBatch({ root: repo.path }),
    },
    {
      id: "toggle-pin",
      label: repo.pinned ? "Pinned: on" : "Pinned: off",
      group: "Config",
      icon: <ToggleRight className="h-4 w-4" />,
      checked: repo.pinned,
      onSelect: async () => {
        try {
          await api.patchRepoSettings(repo.repoId, { pinned: !repo.pinned });
          refreshRepos();
          toast.success(`${repo.name} pinning ${repo.pinned ? "paused" : "enabled"}`);
        } catch (e) {
          clientLog.error("RowKebabs.togglePinned", e);
          toast.error(e instanceof Error ? e.message : "Couldn't change pin setting");
        }
      },
    },
    {
      id: "settings",
      label: "Repo settings…",
      group: "Config",
      icon: <Settings className="h-4 w-4" />,
      onSelect: () => navigate({ to: "/repos/$repoId/settings", params: { repoId: repo.repoId } }),
    },
    {
      id: "bookmark",
      label: repo.bookmarked ? "Remove bookmark" : "Bookmark",
      group: "Flag",
      icon: <Bookmark className="h-4 w-4" />,
      checked: repo.bookmarked,
      onSelect: async () => {
        try {
          await api.toggleBookmark(repo.repoId, !repo.bookmarked);
          refreshRepos();
        } catch (e) {
          clientLog.error("RowKebabs.toggleBookmark", e);
          toast.error(e instanceof Error ? e.message : "Couldn't update bookmark");
        }
      },
    },
    {
      id: "copy-path",
      label: "Copy path",
      group: "Copy",
      icon: <Copy className="h-4 w-4" />,
      onSelect: () => copyToClipboard(repo.path, "Path"),
    },
    {
      id: "remove",
      label: "Remove repo (unregister)",
      group: "Danger",
      danger: true,
      icon: <Trash2 className="h-4 w-4" />,
      onSelect: async () => {
        if (
          !(await confirmModal({
            title: `Remove ${repo.name} from Large File Bridge?`,
            body: "This unregisters the repo only. Your folder and every file on disk stay exactly where they are.",
            confirmLabel: "Remove repo",
          }))
        )
          return;
        try {
          await api.removeRepo(repo.repoId);
          refreshRepos();
          toast.success(`Removed ${repo.name} (files untouched)`);
        } catch (e) {
          clientLog.error("RowKebabs.removeRepo", e);
          toast.error(e instanceof Error ? e.message : "Couldn't remove repo");
        }
      },
    },
  ];

  return <ActionsKebab actions={actions} />;
}

// ── Storage row / storage detail page (storage_settings.mdx §1) ────────────────
// The storage entity catalog. Its Config group carries "Storage settings…" — the same destination as
// the gear on the storage detail header (route /storages/$storageId/settings).
export function StorageKebab({ storage }: { storage: StorageRow }) {
  const navigate = useNavigate();
  const actions: Action[] = [
    {
      id: "open",
      label: "Open storage",
      group: "Open",
      icon: <HardDrive className="h-4 w-4" />,
      onSelect: () => navigate({ to: "/storages/$storageId", params: { storageId: storage.id } }),
    },
    {
      id: "browse",
      label: "Open in File System",
      group: "Open",
      icon: <FolderOpen className="h-4 w-4" />,
      onSelect: () => navigate({ to: "/fs", search: { path: storage.root } }),
    },
    {
      id: "settings",
      label: "Storage settings…",
      group: "Config",
      icon: <Settings className="h-4 w-4" />,
      onSelect: () => navigate({ to: "/storages/$storageId/settings", params: { storageId: storage.id } }),
    },
    {
      id: "copy-path",
      label: "Copy path",
      group: "Copy",
      icon: <Copy className="h-4 w-4" />,
      onSelect: () => copyToClipboard(storage.root, "Path"),
    },
  ];
  return <ActionsKebab actions={actions} />;
}

// ── Peer row (menus.mdx §5.4) ──────────────────────────────────────────────────
export function PeerKebab({ peer }: { peer: PeerRow }) {
  const qc = useQueryClient();
  const actions: Action[] = [
    {
      id: "copy-peerid",
      label: "Copy Peer ID",
      group: "Copy",
      icon: <Copy className="h-4 w-4" />,
      disabled: !peer.ipfsPeerId,
      onSelect: () => {
        if (peer.ipfsPeerId) copyToClipboard(peer.ipfsPeerId, "Peer ID");
      },
    },
    {
      id: "remove",
      label: "Remove peer",
      group: "Danger",
      danger: true,
      icon: <Trash2 className="h-4 w-4" />,
      onSelect: async () => {
        if (
          !(await confirmModal({
            title: `Forget ${peer.label}?`,
            body: "Large File Bridge stops expecting this computer. It removes nothing on that machine and no files here.",
            confirmLabel: "Remove peer",
          }))
        )
          return;
        try {
          await api.removePeer(peer.id);
          qc.invalidateQueries({ queryKey: ["peers"] });
          toast.success(`Removed ${peer.label}`);
        } catch (e) {
          clientLog.error("RowKebabs.removePeer", e);
          toast.error(e instanceof Error ? e.message : "Couldn't remove peer");
        }
      },
    },
  ];
  return <ActionsKebab actions={actions} />;
}

// ── IPFS pin row with NO local file (untracked / path-less) — menus.mdx §5.5 ────
// Rows that DO resolve to a local file use EntityKebab (the file catalog) instead.
export function PinKebab({ pin }: { pin: IpfsPinRow }) {
  const qc = useQueryClient();
  const refreshIpfs = () => qc.invalidateQueries({ queryKey: ["ipfs"] });

  const actions: Action[] = [];
  if (pin.tracked === "import") {
    actions.push({
      id: "import",
      label: "Import into tracking",
      group: "IPFS",
      icon: <DownloadCloud className="h-4 w-4" />,
      onSelect: async () => {
        try {
          await api.ipfsImport({ cids: [pin.cid] });
          refreshIpfs();
          toast.success("Imported into tracking");
        } catch (e) {
          clientLog.error("RowKebabs.ipfsImport", e);
          toast.error(e instanceof Error ? e.message : "Import failed");
        }
      },
    });
  }
  actions.push({
    id: "copy-cid",
    label: "Copy CID",
    group: "Copy",
    icon: <Copy className="h-4 w-4" />,
    onSelect: () => copyToClipboard(pin.cid, "CID"),
  });
  actions.push({
    id: "unpin",
    label: "Unpin from this computer",
    group: "Danger",
    danger: true,
    icon: <Ban className="h-4 w-4" />,
    onSelect: async () => {
      if (
        !(await confirmModal({
          title: "Unpin this CID from this computer?",
          body: "This stops THIS machine serving it. It deletes no local file. Other computers that pin it are unaffected.",
          confirmLabel: "Unpin",
        }))
      )
        return;
      try {
        await api.ipfsPin({ cid: pin.cid, pinned: false });
        refreshIpfs();
        toast.success("Unpinned on this computer");
      } catch (e) {
        clientLog.error("RowKebabs.unpin", e);
        toast.error(e instanceof Error ? e.message : "Couldn't unpin");
      }
    },
  });
  return <ActionsKebab actions={actions} />;
}
