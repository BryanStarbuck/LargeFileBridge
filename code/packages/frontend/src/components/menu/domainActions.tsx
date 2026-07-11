// Shared builders for the page action-links CATALOG (page_actions.mdx §4) — the domain offers that sit
// alongside the two producing actions on each file-list page. The producing pair lives in
// PageActions.tsx (producingActions); these are the page's pre-existing domain operations shown as
// inline links.
//
// IMPORTANT — honesty about backends (page_actions.mdx §4 / task): a batch endpoint does not exist yet
// for per-type compression (videos-only / images-only), for batch git-ignore of big files, for
// track/pin-a-whole-directory, for "Pin all" across repos, or for "Publish IPFS list". Rather than
// fabricate routes, these offers open the confirm modal (for the destructive ones) and then surface a
// graceful "not yet wired" toast in the app's existing style (notWiredToast → toast.message). The
// genuinely-wired offers (Create Transcriptions/Descriptions, Rescan, Re-index, Re-verify, per-directory
// Compress, IPFS pin/unpin over a selection) are wired to their real handlers by the pages directly.
import { Zap, EyeOff, UploadCloud, DownloadCloud, Share2 } from "lucide-react";
import type { Action } from "./EntityMenu";
import { notWiredToast } from "../../lib/pageActions.js";
import { openCompressInside } from "../../lib/compressInside.js";
import { openGitIgnore } from "../../lib/gitIgnore.js";

const ICON = "h-3.5 w-3.5";

/**
 * Compress-all-videos offer. When the page can supply its directory `root`, this opens the Compress-inside
 * pop-over dialog (compress_inside.mdx §2) scoped to that root with VIDEOS pre-checked — the dialog is its
 * own confirm + config, so no separate ConfirmDialog is attached. Without a root (a page that can't resolve
 * one) it falls back to the honest "not yet wired" toast.
 */
export function compressAllVideos(root?: string): Action {
  return {
    id: "compress-videos",
    label: "Compress videos",
    icon: <Zap className={ICON} />,
    group: "Work",
    danger: true,
    onSelect: () =>
      root
        ? openCompressInside(root, { images: false, videos: true })
        : notWiredToast(
            "Batch video compression isn't wired yet",
            "compress a video from its ⋯ menu, or a whole directory from View one directory",
          ),
  };
}

/** Compress-all-images offer — opens the Compress-inside dialog with IMAGES pre-checked (compress_inside.mdx §2). */
export function compressAllImages(root?: string): Action {
  return {
    id: "compress-images",
    label: "Compress images",
    icon: <Zap className={ICON} />,
    group: "Work",
    danger: true,
    onSelect: () =>
      root
        ? openCompressInside(root, { images: true, videos: false })
        : notWiredToast(
            "Batch image compression isn't wired yet",
            "compress an image from its ⋯ menu, or a whole directory from View one directory",
          ),
  };
}

/**
 * Git ignore offer — opens the Git Ignore pop-over dialog (git_ignore.mdx §1/§4) scoped to the resolved
 * target set (the checked `paths`, else the deepest open column's `root`). The dialog IS the confirm step
 * (charter: "Never add a .gitignore entry automatically"), so it stays red-tinted (danger) but no separate
 * ConfirmDialog is attached. `scope` carries the root/paths this action was built with (git_ignore.mdx §2).
 */
export function gitIgnoreBig(scope?: { root?: string; paths?: string[] }): Action {
  return {
    id: "gitignore-big",
    label: "Git ignore",
    icon: <EyeOff className={ICON} />,
    group: "Work",
    danger: true,
    onSelect: () => openGitIgnore({ paths: scope?.paths, root: scope?.root }),
  };
}

/** Track / Pin this directory offer — not batch-wired; points to per-file decisions. */
export function trackPinDir(): Action {
  return {
    id: "track-pin-dir",
    label: "Track / Add to IPFS (pin) this directory",
    icon: <UploadCloud className={ICON} />,
    group: "Work",
    onSelect: () =>
      notWiredToast(
        "Whole-directory tracking isn't wired yet",
        "add files to IPFS (pin) from the File System or the Full paths table",
      ),
  };
}

/** Pin all repos (Repos list) — not batch-wired; pinning is per-repo today. */
export function pinAllRepos(): Action {
  return {
    id: "pin-all",
    label: "Pin all",
    icon: <UploadCloud className={ICON} />,
    group: "Work",
    onSelect: () =>
      notWiredToast("Pin-all isn't wired yet", "open a repo and use Pin now"),
  };
}

/** Publish IPFS list (IPFS pins) — not wired yet. */
export function publishIpfsList(): Action {
  return {
    id: "publish-ipfs-list",
    label: "Publish IPFS list…",
    icon: <Share2 className={ICON} />,
    group: "Work",
    onSelect: () =>
      notWiredToast("Publishing an IPFS list isn't wired yet", "your pinned files are shown below"),
  };
}

export const domainIcons = { Zap, EyeOff, UploadCloud, DownloadCloud, Share2 };
