// Shared walk filters used by BOTH the discovery scan (scanner.service) and the File
// System browser badges (fs/badges). Keeping them in one place enforces the invariant
// stated in scan.mdx §4 and badges.ts: "the FS browser's hard-skip set MATCHES the
// scanner's hard-skip set." Change them here, once.
import path from "node:path";

// Directories we never descend into. Two groups:
//  * VCS / package / OS junk that is never payload.
//  * Build-output directories: generated, ephemeral, and (crucially) they DUPLICATE the
//    source media that already lives under the repo. Walking them made the scan report
//    the same movie twice — once from `static/videos/x.mp4` and once from the Docusaurus
//    `build/videos/x.mp4` copy (scan.mdx §4). We never sync generated output.
export const HARD_SKIP = new Set([
  // vcs / deps / os
  ".git",
  "node_modules",
  ".Trash",
  ".cache",
  "Caches",
  // build outputs (generated — regenerated on demand, so never a sync candidate)
  "build",
  "dist",
  "out",
  ".docusaurus",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "coverage",
]);

// Media extensions LFBridge exists to move: git-ignored video / audio / image files that
// were deliberately kept out of git to be bridged over IPFS (README charter). These are
// candidates REGARDLESS of the big-file size threshold — a 6 MB git-ignored .mp4 is still a
// large-file-bridge payload, not a checked-in text file. (The size threshold still gates
// NON-media git-ignored files so junk like .env / logs isn't swept in — scanner.service.)
//
// NB: `.ts` is intentionally OMITTED — as a git-ignored extension it is far more likely to
// be a TypeScript source file than an MPEG transport stream. Transport streams are rare;
// TypeScript false-positives are not.
const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv",
]);
const AUDIO_EXT = new Set([
  ".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif", ".wma",
]);
const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif",
]);

/** True when `name` is a video / audio / image file — LFBridge's sync payload. */
export function isMediaFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext) || IMAGE_EXT.has(ext);
}
