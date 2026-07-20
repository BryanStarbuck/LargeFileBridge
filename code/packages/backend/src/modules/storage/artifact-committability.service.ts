// ARTIFACTS IN A WORKING REPO MUST BE COMMITTABLE (artifact_placement_policy.mdx §3 / Transcribe.mdx §3.1).
//
// The defect this module repeals (found live on charlie-kirk, 2026-07-20): the tower transcribed 59 files
// into `<repo>/.lfbridge/…/<name>.transcription` — the correct, COMMITTED tracking area — but the repo's
// own `.gitignore` had grown the lines `.lfbridge/`, `*.transcription`, `*.ai_description` (relics of the
// old beside-media placement era, when artifacts were nudged INTO .gitignore). Every committer in play —
// the user's auto-commit, `git add -A`, LFB's own SDL cycle — silently skips ignored paths, so all 59
// transcripts sat stranded on one computer forever while the laptop kept reporting them as still-to-do.
// `git status` was clean and the repo was 0 ahead, so nothing ever LOOKED wrong.
//
// The rule: `.lfbridge/` is LARGE FILE BRIDGE'S OWN quarantine directory inside a guest repo. Its contents
// are the product's whole reason for existing there, and the placement contract (locked) says they travel
// with the repo. So when an artifact we just wrote turns out to be gitignored, we repair the repo's
// `.gitignore` by APPENDING re-include (negation) rules for `.lfbridge/` — additive only, last-match-wins,
// never deleting or rewriting any rule the user wrote. This is deliberately NOT covered by the "never add a
// .gitignore entry automatically" nudging policy: that policy governs the USER'S media files; this governs
// LFB's own artifact directory, whose committability the product itself promised.
//
// Scope guard: only paths that contain a `/.lfbridge/` segment are ever considered — an SDL file repo has
// no `.lfbridge/` (artifact_placement_policy.mdx §0) and its artifacts are committed by its own pin cycle.
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { log } from "../../shared/logging.js";
import { LFBRIDGE_DIR } from "./tracking.service.js";

/** The additive re-include block appended to a repo's .gitignore when it blocks `.lfbridge/` artifacts.
 *  `!.lfbridge/` re-includes the directory itself (git cannot re-include files under an excluded dir),
 *  `!.lfbridge/**` re-includes its contents past any earlier glob like `*.transcription`. */
export const GITIGNORE_REINCLUDE_BLOCK = [
  "",
  "# Large File Bridge: transcripts / AI descriptions / OCR text under .lfbridge/ must travel with the repo.",
  "# These re-include rules override any ignore rule above them (e.g. \".lfbridge/\", \"*.transcription\").",
  "!.lfbridge/",
  "!.lfbridge/**",
].join("\n") + "\n";

/** Roots verified committable recently — one git spawn per repo per window, not per artifact in a batch. */
const verifiedOk = new Map<string, number>();
const VERIFY_TTL_MS = 5 * 60_000;

function run(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 15_000 }, (err, stdout) => {
      // execFile's err.code is the child's numeric exit code (or a string like "ENOENT" for spawn errors).
      const raw = err ? (err as NodeJS.ErrnoException).code ?? 1 : 0;
      resolve({ code: typeof raw === "number" ? raw : 1, stdout: stdout ?? "" });
    });
  });
}

/** The working-repo root for an artifact path, derived from its `/.lfbridge/` segment — null when the
 *  path is not inside a working repo's quarantine dir (SDL artifacts have no such segment). */
export function workingRepoRootForArtifact(absArtifactPath: string): string | null {
  const marker = path.sep + LFBRIDGE_DIR + path.sep;
  const i = absArtifactPath.indexOf(marker);
  if (i <= 0) return null;
  const root = absArtifactPath.slice(0, i);
  return fs.existsSync(path.join(root, ".git")) ? root : null;
}

/**
 * Ensure the artifact just written at `absArtifactPath` is COMMITTABLE — i.e. not silently excluded by the
 * repo's ignore rules, which would strand it on this computer forever (the charlie-kirk 59-transcript
 * defect). Best-effort and never throws: the artifact IS written; a failed repair is a durable-fault-trail
 * WARN, not a reason to fail the transcription the user is waiting on.
 *
 * Called from the single artifact-write choke point, sync-trigger.service.ts `noteArtifactWritten()`, so
 * transcribe / describe / ocr are all covered without touching their write paths.
 */
