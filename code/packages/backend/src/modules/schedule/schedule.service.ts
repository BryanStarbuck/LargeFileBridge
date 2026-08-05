// The transparency contract for both scheduled workers (scan.mdx §7, storage.mdx §13):
// installed vs on/off, reconciled against the real OS state, controllable from the web app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerKind, WorkerState, JobsPageData, AppConfig } from "@lfb/shared";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { peerRows } from "../store-model/peers.service.js";
import { launchdInstaller } from "./os/launchd.js";
import { schtasksInstaller } from "./os/schtasks.js";
import { systemdInstaller, supported as systemdSupported } from "./os/systemd.js";
import type { SchedulerInstaller } from "./os/installer.js";
import { resolveStateDir } from "../../config/state-dir.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { watcherState } from "../watcher/watcher.service.js";
import { isWorkerActive } from "./worker-activity.js";
import { workerMiss, clearWorkerMiss } from "./worker-misses.service.js";
import { backbonePushStates } from "../git/push-health.service.js";
import { log } from "../../shared/logging.js";

// Mac launchd is the primary path, with Windows Task Scheduler and Linux systemd user timers behind the same
// interface (scan.mdx §3). The no-op installer below is the LAST resort — a platform with no scheduler we can
// drive (a non-systemd Linux, anything else) — where the flags still flip so the UI works and the in-process
// watchdog remains the only cadence.
const noopInstaller: SchedulerInstaller = {
  async install() {},
  async uninstall() {},
  async enable() {},
  async disable() {},
  isInstalled: () => false,
  async isEnabled() {
    return false;
  },
  installedIntervalSeconds: () => null,
  installedTriggerScript: () => null,
  installedNodeBin: () => null,
  installedLogPaths: () => null,
};

/** The state root this process would install a plist against — the one place worker log paths come from. */
function stateRootNow(): string {
  return resolveStateDir();
}

function installer(): SchedulerInstaller {
  if (process.platform === "darwin") return launchdInstaller;
  if (process.platform === "win32") return schtasksInstaller;
  // Only when systemd is actually there to drive. A non-systemd Linux gets the no-op rather than a pile of
  // unit files nothing will ever read — and, more to the point, rather than a reconcile pass that would
  // WARN "the OS still won't run the job" on every tick forever.
  if (systemdSupported()) return systemdInstaller;
  return noopInstaller;
}

