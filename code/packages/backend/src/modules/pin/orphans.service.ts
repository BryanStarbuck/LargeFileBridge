// DELETED-HERE DETECTION (decisions.mdx §12 "Delete").
//
// A decided file with no bytes on this computer is TWO completely different situations wearing the same
// face, and the pin pass has to tell them apart before it moves a single byte:
//
//   • never here — a second computer that hasn't pulled the file down yet. Healthy. It is the whole point
//     of the pull-down offer, and fetch-missing SHOULD bring it down.
//   • gone from here — this computer pinned those bytes and now they're absent, i.e. the user deleted the
//     file. Fetching it back is the "surprise re-pinning" §12 forbids, and it is exactly why deleting a
//     synced file used to accomplish nothing: the next pass quietly restored it from our own pin.
//
// The manifest already carries the distinguishing fact — our own label in `pinned_by`, or the CID still
// sitting in our pinset. That is the delete signal, and it is the only one acted on.
//
// A deletion is not acted on IMMEDIATELY, because an unmounted external drive, a repo mid-checkout, and a
// file being rewritten in place all look identical to one for a moment. §12 calls for a grace period: the
// record is held, re-fetching stops at once, and only once the period lapses is the decision returned to
// Undecided and this computer's pin dropped.
//
// Kept as a pure function so the rule is testable without an IPFS daemon, a repo, or a filesystem.

/** One held deletion: when the absence was first noticed, and the CID this computer had pinned for it. */
export interface OrphanRecord {
  first_seen_at: string;
  cid: string | null;
}

/** The manifest facts this classification needs about one path. Undefined ⇒ no manifest entry at all. */
export interface OrphanEntryFacts {
  cid: string | null;
  pinned_by: string[];
}

export interface ClassifyAbsentArgs {
  /** Decided paths with no bytes on this computer right now. */
  absent: readonly string[];
  entryFor: (rel: string) => OrphanEntryFacts | undefined;
  /** Does this node's pinset really hold this CID (content-aware, so a foreign add profile counts)? */
  heldHere: (cid: string) => boolean;
  /** This computer's `pinned_by` label. */
  label: string;
  /** The orphan records carried on the unit's status from previous passes. */
  prior: Readonly<Record<string, OrphanRecord>>;
  nowMs: number;
  graceMs: number;
  /**
   * VETO on the deletion verdict: "some OTHER unit on this computer is holding these exact bytes on disk
   * right now, at this same relative path."
   *
   * Both delete signals below are computer-wide facts, not unit-local ones. `pinned_by` carries this
   * COMPUTER's label (every unit on the machine publishes the same one), and `heldHere` asks the ONE IPFS
   * node, whose pinset every unit shares. So when the same repo is registered twice — two clones of one
   * remote, `~/BGit/work/charlie-kirk` and `~/BGit/Bryan_git/charlie-kirk` — the clone that DOES have the
   * bytes puts the CID in the shared pinset, and the clone that does not then reads that pin as proof it
   * once held the file and the user deleted it. Measured on bryan-mac-pro 2026-08-19: 41 videos, every
   * pass logging `deleted here 41`, never fetched, and 24h from being unpinned and reset to Undecided.
   *
   * A twin holding the bytes explains the pin WITHOUT a deletion, so the file falls back to the healthy
   * never-here answer and the pull-down materializes it. Optional: omitted ⇒ no twin ⇒ prior behavior
   * exactly, which is what every single-registration unit sees.
   */
  bytesHeldByLocalTwin?: (rel: string) => boolean;
}

export interface ClassifyAbsentResult {
  /** Never here — a pull-down offer. Not a deletion; nothing is held or staled for these. */
  missing: string[];
  /** Deleted here and still inside the grace period. These must NOT be re-fetched this pass. */
  orphans: Record<string, OrphanRecord>;
  /** Orphans whose grace period has lapsed: tombstone the decision, drop this computer's pin. */
  stale: string[];
}

/**
 * Split the decided-but-absent paths into "never here" and "deleted here", carry the grace period forward,
 * and name the ones whose grace has run out.
 *
 * Reappearance is handled by omission: a path that is no longer absent simply isn't in `absent`, so its
 * prior record is not carried forward — the bytes came back, the record is live again, and §12's "no
 * surprise re-asking" holds without any extra branch.
 */
/**
 * The orphan map a pass WRITES BACK, given what it just classified.
 *
 * A whole-repo pass looked at every decided file, so its result is the whole answer. A PATHS-SCOPED pass —
 * the bulk "Pin now (selected)", and the targeted pin every decision click fires — only classified the paths
 * it was given, and writing that map wholesale erased every other file's `first_seen_at`. With a click or
 * two a day the 24h grace never lapsed, so a file deleted here was never staled back to Undecided (§12).
 * Scoped runs therefore carry the untouched records forward; within the scope, this run's verdict is
 * authoritative — including "no longer absent", which is expressed by simply not being in `fresh`.
 */
export function mergeOrphans(
  prior: Readonly<Record<string, OrphanRecord>>,
  fresh: Readonly<Record<string, OrphanRecord>>,
  scope?: ReadonlySet<string>,
): Record<string, OrphanRecord> {
  if (!scope) return { ...fresh };
  const merged = { ...prior };
  for (const rel of scope) delete merged[rel];
  return Object.assign(merged, fresh);
}

export function classifyAbsent(args: ClassifyAbsentArgs): ClassifyAbsentResult {
  const { absent, entryFor, heldHere, label, prior, nowMs, graceMs, bytesHeldByLocalTwin } = args;
  const missing: string[] = [];
  const orphans: Record<string, OrphanRecord> = {};
  for (const rel of absent) {
    const entry = entryFor(rel);
    // "We had these bytes" — the delete signal. No CID means we never recorded the file at all, which
    // cannot be a deletion of something we pinned.
    const heldByUs = !!entry?.cid && (entry.pinned_by.includes(label) || heldHere(entry.cid));
    // ...unless a TWIN unit on this same computer is holding those bytes on disk right now. Both halves of
    // the signal above are computer-wide (see `bytesHeldByLocalTwin`), so a second registration of the same
    // repo satisfies them without this unit ever having had the file. The twin explains the pin; there is
    // no deletion to infer, and this stays the healthy never-here pull-down offer.
    if (!heldByUs || bytesHeldByLocalTwin?.(rel)) {
      missing.push(rel);
      continue;
    }
    orphans[rel] = prior[rel] ?? { first_seen_at: new Date(nowMs).toISOString(), cid: entry?.cid ?? null };
  }
  const stale = Object.entries(orphans)
    .filter(([, o]) => {
      const seen = Date.parse(o.first_seen_at);
      // An unparseable timestamp must not stale a file instantly (NaN comparisons are false either way, but
      // being explicit keeps a corrupt status file from ever reading as "grace expired long ago").
      return Number.isFinite(seen) && nowMs - seen >= graceMs;
    })
    .map(([rel]) => rel);
  return { missing, orphans, stale };
}
