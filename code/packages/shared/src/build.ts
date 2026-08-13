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
  number: 6,
  /** What this build is, in a few words — shown next to the number so a stale peer is self-explaining. */
  label: "a disproved wrapper CID cannot survive ANY merge, local or wire; corrections audited and published",
} as const;

export type AppBuild = typeof APP_BUILD;
