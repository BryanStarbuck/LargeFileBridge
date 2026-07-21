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

/** Repo root, derived from this file's build location: <root>/cli/code/dist/bringup.js → three up. */
export function repoRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

function stateDir(): string {
  return process.env.LFB_STATE_DIR || path.join(os.homedir(), "T", "_large_files_bridge");
}

function haveJust(): boolean {
  return spawnSync("just", ["--version"], { stdio: "ignore" }).status === 0;
}

async function waitHealthy(totalMs: number): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await backendHealthy()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
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
    const r = spawnSync("just", ["run"], { cwd: root, stdio: ["ignore", 2, 2] });
    if (r.status !== 0) {
      process.stderr.write("`just run` failed — see output above.\n");
      return failWithLogTail();
    }
  } else {
    // No `just` on this machine: replicate the essentials. pnpm install (setup), then background
    // `pnpm dev` with output appended to the launcher log in the state root (never /tmp).
    const code = path.join(root, "code");
    const install = spawnSync("pnpm", ["install"], { cwd: code, stdio: ["ignore", 2, 2] });
    if (install.status !== 0) {
      process.stderr.write("pnpm install failed — cannot bring the app up.\n");
      return false;
    }
    fs.mkdirSync(stateDir(), { recursive: true });
    const logPath = path.join(stateDir(), "launcher.log");
    const out = fs.openSync(logPath, "a");
    const child = spawn("pnpm", ["dev"], { cwd: code, detached: true, stdio: ["ignore", out, out] });
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
