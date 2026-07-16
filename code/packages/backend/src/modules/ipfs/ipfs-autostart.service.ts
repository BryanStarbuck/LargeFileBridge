// IPFS AUTO-START-ON-REBOOT (ipfs_ui.mdx §13). Backs the IPFS-off page's primary "Turn On IPFS +
// keep it on across reboots" button. On macOS we install a per-user launchd LaunchAgent
// (com.largefilebridge.ipfs) that runs `ipfs daemon --enable-gc` at login/boot, so the node comes
// back on its own after the machine restarts — the exact problem the user hit ("I rebooted; IPFS
// isn't running").
//
// Design choices:
//   * RunAtLoad = true, KeepAlive = FALSE. We want "start once at reboot/login", NOT "relaunch
//     whenever it exits" — otherwise the app's own On/Off toggle (which stops the daemon) would be
//     fought by launchd instantly restarting it. With KeepAlive off, a deliberate stop stays stopped
//     until the next login.
//   * We resolve the ABSOLUTE `ipfs` path (launchd has no user shell PATH) and pin a conservative
//     PATH so brew/`/usr/local` installs both work.
//   * Non-macOS: unsupported for now — status reports supported:false and the UI hides the option.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IpfsAutostartConflict, IpfsAutostartStatus } from "@lfb/shared";
import { updateAppConfig } from "../store-model/config.service.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { log, rotateIfOversized } from "../../shared/logging.js";

const run = promisify(execFile);

// Fixed LaunchAgent label — sibling to com.largefilebridge.{scan,pin} (schedule.service.ts).
export const IPFS_AUTOSTART_LABEL = "com.largefilebridge.ipfs";

function supported(): boolean {
  return process.platform === "darwin";
}

function uid(): number {
  return process.getuid?.() ?? 501;
}

function agentPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${IPFS_AUTOSTART_LABEL}.plist`);
}

function domainTarget(): string {
  return `gui/${uid()}/${IPFS_AUTOSTART_LABEL}`;
}

/** Resolve the absolute path to the `ipfs` binary — launchd has no login PATH, so we must be explicit. */
async function resolveIpfsBin(): Promise<string | null> {
  try {
    const { stdout } = await run("command", ["-v", "ipfs"], { shell: "/bin/bash" });
    const p = stdout.trim().split("\n")[0]?.trim();
    return p && path.isAbsolute(p) ? p : null;
  } catch {
    return null;
  }
}

function renderPlist(ipfsBin: string): string {
  const stateRoot = resolveStateDir();
  const outPath = path.join(stateRoot, "ipfs-autostart.log");
  const errPath = path.join(stateRoot, "ipfs-autostart.err");
  const ipfsPath = path.join(os.homedir(), ".ipfs");
  // A conservative PATH covering Apple-silicon brew (/opt/homebrew), Intel brew (/usr/local), and system.
  const envPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${IPFS_AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ipfsBin}</string>
    <string>daemon</string>
    <string>--enable-gc</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${envPath}</string>
    <key>IPFS_PATH</key><string>${ipfsPath}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Retry ONLY a failed start, never a clean one. A deliberate Off (\`ipfs shutdown\`) exits 0, so
       launchd leaves it stopped — the On/Off toggle still wins, which is why KeepAlive was false.
       But a start that FAILS (exit 1: repo.lock held, home dir not yet mounted, slow disk at boot)
       used to stay dead until the next reboot. SuccessfulExit:false retries just that case. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${outPath}</string>
  <key>StandardErrorPath</key><string>${errPath}</string>
</dict>
</plist>
`;
}

async function launchctl(...args: string[]): Promise<void> {
  try {
    await run("launchctl", args);
  } catch (e) {
    // launchctl is chatty and returns non-zero for benign cases (already loaded / not loaded); log soft.
    log.warn("ipfs", `launchctl ${args.join(" ")}: ${(e as Error).message}`);
  }
}

/**
 * Read launchd's view of our agent. `launchctl print` SUCCEEDING only proves the job is REGISTERED —
 * it says nothing about whether it ran or died. Reading it as "enabled" was the bug behind the exact
 * contradiction the user reported: the IPFS page said "Start on reboot: on ✓" while the job sat at
 * `state = not running, last exit code = 1` after losing the repo-lock race (ipfs_ui.mdx §13.1).
 * So we parse the fields that carry the truth.
 */
