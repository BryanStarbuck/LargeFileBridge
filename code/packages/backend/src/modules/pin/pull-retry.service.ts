// The PULL-RETRY pass (warnings.mdx §10.8.12 C.3): every 3 hours, retry user-DECIDED pulls whose bytes
// still haven't arrived because the only computer holding them looks offline.
//
// Scope is deliberately narrow: ONLY files where the user already chose Add to IPFS (decision `sync`)
// but the bytes never landed here — the exact set the pull-down popup's failed Apply leaves behind. The
// 15-minute pin pass also retries these (fetch-missing), but this pass adds the one thing that pass
// doesn't do: a DIRECT DIAL of the holder device's IPFS peer (`swarm/connect /p2p/<peerId>` from the
// travelling device registry) before pulling, so a laptop that just woke up behind NAT is found by
// asking, not by waiting on passive discovery.
//
// Self-stopping: the timer re-arms ONLY while something is still pending. When a run finds nothing left
// to pull (every decided file landed), it logs and does NOT reschedule — zero background work at zero
// pending. It re-arms from its kick points: server boot, and every pull-down Apply that reports failures
// (`POST /:repoId/pull` in repos.router.ts).
import path from "node:path";
import { listRepoFolders, getRepoConfig } from "../store-model/units.service.js";
import { missingPinnedFromPeers, pullMissing } from "./pin.service.js";
import { resolveStateSyncRepo } from "../storage/tracking-root.service.js";
import { readDevices } from "../storage/devices.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { log } from "../../shared/logging.js";

/** 3 hours (per the product ask); `LFB_PULL_RETRY_MS` shrinks it for tests only. */
const RETRY_MS = Number(process.env.LFB_PULL_RETRY_MS) || 3 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Same one-liner the routers use: the folder's configured working-tree root, `~`-expanded. */
function repoRootFor(folder: string): string {
  const p = getRepoConfig(folder).repo.path;
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/**
 * Arm the 3-hour retry timer (idempotent — an armed timer stays as it is). Called at boot and whenever a
 * pull reports failures; the run itself re-arms while anything is still pending.
 */
export function schedulePullRetry(reason: string): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void runPullRetry();
  }, RETRY_MS);
  timer.unref?.(); // a retry timer must never hold the process open
  log.info("pin", `pull-retry armed (${Math.round(RETRY_MS / 60_000)} min): ${reason}`);
}

/** The decided-but-not-here set for one repo: peer-pinned files missing locally whose decision is `sync`. */
function pendingFor(folder: string, missingPaths: string[]): string[] {
  const decisions = getRepoConfig(folder).decisions;
  return missingPaths.filter((p) => decisions[p] === "sync");
}

/**
 * One retry run over every tracked repo. For each repo with pending decided pulls: dial each distinct
 * holder device's IPFS peer directly (the nudge), then run the normal `pullMissing` (provider probe +
 * pin + materialize + sidecar/history events). Files that land drop out of `missingPinnedFromPeers` on
 * the next computation — the "tracking list" is DERIVED, never a second ledger to maintain. Re-arms
 * itself iff anything is still pending afterwards.
 */
export async function runPullRetry(): Promise<{ pending: number; pulled: number }> {
  if (running) return { pending: 0, pulled: 0 }; // never overlap two runs
  running = true;
  let stillPending = 0;
  let totalPulled = 0;
  try {
    if ((await ipfs.health()) !== "ok") {
      log.info("pin", "pull-retry: IPFS node unreachable — will try again next cycle");
      stillPending = 1; // unknown, assume pending so the timer re-arms
      return { pending: stillPending, pulled: 0 };
    }
    for (const folder of listRepoFolders()) {
      let repoRoot: string;
      let pending: string[];
      let missing: Awaited<ReturnType<typeof missingPinnedFromPeers>>;
      try {
        repoRoot = repoRootFor(folder);
        missing = await missingPinnedFromPeers(repoRoot);
        pending = pendingFor(folder, missing.map((m) => m.path));
      } catch (e) {
        log.warn("pin", `pull-retry: skipped ${folder}: ${(e as Error).message}`);
        continue;
      }
      if (pending.length === 0) continue;

      // The nudge: dial each distinct holder device's IPFS peer directly. Peer ids come from the
      // travelling device registry in the owning sync repo (devices/<name>.yaml → device.ipfs_peer_id).
      const holders = new Set(
        missing.filter((m) => pending.includes(m.path)).map((m) => m.addedByDevice).filter((d): d is string => !!d),
      );
      const syncRepo = resolveStateSyncRepo(repoRoot);
      if (syncRepo && holders.size > 0) {
        try {
          for (const dev of readDevices(syncRepo)) {
            if (holders.has(dev.device.name) && dev.device.ipfsPeerId) {
              const ok = await ipfs.swarmConnect(dev.device.ipfsPeerId);
              log.info("pin", `pull-retry: dial ${dev.device.name} (${dev.device.ipfsPeerId}) -> ${ok ? "connected" : "unreachable"}`);
            }
          }
        } catch (e) {
          log.warn("pin", `pull-retry: device dial skipped for ${folder}: ${(e as Error).message}`);
        }
      }

      const counts = await pullMissing(repoRoot, pending, { compress: false, by: "pull-retry" });
      totalPulled += counts.pulled;
      stillPending += counts.failed;
      log.info(
        "pin",
        `pull-retry: ${folder} — ${counts.pulled} pulled, ${counts.failed} still waiting (of ${pending.length} decided)`,
      );
    }
  } finally {
    running = false;
    if (stillPending > 0) {
      schedulePullRetry(`${stillPending} decided file(s) still waiting on an offline computer`);
    } else {
      log.info("pin", "pull-retry: nothing pending — timer stops until a pull fails again");
    }
  }
  return { pending: stillPending, pulled: totalPulled };
}

/**
 * Boot kick: arm the timer only if something is actually pending (cheap derived check, no transfers).
 * Called once from main.ts after the app is up.
 */
export async function schedulePullRetryIfPending(): Promise<void> {
  try {
    for (const folder of listRepoFolders()) {
      const repoRoot = repoRootFor(folder);
      const missing = await missingPinnedFromPeers(repoRoot);
      if (pendingFor(folder, missing.map((m) => m.path)).length > 0) {
        schedulePullRetry("boot: decided pulls are still waiting for their bytes");
        return;
      }
    }
    log.info("pin", "pull-retry: no decided pulls pending at boot — timer not armed");
  } catch (e) {
    // When the check itself fails we cannot prove "nothing pending" — arm the timer; a no-op run is cheap.
    log.warn("pin", `pull-retry boot check failed (arming timer anyway): ${(e as Error).message}`);
    schedulePullRetry("boot: pending check failed — assuming pending");
  }
}
