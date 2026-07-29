/**
 * SELF-UPDATE — the app watches its OWN build (git_backbone.mdx §6.7).
 *
 * THE INCIDENT THIS EXISTS FOR (2026-07-29). Two churn defects were found, fixed, committed and pushed
 * while the flood continued at exactly its old rate — because the computer doing the flooding was running
 * an **older build**. Its device file was missing fields the current schema publishes (the tell), and it
 * kept emitting a timestamp-only commit every ~16 minutes. **A fix that is not running is not a fix**, and
 * nothing in the product could see the gap: a stale computer is invisible to everyone, including itself.
 *
 * The watchdog already refuses to trust the OS to keep our workers alive (backbone_resilience.mdx §3, and
 * see watchdog.service.ts). This is the same posture aimed one level down — at the code itself:
 *
 *   1. **DETECT** — is this process running code older than its own checkout, and is the checkout behind
 *      its remote? Both are answered locally, from git, with no publishing and therefore no churn.
 *   2. **UPGRADE** — fast-forward the checkout when it is behind (opt-out, never a merge/rebase/force).
 *   3. **SURFACE** — say so, loudly and with the fix, whenever this computer or a PEER is behind.
 *
 * WHY THIS NEVER RESTARTS THE PROCESS ITSELF. The app runs under `tsx watch` (`just run` → `pnpm dev`),
 * which respawns the backend whenever a source file changes — so a successful fast-forward *is* the
 * restart, for free. Calling `process.exit()` would be a bet that something will bring us back up, and in
 * this deployment nothing would: `just run` starts a detached `nohup pnpm dev` with no supervisor, so
 * exiting on our own would take the app down and leave the user with a dead web app instead of a stale one.
 * A stale app is a bug; a dead app is an outage. So we change the code and let the watcher do its job, and
 * if the process is somehow still on the old build afterwards we say that too, rather than acting on it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { APP_BUILD } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { stableGitBin } from "../git/git-bin.js";
import { log } from "../../shared/logging.js";

/** How this computer answers "which build am I on?" — the published integer plus the local git truth. */
export interface BuildState {
  /** The deliberate, published build number (shared/build.ts). */
  build: number;
  label: string;
  /** HEAD of the source checkout as it was WHEN THIS PROCESS BOOTED — i.e. the code actually running. */
  bootedSha: string | null;
  /** HEAD of the source checkout right now. Different from `bootedSha` ⇒ this process is running old code. */
  currentSha: string | null;
  /** True when the checkout has commits waiting on the remote that we have not merged. */
  behindRemote: boolean;
  /** How many commits behind, when known. */
  behindBy: number;
}

/** Captured ONCE, at first use, before any self-update can move HEAD — this is the build we are running. */
let bootedSha: string | null | undefined;

/** Hourly — see the throttle note in `runSelfUpdate`. */
const FETCH_INTERVAL_MS = 60 * 60 * 1000;
let lastFetchAt: number | null = null;

/**
 * The stale-peer report is THROTTLED, and this is not a detail — it is the same rule §6.6 applies to
 * commits, applied to the fault trail. Its host (the watchdog) ticks every 5 minutes, so an unthrottled
 * report would write ~288 WARN lines a day into `error.err` about a condition that changes maybe twice a
 * week. Repeating a standing fact is not reporting it; it buries every other fault in the file. So it is
 * said when the ANSWER CHANGES, and otherwise at most hourly as a reminder that it is still true.
 */
const STALE_REPORT_INTERVAL_MS = 60 * 60 * 1000;
let lastStaleReport: { key: string; at: number } | null = null;

/** True when this stale-peer set is worth saying out loud right now (changed, or the hourly reminder). */
export function shouldReportStalePeers(peers: StalePeer[], now: number): boolean {
  if (peers.length === 0) {
    lastStaleReport = null; // the fleet is current — the next problem is fresh news again
    return false;
  }
  const key = peers.map((p) => `${p.device}@${p.build}`).join(",");
  if (lastStaleReport && lastStaleReport.key === key && now - lastStaleReport.at < STALE_REPORT_INTERVAL_MS) {
    return false;
  }
  lastStaleReport = { key, at: now };
  return true;
}

