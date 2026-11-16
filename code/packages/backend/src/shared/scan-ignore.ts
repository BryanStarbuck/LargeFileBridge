// `scanner.ignore_globs` — ONE reading of the user's ignore list, for every walk that honours it
// (scan.mdx §2.2: the globs apply "before either test").
//
// WHY THIS EXISTS (2026-11-16, tower slowdown — ~/BGit/all/film/bryan/why_slow.txt). Two defects let the
// ACT3 monorepo (~/BGit/all, 259k files) keep costing us after the user put it in `ignore_globs`:
//
//   1. The globs speak GITIGNORE, matched against a path RELATIVE TO THE SCANNER ROOT. The natural way to
//      write "ignore this tree" in config.yaml is its absolute path — `/Users/bryan/BGit/all/**` — and in
//      gitignore grammar a leading `/` means "anchored at the root", so that pattern asked for
//      `<root>/Users/bryan/BGit/all/**` and matched NOTHING. Silently: the watcher kept firing on every
//      file event under the tree. {@link rootRelativeGlobs} rewrites an absolute (or `~/`) glob that lies
//      under the root into the root-anchored form (`/all/**`), and drops one that lies outside it (it can
//      never match anything this root walks). Root-relative globs — `**/node_modules/**`, `/build/` — are
//      passed through untouched, so every existing config keeps its meaning.
//
//   2. Only the live watcher read the globs. Repo DISCOVERY (scanner.service.ts `findGitRepos`) and the
//      scheduled per-unit scan ignored them entirely, so an ignored tree was still discovered, registered
//      and walked. Both now ask {@link makeScanIgnore} / {@link isScanIgnored}.
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import { relPosix } from "./rel-path.js";

const IGNORE_PROBE_RESET = 200_000; // `ignore` caches every path it is asked about and never evicts

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Rewrite `globs` so they mean what the user wrote when matched against paths RELATIVE TO `root`.
 *
 * * `~/x/**` and `/abs/path/**` that lie under `root` → `/rel/path/**` (gitignore: anchored at the root).
 * * an absolute glob outside `root` → dropped (it cannot match anything under this root).
 * * anything else (`**\/node_modules/**`, `/build/`, `*.tmp`) → unchanged.
 * * a leading `!` (negation) is preserved on whichever form results.
 *
 * "Absolute" is decided by the path, not the slash: a leading-`/` pattern is only read as a FILESYSTEM path
 * when it reaches into the home directory or a system prefix (`/Users/…`, `/home/…`, `/Volumes/…`). A
 * short root-anchored gitignore pattern the user already wrote (`/build/`) keeps its old meaning.
 */
export function rootRelativeGlobs(root: string, globs: readonly string[]): string[] {
  const absRoot = path.resolve(root);
  const out: string[] = [];
  for (const raw of globs) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const neg = trimmed.startsWith("!");
    const body = expandTilde(neg ? trimmed.slice(1) : trimmed);
    const bang = neg ? "!" : "";
    if (!path.isAbsolute(body) || !looksLikeFilesystemPath(body)) {
      out.push(trimmed);
      continue;
    }
    // Split the literal directory prefix from the first wildcard segment, so `/a/b/**` → prefix `/a/b`.
    const segs = body.split("/");
    const firstWild = segs.findIndex((s) => /[*?[\]]/.test(s));
    const prefix = (firstWild === -1 ? segs : segs.slice(0, firstWild)).join("/") || "/";
    const rest = firstWild === -1 ? "" : segs.slice(firstWild).join("/");
    const absPrefix = path.resolve(prefix);
    if (absPrefix === absRoot) {
      out.push(`${bang}${rest === "" ? "/**" : `/${rest}`}`);
      continue;
    }
    if (absPrefix.startsWith(absRoot + path.sep)) {
      const rel = relPosix(absRoot, absPrefix);
      const trailingSlash = firstWild === -1 && body.endsWith("/") ? "/" : "";
      out.push(`${bang}/${rel}${rest === "" ? trailingSlash : `/${rest}`}`);
      continue;
    }
    // Absolute and outside this root: nothing under the root can match it. Drop it for THIS root only.
  }
  return out;
}

/** An absolute glob is a FILESYSTEM path (rather than a root-anchored gitignore pattern like `/build/`)
 *  when it reaches into the home directory or an absolute system prefix — i.e. it has at least two literal
 *  leading segments that exist as an absolute location shape (`/Users/...`, `/home/...`, `/Volumes/...`). */
function looksLikeFilesystemPath(body: string): boolean {
  const home = os.homedir();
  if (body === home || body.startsWith(home + path.sep)) return true;
  return /^\/(Users|home|Volumes|mnt|media|opt|private|tmp|var|srv|data)\//.test(body);
}

export interface ScanIgnore {
  /** Is this DIRECTORY (absolute path) excluded whole — never walked, watched or discovered into? */
  dirIgnored(abs: string): boolean;
  /** Is this path (absolute) excluded? */
  pathIgnored(abs: string): boolean;
}

/** The ignore predicate for one scanner root. Paths outside `root` are never "ignored" by it. */
export function makeScanIgnore(root: string, globs: readonly string[]): ScanIgnore {
  const absRoot = path.resolve(root);
  const patterns = rootRelativeGlobs(absRoot, globs);
  const active = patterns.length > 0;
  const hasNegation = patterns.some((g) => g.startsWith("!"));
  let ig = ignore().add(patterns);
  let probes = 0;
  const ignores = (r: string): boolean => {
    if (!active) return false;
    if ((probes += 1) > IGNORE_PROBE_RESET) {
      ig = ignore().add(patterns);
      probes = 0;
    }
    return ig.ignores(r);
  };
  const rel = (abs: string): string | null => {
    const r = relPosix(absRoot, path.resolve(abs));
    return r === "" || r === ".." || r.startsWith("../") || path.isAbsolute(r) ? null : r;
  };
  // Same three probes as scanner.service.ts `dirIsExcluded`: gitignore spells "this whole directory" as
  // `foo`, `foo/`, or `foo/**`, and `ignores()` is literal about each. The `/**` probe is only sound when no
  // pattern re-includes something beneath (a negation), or pruning would hide it.
  const dirIgnored = (abs: string): boolean => {
    const r = rel(abs);
    if (r === null) return false;
    return ignores(r) || ignores(`${r}/`) || (!hasNegation && ignores(`${r}/.lfb-prune-probe`));
  };
  return {
    dirIgnored,
    pathIgnored: (abs) => {
      const r = rel(abs);
      return r !== null && ignores(r);
    },
  };
}

/**
 * Does `scanner.ignore_globs` exclude the directory `abs` under ANY of the scanner roots? Used by the
 * scheduled scan to skip a registered unit whose whole tree the user ignored. Cheap: the globs are a
 * handful of patterns and the matcher is rebuilt per call (callers ask once per unit per scan).
 */
export function isScanIgnored(abs: string, roots: readonly string[], globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  return roots.some((root) => makeScanIgnore(root, globs).dirIgnored(abs));
}
