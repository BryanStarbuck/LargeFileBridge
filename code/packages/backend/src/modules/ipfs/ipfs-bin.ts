// The `ipfs` (Kubo) binary, resolved ONCE to a stable ABSOLUTE path — the exact hardening `git-bin.ts`
// applies to git, applied to the other external binary this product cannot run without.
//
// WHY IT EXISTS. Every `ipfs` invocation was a BARE name: `spawn("ipfs", ["daemon", …])`, `ipfs init`,
// `ipfs version --number`, and a `command -v ipfs` probe run through `/bin/bash`. All four resolve through
// the CALLER's PATH, and the contexts this app is designed to run in are precisely the ones with a thin
// PATH: a launchd worker with no `EnvironmentVariables` block, a Windows scheduled task, a systemd user
// unit. There the daemon start fails with `spawn ipfs ENOENT` and the probe answers "IPFS isn't installed
// on this computer" for a machine that has it — the node never comes up and the UI blames the user.
//
// On Windows it was worse than a PATH problem: the file is `ipfs.exe`, and `/bin/bash` does not exist at
// all, so the install probe threw on every call and IPFS was permanently reported as not installed.
//
// Search order mirrors git-bin.ts: the CURRENT process PATH first (an already-correct interactive PATH
// wins, and a user-preferred build stays preferred), then the well-known install locations for each
// platform's usual installers. Nothing found → the bare name `"ipfs"`, so spawn's own PATH search and
// error message take over (identical to the old behavior). Leaf module: node builtins only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";

/** `ipfs.exe` on Windows — the whole reason a `path.join(dir, "ipfs")` probe never found it there. */
const IPFS_FILENAME = isWindows ? "ipfs.exe" : "ipfs";

/** Where the usual installers actually put Kubo, per platform. */
function standardBinDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const roots = [
      process.env.ProgramW6432,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ].filter((r): r is string => !!r);
    const dirs = roots.flatMap((r) => [path.join(r, "Kubo"), path.join(r, "ipfs")]);
    if (process.env.LOCALAPPDATA) {
      // winget drops a shim here and installs the package under WinGet\Packages\IPFS.Kubo_…
      dirs.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
      dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "Kubo"));
    }
    dirs.push(path.join(home, "go", "bin"));
    return dirs;
  }
  return [
    "/opt/homebrew/bin", // Apple-silicon Homebrew
    "/usr/local/bin", // Intel Homebrew + Kubo's own install.sh
    "/usr/bin",
    "/bin",
    "/snap/bin", // `sudo snap install ipfs` — the command we print on Linux
    path.join(home, ".local", "bin"),
    path.join(home, "go", "bin"),
  ];
}

let cached: string | null = null;

/** Absolute path to the `ipfs` binary (cached after the first call), or `"ipfs"` if none was found. */
export function stableIpfsBin(): string {
  if (cached) return cached;
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...standardBinDirs()].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, IPFS_FILENAME);
    try {
      // X_OK has no meaning on Windows (node treats it as F_OK); ask each OS what it can answer.
      fs.accessSync(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
      cached = candidate;
      return cached;
    } catch {
      // absent or not executable — try the next directory
    }
  }
  cached = "ipfs"; // let spawn do its own PATH search and report its own error
  return cached;
}

/**
 * Did we RESOLVE a real binary, as opposed to falling back to the bare name? This is the honest
 * "is IPFS installed?" probe: it needs no subprocess, no shell, and works identically on all three
 * platforms — unlike the `command -v ipfs` through `/bin/bash` it replaces.
 */
export function ipfsBinResolved(): boolean {
  return path.isAbsolute(stableIpfsBin());
}

/**
 * Drop the memoized result. Called after an install/upgrade job runs a package manager: the binary that
 * did not exist when we first looked exists now, and a cached `"ipfs"` would otherwise make the very next
 * "did the install work?" check answer no.
 */
export function resetIpfsBinCache(): void {
  cached = null;
}
