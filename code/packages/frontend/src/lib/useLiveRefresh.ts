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
import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { streamNdjson } from "./streamNdjson.js";
import { clientLog } from "./clientLog.js";

type StateStreamEvent =
  | { type: "hello"; revisions: Record<string, number> }
  | { type: "bump"; topic: string; revision: number }
  | { type: "heartbeat" };

/** Reconnect backoff. A backend restart or a laptop waking from sleep must recover on its own, but a
 *  backend that is genuinely down must not be hammered — so the delay grows and then holds at 30s. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

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
    if (!topicKey) return; // nothing to watch yet (id still resolving) — don't open a stream
    const ac = new AbortController();
    let attempt = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const invalidate = (): void => {
      for (const key of keysRef.current) {
        void qc.invalidateQueries({ queryKey: key });
      }
    };

    const onEvent = (raw: unknown): void => {
      const ev = raw as StateStreamEvent;
      if (!ev || typeof ev !== "object") return;
      // A delivered line of ANY type proves the stream is healthy — reset the backoff so a long-lived
      // connection that finally drops reconnects fast rather than at the last failure's 30s.
      attempt = 0;
      if (ev.type !== "bump") return;
      const watched = new Set(topicsRef.current.filter(Boolean) as string[]);
      if (!watched.has(ev.topic)) return;
      invalidate();
    };

    const connect = async (): Promise<void> => {
      while (!stopped) {
        try {
          await streamNdjson("/events/stream", { signal: ac.signal, onEvent });
          // A clean end means the server closed the stream (restart, shutdown). Reconnect — but treat it as
          // a failure for backoff purposes so a backend in a crash loop is not hammered.
        } catch (e) {
          if (ac.signal.aborted || stopped) return;
          clientLog.warn("useLiveRefresh.stream", e);
        }
        if (stopped || ac.signal.aborted) return;
        // On reconnect, refetch once: whatever changed while we were disconnected is exactly what this
        // page is now missing, and the `hello` snapshot alone cannot tell us which keys those were.
        invalidate();
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        });
      }
    };

    void connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ac.abort();
    };
  }, [topicKey, qc]);
}

/** The topic string for one repo's detail — mirrors `repoTopic()` on the backend. Kept as a helper so no
 *  call site hand-composes the string and drifts from the server's format. */
export function repoTopic(folder: string): string {
  return `repo:${folder}`;
}
