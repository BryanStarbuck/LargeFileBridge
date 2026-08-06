// The git binary, resolved ONCE to a stable ABSOLUTE path — the `stableNodeBin()` /
// `toolSearchPath()` class of hardening (schedule.service.ts, audio-prep.ts) applied to git.
//
// A background context (a launchd worker with no `EnvironmentVariables` block, a Windows scheduled task, or
// any future supervisor that starts the backend with a minimal environment) can have a PATH that omits the
// directory git lives in, and then EVERY bare `spawn("git", …)` fails with `spawnSync git ENOENT`.
// Resolving to an absolute path up front makes every git spawn immune to the caller's PATH.
//
// Search order: the CURRENT process PATH first (an already-correct interactive PATH wins, and a
// user-preferred git — e.g. Homebrew's — stays preferred), then the well-known install locations.
// Nothing found → fall back to the bare name `"git"` so spawn's own PATH search and error message
// take over (identical to the old behavior). Leaf module: node builtins only, importable from
// anywhere (git.service, storage.service, migrations) without a cycle.
import fs from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

/**
 * The FILENAME to look for. On Windows this is the whole reason git was never found: every candidate was
 * built as `path.join(dir, "git")`, and the file is `git.exe`. The fallback then handed `"git"` to spawn,
 * which happens to work only while git is on the process PATH — i.e. exactly not in the background context
 * this module exists to survive.
 *
 * Only `.exe` is considered, never `git.cmd`: Node refuses to spawn `.cmd`/`.bat` without `shell: true`
 * (CVE-2024-27980), so resolving to one would trade a missing binary for an unspawnable one.
 */
const GIT_FILENAME = isWindows ? "git.exe" : "git";

/** Well-known git locations for a thin background PATH. */
const STANDARD_BIN_DIRS = isWindows ? windowsGitDirs() : ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Where Git for Windows actually installs: the per-machine 64-bit and 32-bit Program Files trees and the
 * per-user install (`winget install Git.Git` with no elevation). `cmd\git.exe` is the wrapper Git for
 * Windows intends non-shell callers to use; `bin\git.exe` is listed after it as the fallback for layouts
 * that lack `cmd\`. Env vars are read rather than hard-coded so a machine whose Windows lives on D: works.
 */
function windowsGitDirs(): string[] {
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : undefined,
  ].filter((r): r is string => !!r);
  const dirs: string[] = [];
  for (const root of roots) {
    dirs.push(path.join(root, "Git", "cmd"), path.join(root, "Git", "bin"), path.join(root, "Git", "mingw64", "bin"));
  }
  return dirs;
}

let cached: string | null = null;

/** Absolute path to the git binary (cached after the first call), or `"git"` if none was found. */
export function stableGitBin(): string {
  if (cached) return cached;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...STANDARD_BIN_DIRS].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, GIT_FILENAME);
    try {
      // X_OK has no meaning on Windows (node treats it as F_OK); ask for what each OS can actually answer.
      fs.accessSync(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
      cached = candidate;
      return cached;
    } catch {
      // absent or not executable — try the next directory
    }
  }
  cached = "git"; // let spawn do its own PATH search and report its own error
  return cached;
}

/**
 * Would `simple-git` ACCEPT this path as its custom `binary`?
 *
 * simple-git validates the value against `/^([a-z]:)?([a-z0-9/.\\_~-]+)$/i` and THROWS out of the factory
 * when it doesn't match — no spaces, no parentheses (`custom-binary.plugin.ts`, `isBadArgument`). That
 * rejects the standard Git for Windows install, `C:\Program Files\Git\cmd\git.exe`, so on Windows EVERY
 * `openRepo()` threw before running a single command and the entire git backbone — device registration,
 * pull, commit, push — failed on every cycle with
 *
 *   [pin] device registration for storage c140b1a11690 failed: Invalid value supplied for custom binary,
 *   restricted characters must be removed or supply the unsafe.allowUnsafeCustomBinary option
 *
 * (the 2026-08-06 Windows report). The direct `execFileSync(stableGitBin(), …)` callers were unaffected —
 * Node's spawn takes a spaced path happily — which is why only the simple-git paths broke.
 *
 * Kept deliberately CONSERVATIVE and in step with simple-git's own rule: answering "no" costs nothing (the
 * caller falls back to the bare name plus {@link withGitOnPath}, which resolves to the very same file),
 * while answering "yes" wrongly is what throws. When in doubt this must say no.
 */
export function isSimpleGitSafeBinary(bin: string): boolean {
  return /^([a-z]:)?([a-z0-9/\\._~-]+)$/i.test(bin);
}

/**
 * Put the directory holding the resolved git binary at the FRONT of `env`'s PATH, so a bare `git` spawned
 * with this environment finds the SAME file {@link stableGitBin} picked. That is this module's whole
 * promise — immunity to a thin background PATH — delivered through a door simple-git will open.
 *
 * No-op when git was never resolved to an absolute path (`"git"`): `path.dirname("git")` is `"."`, and
 * putting the working directory on a child's PATH is not something to do by accident.
 *
 * Windows spells the variable `Path`, and spreading `process.env` into a plain object keeps that spelling —
 * so this UPDATES whichever key is already there instead of adding a second one the child would have to
 * choose between.
 */
export function withGitOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bin = stableGitBin();
  if (!path.isAbsolute(bin)) return env;
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const dir = path.dirname(bin);
  const existing = env[key];
  return { ...env, [key]: existing ? `${dir}${path.delimiter}${existing}` : dir };
}

/** TEST-ONLY: drop the memoized result so a spec can exercise resolution under a different environment. */
export function resetGitBinCache(): void {
  cached = null;
}