interface LaunchdView {
  loaded: boolean;
  running: boolean;
  lastExitCode: number | null;
}

async function readLaunchd(): Promise<LaunchdView> {
  let stdout: string;
  try {
    ({ stdout } = await run("launchctl", ["print", domainTarget()]));
  } catch {
    return { loaded: false, running: false, lastExitCode: null };
  }
  // `state = running` / `state = not running`; `last exit code = 1` / `= (never exited)`.
  const state = /^\s*state\s*=\s*(.+)$/m.exec(stdout)?.[1]?.trim() ?? "";
  const exitRaw = /^\s*last exit code\s*=\s*(.+)$/m.exec(stdout)?.[1]?.trim() ?? "";
  const exitNum = Number.parseInt(exitRaw, 10);
  return {
    loaded: true,
    running: state === "running",
    lastExitCode: Number.isNaN(exitNum) ? null : exitNum,
  };
}

/** Has the user disabled the job? A disabled job is registered but will NOT run at boot. */
async function isDisabled(): Promise<boolean> {
  try {
    const { stdout } = await run("launchctl", ["print-disabled", `gui/${uid()}`]);
    return new RegExp(`"${IPFS_AUTOSTART_LABEL}"\\s*=>\\s*disabled`).test(stdout);
  } catch {
    return false;
  }
}

