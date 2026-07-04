// Media-kind classification shared by the frontend router (media_viewer.mdx) and any caller that
// must route a file to the right viewer BEFORE it has an EntityView (e.g. a File System cell click,
// which only knows the name). The backend keeps its own richer detection in badges.ts/media.ts; this
// is the lightweight, name-only discriminator both sides agree on.
import type { MediaKind } from "./types.js";

// Kept in step with backend badges.ts VIDEO_EXT / IMAGE_* sets. Videos are primary, images secondary
// (charter §Compression). ".ts" is intentionally NOT treated as video here — it collides with
// TypeScript source and would misroute code files; a real MPEG-TS opens fine on /file.
const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv",
]);
const IMAGE_EXT = new Set([
  ".png", ".bmp", ".tif", ".tiff", ".gif", ".jpg", ".jpeg", ".webp", ".heic", ".heif", ".avif",
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

/** "image" | "video" for a viewable medium, else null (→ the /file properties page). */
export function mediaKindForName(name: string): MediaKind | null {
  const ext = fileExt(name);
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

/** The viewer route for a name ("/image" | "/video"), else "/file". */
export function viewerRouteForName(name: string): "/image" | "/video" | "/file" {
  const kind = mediaKindForName(name);
  return kind === "image" ? "/image" : kind === "video" ? "/video" : "/file";
}
