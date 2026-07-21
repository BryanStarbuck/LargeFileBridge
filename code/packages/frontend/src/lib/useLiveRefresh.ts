// LIVE REFRESH — an open page learns that server state changed, instead of waiting to be reloaded
// (storage_company.mdx §8.9, one_repo.mdx §4.11, performance.mdx Aspect 6a/6b).
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
// ONE CONNECTION PER TAB (storage_company.mdx §8.9.4, LOCKED). Every `useLiveRefresh` call registers with
// a module-level SHARED connection — it must NOT open its own stream. The shell alone mounts three
// always-on subscribers (AppShell, ScanProgressBar, ProgressContext) plus one or two per routed page;
// per-hook connections would hold 4–5 streams against the browser's ~6-per-origin HTTP/1.1 cap and starve
// media/API requests. The stream opens when the first subscriber registers and closes when the last leaves.
//
// HIDDEN TABS STAY QUIET (§8.9.4). A bump for a tab the user cannot see is REMEMBERED, not acted on —
// the invalidation runs when the tab becomes visible again. This is the same instinct
// `refetchIntervalInBackground: false` encodes: background tabs do no work.
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

// ── The shared connection (module-level singleton) ────────────────────────────────────────────────

interface Subscriber {
  /** Live topic set — read per event so a re-render's new topics apply without re-registering. */
  topics: () => ReadonlySet<string>;
  /** Invalidate this subscriber's query keys (its own closure over its queryClient + keys). */
  invalidate: () => void;
}

const subscribers = new Set<Subscriber>();
/** Subscribers whose bump arrived while the tab was hidden — flushed on visibilitychange. */
const deferred = new Set<Subscriber>();
let streamAbort: AbortController | null = null;
let visibilityHooked = false;

function invalidateOrDefer(sub: Subscriber): void {
  if (typeof document !== "undefined" && document.hidden) deferred.add(sub);
  else sub.invalidate();
}

function hookVisibility(): void {
  if (visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // The tab is visible again — run every deferred re-read exactly once, still-registered only.
    for (const sub of [...deferred]) {
      deferred.delete(sub);
      if (subscribers.has(sub)) sub.invalidate();
    }
  });
}

/** Open the shared stream if it isn't running. One connection serves every subscriber in this tab. */
function ensureStream(): void {
  if (streamAbort) return;
  const ac = new AbortController();
  streamAbort = ac;
  hookVisibility();

  let attempt = 0;

  const onEvent = (raw: unknown): void => {
    const ev = raw as StateStreamEvent;
    if (!ev || typeof ev !== "object") return;
    // A delivered line of ANY type proves the stream is healthy — reset the backoff so a long-lived
    // connection that finally drops reconnects fast rather than at the last failure's 30s.
    attempt = 0;
    if (ev.type !== "bump") return;
    for (const sub of [...subscribers]) {
      if (sub.topics().has(ev.topic)) invalidateOrDefer(sub);
    }
  };

  void (async () => {
    while (!ac.signal.aborted && subscribers.size > 0) {
      try {
        await streamNdjson("/events/stream", { signal: ac.signal, onEvent });
        // A clean end means the server closed the stream (restart, shutdown). Reconnect — but treat it
        // as a failure for backoff purposes so a backend in a crash loop is not hammered.
      } catch (e) {
        if (ac.signal.aborted) break;
        clientLog.warn("useLiveRefresh.stream", e);
      }
      if (ac.signal.aborted || subscribers.size === 0) break;
      // On reconnect, refetch once per subscriber: whatever changed while we were disconnected is
      // exactly what the open pages are now missing, and the `hello` snapshot alone cannot tell us
      // which keys those were.
      for (const sub of [...subscribers]) invalidateOrDefer(sub);
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    // Only the OWNING loop may clear the slot — a stale loop ending late must not tear down a
    // successor stream another mount already opened.
    if (streamAbort === ac) streamAbort = null;
  })();
}

function register(sub: Subscriber): () => void {
  subscribers.add(sub);
  ensureStream();
  return () => {
    subscribers.delete(sub);
    deferred.delete(sub);
    if (subscribers.size === 0) {
      // Last subscriber gone (auth gate closed, tests unmounting) — release the connection.
      streamAbort?.abort();
      streamAbort = null;
    }
  };
}

// ── The hook ──────────────────────────────────────────────────────────────────────────────────────

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

  // Hold the live values in refs so a changed `topics`/`keys` array identity (new array every render, as
  // is idiomatic at call sites) neither re-registers the subscriber nor misses the newest topic set —
  // the shared dispatcher reads them through `topics()` at event time.
  const topicsRef = useRef(topics);
  const keysRef = useRef(keys);
  topicsRef.current = topics;
  keysRef.current = keys;

  useEffect(() => {
    const sub: Subscriber = {
      topics: () => new Set(topicsRef.current.filter(Boolean) as string[]),
      invalidate: () => {
        for (const key of keysRef.current) {
          void qc.invalidateQueries({ queryKey: key });
        }
      },
    };
    return register(sub);
  }, [qc]);
}

/** The topic string for one repo's detail — mirrors `repoTopic()` on the backend. Kept as a helper so no
 *  call site hand-composes the string and drifts from the server's format. */
export function repoTopic(folder: string): string {
  return `repo:${folder}`;
}
