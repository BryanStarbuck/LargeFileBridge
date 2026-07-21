// UNPUSHED-STATE HEALTH — "did this computer's storage state actually reach the shared repo?"
//
// THE DEFECT THIS CLOSES (BUG #16, observed 2026-07-20/21 in error.err):
//
//   [WARN] [git] …/act3_large_files_bridge: push rejected (…) — attempt 3/3; giving up this cycle
//
// "Giving up this cycle" was the END of the story. The commit stayed local, `result.problem` was logged
// once, and NOTHING anywhere:
//   • re-armed the push — the branch only went out again whenever some later cycle happened to fire, and
//     a machine whose cycles are all losing the same race can stay unpushed indefinitely; and
//   • told the USER. A computer that has silently stopped sharing its file list is the exact failure this
//     product exists to prevent: the other computers never learn about the new large files and the
//     machines drift apart while every screen still looks healthy.
//
// So a failed push is now a DURABLE FACT in the state root (`backbone-push-health.json`), exactly like a
// missed worker cycle (worker-misses.service.ts, the same tmp+rename write, the same "cleared by the next
// good run" rule). Two consumers read it:
//   • {@link armUnpushedRetry} — a jittered, exponentially-backed-off re-arm of that ONE storage's git
//     cycle, so the unpushed commits leave this machine minutes later instead of waiting on the next
//     scheduled worker; and
//   • {@link backbonePushStates} — the Scans page card, which says in plain English how long this
//     computer has been failing to share its state.
//
// WHY THERE IS NO CROSS-PROCESS FILE LOCK HERE. Only ONE Large File Bridge backend can exist per computer
// (shared/single-instance.ts, `backend.lock`), and the launchd worker (deploy/launchd/run-worker.mjs) does
// not do git — it POSTs a kick and the work runs inside that one backend. So the in-process
// per-storage lock (git-lock.ts) plus the working-tree gate (worktree-gate.ts) already serialize every
// git cycle on this machine. The pushes we lose to are the user's OTHER computers pushing to the same
// remote, which no local lock can ever exclude — only retry + backoff + honesty can.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import { log } from "../../shared/logging.js";
import type { BackbonePushState } from "@lfb/shared";

/** The state-root file: one entry per storage backbone working copy. Machine-local; never travels. */
export function pushHealthFile(): string {
  return path.join(resolveStateDir(), "backbone-push-health.json");
}

interface PushRecord {
  storageId: string;
  dir: string;
  repoName: string;
  lastPushAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastProblem: string | null;
  unpushedCommits: number;
}

type HealthMap = Record<string, PushRecord>;

