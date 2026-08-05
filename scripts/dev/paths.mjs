// Every path and port the task runner needs, resolved ONCE and identically on macOS, Linux and Windows.
//
// WHY THIS FILE EXISTS. The justfile used to compute these itself, in `just` expressions evaluated by
// bash: `home_directory() + "/T/_large_files_bridge"`, a literal `/tmp/lfb.web.port`, `/opt/homebrew/bin/node`.
// Every one of those is a macOS answer. On Windows `/tmp/lfb.web.port` is `<current drive>:\tmp\…`, a
// directory that does not exist, so the run→port handshake had nowhere to land; on Linux the Homebrew
// paths are simply absent. Resolving them in Node instead means one answer per machine, and the same
// answer for the justfile, the launcher, the CLI and the app.
//
// The state root MUST stay in lockstep with the app's own resolver —
// `code/packages/backend/src/config/state-dir.ts` `resolveStateDir()` — which is why the fallback here is
// `os.tmpdir()` and not a literal `/tmp` (see the note there). Kept by hand, like
// `code/deploy/launchd/run-worker.mjs` `stateDir()`, because this file has to stay dependency-free: the
// justfile runs it with bare `node`, before `pnpm install` has necessarily ever run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
export const codeDir = path.join(repoRoot, "code");
export const cliDir = path.join(repoRoot, "cli");
export const backendDir = path.join(codeDir, "packages", "backend");
export const frontendDir = path.join(codeDir, "packages", "frontend");
export const scriptsDir = path.join(repoRoot, "scripts");
export const devDir = path.join(scriptsDir, "dev");

/** The dependency-free rotating stdout sink (5 MiB × 5) the launcher pipes the dev tree through. */
export const logPipe = path.join(scriptsDir, "log_rotate_pipe.mjs");

/** OpenAuthFederated — the auth library both packages consume via `link:` deps (@auth/backend, @auth/react). */
export const authLib = path.resolve(repoRoot, "..", "OpenAuthFederated");
export const authRepo = "https://github.com/BryanStarbuck/OpenAuthFederated.git";

/** The app's local storage / state root — `$LFB_STATE_DIR`, else `~/T/_large_files_bridge`. */
export function stateDir() {
  const dir =
    process.env.LFB_STATE_DIR ||
    safeJoin(os.homedir(), "T", "_large_files_bridge") ||
    path.join(os.tmpdir(), "_large_files_bridge");
  ensureDir(dir);
  return dir;
}

/**
 * Runtime scratch (pid/port). NOT logs — these are ephemeral handoff files, cleared on reboot so a stale
 * pidfile never lingers, which is why they stay out of the state root (CLAUDE.md logging policy).
 *
 * `/tmp` is kept verbatim on macOS and Linux so nothing about those machines changes. Windows has no
 * `/tmp`: Node resolves it to `<drive>:\tmp`, and `just run` would then wait 30s for a port file that
 * Vite had written somewhere else entirely. `os.tmpdir()` is that platform's real answer
 * (`C:\Users\<user>\AppData\Local\Temp`), and it is cleared by the OS on the same terms.
 */
export function runtimeDir() {
  return process.env.LFB_RUNTIME_DIR || (process.platform === "win32" ? os.tmpdir() : "/tmp");
}

export const portFile = () => path.join(runtimeDir(), "lfb.web.port");
export const pidFile = () => path.join(runtimeDir(), "lfb.webapp.pid");

// ── logs (all under the state root, all rotating 5 MiB × 5) ─────────────────────────────────────────

export const launcherLog = () => path.join(stateDir(), "launcher.log");
export const appLog = () => path.join(stateDir(), "log.log");
export const errorLog = () => path.join(stateDir(), "error.err");
export const txnLog = () => path.join(stateDir(), "transactions.log");
export const bootOutLog = () => path.join(stateDir(), "boot.out.log");
export const bootErrLog = () => path.join(stateDir(), "boot.err.log");

// ── ports ───────────────────────────────────────────────────────────────────────────────────────────

/** The API port. Overridable so the task runner agrees with the app when BE_PORT is set. */
export function bePort() {
  return numOr(process.env.BE_PORT, 8787);
}

/** The web app's DEFAULT port. The port actually taken is resolved on boot (web-port.mjs) and published
 *  to `portFile()` — always prefer `recordedWebPort()`, which reads that. */
export function fePort() {
  return numOr(process.env.FE_PORT ?? process.env.WEB_PORT, 2222);
}

/** The web port Vite last resolved, or the default when nothing has been recorded yet. */
export function recordedWebPort() {
  try {
    const p = Number(fs.readFileSync(portFile(), "utf8").trim());
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    // never started, or the file was cleared on reboot — the default is the right answer
  }
  return fePort();
}

// ── background-worker labels (schedule.service.ts `labelFor`) ───────────────────────────────────────

export const workerLabels = {
  scan: "com.largefilebridge.scan",
  pin: "com.largefilebridge.pin",
  device: "com.largefilebridge.device",
};

/** The autostart agent for the WEB APP itself (`just boot on`) — a different agent from scan/pin/device. */
export const bootLabel = "com.largefilebridge.webapp";

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort: never crash because a dir couldn't be made (storage.mdx §1)
  }
}

function safeJoin(...parts) {
  try {
    return path.join(...parts);
  } catch {
    return null;
  }
}

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