export async function ensureArtifactCommittable(absArtifactPath: string): Promise<void> {
  try {
    const root = workingRepoRootForArtifact(path.resolve(absArtifactPath));
    if (!root) return; // not a working-repo artifact — SDLs are handled by their own pin cycle.

    const now = Date.now();
    const okAt = verifiedOk.get(root);
    if (okAt && now - okAt < VERIFY_TTL_MS) return;

    const rel = path.relative(root, path.resolve(absArtifactPath));
    // exit 0 = ignored, 1 = not ignored, 128 = error (not a repo, etc.).
    const check = await run(root, ["check-ignore", "-q", "--", rel]);
    if (check.code === 1) {
      verifiedOk.set(root, now);
      return;
    }
    if (check.code !== 0) return; // git errored — nothing safe to conclude or repair.

    // Ignored → repair by APPENDING the re-include block (additive; user rules untouched).
    const gitignorePath = path.join(root, ".gitignore");
    const why = await run(root, ["check-ignore", "-v", "--", rel]);
    log.warn(
      "artifacts",
      `artifact is gitignored and would be stranded on this computer: ${absArtifactPath} ` +
        `(rule: ${why.stdout.trim() || "unknown"}) — appending .lfbridge/ re-include rules to ${gitignorePath}`,
    );
    await fs.promises.appendFile(gitignorePath, GITIGNORE_REINCLUDE_BLOCK, "utf8");

    const recheck = await run(root, ["check-ignore", "-q", "--", rel]);
    if (recheck.code === 1) {
      verifiedOk.set(root, now);
      log.info("artifacts", `repaired ${gitignorePath}: .lfbridge/ artifacts are committable again in ${root}`);
    } else {
      // A rule outside the repo's own .gitignore (core.excludesFile, .git/info/exclude) still blocks it —
      // we must not edit those, so report loudly instead.
      log.error(
        "artifacts",
        `artifact remains gitignored after .gitignore repair (rule outside the repo's .gitignore?): ` +
          `${absArtifactPath} — this file will NOT travel to your other computers until that rule is removed`,
      );
    }
  } catch (e) {
    log.warn("artifacts", `committability check failed for ${absArtifactPath}: ${(e as Error).message}`);
  }
}

// ── artifact health audit (debug.yaml `artifact_health`, pm/debug.mdx §7.1) ──────────────────────────

const ARTIFACT_EXTS = [".transcription", ".ai_description", ".ai_description_rejected", ".ocr"] as const;
const AUDIT_FILE_CAP = 20_000;
const UNTRACKED_LIST_CAP = 100;

export interface ArtifactHealth {
  tracking_base: string;
  artifacts_on_disk: number;
  by_ext: Record<string, number>;
  git_tracked: number;
  untracked: number;
  /** Up to UNTRACKED_LIST_CAP repo-relative artifact paths that exist on disk but are NOT in git — the
   *  exact files a second computer cannot see. */
  untracked_paths: string[];
  /** True when the repo's ignore rules would exclude a `.lfbridge/` artifact — the stranding condition. */
  gitignore_blocks_artifacts: boolean;
  /** `check-ignore -v` output for the probe (e.g. ".gitignore:29:.lfbridge/"), when blocking. */
  blocking_rule: string | null;
  /** Commits ahead of upstream (committed-but-unpushed), null when no upstream is configured. */
  unpushed_commits: number | null;
}

async function walkArtifacts(base: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [base];
  while (stack.length && out.length < AUDIT_FILE_CAP) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && ARTIFACT_EXTS.some((x) => e.name.endsWith(x))) out.push(p);
    }
  }
  return out;
}

/**
 * Audit whether a WORKING repo's `.lfbridge/` artifacts actually made it into git — the block that would
 * have made the charlie-kirk strand a one-line read in debug.yaml ("59 on disk, 0 tracked, blocked by
 * .gitignore:29:.lfbridge/"). Cheap: one directory walk + three git spawns per repo. Returns null when the
 * repo has no `.lfbridge/` yet (nothing to audit).
 */
export async function auditArtifactCommittability(root: string): Promise<ArtifactHealth | null> {
  const base = path.join(root, LFBRIDGE_DIR);
  if (!fs.existsSync(base) || !fs.existsSync(path.join(root, ".git"))) return null;

  const onDisk = await walkArtifacts(base);
  const byExt: Record<string, number> = {};
  for (const p of onDisk) {
    const ext = ARTIFACT_EXTS.find((x) => p.endsWith(x)) ?? "other";
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }

  const ls = await run(root, ["ls-files", "-z", "--", LFBRIDGE_DIR]);
  const tracked = new Set(ls.stdout.split("\0").filter(Boolean));
  const untrackedPaths = onDisk
    .map((p) => path.relative(root, p))
    .filter((rel) => !tracked.has(rel));

  // Probe with a path that need not exist — check-ignore evaluates rules, not the filesystem.
  const probe = path.join(LFBRIDGE_DIR, "__lfb_probe__", "probe.mp4.transcription");
  const probeRel = onDisk.length ? path.relative(root, onDisk[0]) : probe;
  const blocked = await run(root, ["check-ignore", "-v", "--", probeRel]);

  const ahead = await run(root, ["rev-list", "--count", "@{upstream}..HEAD"]);

  return {
    tracking_base: base,
    artifacts_on_disk: onDisk.length,
    by_ext: byExt,
    git_tracked: tracked.size,
    untracked: untrackedPaths.length,
    untracked_paths: untrackedPaths.slice(0, UNTRACKED_LIST_CAP),
    gitignore_blocks_artifacts: blocked.code === 0,
    blocking_rule: blocked.code === 0 ? blocked.stdout.trim().split("\t")[0] || null : null,
    unpushed_commits: ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) : null,
  };
}
