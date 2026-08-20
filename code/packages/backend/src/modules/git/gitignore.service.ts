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
//   • NEVER emit a line that would ignore the SDL's travelling text (git_backbone.mdx §4.2.1) — refuse such
//     targets. TWO shapes: a `.lfbridge/` path (a working repo, or a not-yet-migrated SDL) and an SDL's ROOT
//     payload (`<sdl>/devices`, `<sdl>/storage.yaml`, …), since an SDL has no `.lfbridge/`
//     (artifact_placement_policy.mdx §0).
//   • Skip-already-ignored via `git check-ignore`, and drop a line already present in the .gitignore;
//     writing is append-only + idempotent (§5.4). The ONE removal carve-out is `unignorePaths()` — the
//     toggle's OFF direction — which deletes ONLY an exact anchored single-file line and verifies the
//     result, never a broad/pattern rule (§5.5).
//
// AND ONE WRITER WITH NO DIALOG BEHIND IT (§5.6): `ensureFilesIgnored()` — the ASSERT. It carries a decision
// the shared ledger ALREADY records onto a computer that never heard about it (a teammate's ⊘, a policy
// auto-decision taken on another machine). The charter's "never add a `.gitignore` entry automatically"
// governs the CHOOSING, which happened elsewhere; see that function's header for the bounds that make an
// unattended writer safe — recorded intent only, the anchored single-file line only, and nothing a rule
// already covers.
// Node fs only (no shell `find`) + the shared git helpers.
import fs from "node:fs";
import path from "node:path";
import type {
  GitIgnoreRequest,
  GitIgnorePlan,
  GitIgnoreRepoLines,
  GitIgnoreResult,
  UnignoreOutcome,
} from "@lfb/shared";
import { expandHome } from "../fs/badges.js";
import {
  nearestGitAtOrAbove,
  checkIgnore,
  checkIgnoreRules,
  checkIgnoreVerbose,
  listTrackedFiles,
} from "./git.service.js";
import { RESERVED_SDL_ROOT_NAMES, resolveStorageType, usesLfbridgeDir } from "../storage/storage-type.service.js";
import { relPosix, healWindowsPath, joinRelConfined } from "../../shared/rel-path.js";
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

/**
 * True when `abs` IS one of an SDL's own root payload entries (`<sdl>/devices`, `<sdl>/storage.yaml`, …) —
 * the post-`.lfbridge/` shape of the same "never ignore the SDL's travelling text" rule
 * (artifact_placement_policy.mdx §0, git_backbone.mdx §4.2.1). Ignoring one would make the user's computers
 * invisible to each other.
 *
 * Deliberately checks only the IMMEDIATE parent, not any ancestor: `devices` is reserved at an SDL ROOT, but
 * deeper down (or in a working repo) it is an ordinary user directory the user may legitimately ignore.
 */
function isSdlRootPayload(abs: string): boolean {
  const parent = path.dirname(abs);
  if (!RESERVED_SDL_ROOT_NAMES.has(path.basename(abs))) return false;
  return !usesLfbridgeDir(resolveStorageType(parent));
}

