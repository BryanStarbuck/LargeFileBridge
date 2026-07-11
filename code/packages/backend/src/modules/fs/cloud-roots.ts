// Cloud-storage roots surfaced at the top of the File System home column (file_system.mdx §6,
// dropbox.mdx / google_drive.mdx "browseable root" section).
//
// On macOS, Dropbox, Google Drive, and iCloud Drive do NOT live directly in the home directory —
// they mount under ~/Library/CloudStorage/ (Google Drive for Desktop, Dropbox, and the iCloud
// FileProvider all publish their folders there). So a user who opens the File System browser on ~
// would have to drill Library → CloudStorage → <mount> to reach the very large videos/images that
// LFBridge exists to help them find and compress. This module discovers those mounts so the home
// column can lift them to its top level, "almost as if they were in ~".
//
// This is a pure BROWSING convenience and is INDEPENDENT of the cloud backbones
// (large_files.settings.backbones.{dropbox,google_drive}). Surfacing a mount here never enables a
// backbone, never writes a `LargeFilesBridge_SyncList.yaml`, and never moves bytes — it only makes the mount visible and
// walkable in the column browser. Metadata-only: Node fs stats, never the `find` shell (charter +
// macOS-indexing rule).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloudProvider } from "@lfb/shared";

export interface CloudRoot {
  provider: CloudProvider;
  /** Friendly display label used as the row name, e.g. "Dropbox" or "Google Drive — bryan@act3ai.com". */
  label: string;
  /** The Google Drive account email (from GoogleDrive-<account>); absent for Dropbox/iCloud. */
  account?: string;
  /** The real absolute mount path — what the browser actually opens when the row is clicked. */
  path: string;
}

/** The macOS mount point where Dropbox / Google Drive / iCloud publish their folders. */
export function cloudStorageDir(): string {
  return path.join(os.homedir(), "Library", "CloudStorage");
}

function isRealDir(p: string): boolean {
  try {
    // statSync (follows symlinks) — a placeholder/broken mount that isn't a real directory is skipped,
    // so an offline or half-removed iCloud/Drive mount never shows a dead row.
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover the cloud-storage mounts on this machine that should be surfaced at the top of the home
 * column. Enumerates ~/Library/CloudStorage/ and classifies each mount by its vendor-specific naming:
 *
 *   Dropbox                                   → Dropbox            (dropbox.mdx §3 — the CloudStorage mount)
 *   GoogleDrive-<email>                       → Google Drive — <email>  (google_drive.mdx §2 — one per account)
 *   iCloudDrive-<…>                           → iCloud Drive       (best-effort; skipped if not a real dir)
 *
 * Ordering is stable and vendor-grouped: Dropbox first, then each Google Drive account (alphabetical by
 * email so two accounts never swap places between calls), then iCloud. Only mounts that stat as a real
 * directory are returned. Detection is macOS-only (the CloudStorage convention is Apple's); on other
 * platforms this returns [] and the home column is unchanged.
 */
export function detectCloudRoots(): CloudRoot[] {
  if (process.platform !== "darwin") return [];

  const base = cloudStorageDir();
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return []; // no CloudStorage dir → no cloud mounts to surface
  }

  const dropbox: CloudRoot[] = [];
  const drive: CloudRoot[] = [];
  const icloud: CloudRoot[] = [];

  for (const name of names) {
    if (name.startsWith(".")) continue; // .DS_Store, .claude, etc.
    const abs = path.join(base, name);
    if (!isRealDir(abs)) continue;

    if (name === "Dropbox" || name.startsWith("Dropbox")) {
      // "Dropbox", "Dropbox (Personal)", "Dropbox (Company)" — keep the suffix so two Dropbox accounts
      // stay distinguishable, but present the bare "Dropbox" as-is.
      dropbox.push({ provider: "dropbox", label: name, path: abs });
    } else if (name.startsWith("GoogleDrive-")) {
      const account = name.slice("GoogleDrive-".length);
      drive.push({
        provider: "google_drive",
        label: account ? `Google Drive — ${account}` : "Google Drive",
        account: account || undefined,
        path: abs,
      });
    } else if (name.startsWith("iCloud")) {
      icloud.push({ provider: "icloud", label: "iCloud Drive", path: abs });
    }
  }

  drive.sort((a, b) => (a.account ?? "").localeCompare(b.account ?? ""));
  return [...dropbox, ...drive, ...icloud];
}
