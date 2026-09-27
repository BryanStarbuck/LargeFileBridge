/**
 * THE APP BUILD NUMBER — "does that computer have the fix?" in one integer (git_backbone.mdx §6.7).
 *
 * Every computer publishes this in its device file, so the whole fleet's build state is visible from any
 * one of them. That question had to be answered by HAND on 2026-07-29, by noticing that one device file was
 * missing fields the current schema publishes — while that stale computer kept emitting a commit every ~16
 * minutes and no code fix could reach it.
 *
 * WHY A DELIBERATE INTEGER AND NOT THE GIT SHA. The obvious move is to publish the code repo's HEAD sha.
 * That would be a **churn machine**: this repo is continuously auto-committed, so the sha changes every few
 * minutes, and publishing it into a SYNCED file would manufacture exactly the commit-per-cycle flood §6.6
 * exists to stop — a self-inflicted wound of precisely the shape we just finished removing. The sha is
 * still used for the LOCAL "am I running older code than my own checkout?" check, where nothing is
 * published and nothing can churn.
 *
 * BUMP THIS when a change matters to other computers — a sync/churn fix, a schema field others must
 * publish, a protocol change. Do NOT bump it for a typo or a UI tweak; a build number that moves for
 * everything tells the fleet nothing.
 */
export const APP_BUILD = {
  /** Monotonic. Higher = newer. Compared across computers to find who is behind. */
  number: 7,
  /** What this build is, in a few words — shown next to the number so a stale peer is self-explaining. */
  label: "fleet compatibility: writer-stamped records, semantic merges in git, no rewrites of unchanged meaning",
} as const;

export type AppBuild = typeof APP_BUILD;

/**
 * WHAT AN OLDER BUILD IS KNOWN TO DO TO SHARED DATA (backward_compatibility.md §6).
 *
 * A stale peer cannot be fixed from here — its code is its code until someone updates it. What THIS build
 * can do is (a) refuse to amplify what the old code writes, and (b) say precisely what the old code does, so
 * "update that computer" comes with a reason. Every build that fixes a behaviour other computers can SEE
 * adds a row: `below` is the first build WITHOUT the defect, so a peer with `build < below` still has it.
 *
 * `defended` states what this build does about it, so the message a user reads never promises more than the
 * code delivers.
 */
export interface KnownFleetDefect {
  /** Builds strictly below this still have the defect. */
  below: number;
  /** Short id, cited in logs and in backward_compatibility.md. */
  id: string;
  /** What the older build does, in one sentence a user can read. */
  does: string;
  /** What this build does about it. */
  defended: string;
}

export const KNOWN_FLEET_DEFECTS: readonly KnownFleetDefect[] = [
  {
    below: 7,
    id: "P-56 tombstone re-stamp",
    does: "re-records every fleet-deleted file as Undecided on every pass, rewriting the decision ledger",
    defended: "re-stamps are recognised as unchanged meaning and never written back to the shared copy",
  },
  {
    below: 7,
    id: "P-57 deletion twins",
    does: "keeps a deletion twice after its checksum is filled in, and writes the pair in varying order",
    defended: "twins are folded on read and a difference of order alone is never written back",
  },
  {
    below: 7,
    id: "P-52 line-union merge",
    does: "merges the structured YAML documents line by line, which can leave a file no reader can open",
    defended: "damaged documents are healed on read; this build merges them with a semantic git merge driver",
  },
];

/** The defects a peer on `build` still has. A peer that predates build tracking reports 0 — all of them. */
export function defectsOfBuild(build: number): KnownFleetDefect[] {
  return KNOWN_FLEET_DEFECTS.filter((d) => build < d.below);
}

/** GET /api/health/fleet — the fleet's compatibility picture, from this computer (backward_compatibility.md §6). */
export interface FleetCompat {
  build: number;
  label: string;
  /** Computers on an older build, with what that build is known to do to shared data. */
  stalePeers: Array<{ device: string; build: number; label: string; defects: KnownFleetDefect[] }>;
  /** Shared files the tug-of-war breaker is holding (sync-fight.ts). */
  fights: Array<{ file: string; since: string; held: number }>;
}