// The launchd/cron worker trampoline: code/deploy/launchd/run-worker.mjs. Every scheduled worker (scan,
// pin, device) runs `node <this> <worker> <port>`, which POSTs the loopback /api/internal/run route. If
// this path is wrong the OS job dies instantly with MODULE_NOT_FOUND — SILENTLY, since a dead launchd job
// writes nothing to our logs and never reaches stampRun. That exact bug shipped once: a brittle `../`
// hop-count assumed `deploy/` lived under `packages/` and resolved to code/packages/deploy/... (nonexistent),
// so the every-10-min device-registration worker never ran and device info never reached the Git repos.
// We now LOCATE the file by walking UP the tree — correct no matter which package subdir this module lives
// in — and callers verify the result exists (buildInstallOpts) so a future move can never fail silently.
function triggerScriptPath(): string {
  const rel = path.join("deploy", "launchd", "run-worker.mjs");
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  // Anchor for the not-found fallback: the PARENT of the `packages` segment — i.e. the repo `code/` root,
  // where deploy/launchd/ actually lives. Capturing it by name (not by a fixed `../` count) is what makes
  // the wrong `code/packages/deploy/...` path impossible to synthesize under ANY run layout (tsx-from-src or
  // a compiled dist tree): the fallback always names `code/deploy/...`, never `packages/deploy/...`.
  let codeRoot: string | null = null;
  for (let hops = 0; hops < 12; hops++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate; // the real, existing trampoline — first ancestor that has it
    if (codeRoot === null && path.basename(dir) === "packages") codeRoot = path.dirname(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root — stop
    dir = parent;
  }
  // Not found by walking up (a genuinely broken tree). Name the canonical location so the "missing trigger
  // script" guard warns about a real, checkable path — anchored on the `code/` root (parent of `packages/`)
  // so it can never point into the nonexistent `packages/deploy/...` that caused the original silent crash.
  if (codeRoot !== null) return path.join(codeRoot, rel);
  return path.resolve(start, "../../../../../deploy/launchd/run-worker.mjs");
}

function labelFor(kind: WorkerKind): string {
  if (kind === "scan") return "com.largefilebridge.scan";
  if (kind === "device") return "com.largefilebridge.device";
  return getAppConfig().pin_process.label;
}

// The transparency-contract config block for a worker kind (installed / enabled / interval / last-run).
// The `device` worker (devices.mdx §12) is the every-10-min device-registration write-back.
function processBlock(c: AppConfig, kind: WorkerKind) {
  if (kind === "scan") return c.scan_process;
  if (kind === "device") return c.device_process;
  return c.pin_process;
}

function intervalFor(kind: WorkerKind): number {
  const c = getAppConfig();
  if (kind === "scan") return c.scan_process.interval_hours * 3600;
  if (kind === "device") return c.device_process.interval_minutes * 60;
  return c.pin_process.interval_minutes * 60;
}

// A worker is OVERDUE when its last successful run is older than TWICE its interval (plus a slack), or it
// has never run (backbone_resilience.mdx §3/§7). 2× absorbs one legitimately-missed fire and clock skew; past
// that the OS trigger is presumed dead. Shared by workerState() (the surfaced flag) and the watchdog (the
// backstop that acts on it) so both use one threshold. A run means a SUCCESSFUL run — a stamped failure
// still counts as "ran" for age, but a null stamp (never ran) is overdue.
const OVERDUE_SLACK_SECONDS = 120;
export function isWorkerOverdue(intervalSeconds: number, lastRunAt: string | null): boolean {
  if (lastRunAt === null) return true;
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return true;
  const ageSeconds = (Date.now() - last) / 1000;
  return ageSeconds > intervalSeconds * 2 + OVERDUE_SLACK_SECONDS;
}

export async function workerState(kind: WorkerKind): Promise<WorkerState> {
  const block = processBlock(getAppConfig(), kind);
  const inst = installer();
  const installed = inst.isInstalled(block.label) || block.installed;
  const enabled = installed ? await inst.isEnabled(block.label) : block.enabled;
  const on = enabled || block.enabled;
  const intervalSeconds = intervalFor(kind);
  const running = isWorkerActive(kind);
  return {
    kind,
    installed,
    enabled: on,
    intervalSeconds,
    label: block.label,
    lastRunAt: block.last_run_at,
    lastRunOk: block.last_run_ok,
    running,
    // The charter's background-process transparency for the cycles the app could not see: a scheduled fire
    // that the launchd trigger could not deliver (worker-misses.service.ts). Cleared by the next good run.
    lastMiss: workerMiss(kind),
    // Only a worker that is supposed to be running can be "overdue"; an off/uninstalled worker isn't. And a
    // pass EXECUTING right now is not overdue no matter how long it has been going — a pin/device pass is
    // detached and may legitimately outlast its own interval (run-job.ts). Calling that "overdue" would
    // send the watchdog to kick a worker that is already working.
    overdue: installed && on && !running ? isWorkerOverdue(intervalSeconds, block.last_run_at) : false,
  };
}

export async function jobsPageData(): Promise<JobsPageData> {
  const c = getAppConfig();
  return {
    scan: await workerState("scan"),
    pin: await workerState("pin"),
    device: await workerState("device"),
    watcher: watcherState(),
    computerLabel: c.computer.label,
    ipfs: await ipfs.health(),
    peers: peerRows(),
    // Backbones whose push keeps being rejected — this computer's tracking state is committed but has NOT
    // reached the user's other computers (push-health.service.ts, bug #16). Empty when all is well.
    backbonePush: backbonePushStates(),
  };
}

/**
 * The node binary to bake into a worker plist — a path that SURVIVES A RUNTIME UPGRADE.
 *
 * `process.execPath` is version-pinned by every version manager there is: Homebrew hands us
 * `/opt/homebrew/Cellar/node/26.4.0/bin/node`, and the day `brew upgrade node` runs, that directory is
 * deleted. launchd then has a plist whose interpreter does not exist, so the job dies instantly on every
 * fire — SILENTLY, because a job that never starts writes nothing to our logs and never reaches stampRun.
 * That is the same failure mode as the run-worker.mjs path bug, one argument to the left, and it was live on
 * the reference machine: the `scan` plist pointed at node 26.4.0 while the installed runtime was 26.5.0.
 *
 * So prefer a STABLE symlink (`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`) — but only
 * one that currently resolves to the very binary we are running. That proviso is what makes this safe: we
 * never point a worker at some other node that happens to be on the box, only at a durable alias for THIS
 * one. When the package manager later upgrades node, the alias follows it and the worker keeps running.
 * With no such alias (nvm, a bare tarball, an unusual layout) we fall back to `process.execPath` unchanged.
 */
export function stableNodeBin(execPath: string = process.execPath): string {
  // WINDOWS TAKES THE PATH AS GIVEN, and resolving it would be actively harmful. Both mainstream layouts
  // are already version-independent — the MSI installs to `C:\Program Files\nodejs\node.exe`, and
  // nvm-windows makes that same path a symlink it re-points on `nvm use`. Following that link (what the
  // POSIX branch below does deliberately) would bake in `…\nvm\v26.5.0\node.exe`, i.e. manufacture the
  // version-pinned interpreter this whole function exists to avoid.
  if (process.platform === "win32") return execPath;
  let realExec: string;
  try {
    realExec = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    try {
      if (fs.realpathSync(candidate) === realExec) return candidate;
    } catch {
      // candidate absent or dangling — try the next
    }
  }
  return execPath;
}

// The full install options for a worker plist — the same set whether we're installing fresh or
// re-rendering an existing plist to fix a drifted interval (reconcileWorkerSchedules).
function buildInstallOpts(kind: WorkerKind) {
  const stateRoot = resolveStateDir();
  const triggerScript = triggerScriptPath();
  // A worker whose trampoline script doesn't exist installs a plist that OS-crashes on every fire with no
  // trace in our logs. Surface it loudly rather than let it fail silently (the class of bug this whole path
  // was hardened against). We still install — the reconcile pass self-heals once the script is present.
  if (!fs.existsSync(triggerScript)) {
    log.error("schedule", `${kind}: worker trigger script not found at ${triggerScript} — the launchd job will fail until this file exists`);
  }
  return {
    label: labelFor(kind),
    worker: kind,
    intervalSeconds: intervalFor(kind),
    nodeBin: stableNodeBin(),
    triggerScript,
    apiPort: getAppConfig().server.backend_port,
    logOut: path.join(stateRoot, "log.log"),
    logErr: path.join(stateRoot, "error.err"),
    // The user's on/off choice travels WITH the install. A Task Scheduler task and a systemd timer are live
    // the moment they are registered, so an installer that isn't told this turns a worker the user switched
    // off back on — on every boot, every watchdog repair, every drift re-render — and it silently resumes
    // committing and pushing. launchd ignores it (a plist does nothing until `bootstrap`).
    enabled: processBlock(getAppConfig(), kind).enabled,
  };
}

export async function control(
  kind: WorkerKind,
  action: "install" | "uninstall" | "enable" | "disable",
): Promise<WorkerState> {
  const label = labelFor(kind);
  const inst = installer();
  const opts = buildInstallOpts(kind);

  // The installer shells out to launchctl / writes the plist — surface any OS-level failure to the
  // fault trail before it propagates up to the router's 500.
  try {
    if (action === "install") await inst.install(opts);
    if (action === "uninstall") await inst.uninstall(label);
    if (action === "enable") await inst.enable(label);
    if (action === "disable") await inst.disable(label);
  } catch (e) {
    log.error("schedule", `${kind}: ${action} failed: ${(e as Error).message}`);
    throw e;
  }
  log.info("schedule", `${kind}: ${action}`);

  await updateAppConfig((c) => {
    const block = processBlock(c, kind);
    if (action === "install") block.installed = true;
    if (action === "uninstall") {
      block.installed = false;
      block.enabled = false;
    }
    if (action === "enable") block.enabled = true;
    if (action === "disable") block.enabled = false;
    return c;
  });
  void os;
  return workerState(kind);
}

// Outcome of reconciling one worker's schedule — what the watchdog (watchdog.service.ts tick()) uses to
// decide whether an overdue worker's repair actually landed or whether launchd genuinely won't take it
// (the case that deserves a WARN, vs. the routine self-heal that doesn't).
export interface ScheduleReconcileResult {
  kind: WorkerKind;
  /** Config says this worker should be running (installed + enabled). */
  wantsOn: boolean;
  /** Real OS state AFTER the reconcile attempt — null when wantsOn is false (nothing to check). */
  osEnabledAfter: boolean | null;
}

// Re-render an already-installed worker plist when its baked-in StartInterval no longer matches the
// configured interval, when its trigger-script path has drifted, OR when launchd simply doesn't have the
// job loaded even though it's configured on (a bootstrap that failed or got booted out and never
// reloaded — backbone_resilience.mdx §3/F1). Case in point for the first: the scan cadence default
// dropped 4h → 2h — config.service.ts heals the stored value on load, but the on-disk LaunchAgent still
// fires on the OLD schedule until the plist is re-written and reloaded. Called once at boot (main.ts
// bootstrapState) and after every watchdog-detected overdue worker. Only touches workers that are
// ALREADY installed — it never installs or enables a worker the user hasn't opted into. Best-effort: a
// launchctl/OS hiccup is logged, not fatal to boot.
export async function reconcileWorkerSchedules(): Promise<ScheduleReconcileResult[]> {
  const results: ScheduleReconcileResult[] = [];
  for (const kind of ["scan", "pin", "device"] as WorkerKind[]) {
    const inst = installer();
    const label = labelFor(kind);
    const block = processBlock(getAppConfig(), kind);
    try {
      if (!inst.isInstalled(label)) {
        // CONFIG SAYS INSTALLED, THE OS DISAGREES — restore it. Two ways a machine lands here, and the
        // second one is why this branch exists at all:
        //   • the user (or an installer/migration) deleted the plist / scheduled task by hand, while
        //     `control("uninstall")` — the only sanctioned way off — was never called, so `installed` is
        //     still true and nothing would ever put the OS job back;
        //   • THE PLATFORM GAINED AN INSTALLER IT DIDN'T HAVE BEFORE. Every Windows machine that ever ran
        //     LFB has `device_process.installed = true` and `auto_provisioned = true` written by a build
        //     whose installer for that platform was the no-op — so `ensureDeviceWorkerDefaultOn()` is
        //     latched shut and will never provision the real scheduled task. Without this, upgrading a
        //     Windows computer to the build that HAS a Task Scheduler installer would leave it exactly as
        //     broken as before, forever.
        // A platform with no real installer at all no-ops here and reports as before — the in-process
        // watchdog remains its cadence.
        if (!block.installed) {
          results.push({ kind, wantsOn: false, osEnabledAfter: null });
          continue;
        }
        await inst.install(buildInstallOpts(kind));
        if (block.enabled) await inst.enable(label);
        const restored = inst.isInstalled(label);
        if (restored) {
          log.info("schedule", `${kind}: the OS schedule was missing while config had it installed — reinstalled it`);
        }
        results.push({
          kind,
          wantsOn: restored && block.enabled,
          osEnabledAfter: restored && block.enabled ? await inst.isEnabled(label) : null,
        });
        continue;
      }
      // THE OS HAS IT, CONFIG SAYS IT SHOULD NOT EXIST — remove it. The mirror of the branch above, and
      // without it `installed: false` was only half-true: reconcile skipped the worker entirely, so a unit
      // left behind by a hand-edited config, a config reset, or an uninstall that half-failed kept firing
      // forever with nothing anywhere to correct it. For the `device` worker that is an orphan schedule
      // still committing and pushing from this computer. Config is the decision; the OS is made to match it
      // in BOTH directions, the same way `enabled` now is below.
      if (!block.installed) {
        await inst.uninstall(label);
        log.info("schedule", `${kind}: the OS still had this worker scheduled while config says it is not installed — removed it`);
        results.push({ kind, wantsOn: false, osEnabledAfter: null });
        continue;
      }
      const want = intervalFor(kind);
      const have = inst.installedIntervalSeconds(label);
      // Also heal a drifted/broken TRIGGER SCRIPT path. An already-installed plist can point at a stale or
      // nonexistent run-worker.mjs after a code move/upgrade (the original silent-crash bug) — every machine
      // that installed that plist stays broken until the path is rewritten. Detect it here so a plain restart
      // self-heals: re-render when the interval drifted, OR the baked path no longer matches what we resolve,
      // OR the baked path doesn't exist on disk.
      const wantScript = triggerScriptPath();
      const haveScript = inst.installedTriggerScript(label);
      const scriptDrift = haveScript !== null && haveScript !== wantScript;
      const scriptMissing = haveScript !== null && !fs.existsSync(haveScript);
      // The other, previously-unhandled way the OS trigger goes dead: the plist on disk is byte-for-byte
      // correct (no interval/script drift) but launchd never actually has the job loaded — a `bootstrap`
      // that failed (permissions, a transient launchd hiccup) or a job that got booted out and never
      // reloaded. Config still says `enabled: true` (control() sets that once the user asks, and never
      // un-sets it just because the OS call had trouble — see launchd.ts's launchctl() which logs and
      // swallows rather than throws). Without this check, a worker stuck in that state stayed "overdue"
      // FOREVER: `have === want` short-circuited the whole function before it ever looked at whether
      // launchd had the job loaded, so the repair path was never even attempted again.
      // THE INTERPRETER. Same silent-death class as the trigger script, one argument to the left: the plist
      // bakes in an absolute node path, and a runtime upgrade deletes the version-pinned one it was built
      // from. Live on the reference machine — the `scan` plist named node 26.4.0 after the box had moved to
      // 26.5.0, so launchd had been failing to spawn it on every fire with nothing in our logs. Heal on
      // drift from what we would install now, and on a baked path that no longer exists.
      const wantNode = stableNodeBin();
      const haveNode = inst.installedNodeBin(label);
      const nodeDrift = haveNode !== null && haveNode !== wantNode;
      const nodeMissing = haveNode !== null && !fs.existsSync(haveNode);
      // THE LOG PATHS. launchd will not start a job whose StandardOutPath/StandardErrorPath it cannot open,
      // so a plist pointing into a directory that has since been removed is a dead worker — and the state
      // root can legitimately move (LFB_STATE_DIR). Live on the reference machine: the `device` plist — the
      // every-10-minute git pull/commit/push for EVERY storage — had been installed by a run whose
      // LFB_STATE_DIR was a temp scratchpad, so its logs pointed inside /private/tmp and would stop
      // resolving the moment that directory was reaped.
      const wantLogs = { out: path.join(stateRootNow(), "log.log"), err: path.join(stateRootNow(), "error.err") };
      const haveLogs = inst.installedLogPaths(label);
      const logDrift = haveLogs !== null && (haveLogs.out !== wantLogs.out || haveLogs.err !== wantLogs.err);
      const logDirMissing = haveLogs !== null && !fs.existsSync(path.dirname(haveLogs.out));

      const shouldBeEnabled = block.enabled;
      const osEnabledNow = await inst.isEnabled(label);
      const notActuallyLoaded = shouldBeEnabled && !osEnabledNow;
      // THE OTHER DIRECTION, and it is the one that costs the user something: config says this worker is
      // OFF and the OS is firing it anyway. The switch is not decoration — a `device` worker running while
      // the user believes it is off keeps committing and pushing from this computer every 10 minutes. It
      // happens whenever the OS registration outlives the config decision: a task left enabled in the Task
      // Scheduler UI, a systemd timer still started, or an install that predates this reconcile. Left
      // unhandled, the fast path below would call it "already correct" forever, because it only ever asked
      // whether an ON worker was running, never whether an OFF one had stopped.
      const runningWhileOff = !shouldBeEnabled && osEnabledNow;
      if (
        have === want &&
        !scriptDrift &&
        !scriptMissing &&
        !nodeDrift &&
        !nodeMissing &&
        !logDrift &&
        !logDirMissing &&
        !notActuallyLoaded &&
        !runningWhileOff
      ) {
        // already correct — nothing to do
        results.push({ kind, wantsOn: shouldBeEnabled, osEnabledAfter: shouldBeEnabled ? osEnabledNow : null });
        continue;
      }
      await inst.install(buildInstallOpts(kind)); // rewrite the plist with the current interval + trigger path
      if (shouldBeEnabled) {
        // launchd only picks up plist changes on reload: bootout the stale job, bootstrap the new. Also
        // exactly what re-attempts a bootstrap that never took in the first place (notActuallyLoaded).
        await inst.disable(label);
        await inst.enable(label);
      } else {
        // Config says OFF, so make the OS agree. On launchd the re-render above cannot do this on its own
        // (a plist says nothing about whether it is loaded); on Windows/systemd it is the belt to that
        // brace. Unconditional rather than gated on `runningWhileOff`, because the install we just did is
        // itself capable of reviving a registration.
        await inst.disable(label);
      }
      const osEnabledAfter = shouldBeEnabled ? await inst.isEnabled(label) : null;
      const why = runningWhileOff
        ? `the OS was still running this worker while settings had it switched off — stopped it`
        : scriptDrift || scriptMissing
          ? `trigger script ${haveScript ?? "?"} → ${wantScript}`
          : nodeDrift || nodeMissing
            ? `node binary ${haveNode ?? "?"}${nodeMissing ? " (GONE — the job could not start at all)" : ""} → ${wantNode}`
            : logDrift || logDirMissing
              ? `log paths ${haveLogs?.out ?? "?"}${logDirMissing ? " (directory GONE — launchd could not open it)" : ""} → ${wantLogs.out}`
              : notActuallyLoaded
                ? `the OS didn't actually have the job loaded — re-registered it`
                : `interval ${have ?? "?"}s → ${want}s`;
      if (shouldBeEnabled && !osEnabledAfter) {
        log.warn("schedule", `${kind}: schedule repair did not take — the OS still won't run the job (${why})`);
      } else {
        log.info("schedule", `${kind}: reconciled schedule (${why})`);
      }
      results.push({ kind, wantsOn: shouldBeEnabled, osEnabledAfter });
    } catch (e) {
      log.warn("schedule", `${kind}: schedule reconcile failed: ${(e as Error).message}`);
      results.push({ kind, wantsOn: block.enabled, osEnabledAfter: null });
    }
  }
  return results;
}

/**
 * The device-registration worker (devices.mdx §11) is ON BY DEFAULT — unlike the scan/pin workers it
 * needs no explicit user Install. On first boot LFB auto-installs + enables its launchd job so this
 * computer's device info starts writing back to your Git repos every 10 minutes with zero action. Runs
 * exactly ONCE, latched by `device_process.auto_provisioned`: if the user later turns it OFF, it stays off
 * (we never force it back on). Best-effort — a launchctl/OS failure leaves the latch unset so the next
 * boot retries. Called from main.ts bootstrapState(), before reconcileWorkerSchedules().
 */
export async function ensureDeviceWorkerDefaultOn(): Promise<void> {
  if (getAppConfig().device_process.auto_provisioned) return; // already auto-provisioned once — respect the user's later choice
  try {
    await control("device", "install"); // create the launchd plist
    await control("device", "enable"); // load it so it fires every 10 min
    await updateAppConfig((c) => ((c.device_process.auto_provisioned = true), c));
    log.info("schedule", "device worker: auto-provisioned ON by default (every 10 min)");
  } catch (e) {
    // Leave auto_provisioned unset so the next boot retries; the app still runs.
    log.warn("schedule", `device worker: default-on provisioning failed (retries next boot): ${(e as Error).message}`);
  }
}

export async function stampRun(kind: WorkerKind, ok: boolean): Promise<void> {
  await updateAppConfig((c) => {
    const block = processBlock(c, kind);
    block.last_run_at = new Date().toISOString();
    block.last_run_ok = ok;
    return c;
  });
  // A completed pass means every previously-undelivered fire has now been made good — drop the missed-cycle
  // record so the transparency surface reflects a recovered worker rather than an old scare.
  if (ok) clearWorkerMiss(kind);
}
