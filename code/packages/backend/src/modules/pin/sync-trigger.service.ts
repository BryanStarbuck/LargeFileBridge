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

/** §18.4 — coalesce a burst of artifact writes into one pass shortly after the burst ends. */
const DEBOUNCE_MS = 20_000;
/** §18.4 — but never let a continuously-writing batch defer the checkpoint indefinitely. */
const MAX_DELAY_MS = 120_000;

interface Pending {
  timer: NodeJS.Timeout;
  /** When the first write of this burst landed — the clock for MAX_DELAY_MS. */
  firstNotedAt: number;
  /** Why we're syncing, for the log line — e.g. "3 AI descriptions". */
  reasons: Map<string, number>;
}

const pending = new Map<string, Pending>();

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

async function fire(storageId: string, reasons: Map<string, number>): Promise<void> {
  const what = [...reasons.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
  try {
    // LAZY import — breaks the module cycle pin.service → jobqueue → describe.service → (here) → pin.service.
    // A static import would make Node evaluate pin.service while describe.service is still initializing.
    const { syncStorageText } = await import("./pin.service.js");
    const r = await syncStorageText(storageId);
    if (r.problem) {
      log.warn("sync", `artifact sync for storage ${storageId} (${what}) reported: ${r.problem}`);
    } else if (r.committed || r.pushed) {
      log.info("sync", `artifact sync for storage ${storageId}: ${what} → committed=${r.committed ?? false} pushed=${r.pushed ?? false}`);
    }
  } catch (e) {
    // Never throw into an artifact writer's success path: the file IS written; failing to sync it is a
    // reportable fault, not a reason to fail the description the user is waiting on.
    log.warn("sync", `artifact sync for storage ${storageId} (${what}) failed: ${(e as Error).message}`);
  }
}

/**
 * Note that a durable artifact was written at `absPath`, and schedule that storage's text to be committed
 * and pushed (storage_personal.mdx §18.5.3.1 — "the write IS the trigger").
 *
 * Fire-and-forget and best-effort by contract: an artifact writer calls this as the last step of its own
 * operation and never awaits it. A path under no directory-based storage (a working repo, a loose file) is a
 * no-op here — working repos are governed by git_backbone.mdx / git_ignore.mdx, and LFB is a GUEST there, so
 * it must never auto-commit them (§16.1: the repo's classification is the license for the algorithm).
 */
export function noteArtifactWritten(absPath: string, kind: string): void {
  let storageId: string | null;
  try {
    storageId = storageIdForPath(absPath);
  } catch (e) {
    log.warn("sync", `could not resolve a storage for ${absPath}: ${(e as Error).message}`);
    return;
  }
  if (!storageId) return; // not in a dedicated LFB file repo — not ours to commit.

  const now = Date.now();
  const prev = pending.get(storageId);
  const reasons = prev?.reasons ?? new Map<string, number>();
  reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
  const firstNotedAt = prev?.firstNotedAt ?? now;

  if (prev) clearTimeout(prev.timer);

  // §18.4 — debounce, but never past MAX_DELAY_MS from the first write of this burst.
  const elapsed = now - firstNotedAt;
  const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_DELAY_MS - elapsed));

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
