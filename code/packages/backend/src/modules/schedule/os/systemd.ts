// Linux systemd user-timer installer (scan.mdx §3.3 — "Linux | systemd timer | a `.timer` + `.service`").
//
// WHY THIS FILE EXISTS. It is the same hole the Windows one was written for, one platform over: `installer()`
// returned the NO-OP for Linux, so nothing on a Linux computer ever fired the every-10-minute `device`
// worker — the git pull / commit / push for every storage. The only thing left driving it was the in-process
// watchdog, which by design acts on a worker that is already OVERDUE (2× its interval + slack) and only while
// the web app is up. So auto-commit on Linux ran at roughly a 22-minute cadence at best and stopped dead
// whenever the app was closed. `scan.mdx §3` had listed a systemd timer as a supported target the whole time.
//
// THE SHAPE, and how it differs from launchd (os/launchd.ts):
//   • Two units, not one: a `oneshot` `.service` that runs the trampoline, and a `.timer` that fires it.
//     "Installed" is the TIMER FILE on disk — the exact analogue of the plist, and inert in the same way:
//     writing it schedules nothing until `systemctl --user enable --now`, which is what `enable()` does.
//   • launchd's `StartInterval` becomes `OnActiveSec` + `OnUnitActiveSec`. `OnActiveSec` is deliberately not
//     `OnBootSec`: a boot-relative timer started mid-session has its deadline in the past and fires
//     IMMEDIATELY, so every reconcile repair would kick a git cycle. Relative to activation, the first fire
//     is one interval out and each one after that follows the last — exactly `StartInterval`'s semantics.
//   • `StandardOutput=append:` / `StandardError=append:` point at the same `log.log` / `error.err` the macOS
//     plist names, preserving the run-worker.mjs LOG FORMAT CONTRACT verbatim.
//   • Everything reconcile compares (interval, trigger script, node binary, log paths) is read back out of
//     the two unit files, so a Linux computer self-heals exactly as a Mac one does.
//
// The user manager, NOT the system one: these workers run as the user, reach the user's git credentials, and
// must never be root. That also means a timer only fires while the user has a session — see `supported()`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SchedulerInstaller, InstallOpts } from "./installer.js";
import { log } from "../../../shared/logging.js";

const run = promisify(execFile);

/** systemd's own answer to "was this machine booted with systemd" — the check `sd_booted(3)` documents. */
export function systemdBooted(): boolean {
  try {
    return fs.existsSync("/run/systemd/system");
  } catch {
    return false;
  }
}

/**
 * Absolute path to `systemctl`, resolved the way git-bin.ts resolves git and for the same reason: a worker
 * process started with a thin PATH must still be able to drive its own scheduler. Null when there is no
 * systemctl at all, which is what makes `supported()` answer no on a non-systemd Linux.
 */
export function systemctlBin(): string | null {
  for (const candidate of ["/usr/bin/systemctl", "/bin/systemctl", "/usr/local/bin/systemctl"]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/** True when user timers are a real option here. False → schedule.service.ts keeps the no-op installer, so a
 *  non-systemd Linux is left exactly as it was rather than accumulating unit files nothing will ever read. */
export function supported(): boolean {
  return process.platform === "linux" && systemdBooted() && systemctlBin() !== null;
}

function unitDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "systemd", "user");
}

export function servicePath(label: string): string {
  return path.join(unitDir(), `${label}.service`);
}

export function timerPath(label: string): string {
  return path.join(unitDir(), `${label}.timer`);
}

function timerUnit(label: string): string {
  return `${label}.timer`;
}

// ── the unit files ──────────────────────────────────────────────────────────

/** systemd splits ExecStart on whitespace unless a token is quoted, so every path is quoted — a checkout
 *  under `~/My Projects` would otherwise become four arguments and the worker would never start. */
function quote(s: string): string {
  return `"${s}"`;
}

export function renderService(o: InstallOpts): string {
  return `# Large File Bridge worker — GENERATED, rewritten on every install. Do not edit.
[Unit]
Description=Large File Bridge ${o.worker} worker

[Service]
Type=oneshot
ExecStart=${quote(o.nodeBin)} ${quote(o.triggerScript)} ${o.worker} ${o.apiPort}
StandardOutput=append:${o.logOut}
StandardError=append:${o.logErr}
`;
}

export function renderTimer(o: InstallOpts): string {
  const seconds = Math.max(60, Math.round(o.intervalSeconds));
  return `# Large File Bridge worker timer — GENERATED, rewritten on every install. Do not edit.
[Unit]
Description=Large File Bridge ${o.worker} worker — every ${seconds}s

[Timer]
Unit=${o.label}.service
OnActiveSec=${seconds}s
OnUnitActiveSec=${seconds}s
AccuracySec=30s

[Install]
WantedBy=timers.target
`;
}

