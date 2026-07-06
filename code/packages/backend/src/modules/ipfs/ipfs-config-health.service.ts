// IPFS CONFIG HEALTH & guided self-repair (ipfs_ui.mdx §14–§15). This module exists because of a real
// incident: pressing "Turn on IPFS" reported "the daemon didn't come up in time" when the daemon was
// actually crash-looping — Kubo 0.42 FATAL-s immediately on a deprecated `Reprovider` config key
// ("Deprecated configuration detected. Manually migrate 'Reprovider' … Remove 'Reprovider' from your
// config."). A human had to hand-edit ~/.ipfs/config and restart. This module lets the web app:
//   * READ + classify the node config ($IPFS_PATH/config) into named, severity-ranked issues.
//   * DIAGNOSE the real cause of a start failure from the daemon's own log (never a fake timeout).
//   * REPAIR the config on an explicit user click — after BACKING IT UP first (confirm-then-apply).
//   * Report whether the installed Kubo is OLD vs. a recommended baseline (network-free).
// Every fault here is logged through the app's logging system (log.error → error.err) per ipfs_ui.mdx §19.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IpfsConfigHealth, IpfsConfigIssue, IpfsUpgradeInfo, IpfsPlatform } from "@lfb/shared";
import { log } from "../../shared/logging.js";

const run = promisify(execFile);

// The lowest Kubo version LFB recommends. Baked in (network-free) — authoritative for "too old to be a
// known-good build." Bump this as the project's supported floor moves. NOT a claim about the latest
// release; it's the floor below which we actively nudge an upgrade (ipfs_ui.mdx §15.1).
const RECOMMENDED_MIN_VERSION = "0.30.0";
// The Kubo release that REMOVED the top-level `Reprovider` config section (migrated to `Provide`). At or
// above this, a lingering `Reprovider` block makes the daemon FATAL on startup — the incident.
const REPROVIDER_REMOVED_IN = "0.42.0";

// ── paths ────────────────────────────────────────────────────────────────────
function ipfsRepoPath(): string {
  return process.env.IPFS_PATH && process.env.IPFS_PATH.trim() ? process.env.IPFS_PATH : path.join(os.homedir(), ".ipfs");
}
function configPath(): string {
  return path.join(ipfsRepoPath(), "config");
}

