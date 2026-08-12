// The AUTO-SYNC-IN pass (storage_company.mdx §14): for each COMPANY storage whose machine-local
// auto_sync_in radio is ON (default OFF), wake once an hour, run the company SDL's normal backbone cycle,
// and compare its HEAD against the stored cursor (auto_sync_in.last_seen_sha). Unchanged → shut down
// immediately (one git cycle + one string compare). Changed → teammates checked something in: for every
// repo owned by this company, pull down the files that are (1) company-owned, (2) CID'd + pinned by a
// NON-SELF device, (3) decided `sync` in the travelling ledger, and (4) absent locally — via the SAME
// pullMissing() the manual action uses, so placement, history, and sidecar events are identical.
//
// The cursor advances ONLY on a clean run (§14.3 step 5): a failed pull (holder offline, IPFS down)
// leaves it in place so the next hourly wake retries, and arms the pull-retry pass exactly like a failed
// manual pull. A cursor that advances past unfinished work is "it said it synced" data loss.
import { listStorageIds, getStorageRow } from "../storage/storage.service.js";
import {
  getStorageAutoSyncIn,
  getGitBackboneRemote,
  getOwnedRepoFolders,
  readAutoSyncCursor,
  writeAutoSyncCursor,
} from "../storage/storage-settings.service.js";
import { GitBackbone, openRepo } from "../git/git.service.js";
import { getRepoConfig } from "../store-model/units.service.js";
import { missingPinnedFromPeers, pullMissing, repoPullInFlight, syncStorageText } from "./pin.service.js";
import { schedulePullRetry } from "./pull-retry.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { track } from "../progress/progress.registry.js";
import { WorkNote } from "../progress/work-note.js";
import { log } from "../../shared/logging.js";

/** 1 hour (storage_company.mdx §14.3); `LFB_AUTO_SYNC_IN_MS` shrinks it for tests only. */
const INTERVAL_MS = Number(process.env.LFB_AUTO_SYNC_IN_MS) || 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Arm the hourly timer (idempotent). Unlike pull-retry it ALWAYS re-arms: the pass's whole contract is
 * "wake every hour, check, and vanish" — the cheap no-change run IS the steady state. Called once at boot.
 */
export function startAutoSyncIn(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void runAutoSyncIn().finally(() => startAutoSyncIn());
  }, INTERVAL_MS);
  timer.unref?.(); // a background timer must never hold the process open
  log.info("pin", `auto-sync-in armed (${Math.round(INTERVAL_MS / 60_000)} min)`);
}

/** Whether a pass is in flight right now — the manual trigger reports "already running" honestly. */
export function autoSyncInRunning(): boolean {
  return running;
}

/** The company backbone checkout's current HEAD, or null when it cannot be resolved. */
async function backboneHead(storageId: string): Promise<string | null> {
  const remote = getGitBackboneRemote(storageId);
  if (!remote) return null;
  const backbone = await GitBackbone.resolve(storageId, remote.remote);
  if (!backbone) return null;
  return (await openRepo(backbone.dir).revparse(["HEAD"]).catch(() => "")).trim() || null;
}

/** §14.2 gate 3: of the missing peer-pinned paths, keep only those the travelling ledger decided `sync`. */
function decidedSync(folder: string, missingPaths: string[]): string[] {
  const decisions = getRepoConfig(folder).decisions;
  return missingPaths.filter((p) => decisions[p] === "sync");
}

/**
 * One hourly run over every auto-sync-in company (§14.3). Each company is independent — one company's
 * failure never blocks another's — and the run never overlaps itself.
 *
 * `forceStorageId` is the storage-detail ⋮ menu's manual "Sync IPFS pinned files from peers" trigger:
 * that company joins this run even when its hourly auto_sync_in radio is OFF, without flipping the radio.
 */
