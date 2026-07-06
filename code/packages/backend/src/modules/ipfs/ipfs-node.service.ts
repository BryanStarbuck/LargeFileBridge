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
  IpfsNodeStatus,
  IpfsInstallJob,
  IpfsJobKind,
  IpfsPlatform,
  IpfsDaemonResult,
} from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { computeIpfsPage } from "./ipfs-page.service.js";
import { autostartStatus, installAutostart } from "./ipfs-autostart.service.js";
import * as ipfs from "./ipfs.service.js";
import { log } from "../../shared/logging.js";

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
  const compliant =
    running &&
    (posture.reprovideStrategy === "pinned" || posture.reprovideStrategy === "roots") &&
    posture.gatewayLocalOnly;

  // Will IPFS come back on its own after a reboot? (ipfs_ui.mdx §13) — reads the OS (launchd) state.
  const autostart = await autostartStatus().catch((e) => {
    log.warn("ipfs", `autostart status read failed: ${(e as Error).message}`);
    return { supported: process.platform === "darwin", installed: false, enabled: false };
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
    compliant,
    autostart,
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

/** Spawn a detached `ipfs daemon` and wait for it to answer. */
async function startDaemon(): Promise<boolean> {
  job.phase = "starting";
  append("Starting the IPFS daemon…");
  const stateRoot = resolveStateDir();
  try {
    fs.mkdirSync(stateRoot, { recursive: true });
  } catch {
    /* best effort */
  }
  const outPath = path.join(stateRoot, "ipfs-daemon.log");
  let out: number;
  try {
    out = fs.openSync(outPath, "a");
  } catch (e) {
    // Couldn't open the daemon log file — fall back to inheriting our own stdout rather than fail.
    log.warn("ipfs", `open daemon log ${outPath} failed: ${(e as Error).message}`);
    out = 1;
  }
  try {
    const child = spawn("ipfs", ["daemon", "--enable-gc"], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
  } catch (e) {
    append(`(could not launch daemon: ${(e as Error).message})`);
    log.warn("ipfs", `spawn ipfs daemon failed: ${(e as Error).message}`);
    return false;
  }
  append("Waiting for the daemon to come up…");
  return waitForHealthy(30_000);
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
      if (!(await startDaemon())) {
        return fail("Installed, but the daemon didn't come up in time.", "ipfs daemon --enable-gc");
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
  opts?: { autostart?: boolean },
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
      if (!(await startDaemon())) {
        return fail("The daemon didn't come up in time.", "ipfs daemon --enable-gc");
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
