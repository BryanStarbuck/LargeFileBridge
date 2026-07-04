// A tiny pub/sub bridge so the STREAMED Full Paths listing keeps getting the optimistic per-entity
// badge patches (performance.mdx P-17). The flat large-file table left React Query for the NDJSON
// stream (P-23), so patchEntityBadges' setQueryData(["fsFlat"]) no longer reaches it. Instead the
// streaming hook subscribes here, and patchEntityBadges emits here too — so a flag/decision change
// from a row's ⋯ menu still flips that row's chips immediately, with no re-walk.
import type { FsBadge } from "@lfb/shared";
import { clientLog } from "./clientLog.js";

type Subscriber = (path: string, badges: FsBadge[]) => void;

const subscribers = new Set<Subscriber>();

/** Register a patcher (the streamed listing's setFiles). Returns an unsubscribe for cleanup. */
export function subscribeFlatBadgePatch(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Flip one path's badges across every live streamed listing. */
export function emitFlatBadgePatch(path: string, badges: FsBadge[]): void {
  // Isolate each subscriber: a throwing patcher (e.g. a torn-down listing's stale setState) must not
  // stop the remaining live listings from getting the same badge patch.
  for (const fn of subscribers) {
    try {
      fn(path, badges);
    } catch (e) {
      clientLog.error("flatListingPatch.emit", e);
    }
  }
}
