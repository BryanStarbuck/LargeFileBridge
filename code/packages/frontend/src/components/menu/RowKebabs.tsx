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
} from "lucide-react";
import type { RepoRow, PeerRow, IpfsPinRow } from "@lfb/shared";
import { api } from "@/api/client";
import { ActionsKebab, type Action } from "./EntityMenu";

// Copy to clipboard with a toast — the shared "copy" action body.
function copyToClipboard(text: string, label: string) {
  navigator.clipboard?.writeText(text);
  toast.success(`${label} copied`);
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
        await api.rescan();
        qc.invalidateQueries({ queryKey: ["scanStatus"] });
        toast.success("Rescan started");
      },
    },
    {
      id: "sync",
      label: "Sync now",
      group: "Work",
      icon: <UploadCloud className="h-4 w-4" />,
      onSelect: async () => {
        await api.syncNow(repo.repoId);
        refreshRepos();
        toast.success(`Syncing ${repo.name}`);
      },
    },
    {
      id: "toggle-synced",
      label: repo.synced ? "Synced: on" : "Synced: off",
      group: "Config",
      icon: <ToggleRight className="h-4 w-4" />,
      checked: repo.synced,
      onSelect: async () => {
        await api.patchRepoSettings(repo.repoId, { synced: !repo.synced });
        refreshRepos();
        toast.success(`${repo.name} sync ${repo.synced ? "paused" : "enabled"}`);
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
        await api.toggleBookmark(repo.repoId, !repo.bookmarked);
        refreshRepos();
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
          !window.confirm(
            `Remove ${repo.name} from LargeFileBridge?\n\nThis unregisters the repo only. Your folder and every file on disk stay exactly where they are.`,
          )
        )
          return;
        await api.removeRepo(repo.repoId);
        refreshRepos();
        toast.success(`Removed ${repo.name} (files untouched)`);
      },
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
          !window.confirm(
            `Forget ${peer.label}?\n\nLargeFileBridge stops expecting this computer. It removes nothing on that machine and no files here.`,
          )
        )
          return;
        await api.removePeer(peer.id);
        qc.invalidateQueries({ queryKey: ["peers"] });
        toast.success(`Removed ${peer.label}`);
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
        await api.ipfsImport({ cids: [pin.cid] });
        refreshIpfs();
        toast.success("Imported into tracking");
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
        !window.confirm(
          "Unpin this CID from this computer?\n\nThis stops THIS machine serving it. It deletes no local file. Other computers that pin it are unaffected.",
        )
      )
        return;
      await api.ipfsPin({ cid: pin.cid, pinned: false });
      refreshIpfs();
      toast.success("Unpinned on this computer");
    },
  });
  return <ActionsKebab actions={actions} />;
}
