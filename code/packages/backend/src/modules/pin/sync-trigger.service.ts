// PRODUCING A DURABLE ARTIFACT SCHEDULES ITS OWN SYNCHRONIZATION (storage_personal.mdx §18.5.3 — LOCKED).
//
// The defect this module exists to repeal (storage_personal.mdx §18.5.1, "the stowaway defect"): NO code path
// in LFB had "commit the user's finished work" as its purpose. The artifact writers (describe / transcribe /
// ocr) wrote a file and returned; nothing observed them. Transcripts and AI descriptions reached the server
// ONLY as STOWAWAYS on a commit made for an unrelated reason — the every-10-min DEVICE worker updating one
// small `devices/<self>.yaml` and, on its way past, running the pathspec-less `git add -A` in
// git.service.ts's `commitAndPush`, which swept up whatever else happened to be lying in the tree.
//
// Proven live on 2026-07-16: `git show --stat HEAD` on the Personal SDL read `13 files changed` = 12
// `.ai_description` files (2,385 lines of the user's work) + one `devices/bryan-mac-pro.yaml` — the only file
// the pass INTENDED to commit — all titled "LFB: backbone device state". Because the commit was a side
// effect, its timing was governed by something with no relationship to the work: observed gaps of 21 and 30
// minutes on a 10-minute worker, and six silent forever-cases (§18.5.2 F1–F6) that sever the ride with no
// diagnostic anywhere.
//
// THE ACCEPTANCE TEST (§18.5.3.4 / AC-30): if the device worker were deleted tomorrow, artifacts must still
// reach the server on time. That is why this module calls `syncStorageText` — the GIT-ONLY cycle — and never
// depends on the device worker or on the pin worker (which is, on the reference machine, `installed: false`
// entirely — AC-30 / §16.2(b2)).
//
// Cadence (§18.4): 20s debounce so a 300-file describe batch produces ONE pass ~20s after the last write,
// not 300 passes and not a 10-minute wait; 120s max delay so a continuously-writing batch still checkpoints.
import path from "node:path";
import { log } from "../../shared/logging.js";
import { listStorageIds, getStorageRow } from "../storage/storage.service.js";
import { expandHome } from "../fs/badges.js";
import { workingRepoRootForArtifact } from "../storage/artifact-committability.service.js";
import { isTransientNetworkError, hostFromGitError, whenOnline } from "../../shared/net-transient.js";

/** §18.4 — coalesce a burst of artifact writes into one pass shortly after the burst ends. */
const DEBOUNCE_MS = 20_000;
/** §18.4 — but never let a continuously-writing batch defer the checkpoint indefinitely. */
const MAX_DELAY_MS = 120_000;
/** First retry after a failed pass (jittered ±25%); doubles per consecutive failure. */
const RETRY_BASE_MS = 60_000;
/** Backoff ceiling — a persistently broken backbone is retried at most this often. */
const RETRY_MAX_MS = 30 * 60_000;
/** After this many consecutive failures on one storage, escalate WARN → ERROR. */
const ESCALATE_AFTER = 5;

interface Pending {
  timer: NodeJS.Timeout;
  /** When the first write of this burst landed — the clock for MAX_DELAY_MS. */
  firstNotedAt: number;
  /** Why we're syncing, for the log line — e.g. "3 AI descriptions". */
  reasons: Map<string, number>;
}

const pending = new Map<string, Pending>();

/** Consecutive-failure state per storage — drives the retry backoff and the escalation. */
interface FailState {
  count: number;
  /** Earliest time the next attempt for this storage may run (backoff floor). */
  notBefore: number;
}
const failures = new Map<string, FailState>();

/**
 * Resolve which directory-based storage owns an absolute path, by LONGEST matching root prefix.
 *
 * Deliberately NOT `findStorageRootForPath` (storage.service.ts): that walks up probing for a `.lfbridge/`
 * dir or a root `storage.yaml`, and the live Personal SDL has NEITHER (storage_personal.mdx §16.2(i) — its
 * root metadata was never written), so the probe walks straight past it and returns null. Matching against
 * the discovered rows keeps the trigger working on the repos that exist today rather than the ones the spec
 * wishes existed. Longest-prefix so a company SDL nested under a broader root still wins.
 */
function storageIdForPath(absPath: string): string | null {
  const target = path.resolve(absPath);
  let bestId: string | null = null;
  let bestLen = -1;
  for (const id of listStorageIds()) {
    const row = getStorageRow(id);
    if (!row || row.type === "local" || row.type === "repo") continue;
    const root = path.resolve(expandHome(row.root));
    // Prefix match on a PATH BOUNDARY: `/a/b` must not claim `/a/bcd`.
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    if (root.length > bestLen) {
      bestLen = root.length;
      bestId = id;
    }
  }
  return bestId;
}

/** A pending-map key for a WORKING repo target (vs. a storage id) — the artifact lives in
 *  `<repo>/.lfbridge/` and is delivered by repo-artifact-sync.service.ts, not by the SDL pin cycle. */
