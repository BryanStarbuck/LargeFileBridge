// The installed dependency tree, VERIFIED — because "Already up to date" is not the same claim as
// "the tree on disk works".
//
// WHY THIS FILE EXISTS. On 2026-08-05 `just run` failed on Windows like this:
//
//     pnpm -C "D:\IPFS\LargeFileBridge/code" install
//     Scope: all 4 workspace projects
//     Already up to date                        ← the install said the tree was complete
//     Done in 369ms using pnpm v11.13.0
//     Setup complete.
//     …
//     Error: Cannot find module 'D:\…\code\packages\frontend\node_modules\vite\bin\vite.js'
//
// pnpm decides "already up to date" from the manifests, the lockfile and `node_modules/.modules.yaml` —
// all of them plain files. It does NOT walk the tree. On Windows the package entries inside node_modules
// are JUNCTIONS, and a junction stores an ABSOLUTE path: move or copy the repo to another folder or drive
// — which is a normal thing to do to this repo, it travels between computers by design — and every one of
// them dangles, while the `.bin/*.CMD` shims (plain text, relative paths) survive and go on pointing at
// packages that are no longer reachable. That is exactly the failure above: the shim ran, its target was
// gone. macOS and Linux write RELATIVE symlinks, so a move is harmless there — this is a Windows trap.
//
// The same silent shape appears whenever node_modules and pnpm's bookkeeping disagree: a virtual store
// pruned by hand, a package quarantined by antivirus, a tree written by a different MAJOR of pnpm (the
// `packageManager` pin changing under it — this repo has had both 10.x and 11.x), a path over Windows'
// 260-char limit, an install cut short. The cause does not matter to the task runner. What matters is
// that it stops taking the claim on trust: it CHECKS the tree, REPAIRS it if it can, and if it cannot,
// names the packages that do not resolve — instead of letting `pnpm dev` die 30 seconds later inside a
// background launcher with a module-not-found stack trace nobody is watching.
import fs from "node:fs";
import path from "node:path";
import { isWindows, runTool } from "./proc.mjs";

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

/** Every project of a pnpm workspace: the root, plus each `packages/*` that has a manifest. */
export function projectsIn(root) {
  const projects = [];
  if (readJson(path.join(root, "package.json"))) projects.push(root);
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, "packages"), { withFileTypes: true });
  } catch {
    /* not a workspace — the root is the whole of it (cli/code) */
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, "packages", entry.name);
    if (readJson(path.join(dir, "package.json"))) projects.push(dir);
  }
  return projects;
}

/** The node_modules directories a from-scratch reinstall removes — one per project. */
export function moduleDirs(root) {
  return projectsIn(root).map((project) => path.join(project, "node_modules"));
}

/**
 * What is BROKEN about the installed tree under `root`, as a list of `{ project, name, reason }`.
 *
 * Two questions, both answered against the disk and not against pnpm's bookkeeping:
 *
 *   1. does every DIRECT dependency of every project resolve to a real package directory? pnpm's isolated
 *      node_modules links every direct dep into its own package's node_modules, so a plain `stat` of
 *      `<project>/node_modules/<dep>/package.json` is the whole test — and it FOLLOWS links, which is what
 *      makes a dangling junction (the Windows-move case) fail it;
 *   2. does every tool a project's own scripts invoke have a runnable shim in that project's
 *      `node_modules/.bin`? `vite`, `tsx`, `vitest` — the shim is what `pnpm dev` actually executes.
 *
 * Only bins the scripts NAME are checked, so a package that ships a bin nobody calls can never make this
 * report a false problem, and a manifest is read only for the handful of deps that are tools.
 */
