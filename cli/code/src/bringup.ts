// Server bring-up — the CLI's justfile-equivalent duty (cli.mdx §2). If the backend is down, the
// CLI gets it up itself. It is NOT required to use the justfile — it must do the same things — but
// when `just` is installed we invoke the root justfile's `run` recipe, which IS the reference
// implementation (setup + repo-scoped stop + background start through the rotating log sink + port
// wait). Fallback replicates the essentials directly with pnpm. Either way we then gate on
// /api/health — never on the frontend port (FRONTEND UP ≠ APP UP).
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backendHealthy } from "./client";
import { Spinner } from "./progress";

/** Repo root, derived from this file's build location: <root>/cli/code/dist/bringup.js → three up. */
export function repoRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

function stateDir(): string {
  return process.env.LFB_STATE_DIR || path.join(os.homedir(), "T", "_large_files_bridge");
}

/**
 * Spawn a developer tool (`just`, `pnpm`) portably.
 *
 * On Windows `pnpm` is a `.cmd` shim, and a `.cmd` cannot be handed to CreateProcess — Node has REFUSED to
 * run one without a shell since 20.12 (CVE-2024-27980), so every call below failed with EINVAL there and
 * the CLI could not bring the app up on the one platform where it is most likely to be asked to. Going
 * through `cmd.exe` with `/s` (strip exactly the outer quote pair, run the rest verbatim) is the quoting
 * form that survives paths containing spaces. Kept in lockstep BY HAND with
 * `~/BGit/Bryan_git/LargeFileBridge/scripts/dev/proc.mjs` — `spawnTool()`, the authority; this package
 * compiles standalone and cannot import it.
 */
function toolCommand(name: string, args: string[]): { bin: string; argv: string[]; verbatim: boolean } {
  if (process.platform !== "win32") return { bin: name, argv: args, verbatim: false };
  const quoted = [name, ...args].map((a) => (/[\s&|<>^()"]/.test(a) ? `"${a}"` : a)).join(" ");
  return { bin: process.env.ComSpec || "cmd.exe", argv: ["/d", "/s", "/c", `"${quoted}"`], verbatim: true };
}

function haveJust(): boolean {
  const { bin, argv, verbatim } = toolCommand("just", ["--version"]);
  return spawnSync(bin, argv, { stdio: "ignore", windowsVerbatimArguments: verbatim, windowsHide: true }).status === 0;
}

async function waitHealthy(totalMs: number): Promise<boolean> {
  // The up-to-60 s health wait is exactly where a user would assume a hang — show the live
  // progress line while we poll (cli.mdx §4.7; TTY-gated, erased before any further output).
  const spinner = new Spinner();
  spinner.start("Waiting for the Large File Bridge backend (/api/health)…");
  try {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
      if (await backendHealthy()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  } finally {
    spinner.stop();
  }
}

/**
 * Ensure the backend is up, starting the app when it is not (cli.mdx §2 steps 1–3).
 * Returns true when /api/health answers; on failure prints the launcher-log tail and returns false.
 */
export async function ensureServerUp(): Promise<boolean> {
  if (await backendHealthy()) return true;
  const root = repoRoot();
  process.stderr.write(`Large File Bridge is not running — starting it (from ${root})…\n`);

  if (haveJust()) {
    // The reference path: the root justfile's `run` does setup, our-instance-only stop, the rotating
    // log sink, and its own port wait. Inherit stdio so its progress lands on the user's stderr.
    const just = toolCommand("just", ["run"]);
    const r = spawnSync(just.bin, just.argv, {
      cwd: root,
      stdio: ["ignore", 2, 2],
      windowsVerbatimArguments: just.verbatim,
      windowsHide: true,
    });
    if (r.status !== 0) {
      process.stderr.write("`just run` failed — see output above.\n");
      return failWithLogTail();
    }
  } else {
    // No `just` on this machine: replicate the essentials. pnpm install (setup), then background
    // `pnpm dev` with output appended to the launcher log in the state root (never /tmp).
    const code = path.join(root, "code");
    const pnpmInstall = toolCommand("pnpm", ["install"]);
    const install = spawnSync(pnpmInstall.bin, pnpmInstall.argv, {
      cwd: code,
      stdio: ["ignore", 2, 2],
      windowsVerbatimArguments: pnpmInstall.verbatim,
      windowsHide: true,
    });
    if (install.status !== 0) {
      process.stderr.write("pnpm install failed — cannot bring the app up.\n");
      return false;
    }
    fs.mkdirSync(stateDir(), { recursive: true });
    const logPath = path.join(stateDir(), "launcher.log");
    const out = fs.openSync(logPath, "a");
    const pnpmDev = toolCommand("pnpm", ["dev"]);
    const child = spawn(pnpmDev.bin, pnpmDev.argv, {
      cwd: code,
      detached: true,
      stdio: ["ignore", out, out],
      windowsVerbatimArguments: pnpmDev.verbatim,
      windowsHide: true,
    });
    child.unref();
    process.stderr.write(`Started \`pnpm dev\` in the background (logs: ${logPath}).\n`);
  }

  if (await waitHealthy(60_000)) return true;
  process.stderr.write("Timed out waiting for the backend to answer /api/health.\n");
  return failWithLogTail();
}

function failWithLogTail(): false {
  // The launcher log is the ONLY place a V8 OOM abort appears — show its tail so the failure names
  // its cause (cli.mdx §2 step 3).
  const logPath = path.join(stateDir(), "launcher.log");
  try {
    const lines = fs.readFileSync(logPath, "utf8").split("\n");
    process.stderr.write(`--- tail of ${logPath} ---\n${lines.slice(-30).join("\n")}\n`);
  } catch {
    process.stderr.write(`(no launcher log at ${logPath})\n`);
  }
  return false;
}
