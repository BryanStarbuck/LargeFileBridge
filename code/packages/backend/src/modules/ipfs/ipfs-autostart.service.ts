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
import type { IpfsAutostartStatus } from "@lfb/shared";
import { updateAppConfig } from "../store-model/config.service.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { log, rotateIfOversized } from "../../shared/logging.js";

const run = promisify(execFile);

// Fixed LaunchAgent label — sibling to com.largefilebridge.{scan,sync} (schedule.service.ts).
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
  <key>KeepAlive</key><false/>
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

/** Is the LaunchAgent loaded in launchd (so it WILL run at the next reboot/login)? */
async function isLoaded(): Promise<boolean> {
  try {
    await run("launchctl", ["print", domainTarget()]);
    return true;
  } catch {
    return false;
  }
}

/** Current auto-start posture: OS support, plist on disk, and whether it's loaded/enabled. */
export async function autostartStatus(): Promise<IpfsAutostartStatus> {
  if (!supported()) return { supported: false, installed: false, enabled: false };
  let installed = false;
  try {
    installed = fs.existsSync(agentPath());
  } catch {
    installed = false;
  }
  const enabled = installed ? await isLoaded() : false;
  return { supported: true, installed, enabled };
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
