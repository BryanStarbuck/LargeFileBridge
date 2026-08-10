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
import fs from "node:fs";
import path from "node:path";
import { listRepoFolders, getRepoConfig } from "../store-model/units.service.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { missingPinnedFromPeers, pullMissing } from "./pin.service.js";
import { resolveStateSyncRepo } from "../storage/tracking-root.service.js";
import { readDevices } from "../storage/devices.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { track } from "../progress/progress.registry.js";
import { WorkNote } from "../progress/work-note.js";
import { log } from "../../shared/logging.js";
import { resolveHome } from "../../shared/home-path.js";

/** 3 hours (per the product ask); `LFB_PULL_RETRY_MS` shrinks it for tests only. */
const RETRY_MS = Number(process.env.LFB_PULL_RETRY_MS) || 3 * 60 * 60 * 1000;

/**
 * How soon after boot a pending retry runs when the clock says one is already due (or overdue).
 * Not zero: the IPFS daemon is usually still coming up at this point, and a retry that runs before it
 * answers just burns the attempt. 90 seconds is past that and still inside the window where the user who
 * just restarted the app is watching.
 */
const BOOT_DUE_DELAY_MS = Number(process.env.LFB_PULL_RETRY_BOOT_MS) || 90_000;

/**
 * WHEN THE NEXT RETRY IS DUE — A DURABLE FACT IN THE STATE ROOT, not a `setTimeout` and nothing else.
 *
 * THE DEFECT THIS CLOSES. The retry was a bare in-memory `setTimeout(3h)`, re-armed from scratch at boot.
 * So every restart threw away however long the user had already waited and started the three hours over.
 * Restart more often than every three hours and the automatic retry NEVER RUNS — and restarting is
 * precisely what a person does when they are trying to make a stuck transfer happen. Measured on
 * Bryan_Tower 2026-08-10: sixteen `pull-retry armed (180 min)` lines in one afternoon and one single run,
 * while the pull-down count sat at 10 looking abandoned. The user's report was exactly that: "I pulled
 * them, then I restarted the web app, and it lost them."
 *
 * The intent was never lost — the pull records its decision in the ledger before transferring, so the
 * files stay decided across restarts. What was lost is the SCHEDULE. Persisting it here means a restart
 * RESUMES the remaining wait instead of resetting it, and an overdue retry runs a minute after boot
 * instead of three hours later.
 *
 * Same shape as backbone-push-health.json (bug #16, push-health.service.ts): a small machine-local JSON
 * fact, tmp+rename, absent-or-unparseable reads as "nothing recorded". This is that same fix on the pull
 * side, which is the side the user actually watches.
 */
function retryStateFile(): string {
  return path.join(resolveStateDir(), "pull-retry-state.json");
}

interface PullRetryState {
  /** ISO time the next attempt is due. Absent/unparseable ⇒ nothing scheduled. */
  dueAt: string | null;
  lastRunAt: string | null;
  lastReason: string | null;
}

