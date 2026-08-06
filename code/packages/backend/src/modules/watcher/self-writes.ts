// OUR OWN WRITES ARE NOT NEWS (scan.mdx §2.2.1). A leaf module: one map, no imports beyond node.
//
// THE FAILURE THIS REMOVES. A pin pass pulls six files down over IPFS and writes them into the working
// tree. Each landing `.mp4` is, to the filesystem watcher, exactly what a user dropping a video in would
// look like — a qualifying add of a big media file — so each one kicked a discovery rescan: a walk of
// every repo plus a TO DO recalc, 60–105s apiece, running CONCURRENTLY with the downloads still in
// flight and competing with them for the same disk. Measured on the 2026-08-06 Windows run: 619 MB of
// transfers took 22 minutes, and the rescans were the loudest thing on the box that was not the transfer.
//
// The rescan learns nothing, either. The pin pass already knows the file — it chose it from the manifest,
// fetched it, pinned it, and records the arrival itself. The scan is being asked to discover a file the
// caller just put there on purpose.
//
// WHY A WINDOW AND NOT A FLAG. The watcher's event can arrive well after the write returns (FSEvents
// coalesces; a network volume is slower still), so "suppressed while the pass runs" would miss the tail.
// A path is claimed at the moment we write it and stays claimed for {@link SELF_WRITE_TTL_MS}, then the
// claim expires on its own — nothing has to remember to release it, and a leaked claim cannot outlive the
// window even if a pass dies mid-flight.
//
// WHAT THIS DOES NOT SUPPRESS. Only the RESCAN TRIGGER, and only for the exact absolute paths we wrote.
// A user dropping their own file in during a pin pass still wakes the watcher. And nothing here can hide
// a file permanently: the 4-hour full scan (and the pass's own tracking writes) see it regardless — the
// window only decides whether the discovery walk happens NOW, in the middle of the transfer that created
// the file, or later when the disk is quiet.
//
// Implemented in `code/packages/backend/src/modules/watcher/self-writes.ts` — `noteOwnWrite()` /
// `isOwnRecentWrite()`; claimed by `modules/pin/pin.service.ts` at each `catToFile`, honoured by
// `modules/watcher/watcher.service.ts` — `isQualifying()`.
import path from "node:path";

/** How long a path we wrote stays ours. Comfortably longer than any watcher debounce (1.5s default) plus
 *  the coalescing a platform may add on top, and short enough that a user's own later edit of the same
 *  file still wakes the watcher promptly. */
export const SELF_WRITE_TTL_MS = 5 * 60_000;

/** Hard ceiling on remembered paths. A pass that pulls tens of thousands of files must not grow this
 *  without bound; the oldest claims are dropped first, and dropping one only means an extra rescan. */
const MAX_TRACKED = 20_000;

/** absolute path (normalized) → the moment the claim expires. Insertion order is age order, which is what
 *  makes the eviction below a plain shift of the front. */
const claims = new Map<string, number>();

/** Windows hands the same file back with either slash and either drive-letter case depending on which API
 *  produced it; a claim that does not match the watcher's spelling is a claim that does nothing. */
function key(abs: string): string {
  const norm = path.normalize(abs);
  return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/** Claim a path this process is about to write (or has just written), so the watcher does not treat its
 *  appearance as a user action worth rescanning the computer for. */
export function noteOwnWrite(abs: string): void {
  const k = key(abs);
  claims.delete(k); // re-insert so the entry moves to the BACK, keeping insertion order == age order
  claims.set(k, Date.now() + SELF_WRITE_TTL_MS);
  while (claims.size > MAX_TRACKED) {
    const oldest = claims.keys().next();
    if (oldest.done) break;
    claims.delete(oldest.value);
  }
}

/** Did WE write this path, recently enough that its appearance is not news? Expired claims are dropped as
 *  they are found, so an idle process sheds them without a timer. */
export function isOwnRecentWrite(abs: string): boolean {
  const k = key(abs);
  const until = claims.get(k);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    claims.delete(k);
    return false;
  }
  return true;
}

/** How many claims are live — for the watcher's transparency state and for specs. Prunes as it counts. */
export function ownWriteCount(): number {
  const now = Date.now();
  for (const [k, until] of claims) if (now >= until) claims.delete(k);
  return claims.size;
}

/** TEST-ONLY: forget every claim. */
export function resetOwnWrites(): void {
  claims.clear();
}