/** Repo-root-relative, POSIX-separated path (git .gitignore lines are always `/`-separated). */
function repoRel(repo: string, abs: string): string {
  return relPosix(repo, abs);
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
    // Defense-in-depth: never git-ignore the SDL's travelling text (git_backbone.mdx §4.2.1) — in either
    // layout: the legacy `.lfbridge/` tree, or an SDL's root payload now that it has no `.lfbridge/` (§0).
    // Refuse silently.
    if (isLfbridgePath(abs) || isSdlRootPayload(abs)) continue;
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

/** What {@link ensureFilesIgnored} did, for the caller's log line. */
export interface EnsureIgnoredResult {
  /** Anchored lines actually appended to `<repo>/.gitignore` this call. */
  written: number;
  /** Paths a rule already covered (an anchored line of ours, or anyone's broader rule) — nothing to do. */
  alreadyIgnored: number;
  /** Paths decided git-ignore but ALREADY TRACKED — a line cannot un-track them, so none was written. */
  tracked: number;
  /** Paths refused: outside the repo, or LFB's own travelling text (§5.3). */
  refused: number;
}

/**
 * ASSERT an ALREADY-RECORDED git-ignore decision on this computer's working tree
 * ([decisions.mdx §7](../../../../pm/decisions.mdx), "git-ignore axis → the working tree").
 *
 * This is NOT a second way to decide — it never chooses a file. Every path handed here is one the ledger
 * already carries as `gitignore: true`, i.e. a human (or the team's opt-in §9 policy) said so. The charter's
 * "never add a `.gitignore` entry automatically for anyone" governs the CHOOSING; carrying a choice that was
 * already made onto the computer it has not reached yet is the opposite of acting on our own.
 *
 * It exists because the axis used to be applied at exactly ONE instant — inside `recordDecision`, on the
 * machine where the click happened. A teammate's ⊘ decision travelling in over the sync repo, or a policy
 * auto-decision made on another computer, folded into this computer's ledger and then did nothing: the file
 * stayed committable here forever, and the pin pass would happily materialize its bytes into a working tree
 * that git was still offering to commit.
 *
 * Why not {@link planGitIgnore}: that engine serves the DIALOG, so it stats each target to shape a file vs.
 * directory line and drops whatever is not on disk. Here the paths are ledger keys — always FILES, and very
 * often NOT on disk yet (that is the whole point: the line must exist BEFORE the bytes land). So the line
 * shape is fixed (`/<rel>`, §5.2 FILE) and nothing is stat'd.
 *
 * Same content rules as the dialog engine otherwise: repo-root-relative and ANCHORED (§5.1), append-only and
 * idempotent (§5.4), never a line that would ignore LFB's own travelling text (§5.3), and a path that does
 * not land inside `repoRoot` is refused rather than written. Never throws.
 */
export function ensureFilesIgnored(repoRoot: string, relPaths: string[]): EnsureIgnoredResult {
  const out: EnsureIgnoredResult = { written: 0, alreadyIgnored: 0, tracked: 0, refused: 0 };
  if (relPaths.length === 0) return out;
  const root = path.resolve(expandHome(repoRoot));
  // The lines are anchored at `root`, so `root` must BE the repo — a registered path that sits inside some
  // other repo would get lines relative to the wrong root. Nothing to assert either way.
  if (nearestGitAtOrAbove(root) !== root) return out;

  // rel (a POSIX ledger key) → the absolute path git is asked about. De-duped: a ledger legitimately holds
  // the same file under a `\`- and a `/`-spelling (repo__list_syns.mdx §6.1a), which heal to one line.
  const byLine = new Map<string, { rel: string; abs: string }>();
  for (const raw of relPaths) {
    // NOT normalized beyond the `\` heal: a ledger key is relative BY CONTRACT (relPosix), so a leading
    // `/` means the key is wrong, not that it wants trimming. Stripping it would hand `joinRelConfined` a
    // relative path and defeat the very guard that refuses an absolute key from a merged ledger.
    const rel = healWindowsPath(String(raw ?? "").trim());
    if (!rel) continue;
    const abs = joinRelConfined(root, rel);
    if (!abs) {
      out.refused++; // `..`, absolute, or a drive letter — a merged ledger can carry any of them
      continue;
    }
    if (isLfbridgePath(abs) || isSdlRootPayload(abs)) {
      out.refused++; // never ignore the SDL's / the repo's travelling text (§5.3)
      continue;
    }
    byLine.set(`/${rel}`, { rel, abs });
  }
  if (byLine.size === 0) return out;

  // Cheap pass first: a line already IN the file needs no git at all. On a settled repo this is every
  // path, so the steady state costs one small read and no spawn.
  const existing = readGitignoreLineSet(root);
  for (const line of [...byLine.keys()]) {
    if (existing.has(line)) {
      byLine.delete(line);
      out.alreadyIgnored++;
    }
  }
  if (byLine.size === 0) return out;

  // Then ask git, ONCE, about the rest: anything a BROADER rule already covers (`*.mp4`, a folder rule,
  // someone else's) must not collect a redundant per-file line. `checkIgnoreRules` (`--no-index`) so a
  // file that is tracked DESPITE such a rule is also left alone — one more anchored line would not
  // un-track it, and the checked-in-big-file nudge (scan.mdx §4.2) is what surfaces that case.
  const covered = checkIgnoreRules(root, [...byLine.values()].map((v) => v.abs));
  const candidates: { line: string; rel: string }[] = [];
  for (const [line, v] of byLine) {
    if (covered.has(v.abs)) out.alreadyIgnored++;
    else candidates.push({ line, rel: v.rel });
  }
  if (candidates.length === 0) return out;

  // LAST, and only for what is still standing: a `.gitignore` line does NOTHING to a file that is already in
  // the index. Writing one anyway is the shape that ruins a shared `.gitignore` — measured on a real repo
  // here, 1,880 of 1,896 candidates were already tracked, so a naive assert would have appended 1,880 rules
  // that cannot fire, to a 128-line file, and pushed them to every teammate. What those files actually need
  // is `git rm --cached`, which is destructive ACROSS computers (a teammate's pull deletes their copy of a
  // file only IPFS still holds) and is therefore never ours to run. So: skip, count, and say so — the
  // checked-in-big-file triage (scan.mdx §4.2) is the surface that asks the user to resolve it.
  // UNKNOWN (null) proceeds: applying a recorded decision is this function's job, and a redundant line is a
  // far cheaper mistake than a big file left committable because one `ls-files` failed.
  const tracked = listTrackedFiles(root);
  const lines: string[] = [];
  for (const c of candidates) {
    if (tracked?.has(c.rel)) out.tracked++;
    else lines.push(c.line);
  }
  if (out.tracked > 0) {
    log.info(
      "git",
      `${root}: ${out.tracked} file(s) are decided git-ignore but are already tracked by git — no line ` +
        `written (a .gitignore rule cannot un-track a committed file; they need \`git rm --cached\`)`,
    );
  }
  if (lines.length === 0) return out;

  out.written = appendIgnoreLines(root, lines);
  if (out.written > 0) {
    log.info(
      "git",
      `${root}: asserted ${out.written} recorded git-ignore decision(s) into .gitignore ` +
        `(${out.alreadyIgnored} already covered, ${out.tracked} already tracked, ${out.refused} refused)`,
    );
  }
  return out;
}

/**
 * UN-IGNORE a set of paths — the OFF direction of the Add-to-git-ignore toggle (git_ignore.mdx §5.5).
 *
 * This is the ONE carve-out from §5.4's "LFB only ever adds lines". It is deliberately the narrowest
 * removal that can exist, because `.gitignore` has authors other than us:
 *
 *   • We remove ONLY a line that is EXACTLY the anchored single-file form `/<rel>` — the shape
 *     `linesForTarget()` writes for a file. Such a line matches exactly ONE file, so removing it cannot
 *     affect any other path. We therefore do not need to know whether WE wrote it: removing it does
 *     precisely what the user just asked and nothing more.
 *   • We REFUSE any broader rule (`**\/videos/**`, a bare `RT_1.mp4`, a directory rule). Rewriting one
 *     could un-ignore hundreds of files and let big bytes back into commits — the exact disaster this
 *     product exists to prevent. The refusal carries the rule so the UI can name it instead of no-op'ing.
 *   • We REFUSE a rule sourced outside the repo's root `.gitignore` (`.git/info/exclude`, a global ignore).
 *   • VERIFY-THEN-ROLLBACK: after removing, we re-ask `git check-ignore`. If the file is STILL ignored
 *     (another rule also covers it), the removal did not achieve what the user asked, so we put the line
 *     back and refuse. The `.gitignore` is never left in a state the user did not get a result from.
 *
 * Never throws: every path yields an outcome. Synchronous — it rewrites a few lines of text.
 */
export function unignorePaths(absPaths: string[]): UnignoreOutcome[] {
  const outcomes: UnignoreOutcome[] = [];
  // Group by owning repo so each repo needs only ONE verbose check-ignore call.
  const byRepo = new Map<string, string[]>();
  for (const raw of absPaths) {
    const abs = path.resolve(expandHome(raw.trim()));
    const repo = nearestGitAtOrAbove(abs);
    if (!repo) {
      outcomes.push({ path: abs, removed: false, refusal: "not-in-repo", rule: null });
      continue;
    }
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), abs]);
  }

  for (const [repo, list] of byRepo) {
    const rules = checkIgnoreVerbose(repo, list);
    for (const abs of list) {
      const rule = rules.get(abs) ?? null;
      if (!rule) {
        outcomes.push({ path: abs, removed: false, refusal: "not-ignored", rule: null });
        continue;
      }
      // The rule must live in THIS repo's root .gitignore — never touch an exclude file or a global ignore.
      if (path.resolve(repo, rule.source) !== path.join(repo, ".gitignore")) {
        outcomes.push({ path: abs, removed: false, refusal: "foreign-source", rule });
        continue;
      }
      // The rule must be the exact anchored single-file line. Anything broader is not ours to rewrite.
      const exact = `/${repoRel(repo, abs)}`;
      if (rule.pattern.trim() !== exact) {
        outcomes.push({ path: abs, removed: false, refusal: "pattern-rule", rule });
        continue;
      }
      const before = readFileOrNull(path.join(repo, ".gitignore"));
      if (before === null || !removeIgnoreLines(repo, [exact])) {
        outcomes.push({ path: abs, removed: false, refusal: "write-failed", rule });
        continue;
      }
      // VERIFY: did that actually un-ignore it, or does another rule still cover the file?
      const still = checkIgnoreVerbose(repo, [abs]).get(abs) ?? null;
      if (still) {
        restoreFile(path.join(repo, ".gitignore"), before); // ROLLBACK — the user got no result from the edit
        outcomes.push({ path: abs, removed: false, refusal: "still-ignored", rule: still });
        continue;
      }
      log.info("git", `${repo}: un-ignored ${repoRel(repo, abs)} (removed exact line '${exact}')`);
      outcomes.push({ path: abs, removed: true, rule: null });
    }
  }
  return outcomes;
}

