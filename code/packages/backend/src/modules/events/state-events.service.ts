// The in-process STATE-REVISION BUS (storage_company.mdx §8.9, one_repo.mdx §4.11).
//
// The problem it exists to solve: a page already open in the browser had no way to learn that server-side
// state changed. A backbone pull could reconcile a peer's manifest, produce three new remote-only rows, and
// the One-Repo page would sit there showing the old list until the user happened to reload. A user staring
// at a silently stale page cannot tell it apart from a broken sync — which is exactly the failure
// storage_company.mdx §8 is written to prevent.
//
// The shape is deliberately minimal: every write that changes what a page shows bumps a MONOTONIC revision
// for a TOPIC, and subscribers are told the topic + its new revision. NO payload travels — the bump says
// "what you have is stale", and the client re-asks through the normal authenticated `/api` route it already
// uses. That keeps the stream cheap, keeps authorization on exactly one path, and means a missed bump is
// self-healing (the next bump carries a higher revision and re-triggers the same refetch).
//
// Revisions are per-process and start at 0. They are NOT persisted and are NOT comparable across restarts —
// a client that reconnects simply takes whatever `hello` reports as its new baseline. That is correct: after
// a backend restart the client's cached data is stale by definition, and the reconnect refetch covers it.
import { log } from "../../shared/logging.js";

/**
 * A topic names a slice of server state a page can be watching.
 *
 *   • `repo:<folder>` — one repo's detail (rows, metrics, status). The One-Repo page's topic.
 *   • `repos`         — the repo LIST (a repo registered/unregistered, a rollup count changed).
 *   • `storages`      — the storage list / a storage's own state.
 *
 * Topics are plain strings so a caller can mint `repo:charlie-kirk` without a registry. Callers should use
 * the helpers below rather than composing the string by hand.
 */
export type StateTopic = string;

export function repoTopic(folder: string): StateTopic {
  return `repo:${folder}`;
}
export const REPOS_TOPIC: StateTopic = "repos";
export const STORAGES_TOPIC: StateTopic = "storages";

export interface StateBump {
  topic: StateTopic;
  revision: number;
}

type Subscriber = (bump: StateBump) => void;

const revisions = new Map<StateTopic, number>();
const subscribers = new Set<Subscriber>();

/**
 * Record that `topic`'s server state changed and tell every live subscriber.
 *
 * MUST NEVER THROW. This is called from inside write paths (`writeRepoManifest`, the reconcile fold, the
 * scanner's status write) whose job is to persist data — a notification failure must never fail the write
 * that succeeded. A subscriber that throws is logged and dropped, not retried: a broken stream is one
 * client's problem, and letting it take down the bus would stall every other page.
 *
 * Returns the topic's new revision (useful in tests; callers normally ignore it).
 */
export function bumpTopic(topic: StateTopic): number {
  const next = (revisions.get(topic) ?? 0) + 1;
  revisions.set(topic, next);
  for (const fn of [...subscribers]) {
    try {
      fn({ topic, revision: next });
    } catch (e) {
      // Drop the bad subscriber rather than let it poison the bus for everyone else.
      subscribers.delete(fn);
      log.warn("events", `subscriber threw on ${topic} and was dropped: ${(e as Error).message}`);
    }
  }
  return next;
}

/** Bump several topics at once (one write often changes a repo AND the list rollup above it). */
export function bumpTopics(topics: readonly StateTopic[]): void {
  for (const t of new Set(topics)) bumpTopic(t);
}

/**
 * Listen for bumps. Returns an unsubscribe function — the stream handler MUST call it on client disconnect
 * or the set grows without bound for the life of the process.
 */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * A snapshot of every topic's current revision — sent in the stream's `hello` so a reconnecting client can
 * tell "nothing moved while I was gone" from "I missed something" without a special-case protocol.
 */
export function currentRevisions(): Record<StateTopic, number> {
  return Object.fromEntries(revisions);
}

/** How many streams are currently attached — for the health/diagnostics surface, and for tests. */
export function subscriberCount(): number {
  return subscribers.size;
}
