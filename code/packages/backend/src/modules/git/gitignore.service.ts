// The Git Ignore ENGINE (git_ignore.mdx §5) — plan-then-write behind the "Git ignore" pop-over dialog.
// The whole product bet is that git handles the small text and IPFS carries the big bytes (charter), so
// the big files must be git-ignored to keep them out of commits. This engine turns a target set (checked
// files/dirs, or one directory) into ANCHORED, repo-root-relative `.gitignore` lines and — only on an
// explicit Apply — appends them to each owning repo's root `.gitignore` (append-only, idempotent).
//
// LOCKED rules honored here (git_ignore.mdx §5):
//   • Anchored, repo-root-relative lines (leading `/`) — never a bare, un-anchored name (§5.1).
//   • FILE → `/<rel>`; DIR recursive ON → `/<rel>/`; DIR recursive OFF → `/<rel>/*` + `!/<rel>/*/` (§5.2).
//   • Each target's owning repo = nearestGitAtOrAbove; a selection may span several repos, each getting
//     its own `.gitignore`; a path in NO repo is excluded and counted (§5.3).
//   • NEVER emit a line that would ignore a `.lfbridge/` path (git_sync.mdx §4.2.1) — refuse such targets.
//   • Skip-already-ignored via `git check-ignore`, and drop a line already present in the .gitignore;
//     writing is append-only + idempotent, LFB only ever ADDS lines (§5.4).
// Node fs only (no shell `find`) + the shared git helpers.
import fs from "node:fs";
import path from "node:path";
import type { GitIgnoreRequest, GitIgnorePlan, GitIgnoreRepoLines, GitIgnoreResult } from "@lfb/shared";
import { expandHome } from "../fs/badges.js";
import { nearestGitAtOrAbove, checkIgnore } from "./git.service.js";
import { log } from "../../shared/logging.js";

/** One classified target: an existing file/dir, its owning repo, and its repo-root-relative POSIX path. */
interface Target {
  abs: string;
  isDir: boolean;
  repo: string; // owning repo root (absolute)
  rel: string; // POSIX, repo-root-relative ("" when the target IS the repo root)
}

/** A path is "under .lfbridge/" if any path segment is exactly `.lfbridge` — that text is never ignored. */
function isLfbridgePath(abs: string): boolean {
  return abs.split(path.sep).includes(".lfbridge");
}

/** Repo-root-relative, POSIX-separated path (git .gitignore lines are always `/`-separated). */
function repoRel(repo: string, abs: string): string {
  return path.relative(repo, abs).split(path.sep).join("/");
}

/** The anchored .gitignore line(s) for one target (git_ignore.mdx §5.2). */
function linesForTarget(t: Target, recursive: boolean): string[] {
  if (!t.isDir) return [`/${t.rel}`]; // FILE — one exact, anchored line (Recursive never applies)
  if (t.rel === "") {
    // The target IS the repo root (the repo `⋮` "ignore this whole tree" case, §4). Anchor at root.
    return recursive ? ["/*"] : ["/*", "!/*/"];
  }
  const base = `/${t.rel}`;
  return recursive ? [`${base}/`] : [`${base}/*`, `!${base}/*/`];
}

/** Resolve the target path list: the checked `paths`, else the single `root`; neither is a 400 (§6). */
function resolveTargets(req: GitIgnoreRequest): string[] {
  if (req.paths && req.paths.length > 0) {
    return req.paths.map((p) => path.resolve(expandHome(p.trim())));
  }
  if (req.root && req.root.trim()) return [path.resolve(expandHome(req.root.trim()))];
  throw new Error("git-ignore requires either paths[] (the checked set) or root (a single directory)");
}

/**
 * Plan the `.gitignore` lines for a target set (git_ignore.mdx §5). Classifies each target as file/dir,
 * finds its owning repo, builds anchored repo-relative lines, drops targets git already ignores and lines
 * already present, refuses `.lfbridge/` paths, and groups the survivors by owning repo. `files`/`dirs`
 * count the ORIGINAL (stat-able) target set so the dialog can shape itself even for dropped targets.
 */