function readRetryState(): PullRetryState {
  try {
    const parsed = JSON.parse(fs.readFileSync(retryStateFile(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object") return parsed as PullRetryState;
  } catch {
    // absent or unparseable — "nothing scheduled" is the correct answer either way
  }
  return { dueAt: null, lastRunAt: null, lastReason: null };
}

function writeRetryState(next: PullRetryState): void {
  try {
    const file = retryStateFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    // Losing this write costs us one reset wait, never a transfer — it must not fail a pull.
    log.debug("pin", `recording pull-retry schedule failed: ${(e as Error).message}`);
  }
}

/** Milliseconds until the persisted due time, or null when nothing is scheduled. Negative ⇒ overdue. */
function msUntilDue(): number | null {
  const raw = readRetryState().dueAt;
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t - Date.now() : null;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Same one-liner the routers use: the folder's configured working-tree root, `~`-expanded. */
function repoRootFor(folder: string): string {
  return resolveHome(getRepoConfig(folder).repo.path);
}

/**
 * Arm the retry timer (idempotent — an armed timer stays as it is), and RECORD when it is due so the
 * schedule survives a restart. Called at boot and whenever a pull reports failures; the run itself
 * re-arms while anything is still pending.
 *
 * `resume: true` (the boot path) keeps the time already served: it waits only the REMAINDER of the
 * persisted due time, and runs shortly if that time has already passed. Without it a restart is a reset,
 * which is the bug — see `retryStateFile`.
 */
export function schedulePullRetry(reason: string, opts: { resume?: boolean } = {}): void {
  if (timer) return;
  let waitMs = RETRY_MS;
  if (opts.resume) {
    const remaining = msUntilDue();
    if (remaining === null) {
      waitMs = RETRY_MS; // nothing was scheduled — this is a genuinely new wait
    } else if (remaining <= 0) {
      waitMs = BOOT_DUE_DELAY_MS; // already due (often long overdue): run it, don't start the clock over
    } else {
      waitMs = Math.min(remaining, RETRY_MS); // resume the remainder, never extend it
    }
  }
  writeRetryState({ ...readRetryState(), dueAt: new Date(Date.now() + waitMs).toISOString(), lastReason: reason });
  timer = setTimeout(() => {
    timer = null;
    void runPullRetry();
  }, waitMs);
  timer.unref?.(); // a retry timer must never hold the process open
  log.info(
    "pin",
    `pull-retry armed (${Math.round(waitMs / 60_000)} min${opts.resume && waitMs !== RETRY_MS ? ", resumed" : ""}): ${reason}`,
  );
}

/** Forget the schedule — nothing is pending, so a restart must not resurrect a due retry. */
function clearPullRetrySchedule(): void {
  writeRetryState({ dueAt: null, lastRunAt: new Date().toISOString(), lastReason: null });
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
    // ONE card for the retry sweep (webapp.mdx §12 source B). It runs on a 3-hour timer, dials peers, and
    // can move a lot of bytes — and it showed nothing at all, which is exactly why "the files never arrive"
    // reads as "nothing is happening" rather than "we are still trying".
    const folders = listRepoFolders();
    await track("pin", "files still waiting from another computer", async (report) => {
      const note = new WorkNote(report);
      let doneRepos = 0;
      report({ done: 0, total: folders.length, unit: "repos" });
      for (const folder of folders) {
        note.start(folder, folder);
        try {
          let repoRoot: string;
          let pending: string[];
          let missing: Awaited<ReturnType<typeof missingPinnedFromPeers>>;
          try {
            note.detail(folder, "checking what is still missing");
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
                  // Each dial has its own 20s budget and there can be several — say WHICH computer we are
                  // calling, so a long wait is legible as "reaching your laptop", not as a hang.
                  note.detail(folder, `calling ${dev.device.name}`);
                  const ok = await ipfs.swarmConnect(dev.device.ipfsPeerId);
                  log.info("pin", `pull-retry: dial ${dev.device.name} (${dev.device.ipfsPeerId}) -> ${ok ? "connected" : "unreachable"}`);
                }
              }
            } catch (e) {
              log.warn("pin", `pull-retry: device dial skipped for ${folder}: ${(e as Error).message}`);
            }
          }

          note.detail(folder, `retrying ${pending.length} file${pending.length === 1 ? "" : "s"}`);
          const counts = await pullMissing(repoRoot, pending, { compress: false, by: "pull-retry", label: folder });
          totalPulled += counts.pulled;
          stillPending += counts.failed;
          log.info(
            "pin",
            `pull-retry: ${folder} — ${counts.pulled} pulled, ${counts.failed} still waiting (of ${pending.length} decided)`,
          );
        } finally {
          note.finish(folder);
          report({ done: ++doneRepos, total: folders.length, unit: "repos" });
        }
      }
    });
  } finally {
    running = false;
    writeRetryState({ ...readRetryState(), lastRunAt: new Date().toISOString() });
    if (stillPending > 0) {
      schedulePullRetry(`${stillPending} decided file(s) still waiting on an offline computer`);
    } else {
      clearPullRetrySchedule();
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
        // RESUME, never restart. The wait already served before the app closed still counts — that is the
        // whole point of persisting the due time.
        schedulePullRetry("boot: decided pulls are still waiting for their bytes", { resume: true });
        return;
      }
    }
    clearPullRetrySchedule();
    log.info("pin", "pull-retry: no decided pulls pending at boot — timer not armed");
  } catch (e) {
    // When the check itself fails we cannot prove "nothing pending" — arm the timer; a no-op run is cheap.
    log.warn("pin", `pull-retry boot check failed (arming timer anyway): ${(e as Error).message}`);
    schedulePullRetry("boot: pending check failed — assuming pending", { resume: true });
  }
}
