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
import type { IpfsAutostartConflict, IpfsAutostartOwner, IpfsAutostartStatus } from "@lfb/shared";
import { updateAppConfig } from "../store-model/config.service.js";
import { stableIpfsBin, ipfsBinResolved } from "./ipfs-bin.js";
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

/**
 * Resolve the absolute path to the `ipfs` binary — launchd has no login PATH, so we must be explicit.
 * The shared resolver (ipfs-bin.ts) answers first and needs no subprocess; the `command -v` probe stays as
 * a fallback for an install in a directory the resolver's list doesn't know about but the user's shell does.
 */
async function resolveIpfsBin(): Promise<string | null> {
  if (ipfsBinResolved()) return stableIpfsBin();
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
async function isDisabled(label = IPFS_AUTOSTART_LABEL, domain = `gui/${uid()}`): Promise<boolean> {
  try {
    const { stdout } = await run("launchctl", ["print-disabled", domain]);
    return new RegExp(`"${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=>\\s*disabled`).test(stdout);
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

/** A plist as JSON via plutil (a real parser: binary plists, entities, whitespace). Null if it can't. */
async function readPlistJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", file]);
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extract a plist's ProgramArguments as a string[] — the ONLY key that says what a job actually
 * executes. Prefer plutil; fall back to a regex scoped to the ProgramArguments <array> block if plutil
 * is missing or the file is malformed.
 */
function readProgramArguments(plist: Record<string, unknown> | null, body: string): string[] {
  if (plist) {
    const args = plist.ProgramArguments;
    if (Array.isArray(args)) return args.filter((a): a is string => typeof a === "string");
    return [];
  }
  // Scoped fallback: only the <array> that immediately follows <key>ProgramArguments</key>.
  const block = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(body)?.[1];
  if (!block) return [];
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1].trim());
}

/**
 * Does the plist ASK launchd to start it at login? `RunAtLoad` true, or any truthy `KeepAlive` (a bare
 * `true`, or a dict such as `{ SuccessfulExit: false }` — launchd starts a KeepAlive job on load
 * regardless of the conditions inside). Homebrew's kubo plist has both. Regex fallback for no plutil.
 */
function startsAtLogin(plist: Record<string, unknown> | null, body: string): boolean {
  return runAtLoad(plist, body) || keepsAlive(plist, body);
}

function runAtLoad(plist: Record<string, unknown> | null, body: string): boolean {
  if (plist) return plist.RunAtLoad === true;
  return /<key>\s*RunAtLoad\s*<\/key>\s*<true\s*\/>/.test(body);
}

/**
 * Does the plist say KeepAlive? A bare `true` means launchd relaunches the job the instant it exits —
 * exit 0 included — which is why `ipfs shutdown` can never turn Homebrew's daemon off: the RPC lands,
 * the process exits cleanly, launchd starts it again within the second, and the Off toggle looks like
 * it did nothing (§6.1). A dict (`{ SuccessfulExit: false }`, our own agent) relaunches only a FAILED
 * exit, so a clean shutdown stays down; that is not the fighting kind and is reported as false here.
 */
function keepsAlive(plist: Record<string, unknown> | null, body: string): boolean {
  if (plist) return plist.KeepAlive === true;
  return /<key>\s*KeepAlive\s*<\/key>\s*<true\s*\/>/.test(body);
}

/** Does this argv actually launch an ipfs daemon? argv[0]'s BASENAME is the program; `daemon` its verb. */
function runsIpfsDaemon(args: string[]): boolean {
  const [program, ...rest] = args;
  if (!program) return false;
  return path.basename(program) === "ipfs" && rest.includes("daemon");
}

/**
 * Find a FOREIGN launchd job that also runs `ipfs daemon` — overwhelmingly `brew services start kubo`
 * (homebrew.mxcl.kubo, ProgramArguments = ["/opt/homebrew/opt/kubo/bin/ipfs", "daemon"]). Both agents
 * fire at login, race for ~/.ipfs/repo.lock, and the loser exits 1 forever (KeepAlive is off).
 * Installing a second agent alongside one of these is the bug, not the fix (ipfs_ui.mdx §13.2), so we
 * detect it rather than compete with it.
 *
 * We match ONLY ProgramArguments, per §13.2's wording. Scanning the whole plist body for "ipfs" +
 * "daemon" (what we did before) false-positives on a job that merely MENTIONS ipfs in
 * EnvironmentVariables (IPFS_PATH), WatchPaths, StandardOutPath, or its Label — and a false positive
 * is not cosmetic: installAutostart() bails on any conflict, so a bystander plist would SILENTLY
 * refuse to install auto-start and leave IPFS dead across reboots while the UI blames another agent.
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
      const plist = await readPlistJson(file);
      if (!runsIpfsDaemon(readProgramArguments(plist, body))) continue;
      // LaunchDaemons live in the system domain; LaunchAgents in the user's gui domain.
      const domain = dir === "/Library/LaunchDaemons" ? "system" : `gui/${uid()}`;
      let loaded = false;
      let running = false;
      try {
        const { stdout } = await run("launchctl", ["print", `${domain}/${label}`]);
        loaded = true;
        running = /^\s*state\s*=\s*running\s*$/m.test(stdout);
      } catch {
        loaded = false;
      }
      // The same §13.1 rule we hold OURSELVES to: a plist on disk proves nothing by itself. It will bring
      // IPFS back at login if it sits in a directory launchd scans at login (it does — that is how we
      // found it), asks to be started on load, and the user hasn't disabled it. Whether it is loaded
      // RIGHT NOW is a different question: the Off toggle boots it out for this session on purpose
      // (§6.1), and it still comes back at the next login.
      const willRunAtLogin = startsAtLogin(plist, body) && !(await isDisabled(label, domain));
      return {
        label,
        source: label.startsWith("homebrew.mxcl.") ? "Homebrew (brew services)" : label,
        path: file,
        domain,
        loaded,
        running,
        keepAlive: keepsAlive(plist, body),
        willRunAtLogin,
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
      willStartOnBoot: false,
      owner: null,
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
  const conflict = await findConflict();
  const owner = resolveOwner({ enabled, lastRunFailed, conflict });
  return {
    supported: true,
    installed,
    enabled,
    lastExitCode: view.lastExitCode,
    lastRunFailed,
    failureReason: lastRunFailed ? readFailureReason() : null,
    conflict,
    willStartOnBoot: owner !== null,
    owner,
  };
}

/**
 * The single derivation of "who brings IPFS back after a reboot" (ipfs_ui.mdx §13.3). Every surface —
 * the app-wide banner's liveness poll, the dashboard row, the off page, the start job's log line — reads
 * the result of THIS, never `enabled` or `conflict` on its own. It used to be re-derived per surface,
 * and the surfaces disagreed: the dashboard credited Homebrew ("on ✓"), the banner read `enabled`
 * (ours only) and said "won't restart", and the button it offered ran an install that correctly
 * refused to compete with Homebrew — so it changed nothing the banner could see. Pressed four times
 * on one machine, four "success" toasts, banner still there.
 *
 *   ours    — registered, not disabled, and not dead at exit≠0 (§13.1)
 *   foreign — a non-LFB job launchd will actually run at login (§13.2) — it wins even when ours is
 *             also installed, because ours is then the one LOSING the repo-lock race
 *   nobody  — a plist on disk that launchd won't run, a dead agent, or nothing at all
 */
export function resolveOwner(s: {
  enabled: boolean;
  lastRunFailed: boolean;
  conflict: Pick<IpfsAutostartConflict, "willRunAtLogin"> | null;
}): IpfsAutostartOwner {
  if (s.conflict?.willRunAtLogin) return "foreign";
  if (s.enabled && !s.lastRunFailed) return "lfb";
  return null;
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
  // Only a foreign job that launchd will actually RUN (or is running now) races us. A plist left on disk
  // but disabled / never bootstrapped starts nothing — refusing on its account would leave IPFS with no
  // owner at all, which is the outcome this guard exists to prevent.
  const conflict = await findConflict();
  if (conflict && (conflict.willRunAtLogin || conflict.running)) {
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

// ── Driving a FOREIGN owner's daemon through launchd (ipfs_ui.mdx §6.1) ──────────────────────────
// When Homebrew's agent owns the daemon, the daemon is not ours to stop with an RPC: its plist says
// `KeepAlive = true`, so launchd relaunches it the instant `ipfs shutdown` lands, and the Off toggle
// looks like it did nothing. The only stop that sticks is the one launchd itself performs — bootout —
// and the matching start is bootstrap. Both are SESSION-SCOPED: the plist stays on disk, nothing is
// disabled, and the job comes back at the next login exactly as before. That is the line §13.2 draws:
// we may run the user's service for them, we never reconfigure it.

/** The foreign launchd job that is running the daemon RIGHT NOW, if any (its `running` is true). */
export async function foreignDaemonOwner(): Promise<IpfsAutostartConflict | null> {
  if (!supported()) return null;
  const c = await findConflict();
  return c?.running ? c : null;
}

/** A foreign job that can start the daemon for this session (plist present, in the user's domain). */
export async function foreignDaemonStarter(): Promise<IpfsAutostartConflict | null> {
  if (!supported()) return null;
  const c = await findConflict();
  return c && c.domain !== "system" ? c : null;
}

/**
 * Stop a foreign owner's daemon for THIS login session: `launchctl bootout` unloads the job, which
 * sends the daemon SIGTERM and — unlike a kill — is not something KeepAlive undoes. Throws when the job
 * lives in the system domain (a LaunchDaemon needs root; we don't have it and won't ask).
 */
export async function stopForeignAgent(c: IpfsAutostartConflict): Promise<void> {
  if (c.domain === "system") {
    throw new Error(
      `${c.source} runs IPFS as a system-wide LaunchDaemon (${c.label}); stopping it needs an administrator — run \`sudo launchctl bootout system/${c.label}\` yourself.`,
    );
  }
  await run("launchctl", ["bootout", `${c.domain}/${c.label}`]);
  log.info("ipfs", `booted out ${c.label} (${c.source}) for this session — it returns at the next login`);
}

/**
 * Start (or resume) a foreign owner's daemon for THIS session: bootstrap the plist if we booted it out,
 * then kickstart so a loaded-but-idle job runs now. Errors are the caller's to interpret — the node
 * service falls back to spawning its own daemon and diagnosing the failure from a log it owns.
 */
export async function startForeignAgent(c: IpfsAutostartConflict): Promise<void> {
  if (c.domain === "system") throw new Error(`${c.label} is a system LaunchDaemon; we can't start it without root.`);
  if (!c.loaded) await run("launchctl", ["bootstrap", c.domain, c.path]);
  await run("launchctl", ["kickstart", `${c.domain}/${c.label}`]);
  log.info("ipfs", `started ${c.label} (${c.source}) via launchd${c.loaded ? "" : " (bootstrapped)"}`);
}
