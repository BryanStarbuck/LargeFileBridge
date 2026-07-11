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
import type { SchedulerInstaller } from "./os/installer.js";
import { resolveStateDir } from "../../config/state-dir.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { watcherState } from "../watcher/watcher.service.js";
import { log } from "../../shared/logging.js";

// Mac launchd is the shipped path; other platforms fall back to a no-op installer
// that still flips the config flags so the UI works cross-platform.
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
};

function installer(): SchedulerInstaller {
  return process.platform === "darwin" ? launchdInstaller : noopInstaller;
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
  return {
    kind,
    installed,
    enabled: on,
    intervalSeconds,
    label: block.label,
    lastRunAt: block.last_run_at,
    lastRunOk: block.last_run_ok,
    // Only a worker that is supposed to be running can be "overdue"; an off/uninstalled worker isn't.
    overdue: installed && on ? isWorkerOverdue(intervalSeconds, block.last_run_at) : false,
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
  };
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
    nodeBin: process.execPath,
    triggerScript,
    apiPort: getAppConfig().server.backend_port,
    logOut: path.join(stateRoot, "log.log"),
    logErr: path.join(stateRoot, "error.err"),
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

// Re-render an already-installed worker plist when its baked-in StartInterval no longer matches the
// configured interval. Case in point: the scan cadence default dropped 4h → 2h — config.service.ts heals
// the stored value on load, but the on-disk LaunchAgent still fires on the OLD schedule until the plist is
// re-written and reloaded. Called once at boot (main.ts bootstrapState). Only touches workers that are
// ALREADY installed — it never installs or enables a worker the user hasn't opted into. Best-effort: a
// launchctl/OS hiccup is logged, not fatal to boot.
export async function reconcileWorkerSchedules(): Promise<void> {
  for (const kind of ["scan", "pin", "device"] as WorkerKind[]) {
    const inst = installer();
    const label = labelFor(kind);
    try {
      if (!inst.isInstalled(label)) continue;
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
      if (have === want && !scriptDrift && !scriptMissing) continue; // already correct — nothing to do
      const wasEnabled = await inst.isEnabled(label);
      await inst.install(buildInstallOpts(kind)); // rewrite the plist with the current interval + trigger path
      if (wasEnabled) {
        // launchd only picks up plist changes on reload: bootout the stale job, bootstrap the new.
        await inst.disable(label);
        await inst.enable(label);
      }
      const why =
        scriptDrift || scriptMissing
          ? `trigger script ${haveScript ?? "?"} → ${wantScript}`
          : `interval ${have ?? "?"}s → ${want}s`;
      log.info("schedule", `${kind}: reconciled schedule (${why})`);
    } catch (e) {
      log.warn("schedule", `${kind}: schedule reconcile failed: ${(e as Error).message}`);
    }
  }
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
}
