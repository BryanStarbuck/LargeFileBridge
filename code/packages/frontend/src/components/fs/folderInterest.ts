// Interesting-directory folder coloring (file_system.mdx §2/§3.2). Maps a directory's `interest` level
// to the folder glyph's outline (`color`/stroke) and `fill`, driven by the --lfb-fold-* CSS tokens. The
// single shared helper every folder glyph across the app uses so plain folders, the /fs column browser,
// and any other folder listing all read the same way.
//
// big   → brown         (dark-brown outline, light-brown fill)
// video → blue fill      (medium-dark-blue outline, very-light-blue near-white fill)
// image → blue outline   (blue outline, NO fill)
// null / undefined → keep the default glyph (no override) — a plain, uncolored folder.
import type { FolderInterest } from "@lfb/shared";

export interface FolderGlyphStyle {
  /** The glyph outline (lucide `<Folder>` stroke). Empty string = keep the caller's default. */
  color: string;
  /** The glyph fill. "none" = keep the caller's default (no fill override). */
  fill: string;
}

export function folderGlyphStyle(interest: FolderInterest | undefined): FolderGlyphStyle {
  switch (interest) {
    case "big":
      return { color: "var(--lfb-fold-big-line)", fill: "var(--lfb-fold-big-fill)" };
    case "video":
      return { color: "var(--lfb-fold-video-line)", fill: "var(--lfb-fold-video-fill)" };
    case "image":
      return { color: "var(--lfb-fold-image-line)", fill: "transparent" };
    default:
      // null (computed not-interesting) or undefined (not-yet-known) → no override; keep the plain glyph.
      return { color: "", fill: "none" };
  }
}

/** True when the interest value should override the default glyph styling (i.e. it is interesting). */
export function isInteresting(interest: FolderInterest | undefined): boolean {
  return interest === "big" || interest === "video" || interest === "image";
}
