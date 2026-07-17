// Media-kind classification shared by the frontend router (media_viewer.mdx) and any caller that
// must route a file to the right viewer BEFORE it has an EntityView (e.g. a File System cell click,
// which only knows the name). The backend keeps its own richer detection in badges.ts/media.ts; this
// is the lightweight, name-only discriminator both sides agree on.
import type { MediaKind, FileType } from "./types.js";

// Kept in step with backend badges.ts VIDEO_EXT / IMAGE_* sets. Videos are primary, images secondary
// (charter §Compression). ".ts" is intentionally NOT treated as video here — it collides with
// TypeScript source and would misroute code files; a real MPEG-TS opens fine on /file.
const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv",
]);
const IMAGE_EXT = new Set([
  ".png", ".bmp", ".tif", ".tiff", ".gif", ".jpg", ".jpeg", ".webp", ".heic", ".heif", ".avif",
]);
// Audio media — the /audio player. Audio is NOT a compressible kind (charter: video 1st, image 2nd),
// so it never appears in the compress rollup; it only routes to its viewer here.
const AUDIO_EXT = new Set([
  ".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".oga", ".opus", ".aiff", ".aif", ".wma",
]);

/** Lowercased extension incl. the dot (".mp4"), or "" when the name has none. */
export function fileExt(name: string): string {
  // Isomorphic + untyped callers (File System cell clicks, JSON payloads) can hand us a non-string;
  // guard so we throw a clear reason instead of a cryptic "lastIndexOf is not a function".
  if (typeof name !== "string") {
    throw new Error(`fileExt: expected a string name, got ${typeof name}`);
  }
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

/** "image" | "video" | "audio" for a viewable/playable medium, else null (→ the /file properties page). */
export function mediaKindForName(name: string): MediaKind | null {
  const ext = fileExt(name);
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

/** The viewer route for a name ("/image" | "/video" | "/audio"), else "/file". */
export function viewerRouteForName(name: string): "/image" | "/video" | "/audio" | "/file" {
  const kind = mediaKindForName(name);
  return kind === "image" ? "/image" : kind === "video" ? "/video" : kind === "audio" ? "/audio" : "/file";
}

// PDFs are a distinct, filterable document class in the File-type facet (tables.mdx §2.10) — not media
// (no viewer, no analysis task today) but common enough that "show me just the PDFs" is a real intent.
const PDF_EXT = new Set([".pdf"]);

/**
 * The File-type facet value for a name (tables.mdx §2.10): image | video | audio | pdf | other.
 * A superset of `mediaKindForName()` — same video/image/audio families, plus `pdf` for `.pdf` and
 * `other` for everything else (source, docs, archives, data files). Name-only, isomorphic; the shared
 * discriminator the facet's accessor and the media viewer both agree on.
 */
export function fileTypeForName(name: string): FileType {
  const kind = mediaKindForName(name);
  if (kind) return kind; // image | video | audio
  if (PDF_EXT.has(fileExt(name))) return "pdf";
  return "other";
}