export async function runAutoSyncIn(
  opts: { forceStorageId?: string } = {},
): Promise<{ companies: number; pulled: number; failed: number }> {
  if (running) return { companies: 0, pulled: 0, failed: 0 };
  running = true;
  let companies = 0;
  let totalPulled = 0;
  let totalFailed = 0;
  try {
    const enabled = listStorageIds().filter(
      (id) =>
        getStorageRow(id)?.type === "company" &&
        (getStorageAutoSyncIn(id) || id === opts.forceStorageId),
    );
    if (enabled.length === 0) return { companies: 0, pulled: 0, failed: 0 };

    // IPFS down ⇒ do nothing, loudly (§14.3): a half-run that reconciles but cannot pull would either
    // strand the cursor or advance it past undone work. Try again next hour.
    if ((await ipfs.health()) !== "ok") {
      log.warn("pin", "auto-sync-in: IPFS node unreachable — skipping this hour");
      return { companies: 0, pulled: 0, failed: 0 };
    }

    // ONE card for the whole run (webapp.mdx §12 source B). This pass runs a git cycle per company and then
    // pulls teammates' files down over IPFS — minutes of real work, on the hour, that showed NOTHING in the
    // app. The per-file detail comes from the pullMissing job each repo registers underneath.
    return await track("pin", "changes from your team", async (report) => {
      const note = new WorkNote(report);
      let doneCompanies = 0;
      report({ done: 0, total: enabled.length, unit: "companies" });
      for (const storageId of enabled) {
        companies++;
        try {
          // Step 2: refresh the company repo — fetch → merge → reconcile teammates' manifests/decisions →
          // push. syncStorageText holds the per-storage git lock (§11.3) and is single-flighted.
          note.start(storageId, storageId);
          await syncStorageText(storageId, (t) => note.detail(storageId, t));

          // Step 3: "did anything change since I last ran?"
          note.detail(storageId, "checking whether anything changed");
          const head = await backboneHead(storageId);
          if (!head) {
            log.warn("pin", `auto-sync-in: ${storageId} — no resolvable git backbone; skipping`);
            continue;
          }
          const cursor = readAutoSyncCursor(storageId);
          if (head === cursor) {
            await writeAutoSyncCursor(storageId, null); // stamp last_run_at only; nothing to do
            continue;
          }

          // Step 4: teammates checked something in — pull the qualifying set per owned repo.
          let failedHere = 0;
          let pulledHere = 0;
          let deferredHere = 0; // repos left to a pull already in progress — see repoPullInFlight below
          for (const { folder, repoRoot } of getOwnedRepoFolders(storageId)) {
            try {
              if (repoPullInFlight(repoRoot)) {
                // A pull is already moving this repo's files — the user's, or the 3-hourly retry. Starting a
                // second pass would re-derive the same list and paint a second card for one transfer
                // (pin.service.ts `fetchesInFlight`). The cursor stays put, so next hour finishes the job.
                log.info("pin", `auto-sync-in: ${folder} is already being pulled — leaving it to that run`);
                deferredHere++;
                continue;
              }
              note.detail(storageId, `checking ${folder} for files to pull`);
              const missing = await missingPinnedFromPeers(repoRoot);
              const pending = decidedSync(folder, missing.map((m) => m.path));
              if (pending.length === 0) continue;
              // The pull registers its OWN card (repo name, files done/total, per-file bytes) — this line
              // only has to say which repo the company pass is on.
              note.detail(storageId, `pulling ${pending.length} file${pending.length === 1 ? "" : "s"} into ${folder}`);
              const counts = await pullMissing(repoRoot, pending, {
                compress: false,
                by: "auto-sync-in",
                label: folder,
              });
              pulledHere += counts.pulled;
              failedHere += counts.failed;
              log.info(
                "pin",
                `auto-sync-in: ${folder} — ${counts.pulled} pulled, ${counts.failed} failed (of ${pending.length} decided)`,
              );
            } catch (e) {
              failedHere++;
              log.warn("pin", `auto-sync-in: ${folder} skipped: ${(e as Error).message}`);
            }
          }

          // Step 5: advance the cursor ONLY on a clean run; a failure leaves it and arms pull-retry.
          totalPulled += pulledHere;
          totalFailed += failedHere;
          if (failedHere > 0) {
            await writeAutoSyncCursor(storageId, null);
            schedulePullRetry(`auto-sync-in: ${failedHere} file(s) did not land for company ${storageId}`);
          } else if (deferredHere > 0) {
            // Nothing failed, but a repo was left to a pull already running — so this pass did not see the
            // head through. Stamp the run WITHOUT advancing the cursor; next hour reads the same head.
            await writeAutoSyncCursor(storageId, null);
          } else {
            await writeAutoSyncCursor(storageId, head);
          }
        } catch (e) {
          log.warn("pin", `auto-sync-in: company ${storageId} failed: ${(e as Error).message}`);
        } finally {
          note.finish(storageId);
          report({ done: ++doneCompanies, total: enabled.length, unit: "companies" });
        }
      }
      if (totalPulled + totalFailed > 0) {
        log.info("pin", `auto-sync-in: run done — ${totalPulled} pulled, ${totalFailed} failed across ${companies} company(ies)`);
      }
      return { companies, pulled: totalPulled, failed: totalFailed };
    });
  } finally {
    running = false;
  }
}