// ── reading back what is installed ──────────────────────────────────────────

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null; // not installed / unreadable — nothing to compare against
  }
}

/** The ExecStart command line, split into its arguments with the quoting removed. */
export function execStartTokens(service: string): string[] {
  const m = /^ExecStart=(.*)$/m.exec(service);
  if (!m) return [];
  return (m[1].trim().match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"(.*)"$/, "$1"));
}

/** The cadence the INSTALLED timer fires on, in seconds. `OnUnitActiveSec` is the repeating one — reading
 *  `OnActiveSec` instead would answer with the one-off first-fire delay. */
export function parseIntervalSeconds(timer: string): number | null {
  const m = /^OnUnitActiveSec=(\d+)s\s*$/m.exec(timer);
  return m ? Number(m[1]) : null;
}

export function parseLogPath(service: string, key: "StandardOutput" | "StandardError"): string | null {
  const m = new RegExp(`^${key}=append:(.*)$`, "m").exec(service);
  return m ? m[1].trim() : null;
}

// ── systemctl ───────────────────────────────────────────────────────────────

// Every systemctl call is BOUNDED. `--user` talks to a session bus that can be absent or wedged (a bare
// `ssh` shell, a container, a manager mid-restart), and an unbounded call there hangs forever — `isEnabled()`
// is awaited on every jobs-page render, so one stuck `is-active` would hang the page rather than answer
// "off". schtasks.ts bounds its reads for the same reason.
const SYSTEMCTL_TIMEOUT_MS = 20_000;

/** Drive systemctl, swallowing failures the way launchd.ts swallows launchctl's. A `--user` call fails
 *  outright with no session bus (a bare `ssh` shell, a container), and that must never be fatal. */
async function systemctl(...args: string[]): Promise<void> {
  const bin = systemctlBin();
  if (!bin) return;
  try {
    await run(bin, ["--user", ...args], { timeout: SYSTEMCTL_TIMEOUT_MS });
  } catch (e) {
    log.warn("schedule", `systemctl --user ${args.join(" ")}: ${(e as Error).message}`);
  }
}

export const systemdInstaller: SchedulerInstaller = {
  async install(o) {
    // Inert on purpose, exactly like writing a plist: these two files schedule NOTHING until `enable()`
    // starts the timer, which is what keeps "installed" and "on" the separate choices the charter requires.
    for (const [file, body] of [
      [servicePath(o.label), renderService(o)],
      [timerPath(o.label), renderTimer(o)],
    ] as const) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
      } catch (e) {
        log.error("schedule", `Failed to write systemd unit ${file}: ${(e as Error).message}`);
        throw e;
      }
    }
    // Without this systemd keeps serving the PREVIOUS content of these files, so a re-render that fixed a
    // drifted interval or a moved trigger script would change nothing at all.
    await systemctl("daemon-reload");
    log.info("schedule", `Installed systemd user timer ${timerPath(o.label)}`);
  },

  async uninstall(label) {
    await systemctl("disable", "--now", timerUnit(label));
    for (const f of [timerPath(label), servicePath(label)]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
    await systemctl("daemon-reload");
  },

  async enable(label) {
    // `--now` is both halves: `enable` survives a reboot, `start` makes it fire in this session too.
    await systemctl("enable", "--now", timerUnit(label));
  },

  async disable(label) {
    await systemctl("disable", "--now", timerUnit(label));
  },

  isInstalled(label) {
    try {
      return fs.existsSync(timerPath(label));
    } catch {
      return false;
    }
  },

  async isEnabled(label) {
    // ACTIVE, not `is-enabled`: a timer can be enabled-for-next-boot and not running now, and a worker that
    // is not running now is off as far as every caller of this is concerned. `is-active` exits non-zero for
    // an inactive unit, so the throw IS the answer.
    const bin = systemctlBin();
    if (!bin) return false;
    try {
      const { stdout } = await run(bin, ["--user", "is-active", timerUnit(label)], {
        timeout: SYSTEMCTL_TIMEOUT_MS,
      });
      return stdout.trim() === "active";
    } catch {
      return false;
    }
  },

  installedIntervalSeconds(label) {
    const body = readOrNull(timerPath(label));
    return body ? parseIntervalSeconds(body) : null;
  },

  installedTriggerScript(label) {
    const body = readOrNull(servicePath(label));
    return body ? (execStartTokens(body)[1] ?? null) : null;
  },

  installedNodeBin(label) {
    const body = readOrNull(servicePath(label));
    return body ? (execStartTokens(body)[0] ?? null) : null;
  },

  installedLogPaths(label) {
    const body = readOrNull(servicePath(label));
    if (!body) return null;
    const out = parseLogPath(body, "StandardOutput");
    const err = parseLogPath(body, "StandardError");
    return out && err ? { out, err } : null;
  },
};