/** Read a file's text, or null when it cannot be read (used to snapshot `.gitignore` for rollback). */
function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Put a snapshotted `.gitignore` back verbatim after a failed/ineffective removal. */
function restoreFile(p: string, body: string): void {
  try {
    fs.writeFileSync(p, body, "utf8");
  } catch (e) {
    log.warn("git", `could not roll back ${p}: ${(e as Error).message}`);
  }
}

/**
 * Drop every line whose trimmed text exactly equals one of `lines` from `<repo>/.gitignore`, preserving all
 * other content (comments, blank lines, ordering) byte-for-byte. Returns true when the file was rewritten.
 */
function removeIgnoreLines(repo: string, lines: string[]): boolean {
  const gi = path.join(repo, ".gitignore");
  const body = readFileOrNull(gi);
  if (body === null) return false;
  const drop = new Set(lines.map((l) => l.trim()));
  const kept = body.split("\n").filter((l) => !drop.has(l.trim()));
  if (kept.length === body.split("\n").length) return false; // nothing matched — do not rewrite
  try {
    fs.writeFileSync(gi, kept.join("\n"), "utf8");
    return true;
  } catch (e) {
    log.warn("git", `could not rewrite ${gi}: ${(e as Error).message}`);
    return false;
  }
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

// ── Legacy artifact-ignore HEALING (artifact_placement_policy.mdx §1.1.2) ─────────────────────────────
//
// Two since-deleted "nudge" writers (describe.service `ensureLfbridgeIgnored`, 2026-07-05→07-13, and the
// transcribe twin `ensureTranscribeIgnored`) appended these exact lines to a WORKING repo's root
// `.gitignore` back when derived artifacts were policy-ignored. The policy reversed — artifacts now live
// COMMITTED in `.lfbridge/` so they travel with the repo — but the lines those builds already wrote were
// never removed, so every artifact in an affected repo was invisible to git: written, readable locally,
// and permanently stranded on the machine that produced it (proven live on charlie-kirk, 2026-07-20:
// 158 `.ai_description` + 59 `.transcription` files, 0 tracked). `unignorePaths()` deliberately refuses
// pattern rules, so nothing else in the product could ever heal this. This is the working-repo twin of
// git.service `ensureSdlCommittable()` (which heals the same defect shape for SDL repos).
export const LEGACY_ARTIFACT_IGNORE_LINES: ReadonlySet<string> = new Set([
  ".lfbridge/",
  ".lfbridge",
  "/.lfbridge/",
  "/.lfbridge",
  "*.transcription",
  "*.ai_description",
]);

/** The legacy artifact-ignore lines currently present in a repo's root `.gitignore` (read-only probe —
 *  used by the debug export so a dump can NAME the poison without mutating anything). */
export function legacyArtifactIgnoreLines(repoRoot: string): string[] {
  try {
    const body = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    return body.split("\n").map((l) => l.trim()).filter((l) => LEGACY_ARTIFACT_IGNORE_LINES.has(l));
  } catch {
    return [];
  }
}

/**
 * Remove the legacy artifact-ignore lines from a WORKING repo's root `.gitignore` so the committed
 * `.lfbridge/` artifact tree can actually enter git. Scope is deliberately exact:
 *   • Only a WORKING repo (`usesLfbridgeDir` kind) with a `.git/` — SDL repos are healed by
 *     `ensureSdlCommittable()` on every backbone cycle and are not touched here.
 *   • Only lines whose trimmed text EXACTLY matches one of {@link LEGACY_ARTIFACT_IGNORE_LINES} — the
 *     shapes LFB's own deleted nudges wrote. Every other rule (the big-file byte ignores, the user's own
 *     rules) is preserved byte-for-byte.
 * Idempotent, never throws. Returns the removed lines (empty = nothing to heal).
 */
export function repairLegacyArtifactIgnores(repoRoot: string): string[] {
  try {
    const root = path.resolve(expandHome(repoRoot));
    if (!fs.existsSync(path.join(root, ".git"))) return [];
    if (!usesLfbridgeDir(resolveStorageType(root))) return []; // an SDL — ensureSdlCommittable's job
    const gi = path.join(root, ".gitignore");
    let body: string;
    try {
      body = fs.readFileSync(gi, "utf8");
    } catch {
      return []; // no .gitignore → nothing is ignoring the artifacts
    }
    const lines = body.split("\n");
    const removed = lines.map((l) => l.trim()).filter((l) => LEGACY_ARTIFACT_IGNORE_LINES.has(l));
    if (removed.length === 0) return [];
    const kept = lines.filter((l) => !LEGACY_ARTIFACT_IGNORE_LINES.has(l.trim()));
    fs.writeFileSync(gi, kept.join("\n"), "utf8");
    log.info(
      "git",
      `${root}: healed .gitignore — removed legacy artifact-ignore line(s) ${removed.map((l) => `'${l}'`).join(", ")} ` +
        `so the committed .lfbridge/ artifacts can travel (artifact_placement_policy.mdx §1.1.2)`,
    );
    return removed;
  } catch (e) {
    log.warn("git", `could not heal legacy artifact ignores in ${repoRoot}: ${(e as Error).message}`);
    return [];
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
