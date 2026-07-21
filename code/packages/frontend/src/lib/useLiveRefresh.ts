// LIVE REFRESH — an open page learns that server state changed, instead of waiting to be reloaded
// (storage_company.mdx §8.9, one_repo.mdx §4.11, performance.mdx).
//
// THE FAILURE THIS REMOVES. Another of the user's computers pins a file; the git backbone carries the
// manifest here; the reconcile folds it in and three new remote-only rows now exist on the server. The One
// Repo page sitting open in the browser shows none of them, because `["repo", repoId]` has no reason to
// refetch. The user sees a page that looks exactly like a broken sync — and cannot tell the difference.
//
// WHY A STREAM AND NOT A POLL. performance.mdx LOCKS "no background polling" (`refetchIntervalInBackground:
// false`, and P-07 names a global 5s poll as a defect). This is the mechanism that lets that rule HOLD: one
// request is made and then the client sits idle until the server actually has something to say. Zero
// requests are spent on "did anything change?" — the server answers that unasked.
//
// WHY NOT SSE. `EventSource` cannot set an Authorization header, and every /api call must carry the
// OpenAuth federated Bearer token — an SSE endpoint would bypass the allow-list gate. So this rides the
// same authenticated `fetch` + NDJSON transport the Full Paths table already uses (`streamNdjson`).
//
// NO PAYLOAD TRAVELS. A bump says only "topic X is at revision N" — the page re-asks through its normal
// authenticated route. Authorization stays on exactly one path, and a missed bump self-heals because the
// next one carries a higher revision and re-triggers the same invalidation.
//
// ONE CONNECTION PER TAB. Every call site here shares the single stream owned by `liveStream.ts` and gets
// its events fanned out in memory. A tab mounts this hook four-plus times at once (AppShell, the progress
// context, the scan bar, the routed page) — one connection each would blow past the browser's ~6
// connections-per-origin limit and starve ordinary /api calls, which is exactly the failure that made
// streams die with "network error" while the page kept showing frozen data.
//
// HIDDEN TABS STAY QUIET (storage_company.mdx §8.9.4, LOCKED). The connection persists — it costs nothing
// while idle — but a bump for a page the user cannot see REMEMBERS the re-read and runs it when the tab
// becomes visible again. This is the same instinct `refetchIntervalInBackground: false` encodes: a
// background tab does no work. Deferral lives here rather than in `liveStream.ts` because it is per
// subscriber (each hook has its own query keys), while the connection itself is per tab.
import { useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { subscribeLive, subscribeLiveStatus, liveStatus, type LiveStatus, type StateStreamEvent } from "./liveStream.js";

/**
 * Subscribe to the server's state-event stream and invalidate query keys when a watched topic bumps.
 *
 * @param topics  Topics to watch, e.g. `["repo:charlie-kirk", "repos"]`. A `null`/`undefined` entry is
 *                ignored, so a caller can pass `repoId ? repoTopic(repoId) : null` before its id resolves.
 * @param keys    The react-query keys to invalidate when any watched topic bumps.
 *
 * GRACEFUL DEGRADATION: if the stream cannot be opened at all, the page keeps working exactly as it does
 * today — the user reloads to see new data. It NEVER falls back to a poll, because a silent fallback poll
 * is how the locked no-polling rule gets quietly repealed.
 */
export function useLiveRefresh(
  topics: ReadonlyArray<string | null | undefined>,
  keys: ReadonlyArray<QueryKey>,
): void {
  const qc = useQueryClient();

  // Hold the live values in refs so a changed `topics`/`keys` array identity (new array every render, as is
  // idiomatic at call sites) does NOT tear down and reopen the stream. Only the topic CONTENT matters.
  const topicsRef = useRef(topics);
  const keysRef = useRef(keys);
  topicsRef.current = topics;
  keysRef.current = keys;

  // The dependency is the topic content, not the array — join it so `["repo:x"]` re-renders don't reconnect.
  const topicKey = topics.filter(Boolean).join("|");

  useEffect(() => {
    if (!topicKey) return; // nothing to watch yet (id still resolving) — don't attach

    const runInvalidate = (): void => {
      for (const key of keysRef.current) {
        void qc.invalidateQueries({ queryKey: key });
      }
    };

    // A bump for a tab the user cannot see is REMEMBERED, not acted on (§8.9.4, LOCKED). Collapsing to a
    // single boolean is deliberate: ten bumps while hidden still cost exactly one re-read on return, and
    // the refetch reads current server state anyway, so replaying each one would be pure waste.
    let pending = false;
    const invalidate = (): void => {
      if (typeof document !== "undefined" && document.hidden) pending = true;
      else runInvalidate();
    };

    const onVisible = (): void => {
      if (document.hidden || !pending) return;
      pending = false;
      runInvalidate();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }

    const unsubscribe = subscribeLive((ev: StateStreamEvent) => {
      // A dropped connection just came back: whatever changed while this tab was disconnected is exactly
      // what it is now missing, and the `hello` snapshot alone cannot say which keys those were — so
      // refetch this hook's keys once, unconditionally.
      if (ev.type === "reconnect") {
        invalidate();
        return;
      }
      if (ev.type !== "bump") return;
      const watched = new Set(topicsRef.current.filter(Boolean) as string[]);
      if (!watched.has(ev.topic)) return;
      invalidate();
    });

    return () => {
      unsubscribe();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [topicKey, qc]);
}

/**
 * The tab's live-connection status, for UI that must TELL the user when updates have stopped flowing.
 *
 * A page that quietly shows stale pin status and frozen sync progress is indistinguishable from a broken
 * sync — the banner this feeds (`LiveUpdatesBanner`) is what makes the difference visible.
 */
export function useLiveStatus(): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(() => liveStatus());
  useEffect(() => {
    setStatus(liveStatus()); // catch a transition that happened between render and effect
    return subscribeLiveStatus(setStatus);
  }, []);
  return status;
}

/** The topic string for one repo's detail — mirrors `repoTopic()` on the backend. Kept as a helper so no
 *  call site hand-composes the string and drifts from the server's format. */
export function repoTopic(folder: string): string {
  return `repo:${folder}`;
}