export function planGitIgnore(req: GitIgnoreRequest): GitIgnorePlan {
  const targets = resolveTargets(req);
  const recursive = !!req.recursive;

  let files = 0;
  let dirs = 0;
  let notInRepo = 0;
  const classified: Target[] = [];

  for (const abs of targets) {
    // Defense-in-depth: never git-ignore the `.lfbridge/` SDL text (git_sync.mdx §4.2.1). Refuse silently.
    if (isLfbridgePath(abs)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // a target that no longer exists can't be classified — skip it
    }
    const isDir = st.isDirectory();
    if (isDir) dirs++;
    else files++;
    const repo = nearestGitAtOrAbove(abs);
    if (!repo) {
      notInRepo++; // git-ignore only means something inside a repo (§5.3) — excluded
      continue;
    }
    classified.push({ abs, isDir, repo, rel: repoRel(repo, abs) });
  }

  // Group by owning repo so each repo's own `.gitignore` gets its own block (§5.3).
  const byRepo = new Map<string, Target[]>();
  for (const t of classified) {
    const list = byRepo.get(t.repo) ?? [];
    list.push(t);
    byRepo.set(t.repo, list);
  }

  let alreadyIgnored = 0;
  const linesByRepo: GitIgnoreRepoLines[] = [];

  for (const [repo, list] of byRepo) {
    // Skip-already-ignored: ONE `git check-ignore` for this repo's targets (§5.4).
    const ignored = checkIgnore(repo, list.map((t) => t.abs));
    // Lines already present in the repo's current .gitignore are also dropped (idempotent).
    const existing = readGitignoreLineSet(repo);
    const seen = new Set<string>(); // de-dup within this repo (two dir targets → overlapping negations)
    const lines: string[] = [];
    for (const t of list) {
      if (ignored.has(t.abs)) {
        alreadyIgnored++;
        continue;
      }
      for (const line of linesForTarget(t, recursive)) {
        if (existing.has(line) || seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
      }
    }
    if (lines.length > 0) {
      linesByRepo.push({ repo, repoName: path.basename(repo), lines });
    }
  }

  return { files, dirs, linesByRepo, alreadyIgnored, notInRepo };
}

/**
 * Apply a git-ignore (git_ignore.mdx §5.4/§6). Re-plans on the server (authoritative), then APPENDS the
 * planned lines into each owning repo's root `.gitignore` — append-only, idempotent, preserving a trailing
 * newline (mirrors describe.service `ensureLfbridgeIgnored`). Synchronous: it writes a few lines of text.
 */
export function applyGitIgnore(req: GitIgnoreRequest): GitIgnoreResult {
  const plan = planGitIgnore(req);
  let written = 0;
  let repos = 0;
  for (const group of plan.linesByRepo) {
    const wrote = appendIgnoreLines(group.repo, group.lines);
    if (wrote > 0) {
      written += wrote;
      repos++;
    }
  }
  log.info(
    "git",
    `git-ignore apply: wrote ${written} line(s) across ${repos} repo(s) ` +
      `(${plan.alreadyIgnored} already ignored, ${plan.notInRepo} not in a repo)`,
  );
  return { written, repos, alreadyIgnored: plan.alreadyIgnored, notInRepo: plan.notInRepo };
}

/** The set of trimmed, non-empty lines already in a repo's root `.gitignore` (for the skip-existing test). */
function readGitignoreLineSet(repo: string): Set<string> {
  try {
    const body = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
    return new Set(body.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set(); // no .gitignore yet → nothing present
  }
}

/**
 * Append the given lines to `<repo>/.gitignore`, skipping any already present (append-only + idempotent,
 * git_ignore.mdx §5.4). Preserves a trailing newline. Returns how many lines were actually written.
 */
function appendIgnoreLines(repo: string, lines: string[]): number {
  const gi = path.join(repo, ".gitignore");
  let body = "";
  try {
    body = fs.readFileSync(gi, "utf8");
  } catch {
    /* none yet — we'll create it */
  }
  const existing = new Set(body.split("\n").map((l) => l.trim()).filter(Boolean));
  const toAdd = lines.filter((l) => !existing.has(l.trim()));
  if (toAdd.length === 0) return 0;
  const prefix = body && !body.endsWith("\n") ? `${body}\n` : body;
  try {
    fs.writeFileSync(gi, `${prefix}${toAdd.join("\n")}\n`, "utf8");
  } catch (e) {
    log.warn("git", `could not append to ${gi}: ${(e as Error).message}`);
    return 0;
  }
  return toAdd.length;
}