const REPO_TARGET_PREFIX = "repo:";

/** The storage's on-disk repo root, for the log line — the reader must know WHICH repo git failed in. */
function storageRootForLog(storageId: string): string {
  if (storageId.startsWith(REPO_TARGET_PREFIX)) return storageId.slice(REPO_TARGET_PREFIX.length);
  try {
    const row = getStorageRow(storageId);
    return row ? path.resolve(expandHome(row.root)) : "unknown root";
  } catch {
    return "unknown root";
  }
}

/** Full diagnostic text for a thrown error — message, cause chain, never a bare toString of an object. */
function errDetail(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
  return `${e.message}${cause}`;
}

/** Name the known PERSISTENT git-failure shapes so the log explains itself instead of just quoting stderr. */
function classifyGitFailure(detail: string): string {
  if (/index\.lock|Another git process/i.test(detail))
    return " [another git process holds the index — likely concurrent auto-commit; contention clears on its own]";
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(detail)) return " [push rejected by remote — non-fast-forward]";
  if (/unmerged|needs merge|not concluded|MERGE_HEAD/i.test(detail)) return " [repo has an unfinished merge / unmerged files]";
  if (/detached/i.test(detail)) return " [repo is on a detached HEAD]";
  return "";
}

/** Jittered exponential backoff for the n-th consecutive failure (±25% so retries never align). */
function backoffMs(count: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** (count - 1), RETRY_MAX_MS);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/**
 * Record a failed pass: log the REAL cause with repo path, and schedule a retry at a jittered,
 * exponentially growing interval. Without this the artifact sat uncommitted until the NEXT artifact
 * write happened along — and when writes kept coming, a broken backbone was retried every debounce
 * with the identical failure and no growing interval.
 */
function noteFailure(storageId: string, reasons: Map<string, number>, what: string, detail: string): void {
  // OFFLINE IS NOT A FAILURE (bug #15). "Could not resolve host" / "Resolving timed out" means the lid was
  // shut or the wifi was mid-switch — the artifact is fine, the remote is fine, there is simply no network
  // this second. Counting it would (a) write laptop weather into the durable fault trail, (b) escalate to
  // ERROR after five blips, and (c) push the retry out to the 30-minute backoff ceiling for something that
  // typically clears in seconds. So: leave the consecutive-failure state UNTOUCHED, say it at INFO, and
  // re-fire the pass the moment the remote's host resolves again.
  if (isTransientNetworkError(detail)) {
    log.info(
      "sync",
      `artifact sync for storage ${storageId} (${storageRootForLog(storageId)}; ${what}) postponed — ` +
        `this computer is offline (${detail.split("\n")[0]}); retrying when the network returns`,
    );
    if (pending.has(storageId)) return; // a queued pass already covers this storage
    whenOnline(`artifact sync ${storageId}`, hostFromGitError(detail), () => {
      void fire(storageId, reasons);
    });
    return;
  }
  const prev = failures.get(storageId);
  const count = (prev?.count ?? 0) + 1;
  const delay = backoffMs(count);
  failures.set(storageId, { count, notBefore: Date.now() + delay });

  const line =
    `artifact sync for storage ${storageId} (${storageRootForLog(storageId)}; ${what}) failed` +
    `${count > 1 ? ` (${count} consecutive)` : ""}: ${detail}${classifyGitFailure(detail)}` +
    ` — retrying in ~${Math.round(delay / 1000)}s`;
  if (count >= ESCALATE_AFTER) log.error("sync", line);
  else log.warn("sync", line);

  // Schedule the retry ourselves — unless new writes already queued a pass, which covers the same repo.
  if (pending.has(storageId)) return;
  const timer = setTimeout(() => {
    pending.delete(storageId);
    void fire(storageId, reasons);
  }, delay);
  timer.unref?.();
  pending.set(storageId, { timer, firstNotedAt: Date.now(), reasons });
}