/** The daemon's own last words, so a failure names its real cause instead of a shrug. */
function readFailureReason(): string | null {
  try {
    const errPath = path.join(resolveStateDir(), "ipfs-autostart.err");
    const size = fs.statSync(errPath).size;
    const start = Math.max(0, size - 8192); // last 8 KiB is plenty; never slurp the whole (rotating) file
    const fd = fs.openSync(errPath, "r");
    try {
      const buf = Buffer.allocUnsafe(size - start);
      const read = fs.readSync(fd, buf, 0, size - start, start);
      const lines = buf
        .subarray(0, read)
        .toString("utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return lines.at(-1) ?? null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Find a FOREIGN launchd job that also runs `ipfs daemon` — overwhelmingly `brew services start kubo`
 * (homebrew.mxcl.kubo). Both agents fire at login, race for ~/.ipfs/repo.lock, and the loser exits 1
 * forever (KeepAlive is off). Installing a second agent alongside one of these is the bug, not the fix
 * (ipfs_ui.mdx §13.2), so we detect it rather than compete with it.
 */
async function findConflict(): Promise<IpfsAutostartConflict | null> {
  const dirs = [
    path.join(os.homedir(), "Library", "LaunchAgents"),
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
  ];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // dir may not exist / not be readable — never fatal to a status read
    }
    for (const name of entries) {
      if (!name.endsWith(".plist")) continue;
      const label = name.slice(0, -".plist".length);
      if (label === IPFS_AUTOSTART_LABEL) continue; // ours
      const file = path.join(dir, name);
      let body: string;
      try {
        body = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      // Only a job that actually launches an ipfs daemon competes for the repo lock.
      if (!/<string>[^<]*\bipfs\b<\/string>/.test(body) || !/<string>daemon<\/string>/.test(body)) continue;
      let running = false;
      try {
        const { stdout } = await run("launchctl", ["print", `gui/${uid()}/${label}`]);
        running = /^\s*state\s*=\s*running\s*$/m.test(stdout);
      } catch {
        running = false;
      }
      return {
        label,
        source: label.startsWith("homebrew.mxcl.") ? "Homebrew (brew services)" : label,
        path: file,
        running,
      };
    }
  }
  return null;
}

/**
 * Current auto-start posture: OS support, plist on disk, whether launchd will really run it, and
 * whether it actually WORKED last boot. `enabled` is now "registered AND not disabled"; it is no
 * longer allowed to imply success — `lastRunFailed` carries that, so the UI can stop claiming "on ✓"
 * for a dead agent.
 */
export async function autostartStatus(): Promise<IpfsAutostartStatus> {
  if (!supported()) {
    return {
      supported: false,
      installed: false,
      enabled: false,
      lastExitCode: null,
      lastRunFailed: false,
      failureReason: null,
      conflict: null,
    };
  }
  let installed = false;
  try {
    installed = fs.existsSync(agentPath());
  } catch {
    installed = false;
  }
  const view = installed ? await readLaunchd() : { loaded: false, running: false, lastExitCode: null };
  const enabled = view.loaded && !(await isDisabled());
  // Failed = it ran and exited non-zero, and isn't up right now. (A daemon we deliberately stopped
  // exits 0, so a clean Off is never reported as a failure.)
  const lastRunFailed = enabled && !view.running && view.lastExitCode !== null && view.lastExitCode !== 0;
  return {
    supported: true,
    installed,
    enabled,
    lastExitCode: view.lastExitCode,
    lastRunFailed,
    failureReason: lastRunFailed ? readFailureReason() : null,
    conflict: await findConflict(),
  };
}

/**
 * Install (or refresh) the reboot auto-start LaunchAgent and load it. Idempotent: re-writing the plist
 * and re-bootstrapping is safe. Records the intent in app-config (ipfs.auto_start_daemon) so the
 * preference is visible even before the OS state is re-read. Throws only on truly fatal setup errors
 * (can't find `ipfs`, can't write the plist) — launchctl quirks are logged, not fatal.
 */
export async function installAutostart(): Promise<IpfsAutostartStatus> {
  if (!supported()) {
    throw new Error("Auto-start on reboot isn't available on this operating system yet.");
  }
  const ipfsBin = await resolveIpfsBin();
  if (!ipfsBin) {
    throw new Error("Couldn't find the `ipfs` binary to auto-start. Install IPFS first.");
  }
  // Refuse to become the second agent racing for the repo lock (ipfs_ui.mdx §13.2). Something else
  // already starts IPFS at login; adding our own is what produced "auto-start says on, IPFS is off" —
  // the loser of the race exits 1 and, with KeepAlive off, never retries. Adopt instead of compete.
  const conflict = await findConflict();
  if (conflict) {
    log.warn(
      "ipfs",
      `not installing IPFS auto-start: ${conflict.label} (${conflict.source}) already auto-starts a daemon at ${conflict.path}`,
    );
    await persistIntent(true); // the user's intent — "keep IPFS on" — IS satisfied, just not by our agent
    return autostartStatus();
  }
  const file = agentPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderPlist(ipfsBin));
    log.info("ipfs", `Installed IPFS auto-start LaunchAgent ${file} -> ${ipfsBin}`);
  } catch (e) {
    log.error("ipfs", `Failed to write IPFS auto-start plist ${file}: ${(e as Error).message}`);
    throw e;
  }
  // launchd holds the daemon's StandardOut/Err fds for its whole lifetime (no per-write cap), but
  // bootout below closes them and bootstrap reopens fresh ones. Roll these now if they're at/over the
  // 5 MiB cap so the relaunched daemon reopens onto empty files (same 5 MiB × 5 policy as every LFB log).
  const stateRoot = resolveStateDir();
  rotateIfOversized(path.join(stateRoot, "ipfs-autostart.log"));
  rotateIfOversized(path.join(stateRoot, "ipfs-autostart.err"));

  // Re-bootstrap: bootout any stale copy first so bootstrap picks up the new plist, then enable.
  await launchctl("bootout", domainTarget());
  await launchctl("bootstrap", `gui/${uid()}`, file);
  await launchctl("enable", domainTarget());

  await persistIntent(true);
  return autostartStatus();
}

/** Remove the reboot auto-start LaunchAgent (unload + delete). Leaves a running daemon running. */
export async function removeAutostart(): Promise<IpfsAutostartStatus> {
  if (supported()) {
    await launchctl("bootout", domainTarget());
    try {
      fs.unlinkSync(agentPath());
      log.info("ipfs", `Removed IPFS auto-start LaunchAgent ${agentPath()}`);
    } catch {
      /* already gone */
    }
  }
  await persistIntent(false);
  return autostartStatus();
}

async function persistIntent(on: boolean): Promise<void> {
  try {
    await updateAppConfig((c) => {
      c.ipfs.auto_start_daemon = on;
      return c;
    });
  } catch (e) {
    log.warn("ipfs", `persist auto_start_daemon=${on} failed: ${(e as Error).message}`);
  }
}
