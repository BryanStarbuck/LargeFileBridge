// The transparency contract for both scheduled workers (scan.mdx §7, storage.mdx §13):
// installed vs on/off, reconciled against the real OS state, controllable from the web app.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerKind, WorkerState, SyncPageData } from "@lfb/shared";
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
};

function installer(): SchedulerInstaller {
  return process.platform === "darwin" ? launchdInstaller : noopInstaller;
}

function triggerScriptPath(): string {
  // code/deploy/launchd/run-worker.mjs — three dirs up from this module's dir.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../deploy/launchd/run-worker.mjs");
}

function labelFor(kind: WorkerKind): string {
  return kind === "scan" ? "com.largefilebridge.scan" : "com.largefilebridge.sync";
}
function intervalFor(kind: WorkerKind): number {
  const c = getAppConfig();
  return kind === "scan" ? c.scan_process.interval_hours * 3600 : c.sync_process.interval_minutes * 60;
}

export async function workerState(kind: WorkerKind): Promise<WorkerState> {
  const c = getAppConfig();
  const block = kind === "scan" ? c.scan_process : c.sync_process;
  const inst = installer();
  const installed = inst.isInstalled(block.label) || block.installed;
  const enabled = installed ? await inst.isEnabled(block.label) : block.enabled;
  return {
    kind,
    installed,
    enabled: enabled || block.enabled,
    intervalSeconds: intervalFor(kind),
    label: block.label,
    lastRunAt: block.last_run_at,
    lastRunOk: block.last_run_ok,
  };
}

export async function syncPageData(): Promise<SyncPageData> {
  const c = getAppConfig();
  return {
    scan: await workerState("scan"),
    sync: await workerState("sync"),
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
  return {
    label: labelFor(kind),
    worker: kind,
    intervalSeconds: intervalFor(kind),
    nodeBin: process.execPath,
    triggerScript: triggerScriptPath(),
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
    const block = kind === "scan" ? c.scan_process : c.sync_process;
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
  for (const kind of ["scan", "sync"] as WorkerKind[]) {
    const inst = installer();
    const label = labelFor(kind);
    try {
      if (!inst.isInstalled(label)) continue;
      const want = intervalFor(kind);
      const have = inst.installedIntervalSeconds(label);
      if (have === want) continue; // already correct — nothing to do
      const wasEnabled = await inst.isEnabled(label);
      await inst.install(buildInstallOpts(kind)); // rewrite the plist with the current interval
      if (wasEnabled) {
        // launchd only picks up a new StartInterval on reload: bootout the stale job, bootstrap the new.
        await inst.disable(label);
        await inst.enable(label);
      }
      log.info("schedule", `${kind}: reconciled schedule interval ${have ?? "?"}s → ${want}s`);
    } catch (e) {
      log.warn("schedule", `${kind}: schedule reconcile failed: ${(e as Error).message}`);
    }
  }
}

export async function stampRun(kind: WorkerKind, ok: boolean): Promise<void> {
  await updateAppConfig((c) => {
    const block = kind === "scan" ? c.scan_process : c.sync_process;
    block.last_run_at = new Date().toISOString();
    block.last_run_ok = ok;
    return c;
  });
}
