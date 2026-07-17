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
//    `build/videos/x.mp4` copy (scan.mdx §4). We never pin generated output.
export const HARD_SKIP = new Set([
  // vcs / deps / os
  ".git",
  "node_modules",
  ".Trash",
  ".cache",
  "Caches",
  // cloud-backbone bookkeeping — Dropbox/Google-Drive metadata that must never be walked or pinned
  // (dropbox.mdx §4, google_drive.mdx §5). These are the vendors' own scratch dirs, not payload.
  ".dropbox",
  ".dropbox.cache",
  ".tmp.drivedownload",
  ".driveupload",
  // build outputs (generated — regenerated on demand, so never a pin candidate)
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

// macOS package/bundle directories are OPAQUE — a `.app`, `.framework`, `.bundle`, etc. is a single
// logical unit whose internal Resources (icons, .gif/.png assets, frameworks) are referenced BY NAME by
// the app. Descending in to compress those assets to .webp renames them and breaks the app; deleting the
// originals is unrecoverable. So we never walk into them — the same way Finder shows them as one item.
// (This is how a `compress inside ~/…` walk wandered into GlanceGuest.app and rewrote its framework
// resources.) Matched by extension on the directory name, since these are extension- not exact-name based.
const MAC_PACKAGE_EXT = new Set([
  ".app", ".framework", ".bundle", ".plugin", ".kext", ".xpc", ".prefpane", ".qlgenerator",
  ".mdimporter", ".component", ".dSYM", ".pkg", ".mpkg", ".appex", ".systemextension",
  // media / library packages that also hold many nested asset files as one opaque document
  ".photoslibrary", ".fcpbundle", ".imovielibrary", ".tvlibrary", ".aplibrary", ".migbundle",
  ".rtfd", ".scptd", ".download",
]);

/** True when `dirName` is a macOS package/bundle directory that must be treated as an opaque unit. */
export function isMacPackageDir(dirName: string): boolean {
  return MAC_PACKAGE_EXT.has(path.extname(dirName).toLowerCase());
}

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

/** True when `name` is a video / audio / image file — LFBridge's pin payload. */
export function isMediaFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext) || IMAGE_EXT.has(ext);
}

// Documents that are not media (no player, no IPFS payload) but ARE analysis targets — today just PDF, which
// the OCR tab reads by rasterizing each page (ocr.mdx §1.7.1). Kept SEPARATE from isMediaFile on purpose: a
// PDF must never be treated as pin payload or a compress candidate, only admitted for analysis (rule 5).
const PDF_EXT = new Set([".pdf"]);

/** True when `name` is a PDF — a non-media analysis candidate (OCR only). */
export function isPdfFile(name: string): boolean {
  return PDF_EXT.has(path.extname(name).toLowerCase());
}

/** True when `name` is something the analysis tabs can act on — media (transcribe / describe / OCR) OR a PDF
 *  (OCR only). This is the scanner's rule-5 admission predicate (scan.mdx §4.1 rule 5): a file at ANY size is
 *  a candidate so the analysis tabs can reach it, even below the large-file threshold. */
export function isAnalysisCandidate(name: string): boolean {
  return isMediaFile(name) || isPdfFile(name);
}
