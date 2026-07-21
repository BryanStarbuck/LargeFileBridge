// The IPFS DASHBOARD backend (ipfs_ui.mdx): is the node installed & running, live metrics, the
// gateway summary, and the only-our-content posture — plus the INSTALL and START/STOP jobs that back
// the dashboard's two big controls. Install is cross-platform (brew/winget) with a live progress log
// and an ALWAYS-present copyable manual command; on Linux we go straight to the manual command (no
// non-interactive sudo). Jobs are single-flight, server-side, and re-attachable (like the scan job).
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import type {
  IpfsAutostartStatus,
  IpfsNodeStatus,
  IpfsInstallJob,
  IpfsJobKind,
  IpfsPlatform,
  IpfsDaemonResult,
  IpfsLiveness,
} from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { computeIpfsPage } from "./ipfs-page.service.js";
import { autostartStatus, installAutostart } from "./ipfs-autostart.service.js";
import {
  configHealth,
  diagnoseStartFailure,
  upgradeInfo,
  upgradePlan,
  type StartDiagnosis,
} from "./ipfs-config-health.service.js";
import * as ipfs from "./ipfs.service.js";
import { bumpTopicThrottled, IPFS_TOPIC } from "../events/state-events.service.js";
import { log, rotateIfOversized } from "../../shared/logging.js";

const run = promisify(execFile);

// ── platform + install plan ─────────────────────────────────────────────────
function platform(): IpfsPlatform {
  const p = process.platform;
  return p === "darwin" || p === "win32" || p === "linux" ? p : "other";
}

