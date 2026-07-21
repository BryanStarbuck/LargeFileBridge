// THE ONE live state-event connection per browser tab (performance.mdx Aspect 6b, storage_company.mdx §8.9).
//
// WHY THIS MODULE EXISTS — the bug it fixes. `useLiveRefresh` used to open its OWN `fetch` stream per call
// site. A single tab mounts several of them at once (AppShell + ProgressContext + ScanProgressBar + the
// routed page, and MediaViewer/child components on top), and each one holds a browser connection open
// FOREVER. HTTP/1.1 allows only ~6 concurrent connections per origin, so four-plus permanent streams
// starved everything else the tab needed: ordinary `/api` calls queued behind them and eventually failed
// ("AxiosError: Network Error" from sessionPing), and a stream that lost the race died with
// "TypeError: network error". The page then looked live while showing frozen pin status and sync progress.
//
// The fix is structural: ONE connection per tab, fanned out in memory to every subscriber. Connection count
// is now O(1) in the number of components, not O(n).
//
// It also owns the three things a long-lived stream needs and none of the call sites should reimplement:
//   • RECONNECT with exponential backoff + jitter (a backend restart or a laptop waking from sleep must
//     self-heal; a backend that is genuinely down must not be hammered, and 20 tabs must not retry in lockstep).
//   • A STALL WATCHDOG. The server sends a heartbeat every 25s, so silence longer than STALL_MS means the
//     connection is dead in a way the socket never reported — reconnect instead of sitting on a corpse.
//   • EXPECTED-vs-REAL disconnect. A page unload/navigation or an offline laptop tears the stream down by
//     design; warning about it just fills the fault trail with noise that hides the real failures.
//
// It exposes a STATUS so the UI can say "live updates paused" out loud rather than silently showing stale
// data — the whole point of the module is that a user never mistakes a dead stream for a quiet one.
import { streamNdjson } from "./streamNdjson.js";
import { clientLog } from "./clientLog.js";

/** What the server sends, plus one client-only event. */
export type StateStreamEvent =
  | { type: "hello"; revisions: Record<string, number> }
  | { type: "bump"; topic: string; revision: number }
  | { type: "heartbeat" }
  /** Client-side only: a dropped stream just came back. Whatever changed while we were gone is exactly
   *  what this tab is now missing, and `hello` alone cannot say which topics those were — so subscribers
   *  refetch unconditionally on this one. */
  | { type: "reconnect" };

export type LiveStatus =
  /** No connection yet in this tab (first attempt, or retrying before we ever succeeded). */
  | "connecting"
  /** Connected — bumps are flowing. */
  | "live"
  /** We were live, the connection dropped, and we are retrying. Data on screen may be stale. */
  | "reconnecting";

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Server heartbeat is 25s. Two missed beats plus slack = dead, even if the socket never said so. */
const STALL_MS = 70_000;
const STALL_CHECK_MS = 5_000;

/**
 * Backoff for reconnect attempt `attempt` (0-based), with HALF-TO-FULL JITTER.
 *
 * Jitter matters here: without it every tab (and every one of the user's computers running the app)
 * retries on the same 1/2/4/8s grid and re-collides on a backend that is coming back up. Exported and
 * pure so the policy is testable without a network.
 */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt));
  return Math.max(250, Math.round(ceiling * (0.5 + rand() * 0.5)));
}

type EventListener = (ev: StateStreamEvent) => void;
type StatusListener = (status: LiveStatus) => void;

const listeners = new Set<EventListener>();
const statusListeners = new Set<StatusListener>();

let status: LiveStatus = "connecting";
let loopAc: AbortController | null = null;
let connectedOnce = false;
/** One warning per disconnection EPISODE, not one per retry — a backend down for an hour must not write
 *  120 identical WARN lines into the shared fault trail. */
let warnedThisEpisode = false;
/** Set while we are between connections, so the next `hello` can be announced as a reconnect. */
let droppedSinceLastHello = false;
/** Resolver for the in-progress backoff sleep — lets a wake event (tab focused, network back) retry now. */
let wakeSleep: (() => void) | null = null;

// ---------------------------------------------------------------------------------------------------
// Page lifecycle — telling an EXPECTED teardown apart from a real failure.
// ---------------------------------------------------------------------------------------------------

let pageUnloading = false;

/** True when the stream ending is the browser's doing, not a fault: the page is going away, or the
 *  machine is offline. Neither deserves a WARN in the fault trail. */
export function isExpectedDisconnect(): boolean {
  if (pageUnloading) return true;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return false;
}

