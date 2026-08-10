// THE DEVICE HEARTBEAT FLOOR (devices.mdx §7.1) — a LEAF module, because the floor has to hold at TWO
// layers that must not import each other: the WRITER (`writeSelfDevice`, which declines to re-stamp a
// device record whose meaning has not changed) and the COMMITTER (the git backbone's quiet gate, which
// reverts a staged change whose only difference is volatile). Both suppressions are correct on their own
// and, together, they made this computer's published liveness signal stop dead.
//
// What that cost, measured 2026-08-10: this Mac Pro's device record in the Act3 storage was stamped
// 2026-08-03 — the last day anything SUBSTANTIVE about it changed. `deviceRows()` reads a peer's
// `lastSeen` straight off that field, so every other computer concluded this one had been offline for a
// week, and pull-downs failed with "<computer> looks offline. Bring it online and try again." about
// computers that were running the whole time. Neither layer was wrong; nobody owned the floor.
//
// Fixing only the committer would have changed nothing: the writer never dirties the file, so the gate
// never sees it. Both layers consult this module, so the guarantee is one fact in one place.

/**
 * How stale a device heartbeat may get before both layers let one through.
 *
 * Six hours: short enough that "is this computer alive?" has a useful answer — the alternative was a stamp
 * frozen for a week — and long enough that heartbeats cost at most 4 writes (and 4 commits) per computer
 * per day. That is two orders of magnitude below the churn the suppressions exist to stop: the quiet gate
 * was written against 2,322 device-file commits in 7 days, which was one per PASS, every few minutes.
 */
export const HEARTBEAT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Has a device record's stamp aged past the floor? An absent or unparseable stamp answers YES on purpose:
 * a record nobody can date is exactly the one whose liveness we cannot vouch for, and letting it through
 * re-stamps it correctly instead of freezing the fault in place forever.
 */
export function heartbeatIsStale(doc: Record<string, unknown> | null | undefined, now = Date.now()): boolean {
  const raw = doc?.updated_at;
  if (typeof raw !== "string") return true;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return true;
  return now - t > HEARTBEAT_MAX_AGE_MS;
}