async function fire(storageId: string, reasons: Map<string, number>): Promise<void> {
  const what = [...reasons.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
  // A WORKING-repo target: deliver via the scoped `.lfbridge/`-pathspec commit + push
  // (repo-artifact-sync.service.ts), never the SDL pin cycle. Same failure backoff either way.
  if (storageId.startsWith(REPO_TARGET_PREFIX)) {
    const root = storageId.slice(REPO_TARGET_PREFIX.length);
    try {
      const { syncWorkingRepoArtifacts } = await import("./repo-artifact-sync.service.js");
      const r = await syncWorkingRepoArtifacts(root);
      if (r.problem) {
        noteFailure(storageId, reasons, what, r.problem);
        return;
      }
      failures.delete(storageId);
      if (r.committed || r.pushed) {
        log.info("sync", `working-repo artifact sync for ${root}: ${what} → committed=${r.committed} pushed=${r.pushed}`);
      }
    } catch (e) {
      noteFailure(storageId, reasons, what, errDetail(e));
    }
    return;
  }
  try {
    // LAZY import — breaks the module cycle pin.service → jobqueue → describe.service → (here) → pin.service.
    // A static import would make Node evaluate pin.service while describe.service is still initializing.
    const { syncStorageText } = await import("./pin.service.js");
    const r = await syncStorageText(storageId);
    if (r.problem) {
      // A contained git problem (pull/push failed inside the cycle) is still a FAILED delivery — the
      // artifact is not on the server. Same backoff as a throw; `r.problem` carries git's own stderr.
      noteFailure(storageId, reasons, what, r.problem);
      return;
    }
    const prevCount = failures.get(storageId)?.count ?? 0;
    failures.delete(storageId);
    if (prevCount >= ESCALATE_AFTER) {
      log.info("sync", `artifact sync for storage ${storageId} recovered after ${prevCount} consecutive failures`);
    }
    if (r.committed || r.pushed) {
      log.info("sync", `artifact sync for storage ${storageId}: ${what} → committed=${r.committed ?? false} pushed=${r.pushed ?? false}`);
    }
  } catch (e) {
    // Never throw into an artifact writer's success path: the file IS written; failing to sync it is a
    // reportable fault, not a reason to fail the description the user is waiting on.
    noteFailure(storageId, reasons, what, errDetail(e));
  }
}

/**
 * Note that a durable artifact was written at `absPath`, and schedule that storage's text to be committed
 * and pushed (storage_personal.mdx §18.5.3.1 — "the write IS the trigger").
 *
 * Fire-and-forget and best-effort by contract: an artifact writer calls this as the last step of its own
 * operation and never awaits it.
 *
 * A WORKING-repo artifact (a path under `<repo>/.lfbridge/`) is delivered by the scoped
 * `.lfbridge/`-pathspec commit + push (repo-artifact-sync.service.ts `syncWorkingRepoArtifacts`) — the
 * GUEST rule (§16.1) survives narrowed to what it protects: LFB never commits the USER'S content in a
 * working repo, but the `.lfbridge/` quarantine is LFB's OWN output, and leaving it to ride some
 * unrelated auto-commit is the stowaway defect (§18.5.1) all over again. Proven live on charlie-kirk,
 * 2026-07-20: 158 finished `.ai_description` + 59 `.transcription` files stranded on one computer with a
 * clean `git status`, the second computer reporting all of it as still-to-do.
 *
 * The artifact must also be COMMITTABLE — a `.gitignore` that excludes `.lfbridge/` strands it silently.
 * Guard implemented in: artifact-committability.service.ts, ensureArtifactCommittable().
 * A loose path in neither an SDL nor a working repo's quarantine is a no-op here.
 */
export function noteArtifactWritten(absPath: string, kind: string): void {
  // Fire-and-forget by contract (see ensureArtifactCommittable — never throws). Runs for EVERY artifact
  // write, including working-repo ones that fall out below at `if (!storageId) return`.
  void import("../storage/artifact-committability.service.js")
    .then((m) => m.ensureArtifactCommittable(absPath))
    .catch((e) => log.warn("sync", `committability guard failed for ${absPath}: ${(e as Error).message}`));

  let storageId: string | null;
  try {
    storageId = storageIdForPath(absPath);
  } catch (e) {
    log.warn("sync", `could not resolve a storage for ${absPath}: ${(e as Error).message}`);
    return;
  }
  if (!storageId) {
    // Not in an SDL — a WORKING-repo quarantine artifact gets its own delivery target (see fire()).
    const repoRoot = workingRepoRootForArtifact(path.resolve(expandHome(absPath)));
    if (!repoRoot) return; // a loose path — not ours to commit.
    storageId = REPO_TARGET_PREFIX + repoRoot;
  }

  const now = Date.now();
  const prev = pending.get(storageId);
  const reasons = prev?.reasons ?? new Map<string, number>();
  reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
  const firstNotedAt = prev?.firstNotedAt ?? now;

  if (prev) clearTimeout(prev.timer);

  // §18.4 — debounce, but never past MAX_DELAY_MS from the first write of this burst.
  const elapsed = now - firstNotedAt;
  let delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_DELAY_MS - elapsed));
  // A storage in failure backoff keeps its floor: new writes join the pending pass but must not
  // collapse the retry interval back to the 20s debounce (that was the tight loop).
  const fail = failures.get(storageId);
  if (fail) delay = Math.max(delay, fail.notBefore - now);

  const timer = setTimeout(() => {
    pending.delete(storageId);
    void fire(storageId, reasons);
  }, delay);
  // Never hold the process open for a debounce timer.
  timer.unref?.();

  pending.set(storageId, { timer, firstNotedAt, reasons });
}

/**
 * Force any debounced work to run NOW — the batch-completion hook (§18.4, jobqueue.service.ts), which
 * bypasses the debounce because a finished batch is a natural checkpoint and the user is watching for it.
 */
export function flushArtifactSync(): void {
  for (const [storageId, p] of [...pending.entries()]) {
    clearTimeout(p.timer);
    pending.delete(storageId);
    void fire(storageId, p.reasons);
  }
}