function readAll(): HealthMap {
  try {
    const parsed = JSON.parse(fs.readFileSync(pushHealthFile(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object") return parsed as HealthMap;
  } catch {
    // absent or unparseable — "nothing recorded" is the correct answer either way
  }
  return {};
}

function writeAll(all: HealthMap): void {
  try {
    const file = pushHealthFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    // Losing this write only costs us a stale card — it must never fail a git cycle.
    log.debug("git", `recording backbone push health failed: ${(e as Error).message}`);
  }
}

/** A push landed: stamp the success and forget the failure streak (and any pending re-arm). */
export function recordPushSuccess(storageId: string, dir: string): void {
  const all = readAll();
  const prior = all[dir];
  all[dir] = {
    storageId,
    dir,
    repoName: path.basename(dir),
    lastPushAt: new Date().toISOString(),
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastProblem: null,
    unpushedCommits: 0,
  };
  writeAll(all);
  if (prior && prior.consecutiveFailures > 0) {
    log.info(
      "git",
      `${dir}: pushed again after ${prior.consecutiveFailures} failed cycle(s) — this computer is sharing its ` +
        `storage state with the user's other computers again.`,
    );
  }
  cancelUnpushedRetry(storageId);
}

/**
 * A cycle EXHAUSTED its push attempts. Record it durably and return the new consecutive-failure count so
 * the caller can log the right sentence. Never throws.
 */
export function recordPushFailure(
  storageId: string,
  dir: string,
  problem: string,
  unpushedCommits: number,
): number {
  const all = readAll();
  const prior = all[dir];
  const consecutiveFailures = (prior?.consecutiveFailures ?? 0) + 1;
  all[dir] = {
    storageId,
    dir,
    repoName: path.basename(dir),
    lastPushAt: prior?.lastPushAt ?? null,
    lastFailureAt: new Date().toISOString(),
    consecutiveFailures,
    lastProblem: problem,
    unpushedCommits,
  };
  writeAll(all);
  return consecutiveFailures;
}

/**
 * What the UI shows (Scans page). Only storages that currently have an OUTSTANDING failure are returned —
 * a healthy backbone is not news, and the page must not grow a row per storage forever.
 */
export function backbonePushStates(): BackbonePushState[] {
  return Object.values(readAll())
    .filter((r) => r && r.consecutiveFailures > 0)
    .map((r) => ({
      storageId: r.storageId,
      repoName: r.repoName ?? path.basename(r.dir ?? ""),
      lastPushAt: r.lastPushAt ?? null,
      lastFailureAt: r.lastFailureAt ?? null,
      consecutiveFailures: r.consecutiveFailures,
      unpushedCommits: r.unpushedCommits ?? 0,
      problem: r.lastProblem ?? null,
    }))
    .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);
}

// ── the re-arm ────────────────────────────────────────────────────────────────────────────────────────
//
// A cycle that gave up must not wait for the next scheduled worker (10–15 min) or a page load. It re-runs
// ITSELF, soon, with an exponential + JITTERED delay. Jitter matters twice over: it keeps this machine's
// two storages from retrying in lockstep, and it keeps two of the USER'S COMPUTERS — running identical
// code against the same remote, which is exactly how these rejections happen — from colliding forever on
// the same deterministic schedule.

const RETRY_BASE_MS = 60_000; // first re-arm ≈ 1 minute after giving up
const RETRY_CAP_MS = 15 * 60_000; // never slower than the scheduled workers themselves

/** Jittered exponential delay for the Nth consecutive failure (1-based). Pure but for `rnd` — testable. */
export function unpushedRetryDelayMs(consecutiveFailures: number, rnd: () => number = Math.random): number {
  const n = Math.max(1, Math.min(consecutiveFailures, 10));
  const base = Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_CAP_MS);
  return Math.round(base * (0.75 + rnd() * 0.5)); // ±25% full-spectrum jitter
}

const timers = new Map<string, NodeJS.Timeout>();

/** Drop any pending re-arm for this storage (its push landed, or a newer one supersedes it). */
export function cancelUnpushedRetry(storageId: string): void {
  const t = timers.get(storageId);
  if (!t) return;
  clearTimeout(t);
  timers.delete(storageId);
}

/**
 * Re-run this storage's git cycle after a jittered backoff, so unpushed commits are never simply left
 * behind by the cycle that failed. At most one re-arm per storage is ever pending; a success cancels it.
 */
export function armUnpushedRetry(storageId: string, consecutiveFailures: number): void {
  cancelUnpushedRetry(storageId);
  const wait = unpushedRetryDelayMs(consecutiveFailures);
  const t = setTimeout(() => {
    timers.delete(storageId);
    void (async () => {
      try {
        // LAZY import: pin.service imports the git module, so a static import here is a cycle.
        const { syncStorageText } = await import("../pin/pin.service.js");
        log.info("git", `storage ${storageId}: retrying the push that could not be delivered earlier.`);
        await syncStorageText(storageId);
      } catch (e) {
        log.warn("git", `storage ${storageId}: unpushed-state retry failed: ${(e as Error).message}`);
      }
    })();
  }, wait);
  t.unref?.(); // a pending retry must never hold the process open
  timers.set(storageId, t);
  log.info(
    "git",
    `storage ${storageId}: ${consecutiveFailures} cycle(s) in a row could not push — retrying in ` +
      `${Math.round(wait / 1000)}s (the commits stay queued locally until they land).`,
  );
}

/** TEST-ONLY: how many re-arms are pending. */
export function pendingRetryCount(): number {
  return timers.size;
}