export function treeProblems(root) {
  const problems = [];
  for (const project of projectsIn(root)) {
    const manifest = readJson(path.join(project, "package.json")) ?? {};
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    const tokens = new Set(
      Object.values(manifest.scripts ?? {})
        .join(" ")
        .split(/[\s"'&|]+/)
        .filter(Boolean),
    );
    for (const name of Object.keys(deps)) {
      const dir = path.join(project, "node_modules", ...name.split("/"));
      const manifestPath = path.join(dir, "package.json");
      if (!isFile(manifestPath)) {
        problems.push({ project, name, reason: unresolvedReason(dir) });
        continue;
      }
      const bare = name.replace(/^@[^/]+\//, "");
      if (!tokens.has(bare)) continue; // not a tool this project's scripts run — the package itself is enough
      const pkg = readJson(manifestPath) ?? {};
      const bins = typeof pkg.bin === "string" ? [bare] : Object.keys(pkg.bin ?? {});
      for (const bin of bins) {
        if (!tokens.has(bin) || hasShim(project, bin)) continue;
        problems.push({ project, name, reason: `no runnable node_modules/.bin/${bin}` });
      }
    }
  }
  return problems;
}

/** The problem list as lines a human can act on, relative to the workspace root. */
export function describeProblems(problems, root) {
  const width = Math.max(...problems.map((p) => label(p.project, root).length), 0);
  return problems.map((p) => `    ${label(p.project, root).padEnd(width)}  ${p.name} — ${p.reason}`);
}

/**
 * Install `root`, then PROVE the tree it produced resolves — and repair it when it does not.
 *
 * The ladder escalates only as far as it has to, and says what it is doing at each step, because every
 * step after the first costs the user real time:
 *
 *   1. `pnpm install` — the ordinary path, and on a healthy tree the only one that runs;
 *   2. `pnpm install --force` — pnpm's own documented remedy for a modules directory it cannot reconcile,
 *      including one written by a non-compatible pnpm MAJOR (this repo has had both 10.x and 11.x). It is
 *      seconds, and it is worth trying first — but measured against a tree with a link removed it says
 *      "Already up to date" and repairs nothing, which is why it is not the last rung;
 *   3. remove every node_modules and install from scratch — the rung that always works, and the only one
 *      that fixes links whose stored absolute paths point at where the repo used to live.
 *
 * Returns 0 when the tree resolves, non-zero when it still does not — and a non-zero return here FAILS
 * `just setup`, and with it `just run`. A broken tree that is reported at install time costs a minute; the
 * same tree discovered later costs a 30-second timeout against an app that was never going to start.
 */
export async function ensureInstalled(root, { label: what = root, beforeReinstall } = {}) {
  let forced = false;
  let code = await pnpmInstall(root, false);
  if (code !== 0) {
    out("");
    out(`${what}: pnpm install exited ${code} — retrying with --force …`);
    forced = true;
    code = await pnpmInstall(root, true);
    if (code !== 0) {
      reportUnfixable(what, treeProblems(root), root, `pnpm install exited ${code}`);
      return code;
    }
  }

  let problems = treeProblems(root);
  if (!problems.length) return 0;

  out("");
  out(`${what}: pnpm reported the install was complete, but the tree on disk does not resolve:`);
  for (const line of describeProblems(problems, root).slice(0, 12)) out(line);
  if (problems.length > 12) out(`    …and ${problems.length - 12} more`);

  if (!forced) {
    out("");
    out("Repairing — pnpm install --force …");
    await pnpmInstall(root, true);
    problems = treeProblems(root);
    if (!problems.length) {
      out("✓ Repaired: the dependency tree resolves again.");
      return 0;
    }
  }

  out("");
  out("Still unresolved. Removing node_modules and installing from scratch …");
  if (beforeReinstall) await beforeReinstall();
  for (const dir of moduleDirs(root)) removeDir(dir);
  await pnpmInstall(root, false);
  problems = treeProblems(root);
  if (!problems.length) {
    out("✓ Repaired: the dependency tree resolves again.");
    return 0;
  }

  reportUnfixable(what, problems, root, "the tree still does not resolve after a from-scratch reinstall");
  return 1;
}

// ── internals ───────────────────────────────────────────────────────────────────────────────────────

function pnpmInstall(root, force) {
  return runTool("pnpm", force ? ["-C", root, "install", "--force"] : ["-C", root, "install"]);
}

/**
 * WHY a dep did not resolve — the distinction is the diagnosis. "link points nowhere" is the signature of
 * a repo that moved after its install; "not installed" is a tree that was never (or only partly) built.
 */
function unresolvedReason(dir) {
  let link;
  try {
    link = fs.lstatSync(dir);
  } catch {
    return "not installed";
  }
  if (!link.isSymbolicLink()) return "no package.json in it";
  let target = "";
  try {
    target = fs.readlinkSync(dir);
  } catch {
    /* unreadable reparse point — the arrow is a nicety, not the finding */
  }
  return `link points nowhere${target ? ` (→ ${target})` : ""}`;
}

/** Is there a runnable shim for this bin? Windows gets three of them per bin; POSIX gets one symlink. */
function hasShim(project, bin) {
  const dir = path.join(project, "node_modules", ".bin");
  const names = isWindows ? [bin, `${bin}.cmd`, `${bin}.exe`, `${bin}.ps1`] : [bin];
  // statSync, not lstatSync: a .bin entry that is itself a dangling symlink is not runnable either.
  return names.some((name) => isFile(path.join(dir, name)));
}

function removeDir(dir) {
  try {
    // maxRetries is for Windows: a file that antivirus or a just-stopped process still holds answers
    // EBUSY/EPERM once and is gone a moment later.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    err(`could not remove ${dir}: ${e?.message || e}`);
  }
}

function reportUnfixable(what, problems, root, why) {
  err("");
  err("  ============================================================================");
  err(`   ***  ${what.toUpperCase()}: DEPENDENCIES ARE NOT INSTALLED — IT CANNOT START.  ***`);
  err("  ============================================================================");
  err(`  ${why}.`);
  if (problems.length) {
    err("");
    err("  Does not resolve:");
    for (const line of describeProblems(problems, root).slice(0, 20)) err(line);
    if (problems.length > 20) err(`    …and ${problems.length - 20} more`);
  }
  err("");
  err("  Known causes, most common first:");
  if (isWindows) {
    err("    · the repo was MOVED or copied after installing — on Windows pnpm's package links are");
    err("      junctions holding ABSOLUTE paths, so every one of them dangles at the new location;");
    err("    · antivirus quarantined files under node_modules — exclude this repo from real-time scanning;");
    err("    · a path over 260 chars — enable long paths (LongPathsEnabled=1) or move the repo nearer the");
    err("      drive root;");
  } else {
    err("    · an install that was interrupted, or a node_modules edited by hand;");
  }
  err("    · a pnpm store that is gone or unreadable — `pnpm store path`, then `pnpm store prune`.");
  err("");
  err("  Next:  just clean     (removes node_modules and the run state)");
  err("         just setup     (installs again from scratch)");
  err("");
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function label(project, root) {
  return path.relative(root, project) || ".";
}
