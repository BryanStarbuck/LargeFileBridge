// The ONE classifier for "special" files (special_files.mdx §1). Every other surface reads this instead of
// re-deriving media/large/pinned rules. It CONSOLIDATES the scattered signals — `isMediaFile` (the pin
// payload set), `mediaKindForName` (video/image/audio), the scan payload/threshold rule, `compressInfo`
// (the compress verdict), and the IPFS pinset — into one enum + one function, REUSING those classifiers so
// the vocabulary never drifts. Pure, metadata-cheap (no per-file decode): it reasons over a name, a size,
// and a few caller-supplied predicates.
import path from "node:path";
import { mediaKindForName } from "@lfb/shared";
import { isMediaFile } from "../../shared/scan-filters.js";
import { compressInfo } from "../fs/badges.js";

/** The unified special-file categories (special_files.mdx §1). NOT mutually exclusive — a git-ignored,
 *  pinned 4K clip is `large` AND `video` AND `ipfs_pinned` at once. */
export type SpecialCategory = "large" | "ipfs_pinned" | "video" | "image" | "audio";

export interface SpecialClass {
  isSpecial: boolean;
  categories: SpecialCategory[]; // every category that applies (not exclusive)
  compressible: boolean; // §2 — media that looks uncompressed (compression.mdx verdict)
  transcribable: boolean; // §3 — video (has an audio track) or audio
}

/** The one file the classifier reasons about — repo-relative path, name, size (bytes). Cheap: no decode. */
export interface SpecialFile {
  path: string; // repo-relative (the stable key even when the bytes are absent locally)
  name?: string; // basename; defaults from `path`
  size: number; // bytes, as last seen
}

/**
 * Repo-wide context the classifier needs. Carries the EFFECTIVE big-file threshold, the git-ignore state,
 * the forced-include (`include_globs`) state, and the IPFS pinset — the last three as cheap per-path
 * predicates so a whole-repo rollup keys them off Sets the caller builds once. All predicates are optional
 * (absent ⇒ "no", e.g. a repo with no gitignore, or a classification done before the pinset is known).
 */
export interface SpecialClassifyCtx {
  thresholdBytes: number;
  /** Is this repo-relative path git-ignored (a deliberate keep-out-of-git, LFBridge's whole domain)? */
  isGitIgnored?: (relPath: string) => boolean;
  /** Does this path match the repo's `include_globs` (a forced candidate regardless of size)? */
  isForced?: (relPath: string) => boolean;
  /** Is this path pinned on THIS computer's IPFS node — by us OR observed pinned outside us? */
  isPinned?: (relPath: string) => boolean;
}

/**
 * Classify one file as special or not, reusing the existing signals (special_files.mdx §1):
 *   • `large`        — the scan payload rule: git-ignored media of ANY size, OR any file at/above the
 *                      effective threshold, OR a forced `include_globs` match.
 *   • `ipfs_pinned`  — pinned on this computer's node (ours or observed outside us) — special even if small.
 *   • `video`/`image`/`audio` — the media kind (special regardless of size).
 * Plus two offer sub-flags: `compressible` (compression.mdx verdict — media that looks uncompressed) and
 * `transcribable` (video, because it carries audio, or audio).
 */
export function classifySpecial(file: SpecialFile, ctx: SpecialClassifyCtx): SpecialClass {
  const name = file.name ?? path.basename(file.path);
  const kind = mediaKindForName(name); // "video" | "image" | "audio" | null

  const categories: SpecialCategory[] = [];

  // `large` — the payload rule (scan.mdx §4.1): forced glob, OR git-ignored media at any size, OR
  // at/above the effective big-file threshold. `isMediaFile` matches the scanner's media-bypass exactly.
  const forced = ctx.isForced?.(file.path) ?? false;
  const gitIgnoredMedia = (ctx.isGitIgnored?.(file.path) ?? false) && isMediaFile(name);
  if (forced || gitIgnoredMedia || file.size >= ctx.thresholdBytes) categories.push("large");

  // `ipfs_pinned` — special even if small (a file pinned on the CLI is still ours to track).
  if (ctx.isPinned?.(file.path) ?? false) categories.push("ipfs_pinned");

  // media kind — special regardless of size.
  if (kind === "video") categories.push("video");
  else if (kind === "image") categories.push("image");
  else if (kind === "audio") categories.push("audio");

  // compressible: the compression.mdx verdict — media that "looks uncompressed" (compressState "should").
  // Reuses badges.compressInfo so the vocabulary never drifts (it covers video + lossless/convertible
  // images; audio is not a compressible kind there, per the charter's video-first/image-second scope).
  const compressible = compressInfo(name).compressState === "should";

  // transcribable: video (carries an audio track) or audio (Transcribe.mdx). Images are NOT transcribable.
  const transcribable = kind === "video" || kind === "audio";

  return { isSpecial: categories.length > 0, categories, compressible, transcribable };
}