if (typeof window !== "undefined") {
  // `pagehide` fires for bfcache navigations too, which `beforeunload` misses. Both are cheap.
  const markUnloading = (): void => {
    pageUnloading = true;
  };
  window.addEventListener("pagehide", markUnloading);
  window.addEventListener("beforeunload", markUnloading);
  // A bfcache restore un-does the unload — the tab is alive again and wants its stream back.
  window.addEventListener("pageshow", () => {
    pageUnloading = false;
    wakeNow();
  });
  window.addEventListener("online", wakeNow);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) wakeNow(); // a laptop just woke / the tab came forward — retry immediately
    });
  }
}

/** Cut any pending backoff short and retry NOW (tab visible again, network back, bfcache restore). */
function wakeNow(): void {
  if (status === "live") return;
  wakeSleep?.();
}

// ---------------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------------

function setStatus(next: LiveStatus): void {
  if (status === next) return;
  status = next;
  for (const fn of [...statusListeners]) {
    try {
      fn(next);
    } catch (e) {
      clientLog.error("liveStream.statusListener", e);
    }
  }
}

export function liveStatus(): LiveStatus {
  return status;
}

/** Watch the connection status. Returns an unsubscribe. */
export function subscribeLiveStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

// ---------------------------------------------------------------------------------------------------
// The single connection
// ---------------------------------------------------------------------------------------------------

/**
 * Attach to the tab's shared state-event stream. The FIRST subscriber opens the connection; the LAST one
 * to leave closes it. Returns an unsubscribe.
 */
export function subscribeLive(fn: EventListener): () => void {
  listeners.add(fn);
  ensureRunning();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stop();
  };
}

/** How many components are attached — for tests and diagnostics. */
export function liveListenerCount(): number {
  return listeners.size;
}

function ensureRunning(): void {
  if (loopAc) return;
  const ac = new AbortController();
  loopAc = ac;
  void runLoop(ac);
}

function stop(): void {
  const ac = loopAc;
  loopAc = null;
  wakeSleep?.();
  ac?.abort();
  // The next subscriber starts a fresh connection; don't leave a stale "reconnecting" behind it.
  setStatus(connectedOnce ? "reconnecting" : "connecting");
}

function emit(ev: StateStreamEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(ev);
    } catch (e) {
      // One broken subscriber must never take the stream down for every other page in the tab.
      clientLog.error("liveStream.listener", e);
    }
  }
}

async function runLoop(ac: AbortController): Promise<void> {
  let attempt = 0;

  while (!ac.signal.aborted) {
    const attemptAc = new AbortController();
    const relayAbort = (): void => attemptAc.abort();
    ac.signal.addEventListener("abort", relayAbort);

    let lastLineAt = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastLineAt > STALL_MS) {
        stalled = true;
        attemptAc.abort(); // silence past two heartbeats = dead connection; reconnect rather than wait
      }
    }, STALL_CHECK_MS);

    try {
      await streamNdjson("/events/stream", {
        signal: attemptAc.signal,
        onEvent: (raw) => {
          lastLineAt = Date.now();
          // A delivered line of ANY type proves the connection is healthy.
          attempt = 0;
          connectedOnce = true;
          warnedThisEpisode = false;
          setStatus("live");

          const ev = raw as StateStreamEvent;
          if (!ev || typeof ev !== "object") return;
          if (ev.type === "hello" && droppedSinceLastHello) {
            droppedSinceLastHello = false;
            emit({ type: "reconnect" });
          }
          emit(ev);
        },
      });
      // A clean end means the server closed the stream (restart, shutdown). Reconnect — but count it as
      // an attempt for backoff purposes so a backend in a crash loop is not hammered.
    } catch (e) {
      if (ac.signal.aborted) break;
      // A stall we caused ourselves, a page teardown, and an offline machine are all EXPECTED — the
      // stream ending there is the design working, not a fault. Only a genuine, unexplained failure
      // earns a line in the fault trail, and only the first one of an episode.
      if (!stalled && !isExpectedDisconnect() && !warnedThisEpisode) {
        warnedThisEpisode = true;
        clientLog.warn("useLiveRefresh.stream", e);
      }
    } finally {
      clearInterval(watchdog);
      ac.signal.removeEventListener("abort", relayAbort);
    }

    if (ac.signal.aborted || pageUnloading) break;

    droppedSinceLastHello = true;
    setStatus(connectedOnce ? "reconnecting" : "connecting");

    await sleep(backoffDelay(attempt), ac.signal);
    attempt += 1;
  }
}

/** Sleep that resolves early when the loop is aborted or a wake event fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      if (wakeSleep === finish) wakeSleep = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
    wakeSleep = finish;
  });
}