// ── semver-ish compare (Kubo versions are plain a.b.c) ───────────────────────
function parseVer(v: string | null): [number, number, number] | null {
  if (!v) return null;
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** a < b ? Returns false when either is unparseable (we don't guess). */
function versionLt(a: string | null, b: string): boolean {
  const pa = parseVer(a);
  const pb = parseVer(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}
/** a >= b ? (only true when both parse). */
function versionGte(a: string | null, b: string): boolean {
  const pa = parseVer(a);
  const pb = parseVer(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return true;
}

/** Read `ipfs version --number` from the CLI (works with the daemon OFF, unlike the RPC). null if absent. */
export async function cliVersion(): Promise<string | null> {
  try {
    const { stdout } = await run("ipfs", ["version", "--number"], { timeout: 5000 });
    const v = stdout.trim();
    return v || null;
  } catch (e) {
    log.debug("ipfs", `cli version read failed: ${(e as Error).message}`);
    return null;
  }
}

// ── config health (GET /api/ipfs/config-health, ipfs_ui.mdx §14.1) ───────────
/**
 * Read $IPFS_PATH/config and classify it into a health report. A metadata-only read — it opens the one
 * config file and nothing else. Structural crashers (missing / unreadable / deprecated) are BLOCKERS
 * (IPFS can't run); only-our-content drift stays with the security card (§8), not duplicated here.
 */
export async function configHealth(): Promise<IpfsConfigHealth> {
  const p = configPath();
  const issues: IpfsConfigIssue[] = [];

  let exists = false;
  let readable = false;
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(p, "utf8");
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    issues.push({
      id: "missing",
      class: "missing",
      severity: "blocker",
      title: "IPFS isn't set up on this computer yet",
      detail:
        "There's no IPFS configuration file, which means the repository was never initialized. Turning IPFS on will initialize it for you.",
      keys: [],
      changes: ["Initialize a new IPFS repository (creates ~/.ipfs and a config)"],
      fixable: true,
      manualSteps: ["ipfs init"],
    });
    return { checked: true, path: p, exists: false, readable: false, healthy: false, hasBlocker: true, issues };
  }

  let cfg: Record<string, unknown> | null = null;
  try {
    cfg = JSON.parse(raw as string) as Record<string, unknown>;
    readable = true;
  } catch (e) {
    readable = false;
    log.warn("ipfs", `config at ${p} is not valid JSON: ${(e as Error).message}`);
    issues.push({
      id: "unreadable",
      class: "unreadable",
      severity: "blocker",
      title: "The IPFS configuration file is corrupt",
      detail:
        "The config exists but isn't valid JSON, so IPFS can't read it. We can back it up and recreate a fresh configuration — note this creates a new node identity (PeerID).",
      keys: [],
      changes: [
        "Back up the unreadable config to config.bak.<timestamp>",
        "Recreate a fresh IPFS configuration (new PeerID)",
      ],
      fixable: true,
      manualSteps: [`cp "${p}" "${p}.bak.$(date +%s)"`, `rm "${p}"`, "ipfs init"],
    });
    return { checked: true, path: p, exists: true, readable: false, healthy: false, hasBlocker: true, issues };
  }

  // Deprecated `Reprovider` block — the incident. Present + Kubo ≥ 0.42 ⇒ the daemon FATAL-s on start.
  // (On older Kubo the same key is still valid, so we down-rank it to info rather than blocking.)
  if (cfg && Object.prototype.hasOwnProperty.call(cfg, "Reprovider")) {
    const ver = await cliVersion();
    // Blocker when we KNOW the binary removed it, OR when we can't read the version (safer to flag).
    const removed = ver == null || versionGte(ver, REPROVIDER_REMOVED_IN);
    const reprovider = (cfg.Reprovider ?? {}) as Record<string, unknown>;
    const strat = typeof reprovider.Strategy === "string" ? (reprovider.Strategy as string) : "pinned";
    const changes = [
      "Remove the deprecated `Reprovider` block",
      `Keep announce-only-our-content by ensuring Provide.Strategy = "${strat}"`,
    ];
    if (reprovider.Interval) changes.push("Move Reprovider.Interval → Provide.DHT.Interval");
    changes.push("Back up your current config to config.bak.<timestamp> first");
    issues.push({
      id: "deprecated-reprovider",
      class: "deprecated",
      severity: removed ? "blocker" : "info",
      title: removed
        ? "IPFS can't start — its configuration has a setting a newer Kubo removed"
        : "Your IPFS config has a setting newer Kubo versions have removed",
      detail: removed
        ? "Kubo 0.42 removed the old `Reprovider` setting. Until it's migrated to `Provide`, the IPFS service exits immediately on startup — this is why 'Turn on' looked like it timed out. Migrating it is safe: your announce-only-our-content behavior is preserved."
        : "This config still uses the old `Reprovider` key. It works on your current Kubo but will stop the daemon from starting after you upgrade. Migrating now avoids a future failure.",
      keys: ["Reprovider", "Provide.Strategy"],
      changes,
      fixable: true,
      manualSteps: [
        `cp "${p}" "${p}.bak.$(date +%s)"`,
        `ipfs config Provide.Strategy "${strat}"`,
        "# then remove the top-level \"Reprovider\": { … } block from the config with a text editor",
        "ipfs daemon --enable-gc",
      ],
    });
  }

  // Suspicious-but-not-fatal: garbage collection appears off (incidental third-party cache would not be
  // reclaimed — knowledge/ipfs.mdx §4). Info only, never forced.
  const datastore = (cfg?.Datastore ?? {}) as Record<string, unknown>;
  const gcPeriod = typeof datastore.GCPeriod === "string" ? datastore.GCPeriod.trim() : "";
  if (cfg && "Datastore" in cfg && gcPeriod.length === 0) {
    issues.push({
      id: "gc-off",
      class: "suspicious",
      severity: "info",
      title: "Garbage collection isn't configured",
      detail:
        "No GC period is set, so any content your node incidentally caches wouldn't be reclaimed. LFB runs the daemon with --enable-gc, so this is usually harmless.",
      keys: ["Datastore.GCPeriod"],
      changes: ['Set Datastore.GCPeriod = "1h"'],
      fixable: false,
      manualSteps: ['ipfs config Datastore.GCPeriod "1h"'],
    });
  }

  const hasBlocker = issues.some((i) => i.severity === "blocker");
  const healthy = issues.length === 0 || !hasBlocker;
  return { checked: true, path: p, exists, readable, healthy, hasBlocker, issues };
}

// ── diagnose a failed daemon start (ipfs_ui.mdx §14.2 / §9) ──────────────────
export interface StartDiagnosis {
  cause: "deprecated_config" | "needs_migrate" | "port_busy" | "lock_held" | "init_needed" | "timeout" | "unknown";
  message: string; // human — becomes the job's `error`
  manualCommand: string; // the always-present escape hatch
  isConfigBlocker: boolean; // → the off-page shows the Config-health card, not a raw error
}

/**
 * Classify why the daemon didn't come up, from the tail of its own log. This is the fix for the
 * incident: we no longer report a blanket "didn't come up in time" — we read what the daemon actually
 * said and name the real cause. Only a genuinely-unclassified stall stays a timeout.
 */
export function diagnoseStartFailure(logLines: string[]): StartDiagnosis {
  const text = logLines.join("\n");
  const tail = logLines.slice(-40).join("\n"); // recent lines carry the fatal reason

  if (/deprecated configuration/i.test(text) || (/Reprovider/i.test(text) && /migrate/i.test(text))) {
    return {
      cause: "deprecated_config",
      message:
        "IPFS can't start because its configuration has a deprecated setting (Reprovider) that this Kubo version removed. It needs a one-click migration.",
      manualCommand: `cp "${configPath()}" "${configPath()}.bak.$(date +%s)"  # then remove the "Reprovider" block and run: ipfs daemon --enable-gc`,
      isConfigBlocker: true,
    };
  }
  if (/ipfs daemon --migrate/i.test(text) || /run\s+migrations/i.test(text) || /Please run.*migrat/i.test(text)) {
    return {
      cause: "needs_migrate",
      message:
        "IPFS can't start because its on-disk repository is from an older version and needs a one-time migration.",
      manualCommand: "ipfs daemon --enable-gc --migrate",
      isConfigBlocker: true,
    };
  }
  if (/address already in use/i.test(text) || /bind: address/i.test(text) || /could not bind/i.test(text)) {
    const port = tail.match(/tcp\/(\d+)|:(\d{2,5})\b/);
    const which = port ? ` (port ${port[1] ?? port[2]})` : "";
    return {
      cause: "port_busy",
      message: `IPFS can't start because a network port it needs is already in use${which} — most often another IPFS daemon is already running.`,
      manualCommand: "ipfs daemon --enable-gc",
      isConfigBlocker: false,
    };
  }
  if (/someone else has the lock/i.test(text) || /repo\.lock/i.test(text) || /lock.*held/i.test(text)) {
    return {
      cause: "lock_held",
      message:
        "Another IPFS process already holds the repository lock (or a stale lock remains from a crash). If IPFS is already running, you can use it; otherwise remove ~/.ipfs/repo.lock and retry.",
      manualCommand: "rm -f ~/.ipfs/repo.lock && ipfs daemon --enable-gc",
      isConfigBlocker: false,
    };
  }
  if (/no ipfs repo found/i.test(text) || /ipfs init/i.test(text)) {
    return {
      cause: "init_needed",
      message: "IPFS isn't initialized on this computer yet. Turning it on will initialize the repository first.",
      manualCommand: "ipfs init && ipfs daemon --enable-gc",
      isConfigBlocker: true,
    };
  }
  return {
    cause: "timeout",
    message: "The IPFS daemon didn't come up in time. See the log below for what it reported.",
    manualCommand: "ipfs daemon --enable-gc",
    isConfigBlocker: false,
  };
}

// ── repair the config (POST /api/ipfs/config-repair, ipfs_ui.mdx §14.3) ──────
export interface RepairOutcome {
  applied: string[];
  skipped: string[];
  backupPath: string | null;
  needsInit: boolean; // caller should run `ipfs init` (missing/recreated config)
}

/**
 * Apply the confirmed config repairs. ALWAYS backs up first (config.bak.<unix-seconds>). Returns which
 * issue ids were applied/skipped and whether the caller must run `ipfs init` afterwards (a missing or
 * recreated config). Never edits config without being called — the click IS the consent (§14.3). JSON
 * edits are done in-process (parse → mutate → write) so we never depend on the daemon being up.
 */
export async function repairConfig(issueIds?: string[]): Promise<RepairOutcome> {
  const p = configPath();
  const want = (id: string) => !issueIds || issueIds.length === 0 || issueIds.includes(id);
  const applied: string[] = [];
  const skipped: string[] = [];
  let backupPath: string | null = null;
  let needsInit = false;

  const backup = (): void => {
    if (backupPath) return; // once
    try {
      if (fs.existsSync(p)) {
        backupPath = `${p}.bak.${Math.floor(Date.now() / 1000)}`;
        fs.copyFileSync(p, backupPath);
        log.info("ipfs", `Backed up IPFS config to ${backupPath} before repair`);
      }
    } catch (e) {
      log.error("ipfs", `Failed to back up IPFS config ${p}: ${(e as Error).message}`);
      throw new Error(`Couldn't back up your config before changing it: ${(e as Error).message}`);
    }
  };

  // Missing config → the fix is `ipfs init` (handled by the caller as a start job).
  if (!fs.existsSync(p)) {
    if (want("missing")) {
      applied.push("missing");
      needsInit = true;
      log.info("ipfs", "Config missing — repair will initialize a new IPFS repository.");
    }
    return { applied, skipped, backupPath, needsInit };
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch (e) {
    // Unreadable → back up + recreate via init (documented: new PeerID).
    if (want("unreadable")) {
      backup();
      try {
        fs.rmSync(p, { force: true });
      } catch (rmErr) {
        log.error("ipfs", `Failed to remove corrupt config ${p}: ${(rmErr as Error).message}`);
        throw rmErr;
      }
      applied.push("unreadable");
      needsInit = true;
      log.warn("ipfs", `Corrupt config recreated (backup at ${backupPath}): ${(e as Error).message}`);
      return { applied, skipped, backupPath, needsInit };
    }
    skipped.push("unreadable");
    return { applied, skipped, backupPath, needsInit };
  }

  let mutated = false;

  // Deprecated Reprovider → Provide migration (the incident fix). Idempotent.
  if (Object.prototype.hasOwnProperty.call(cfg, "Reprovider")) {
    if (want("deprecated-reprovider")) {
      backup();
      const reprovider = (cfg.Reprovider ?? {}) as Record<string, unknown>;
      const provide = ((cfg.Provide as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      // Preserve the announce-only-our-content strategy in its new home.
      if (typeof reprovider.Strategy === "string" && !provide.Strategy) provide.Strategy = reprovider.Strategy;
      if (!provide.Strategy) provide.Strategy = "pinned";
      // Migrate the interval into Provide.DHT.Interval if it was set.
      if (reprovider.Interval) {
        const dht = ((provide.DHT as Record<string, unknown>) ?? {}) as Record<string, unknown>;
        if (!dht.Interval) dht.Interval = reprovider.Interval;
        provide.DHT = dht;
      }
      cfg.Provide = provide;
      delete cfg.Reprovider;
      mutated = true;
      applied.push("deprecated-reprovider");
      log.info("ipfs", "Migrated deprecated Reprovider block → Provide (config repair).");
    } else {
      skipped.push("deprecated-reprovider");
    }
  }

  if (mutated) {
    try {
      // Pretty-print to keep the file human-diffable (Kubo rewrites it on next config-set anyway).
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
      log.info("ipfs", `Wrote repaired IPFS config ${p}`);
    } catch (e) {
      log.error("ipfs", `Failed to write repaired config ${p}: ${(e as Error).message}`);
      throw new Error(`Couldn't write the repaired config: ${(e as Error).message}`);
    }
  }

  return { applied, skipped, backupPath, needsInit };
}

// ── version / upgrade info (GET /node → upgrade, ipfs_ui.mdx §15) ─────────────
/**
 * Compare the installed Kubo version against a baked-in recommended baseline (network-free), and — on
 * macOS, best-effort and local — ask Homebrew whether a newer build exists. Any failure degrades to
 * "unknown" (null), never throws. `upgradeCommand`/`canAutoUpgrade` come from the platform plan.
 */
export async function upgradeInfo(
  platform: IpfsPlatform,
  installedVersion: string | null,
  packageManagerPresent: boolean,
): Promise<IpfsUpgradeInfo> {
  const version = installedVersion ?? (await cliVersion());
  const belowBaseline = versionLt(version, RECOMMENDED_MIN_VERSION);

  const plan = upgradePlan(platform);
  const canAutoUpgrade = !!plan.bin && packageManagerPresent;

  let updateAvailable: boolean | null = null;
  // Local, best-effort: `brew outdated ipfs` reports from brew's local state (no forced fetch). Bounded
  // and fully swallowed — this must never block the dashboard or surprise-network on the user.
  if (platform === "darwin" && packageManagerPresent) {
    try {
      const { stdout } = await run("brew", ["outdated", "--quiet", "ipfs"], { timeout: 6000 });
      updateAvailable = /(^|\n)\s*ipfs\s*($|\n)/.test(stdout);
    } catch (e) {
      // brew exits non-zero in some states; treat as "unknown" rather than a fault.
      log.debug("ipfs", `brew outdated ipfs check inconclusive: ${(e as Error).message}`);
      updateAvailable = null;
    }
  }

  return {
    installedVersion: version,
    recommendedMin: RECOMMENDED_MIN_VERSION,
    belowBaseline,
    updateAvailable,
    canAutoUpgrade,
    upgradeCommand: plan.command,
  };
}

export interface UpgradePlan {
  bin: string | null;
  args: string[];
  command: string;
}
/** How we'd upgrade IPFS per platform (mirrors the install plan; ipfs_ui.mdx §15.2). */
export function upgradePlan(platform: IpfsPlatform): UpgradePlan {
  switch (platform) {
    case "darwin":
      return { bin: "brew", args: ["upgrade", "ipfs"], command: "brew upgrade ipfs" };
    case "win32":
      return {
        bin: "winget",
        args: ["upgrade", "--id", "IPFS.Kubo", "-e", "--accept-source-agreements", "--accept-package-agreements"],
        command: "winget upgrade --id IPFS.Kubo -e",
      };
    default:
      return { bin: null, args: [], command: "Download the latest Kubo from https://dist.ipfs.tech/#kubo" };
  }
}