/** Is a binary resolvable on PATH? Uses `command -v` (posix) / `where` (win) — never a shell alias. */
async function hasBinary(name: string): Promise<boolean> {
  try {
    if (process.platform === "win32") await run("where", [name]);
    else await run("command", ["-v", name], { shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

interface InstallPlan {
  method: string | null; // package manager we would auto-run (null → manual only)
  command: string; // the exact copyable manual command for this platform
  bin: string | null; // executable to spawn for an auto-install
  args: string[]; // its arguments
}

function installPlan(p: IpfsPlatform): InstallPlan {
  switch (p) {
    case "darwin":
      // Homebrew installs the Kubo formula as `ipfs`; no sudo required.
      return { method: "brew", command: "brew install ipfs", bin: "brew", args: ["install", "ipfs"] };
    case "win32":
      return {
        method: "winget",
        command: "winget install --id IPFS.Kubo -e",
        bin: "winget",
        args: ["install", "--id", "IPFS.Kubo", "-e", "--accept-source-agreements", "--accept-package-agreements"],
      };
    case "linux":
      // We do NOT auto-run sudo/snap non-interactively; surface the manual command instead.
      return {
        method: null,
        command:
          "sudo snap install ipfs   # or download Kubo from https://dist.ipfs.tech/#kubo and run ./install.sh",
        bin: null,
        args: [],
      };
    default:
      return {
        method: null,
        command: "Download Kubo for your OS from https://dist.ipfs.tech/#kubo",
        bin: null,
        args: [],
      };
  }
}

// ── node status (GET /api/ipfs/node) ────────────────────────────────────────
export async function nodeStatus(): Promise<IpfsNodeStatus> {
  const p = platform();
  const plan = installPlan(p);
  const health = await ipfs.health();
  const running = health === "ok";

  // "installed" = the CLI is on PATH OR the daemon answers RPC (a running node is, by definition,
  // installed even if the current PATH can't see the binary).
  const cliInstalled = await hasBinary("ipfs");
  const installed = cliInstalled || running;
  const packageManagerPresent = plan.bin ? await hasBinary(plan.bin) : false;

  // Metrics + posture only make sense when the daemon is up; otherwise return a null block cheaply.
  let version: string | null = null;
  let peerId: string | null = null;
  let repoPath: string | null = null;
  let metrics: IpfsNodeStatus["metrics"] = emptyMetrics();
  let gateway = { enabled: false, localOnly: true, url: null as string | null, addr: null as string | null };
  const posture = await ipfs.nodePosture(); // reads config; falls back to app-config when unreachable

  if (running) {
    const [ver, pid, stat, peers, bw, gw, page] = await Promise.all([
      ipfs.version(),
      ipfs.peerId(),
      ipfs.repoStat(),
      ipfs.swarmPeerCount(),
      ipfs.bandwidth(),
      ipfs.gatewaySummary(),
      // Reuse the pinset page compute for the pin counts so the tile agrees with /ipfs/pins.
      computeIpfsPage().catch((e) => {
        log.warn("ipfs", `node-card pin-count compute failed: ${(e as Error).message}`);
        return null;
      }),
    ]);
    version = ver;
    peerId = pid;
    repoPath = stat.repoPath;
    gateway = gw;
    metrics = {
      sharedFiles: page ? page.node.pinnedCount : null,
      untrackedFiles: page ? page.node.untrackedCount : null,
      repoObjects: stat.numObjects,
      repoSizeBytes: stat.repoSizeBytes,
      storageMaxBytes: stat.storageMaxBytes,
      peersConnected: peers,
      bandwidthTotalIn: bw.totalIn,
      bandwidthTotalOut: bw.totalOut,
      bandwidthRateIn: bw.rateIn,
      bandwidthRateOut: bw.rateOut,
    };
  } else {
    gateway = await ipfs.gatewaySummary().catch((e) => {
      log.warn("ipfs", `gateway summary (node down) failed: ${(e as Error).message}`);
      return gateway;
    });
  }

  const publicGateway = getAppConfig().ipfs.public_gateway;
  // Compliance is the CHARTER's question — "are we serving/bouncing anyone else's content or traffic?"
  // It used to answer using only the two CONTENT vectors (reprovide + gateway), so a node happily
  // relaying strangers' traffic and answering their DHT queries still rendered "compliant ✓". Both of
  // those default to ON in Kubo, so omitting them wasn't a small gap — it was the default state.
  const compliant =
    running &&
    (posture.reprovideStrategy === "pinned" || posture.reprovideStrategy === "roots") &&
    posture.gatewayLocalOnly &&
    posture.relayServiceOff &&
    posture.dhtClientOnly;

  // Will IPFS come back on its own after a reboot? (ipfs_ui.mdx §13) — reads the OS (launchd) state.
  const autostart = await autostartStatus().catch((e) => {
    log.warn("ipfs", `autostart status read failed: ${(e as Error).message}`);
    return unknownAutostart();
  });

  // Config health (ipfs_ui.mdx §14) — is the node config sane / repairable? Reads $IPFS_PATH/config;
  // this is what makes a "won't start" crash a named, fixable state instead of a fake timeout.
  const cfgHealth = await configHealth().catch((e) => {
    log.warn("ipfs", `config health read failed: ${(e as Error).message}`);
    return {
      checked: false,
      path: "",
      exists: false,
      readable: false,
      healthy: true,
      hasBlocker: false,
      issues: [],
    };
  });

  // Is the installed Kubo old vs. our recommended baseline? (ipfs_ui.mdx §15) — network-free compare.
  const upgrade = await upgradeInfo(p, version, packageManagerPresent).catch((e) => {
    log.warn("ipfs", `upgrade info read failed: ${(e as Error).message}`);
    return {
      installedVersion: version,
      recommendedMin: "",
      belowBaseline: false,
      updateAvailable: null,
      canAutoUpgrade: false,
      upgradeCommand: plan.command,
    };
  });

  return {
    installed,
    running,
    version,
    peerId,
    repoPath,
    platform: p,
    installMethod: plan.method,
    installCommand: plan.command,
    packageManagerPresent,
    metrics,
    gateway,
    reprovideStrategy: posture.reprovideStrategy,
    gatewayLocalOnly: posture.gatewayLocalOnly,
    publicGateway,
    gcOn: posture.gcOn,
    relayServiceOff: posture.relayServiceOff,
    dhtClientOnly: posture.dhtClientOnly,
    compliant,
    autostart,
    configHealth: cfgHealth,
    upgrade,
  };
}

/**
 * The CHEAP liveness summary for the app-wide nudge (ipfs_ui.mdx §10/§17). Deliberately light — a PATH
 * probe, an RPC id, a launchctl print, a config-file read — and NEVER the pinset/metrics, so it's safe
 * to poll on every page. Lets the banner pick the start-up scenario without loading the whole dashboard.
 */
export async function liveness(): Promise<IpfsLiveness> {
  const health = await ipfs.health();
  const running = health === "ok";
  const installed = (await hasBinary("ipfs")) || running;
  const autostart = await autostartStatus().catch(() => unknownAutostart());
  const cfg = await configHealth().catch(() => ({ hasBlocker: false }) as { hasBlocker: boolean });
  return {
    installed,
    running,
    autostartSupported: autostart.supported,
    autostartEnabled: autostart.enabled,
    // A config blocker only matters when the node isn't already running.
    configBlocker: !running && cfg.hasBlocker,
  };
}

/** The "we couldn't read launchd" fallback. Reports nothing as working — never a cheerful default. */
function unknownAutostart(): IpfsAutostartStatus {
  return {
    supported: process.platform === "darwin",
    installed: false,
    enabled: false,
    lastExitCode: null,
    lastRunFailed: false,
    failureReason: null,
    conflict: null,
  };
}

function emptyMetrics(): IpfsNodeStatus["metrics"] {
  return {
    sharedFiles: null,
    untrackedFiles: null,
    repoObjects: null,
    repoSizeBytes: null,
    storageMaxBytes: null,
    peersConnected: null,
    bandwidthTotalIn: null,
    bandwidthTotalOut: null,
    bandwidthRateIn: null,
    bandwidthRateOut: null,
  };
}

// ── install / start / stop jobs (ipfs_ui.mdx §7.2) — a single in-memory, re-attachable job ──
let job: IpfsInstallJob = idleJob();

function idleJob(): IpfsInstallJob {
  return {
    kind: "install",
    status: "idle",
    phase: "idle",
    method: null,
    log: [],
    manualCommand: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

export function getJob(): IpfsInstallJob {
  return job;
}

function append(line: string): void {
  job.log.push(line);
  // Keep the log bounded so a chatty installer can't grow it without limit.
  if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
  // Every install/upgrade log line and status flip flows through here or fail() — the IPFS pages
  // learn live, throttled against chatty installers (performance.mdx Aspect 6b).
  bumpTopicThrottled(IPFS_TOPIC);
}

function fail(message: string, manualCommand: string | null): void {
  job.status = "error";
  job.phase = "error";
  job.error = message;
  job.manualCommand = manualCommand;
  job.finishedAt = new Date().toISOString();
  append(`✗ ${message}`);
  log.warn("ipfs", `job ${job.kind} failed: ${message}`);
}

/** Spawn a process and stream its output into the job log; resolves with the exit code. */
function runStreaming(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    append(`$ ${bin} ${args.join(" ")}`);
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      append(`(could not launch ${bin}: ${(e as Error).message})`);
      log.warn("ipfs", `spawn ${bin} failed: ${(e as Error).message}`);
      return resolve(127);
    }
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        const t = line.replace(/\s+$/, "");
        if (t) append(t);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      append(`(process error: ${e.message})`);
      log.warn("ipfs", `process ${bin} errored: ${e.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll health until the daemon answers or we time out. */
async function waitForHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ipfs.health()) === "ok") return true;
    await sleep(1000);
  }
  return false;
}

async function waitForStopped(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ipfs.health()) !== "ok") return true;
    await sleep(500);
  }
  return false;
}

/** `ipfs init` if the repo is new (idempotent — "already initialized" is success). */
async function ensureInit(): Promise<boolean> {
  job.phase = "initializing";
  append("Initializing the IPFS repository (if new)…");
  const code = await runStreaming("ipfs", ["init"]);
  if (code === 0) return true;
  // A non-zero exit whose output says the repo already exists is fine.
  if (job.log.slice(-6).some((l) => /already/i.test(l))) {
    append("Repository already initialized — continuing.");
    return true;
  }
  return false;
}

// The most daemon output we will ever pull into memory for one diagnosis (2_2_do §I item I6). A failed
// start prints a handful of lines, so this never bites in practice — it is the backstop that keeps a
// chatty/looping daemon from handing us the whole (rotation-capped, 5 MiB) log to diagnose.
const DAEMON_TAIL_MAX_BYTES = 512 * 1024;

/**
 * Read only THIS run's daemon output — the bytes appended to the log after `fromOffset`.
 *
 * POSITIONAL on purpose (2_2_do §I item I6): this used to `readFileSync` the ENTIRE log (up to the
 * 5 MiB rotation cap) and only then slice off the tail — buffering megabytes to show a few lines, the
 * same "read more than needed" disease as to_fix. We now stat the size and read just the bytes we want
 * through a file handle, so the read is bounded by what this run actually printed (and by
 * DAEMON_TAIL_MAX_BYTES), not by how big the log has grown.
 *
 * The old slice was also subtly wrong: `fromOffset` is a BYTE offset (statSync().size) but it was
 * applied to a decoded UTF-8 STRING, so any non-ASCII earlier in the log shifted the cut. Reading at a
 * byte position removes that mismatch — do not "simplify" this back to readFileSync + slice.
 */
function readDaemonLogTail(outPath: string, fromOffset: number): string[] {
  let fd: number | null = null;
  try {
    const size = fs.statSync(outPath).size;
    // Start at this run's first byte; if it printed more than the cap, keep the END (the fatal reason
    // is in the last lines — diagnoseStartFailure and the progress log both read from the tail).
    const start = Math.max(fromOffset > size ? 0 : fromOffset, size - DAEMON_TAIL_MAX_BYTES);
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.allocUnsafe(length);
    fd = fs.openSync(outPath, "r");
    const read = fs.readSync(fd, buf, 0, length, start);
    const lines = buf.subarray(0, read).toString("utf8").split("\n");
    // A capped start can land mid-line; drop that partial first line rather than diagnose on a fragment.
    if (start > fromOffset && lines.length > 1) lines.shift();
    return lines.map((l) => l.replace(/\s+$/, "")).filter(Boolean);
  } catch {
    // Defensive by contract: a missing/unreadable log must never throw into a start attempt — the
    // caller degrades to an "unknown cause" diagnosis rather than losing the real failure path.
    return [];
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Spawn a detached `ipfs daemon` and wait for it to answer. Returns `null` on success, or a
 * StartDiagnosis naming the REAL reason it failed (ipfs_ui.mdx §14.2) — read from the daemon's own log
 * — so callers report "your config has a deprecated setting", not a blanket "didn't come up in time".
 * `opts.migrate` adds `--migrate` to run a one-time repo-version migration.
 */
async function startDaemon(opts?: { migrate?: boolean }): Promise<StartDiagnosis | null> {
  job.phase = opts?.migrate ? "migrating" : "starting";
  append(opts?.migrate ? "Starting IPFS and migrating its repository…" : "Starting the IPFS daemon…");
  const stateRoot = resolveStateDir();
  try {
    fs.mkdirSync(stateRoot, { recursive: true });
  } catch {
    /* best effort */
  }
  const outPath = path.join(stateRoot, "ipfs-daemon.log");
  // The detached daemon writes to this fd directly (no per-write cap), so bound it at the boundary we
  // own: roll it here if it's already at/over 5 MiB before we reopen it for append (5 MiB × 5 policy).
  rotateIfOversized(outPath);
  // Note where this run's output will begin, so a failure reads only what THIS start printed.
  let startOffset = 0;
  try {
    startOffset = fs.statSync(outPath).size;
  } catch {
    startOffset = 0;
  }
  let out: number;
  try {
    out = fs.openSync(outPath, "a");
  } catch (e) {
    // Couldn't open the daemon log file — fall back to inheriting our own stdout rather than fail.
    log.warn("ipfs", `open daemon log ${outPath} failed: ${(e as Error).message}`);
    out = 1;
    startOffset = 0;
  }
  const args = ["daemon", "--enable-gc", ...(opts?.migrate ? ["--migrate"] : [])];
  try {
    const child = spawn("ipfs", args, { detached: true, stdio: ["ignore", out, out] });
    child.unref();
  } catch (e) {
    append(`(could not launch daemon: ${(e as Error).message})`);
    log.error("ipfs", `spawn ipfs daemon failed: ${(e as Error).message}`);
    return {
      cause: "unknown",
      message: `Couldn't launch the IPFS daemon: ${(e as Error).message}`,
      manualCommand: "ipfs daemon --enable-gc",
      isConfigBlocker: false,
    };
  }
  append("Waiting for the daemon to come up…");
  if (await waitForHealthy(30_000)) return null; // success

  // It didn't answer — read what the daemon actually said and classify it (no more fake timeouts).
  const tail = readDaemonLogTail(out === 1 ? outPath : outPath, startOffset);
  // Surface the daemon's own last lines in the progress log so the user/support can see them.
  for (const line of tail.slice(-12)) append(line);
  const diag = diagnoseStartFailure(tail);
  log.error(
    "ipfs",
    `daemon start failed (${diag.cause}): ${diag.message}${tail.length ? ` — tail: ${tail.slice(-3).join(" | ")}` : ""}`,
  );
  return diag;
}

/** Kick off the install job (single-flight). Returns the job snapshot immediately. */
export function startInstall(): IpfsInstallJob {
  if (job.status === "running") return job;
  const p = platform();
  const plan = installPlan(p);
  job = { ...idleJob(), kind: "install", status: "running", phase: "detecting", method: plan.method, startedAt: new Date().toISOString() };
  append(`Detected platform: ${p}. Install method: ${plan.method ?? "manual"}.`);

  void (async () => {
    try {
      // No auto-installer for this platform (Linux/other), or the package manager is missing → manual.
      if (!plan.bin) {
        return fail("Automatic install isn't available on this platform — copy the command below.", plan.command);
      }
      if (!(await hasBinary(plan.bin))) {
        return fail(
          `${plan.bin} isn't installed, so we can't install IPFS automatically. Install ${plan.bin} (or run the command below yourself).`,
          plan.command,
        );
      }
      job.phase = "installing";
      append(`Installing IPFS with ${plan.method}…`);
      const code = await runStreaming(plan.bin, plan.args);
      if (code !== 0) {
        return fail(`${plan.method} exited with code ${code}.`, plan.command);
      }
      if (!(await hasBinary("ipfs"))) {
        return fail("Install finished but the `ipfs` command still isn't on PATH.", plan.command);
      }
      if (!(await ensureInit())) {
        return fail("`ipfs init` failed — run it yourself, then start the daemon.", "ipfs init");
      }
      const diag = await startDaemon();
      if (diag) {
        return fail(`Installed, but ${diag.message[0].toLowerCase()}${diag.message.slice(1)}`, diag.manualCommand);
      }
      // Bring the fresh node into only-our-content compliance (best effort).
      await ipfs.enforceCompliance().catch((e) =>
        log.warn("ipfs", `enforce compliance after install failed: ${(e as Error).message}`),
      );
      job.status = "done";
      job.phase = "done";
      job.finishedAt = new Date().toISOString();
      append("✓ IPFS is installed and running.");
      log.info("ipfs", "install job complete — node is up");
    } catch (e) {
      fail((e as Error).message, plan.command);
    }
  })();

  return job;
}

/**
 * Start OR stop the daemon (the on/off toggle). Start runs as a job; stop is quick but tracked too.
 * `opts.autostart` (start only) ALSO sets up reboot auto-start once the daemon is healthy — this backs
 * the IPFS-off page's primary "Turn On IPFS + keep it on across reboots" button (ipfs_ui.mdx §12).
 */
export async function controlDaemon(
  action: "start" | "stop",
  opts?: { autostart?: boolean; migrate?: boolean },
): Promise<IpfsDaemonResult> {
  if (job.status === "running") return { job, node: await nodeStatus() };
  const wantAutostart = action === "start" && opts?.autostart === true;

  const kind: IpfsJobKind = action === "start" ? "start" : "stop";
  job = { ...idleJob(), kind, status: "running", phase: action === "start" ? "starting" : "stopping", startedAt: new Date().toISOString() };

  if (action === "stop") {
    append("Stopping the IPFS daemon…");
    try {
      await ipfs.shutdownDaemon();
    } catch (e) {
      append(`(shutdown RPC error: ${(e as Error).message})`);
      log.warn("ipfs", `shutdown RPC error: ${(e as Error).message}`);
    }
    const stopped = await waitForStopped(10_000);
    if (stopped) {
      job.status = "done";
      job.phase = "done";
      append("✓ IPFS stopped.");
    } else {
      fail("The daemon didn't stop — you may need to quit it manually.", null);
    }
    job.finishedAt = job.finishedAt ?? new Date().toISOString();
    return { job, node: await nodeStatus() };
  }

  // Start: run as a background job so the UI can watch it (spawning + health poll isn't instant).
  void (async () => {
    try {
      if (!(await hasBinary("ipfs"))) {
        return fail("IPFS isn't installed on this computer.", installPlan(platform()).command);
      }
      if (!(await ensureInit())) {
        return fail("`ipfs init` failed — run it yourself, then start the daemon.", "ipfs init");
      }
      const diag = await startDaemon({ migrate: opts?.migrate });
      if (diag) {
        return fail(diag.message, diag.manualCommand);
      }
      await ipfs.enforceCompliance().catch((e) =>
        log.warn("ipfs", `enforce compliance after start failed: ${(e as Error).message}`),
      );
      // Primary-button path: also set IPFS to come back on its own after a reboot (best-effort — a
      // failure here does NOT fail the start; the daemon is already up).
      if (wantAutostart) {
        job.phase = "autostart";
        append("Setting IPFS to start automatically when you reboot…");
        try {
          const st = await installAutostart();
          append(
            st.enabled
              ? "✓ IPFS will now start automatically on reboot."
              : "IPFS is running, but auto-start couldn't be fully enabled — you can retry from the IPFS page.",
          );
        } catch (e) {
          append(`(couldn't set up reboot auto-start: ${(e as Error).message})`);
          log.warn("ipfs", `install autostart after start failed: ${(e as Error).message}`);
        }
      }
      job.status = "done";
      job.phase = "done";
      job.finishedAt = new Date().toISOString();
      append("✓ IPFS is running.");
    } catch (e) {
      fail((e as Error).message, "ipfs daemon --enable-gc");
    }
  })();

  return { job, node: await nodeStatus() };
}

/**
 * Upgrade the `ipfs` binary via the package manager (ipfs_ui.mdx §15.2), as a single-flight, watchable
 * job: stop the daemon → run the package-manager upgrade → restart → bring back to compliance. Always
 * leaves a copyable manual command on failure. Best-effort restart: an upgrade that succeeds but whose
 * restart hits a config issue hands off to the same diagnosis as a normal start (§14.2).
 */
export function startUpgrade(): IpfsInstallJob {
  if (job.status === "running") return job;
  const p = platform();
  const plan = upgradePlan(p);
  job = { ...idleJob(), kind: "upgrade", status: "running", phase: "detecting", method: plan.bin, startedAt: new Date().toISOString() };
  append(`Upgrading IPFS on ${p} via ${plan.bin ?? "manual"}…`);

  void (async () => {
    try {
      if (!plan.bin || !(await hasBinary(plan.bin))) {
        return fail(
          `Automatic upgrade isn't available here${plan.bin ? ` (${plan.bin} isn't installed)` : ""} — run the command below yourself.`,
          plan.command,
        );
      }
      // Stop the daemon first so the binary can be replaced cleanly (ignore if it's already off).
      if ((await ipfs.health()) === "ok") {
        append("Stopping IPFS before the upgrade…");
        try {
          await ipfs.shutdownDaemon();
        } catch (e) {
          log.warn("ipfs", `shutdown before upgrade failed: ${(e as Error).message}`);
        }
        await waitForStopped(10_000);
      }
      job.phase = "upgrading";
      append(`Running ${plan.command}…`);
      const code = await runStreaming(plan.bin, plan.args);
      if (code !== 0) {
        return fail(`${plan.bin} exited with code ${code} during upgrade.`, plan.command);
      }
      // Restart the (now newer) daemon, diagnosing any start failure the upgrade surfaced.
      const diag = await startDaemon();
      if (diag) {
        return fail(`Upgraded, but ${diag.message[0].toLowerCase()}${diag.message.slice(1)}`, diag.manualCommand);
      }
      await ipfs.enforceCompliance().catch((e) =>
        log.warn("ipfs", `enforce compliance after upgrade failed: ${(e as Error).message}`),
      );
      job.status = "done";
      job.phase = "done";
      job.finishedAt = new Date().toISOString();
      const v = await ipfs.version().catch(() => null);
      append(`✓ IPFS upgraded${v ? ` to Kubo v${v}` : ""} and running.`);
      log.info("ipfs", `upgrade job complete${v ? ` — now v${v}` : ""}`);
    } catch (e) {
      fail((e as Error).message, plan.command);
    }
  })();

  return job;
}
