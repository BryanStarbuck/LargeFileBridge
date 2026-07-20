// The git binary, resolved ONCE to a stable ABSOLUTE path — the `stableNodeBin()` /
// `toolSearchPath()` class of hardening (schedule.service.ts, audio-prep.ts) applied to git.
//
// A background context (a launchd worker with no `EnvironmentVariables` block, or any future
// supervisor that starts the backend with a minimal environment) can have a PATH that omits the
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

/** Well-known git locations for a thin background PATH: the macOS system shim first (always present
 *  on a Mac), then Homebrew (Apple Silicon) and /usr/local (Intel brew / manual installs). */
const STANDARD_BIN_DIRS = ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"];

let cached: string | null = null;

/** Absolute path to the git binary (cached after the first call), or `"git"` if none was found. */
export function stableGitBin(): string {
  if (cached) return cached;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...STANDARD_BIN_DIRS].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "git");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cached = candidate;
      return cached;
    } catch {
      // absent or not executable — try the next directory
    }
  }
  cached = "git"; // let spawn do its own PATH search and report its own error
  return cached;
}