/**
 * The root of LFB's own source checkout, or null when the app is not running from a git tree (a packaged
 * install). Derived from this module's own location, never from cwd — the background worker and the web app
 * are launched from different directories.
 */
export function sourceRepoRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 12; hop++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync(stableGitBin(), args, {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      // Explicit stdio: without it a git that writes to stderr mirrors into OUR stderr and lands in the
      // fault trail as though the app had failed.
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** Read this computer's build state. Pure observation — never writes, never fetches. */
export function buildState(): BuildState {
  const root = sourceRepoRoot();
  const currentSha = root ? git(root, ["rev-parse", "HEAD"]) : null;
  if (bootedSha === undefined) bootedSha = currentSha; // first read of the session = what we booted on

  let behindBy = 0;
  if (root) {
    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch && branch !== "HEAD") {
      const counts = git(root, ["rev-list", "--count", `HEAD..origin/${branch}`]);
      const n = parseInt(counts ?? "", 10);
      if (Number.isFinite(n)) behindBy = n;
    }
  }
  return {
    build: APP_BUILD.number,
    label: APP_BUILD.label,
    bootedSha: bootedSha ?? null,
    currentSha,
    behindRemote: behindBy > 0,
    behindBy,
  };
}

/** True when the running process is older than the code sitting in its own checkout. */
export function runningStaleCode(state: BuildState = buildState()): boolean {
  return !!state.bootedSha && !!state.currentSha && state.bootedSha !== state.currentSha;
}

/**
 * One self-update pass: fetch, fast-forward if we are behind, and report.
 *
 * SAFETY RAILS, all load-bearing:
 *   • **Fast-forward ONLY.** Never a merge, never a rebase, never a force. If the local branch has diverged
 *     (this repo is auto-committed, so a computer may legitimately be ahead), the FF fails, we say so, and
 *     we change nothing. Reconciling a divergence is the user's call, not a background job's.
 *   • **A dirty tree is never touched.** Uncommitted work in the source checkout is somebody's work in
 *     progress; the update is postponed, not forced past it.
 *   • **`check_only` writes nothing**, for a machine whose source is managed elsewhere.
 *   • **No process restart** (see the file header).
 */
export function runSelfUpdate(opts?: { force?: boolean }): { updated: boolean; problem?: string } {
  const cfg = getAppConfig().self_update;
  if (!cfg.enabled) return { updated: false };

  const root = sourceRepoRoot();
  if (!root) return { updated: false }; // not a git checkout — nothing this can do, and nothing is wrong

  // THROTTLED, because its host is not. The watchdog ticks every 5 minutes to catch a dead worker quickly;
  // a build does not go stale on that timescale, and fetching this repo 288 times a day would be exactly
  // the kind of pointless background traffic this whole day's work was about removing. Hourly catches an
  // upgrade well inside any human's patience.
  const now = Date.now();
  if (!opts?.force && lastFetchAt !== null && now - lastFetchAt < FETCH_INTERVAL_MS) return { updated: false };
  lastFetchAt = now;

  const before = git(root, ["rev-parse", "HEAD"]);
  if (git(root, ["fetch", "--quiet", "origin"]) === null) {
    // Offline is the overwhelmingly likely cause and is not a fault — the next tick tries again.
    return { updated: false };
  }
  const state = buildState();
  if (!state.behindRemote) {
    if (runningStaleCode(state)) {
      log.warn(
        "self-update",
        `this process is running build ${APP_BUILD.number} from commit ${state.bootedSha?.slice(0, 8)}, but the ` +
          `checkout has since moved to ${state.currentSha?.slice(0, 8)}. The source watcher normally restarts the ` +
          `app on a source change; it has not. Restart Large File Bridge (\`just run\`) to pick up the newer code.`,
      );
    }
    return { updated: false };
  }

  if (cfg.check_only) {
    const problem =
      `Large File Bridge is ${state.behindBy} commit(s) behind its remote and automatic updating is set to ` +
      `check-only, so it will keep running the current build. Update this computer's checkout to pick up the newer build.`;
    log.warn("self-update", problem);
    return { updated: false, problem };
  }

  // A dirty tree is somebody's work in progress. Postpone rather than force past it.
  const dirty = git(root, ["status", "--porcelain"]);
  if (dirty === null || dirty.length > 0) {
    const problem =
      `Large File Bridge is ${state.behindBy} commit(s) behind its remote but its source checkout at ${root} has ` +
      `uncommitted changes, so it was not updated automatically. Commit or stash them to let it update.`;
    log.warn("self-update", problem);
    return { updated: false, problem };
  }

  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") return { updated: false }; // detached — never guess where to go
  if (git(root, ["merge", "--ff-only", `origin/${branch}`]) === null) {
    const problem =
      `Large File Bridge could not fast-forward its own checkout at ${root} — the local branch has diverged from ` +
      `origin/${branch}. It is still running build ${APP_BUILD.number}. Reconcile that checkout by hand to let it update.`;
    log.warn("self-update", problem);
    return { updated: false, problem };
  }

  const after = git(root, ["rev-parse", "HEAD"]);
  if (after && after !== before) {
    log.info(
      "self-update",
      `updated Large File Bridge's source from ${before?.slice(0, 8)} to ${after.slice(0, 8)} ` +
        `(${state.behindBy} commit(s)). The source watcher will restart the app onto the new build.`,
    );
    return { updated: true };
  }
  return { updated: false };
}

/** One peer that is running an older build than this computer. */
export interface StalePeer {
  device: string;
  build: number;
  label: string;
}

/**
 * Which of the user's OTHER computers are behind this one (§6.7). This is the question that had to be
 * answered by hand while a stale peer flooded the tracking repo — a peer that predates the build field at
 * all reports 0, which is itself the answer and the loudest possible one.
 *
 * Pure: the caller supplies the registry rows, so this stays testable and free of storage plumbing.
 */
export function stalePeers(
  peers: Array<{ name: string; build: number; label?: string }>,
  selfName: string,
  ourBuild: number = APP_BUILD.number,
): StalePeer[] {
  return peers
    .filter((p) => p.name !== selfName && p.build < ourBuild)
    .map((p) => ({ device: p.name, build: p.build, label: p.label ?? "" }))
    .sort((a, b) => a.build - b.build || a.device.localeCompare(b.device));
}

/**
 * The user's other computers that are behind this one, read from the travelling device registry of every
 * storage. Never throws: a registry we cannot read is a question we cannot answer, not a fault.
 */
export async function stalePeersAcrossStorages(): Promise<StalePeer[]> {
  try {
    const { listStorageIds, getStorageRow } = await import("../storage/storage.service.js");
    const { readDevices } = await import("../storage/devices.service.js");
    const { getAppConfig: cfg } = await import("../store-model/config.service.js");
    const selfName = cfg().computer.label || "this-computer";

    // One row per DEVICE, not per (device, storage) pair — a computer in five storages is one computer.
    const byName = new Map<string, { name: string; build: number; label?: string }>();
    for (const id of listStorageIds()) {
      const row = getStorageRow(id);
      if (!row || row.type === "local") continue;
      for (const rec of readDevices(row.root)) {
        const name = rec.device.name;
        if (!name) continue;
        const seen = byName.get(name);
        // Keep the HIGHEST build seen for a computer: registries in different storages update at different
        // times, and the newest sighting is the truthful one. Being pessimistic here would nag about a
        // computer that has already been updated.
        if (!seen || rec.device.appBuild > seen.build) {
          byName.set(name, { name, build: rec.device.appBuild, label: rec.device.appBuildLabel });
        }
      }
    }
    return stalePeers([...byName.values()], selfName);
  } catch (e) {
    log.warn("self-update", `could not read peer builds: ${(e as Error).message}`);
    return [];
  }
}

/**
 * The sentence a user can act on. Names the computer, the gap, and what to do — never just "out of date".
 */
export function stalePeerMessage(peers: StalePeer[]): string | null {
  if (peers.length === 0) return null;
  const names = peers.map((p) => `${p.device} (build ${p.build || "older than build tracking"})`).join(", ");
  return (
    `${peers.length === 1 ? "Another computer is" : `${peers.length} other computers are`} running an older ` +
    `Large File Bridge than this one (this computer is on build ${APP_BUILD.number}): ${names}. ` +
    `Fixes that shipped since then are not running there — update Large File Bridge on ` +
    `${peers.length === 1 ? "that computer" : "those computers"}.`
  );
}
