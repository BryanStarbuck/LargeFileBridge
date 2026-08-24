// perfWatch.ts — the browser half of "the pages are spinning", written into the SAME fault trail as the
// server half (error.err, via the /client-log bridge).
//
// WHAT WAS MISSING. The backend could say the event loop stopped (`loop-watch`), what stopped it
// (`blocking`), and which request was left open (`request-watch`) — but every one of those is a statement
// about the SERVER. A spinner has two possible owners, and nothing in the fault trail could tell them
// apart:
//   * the server never answered  → a backend stall, already covered by the three watches above;
//   * the answer arrived and the TAB could not paint it → a long task on the browser's own main thread,
//     which no server-side log can see, and which is exactly what T1/T2 in performance.mdx describe
//     (whole datasets rendered to the DOM, every keystroke re-rendering everything).
//
// Three signals, each mapping to one thing a person actually sees:
//
//   1. LONG TASK — the browser's own `longtask` PerformanceObserver entry: a stretch over 50 ms where the
//      main thread could not paint or handle input. Reported in a rolling window as a TOTAL rather than
//      per task, because the shape that freezes a tab is 200 × 60 ms far more often than 1 × 12 s, and a
//      per-task threshold would miss it entirely (the same reasoning as blocking.ts's per-window tally).
//   2. STILL LOADING — a route that has been mounted for longer than `STUCK_MS` with react-query fetches
//      still in flight. That IS the spinner, named while it is on screen, with the query keys that are
//      still pending — so the log says WHICH data the page is waiting for, not merely that it is waiting.
//   3. SLOW NAVIGATION — a route that took longer than `SLOW_ROUTE_MS` to reach a settled state, reported
//      once it settles, so a page that is merely slow is separable from one that is hung.
//
// CONTRACT: it never throws (a broken observer must not break the app), it is fire-and-forget over the
// existing clientLog bridge, and it degrades silently on a browser without `longtask` support (Safari) —
// signals 2 and 3 work everywhere because they are our own timers.
import { clientLog } from "./clientLog.js";
import { queryClient } from "../api/queryClient.js";

/** Report the rolling window when the main thread was blocked for at least this much of it. 500 ms out of
 *  10 s is a tab that visibly stutters; below that is ordinary render work and not worth a line. */
const LONGTASK_WINDOW_MS = 10_000;
const LONGTASK_BUDGET_MS = 500;

/** A route still fetching after this long is reported as a spinner the user is looking at right now. */
const STUCK_MS = 10_000;

/** A route that settles slower than this is reported once, after it settles. */
const SLOW_ROUTE_MS = 3_000;

// ── 1. long tasks on the main thread ────────────────────────────────────────────────────────────────

let longTaskTotal = 0;
let longTaskCount = 0;
let longTaskWorst = 0;
let longTaskWorstAttribution = "";
let longTaskWindowStarted = 0;

function flushLongTasks(): void {
  if (longTaskCount === 0) return;
  const total = longTaskTotal;
  const count = longTaskCount;
  const worst = longTaskWorst;
  const attribution = longTaskWorstAttribution;
  longTaskTotal = 0;
  longTaskCount = 0;
  longTaskWorst = 0;
  longTaskWorstAttribution = "";
  longTaskWindowStarted = performance.now();
  if (total < LONGTASK_BUDGET_MS) return;
  clientLog.warn(
    "perf.longtask",
    `MAIN THREAD BLOCKED: ${Math.round(total)}ms of the last ${LONGTASK_WINDOW_MS / 1000}s was spent in ` +
      `${count} long task(s) (worst ${Math.round(worst)}ms${attribution ? `, ${attribution}` : ""}) on ` +
      `${location.pathname}. While a long task runs the tab cannot paint, scroll or answer a click — this ` +
      `is the BROWSER-side half of "the page is spinning", and no backend log can see it. Look for a list ` +
      `rendering every row instead of a window, or state that every row subscribes to. See performance.mdx ` +
      `T1/T2.`,
  );
}

function startLongTaskWatch(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    longTaskWindowStarted = performance.now();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskTotal += entry.duration;
        longTaskCount += 1;
        if (entry.duration > longTaskWorst) {
          longTaskWorst = entry.duration;
          // `attribution` names the frame/container the browser blames; it is often "self" or "unknown",
          // which is still worth carrying — "unknown" narrows it to our own script rather than an iframe.
          const attr = (entry as PerformanceEntry & { attribution?: Array<{ name?: string; containerType?: string }> })
            .attribution?.[0];
          longTaskWorstAttribution = attr?.name ? `attributed to ${attr.name}` : "";
        }
      }
      if (performance.now() - longTaskWindowStarted >= LONGTASK_WINDOW_MS) flushLongTasks();
    });
    // `buffered` picks up the long tasks that happened during BOOT — historically the worst ones, and the
    // ones an observer registered at mount would otherwise never see.
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    /* longtask unsupported (Safari) — the route watches below still work */
  }
  // A window that ends with no further entries would never flush from inside the observer callback.
  const t = setInterval(() => {
    try {
      if (performance.now() - longTaskWindowStarted >= LONGTASK_WINDOW_MS) flushLongTasks();
    } catch {
      /* never let instrumentation break the app */
    }
  }, LONGTASK_WINDOW_MS);
  // Node-style unref does not exist in the browser; the interval lives for the tab's lifetime by design.
  void t;
}

// ── 2 & 3. routes that never finish loading ─────────────────────────────────────────────────────────

/** The query keys still fetching, as a short readable list — this is what the page is waiting FOR. */
function pendingQueryKeys(limit = 6): string[] {
  try {
    return queryClient
      .getQueryCache()
      .findAll({ fetchStatus: "fetching" })
      .slice(0, limit)
      .map((q) => JSON.stringify(q.queryKey));
  } catch {
    return [];
  }
}

let routePath = "";
let routeStartedAt = 0;
let routeSettled = false;
let routeReportedStuck = false;

/**
 * Tell the watch that the app navigated. Called from the router's own subscription, so "when did this page
 * start loading" is the router's answer rather than a guess from a component's mount effect.
 */
export function noteRouteChange(path: string): void {
  routePath = path;
  routeStartedAt = performance.now();
  routeSettled = false;
  routeReportedStuck = false;
}

function checkRoute(): void {
  if (!routePath || routeSettled) return;
  const age = performance.now() - routeStartedAt;
  const pending = pendingQueryKeys();
  if (pending.length === 0) {
    // Nothing in flight: the page has the data it asked for. Report it only if getting here was slow.
    routeSettled = true;
    if (age >= SLOW_ROUTE_MS) {
      clientLog.warn(
        "perf.route",
        `SLOW PAGE: ${routePath} took ${Math.round(age)}ms before every query it opened had answered. The ` +
          `spinner was on screen for that long. If the backend's request-watch shows no SLOW line for the ` +
          `same window, the time went on the browser's main thread — see the perf.longtask lines.`,
      );
    }
    return;
  }
  if (age >= STUCK_MS && !routeReportedStuck) {
    routeReportedStuck = true;
    clientLog.error(
      "perf.route",
      `PAGE STILL SPINNING after ${Math.round(age)}ms: ${routePath} is still waiting on ${pending.length} ` +
        `query/queries: ${pending.join(", ")}. This is the spinner the user is looking at RIGHT NOW. ` +
        `Cross-check the backend's [request] STILL OPEN lines for the same moment: if they name the same ` +
        `endpoint the server never answered; if they do not, the answer arrived and the tab could not ` +
        `render it.`,
    );
  }
}

/**
 * Arm every browser-side performance signal. Called once, at mount, from main.tsx. Safe to call twice
 * (the second call is a no-op) and safe on any browser — everything degrades to silence rather than error.
 */
let armed = false;
export function startPerfWatch(): void {
  if (armed) return;
  armed = true;
  try {
    startLongTaskWatch();
    noteRouteChange(location.pathname);
    setInterval(() => {
      try {
        checkRoute();
      } catch {
        /* never let instrumentation break the app */
      }
    }, 2_000);
  } catch (e) {
    // The fault trail's own failure is worth one line, and nothing more.
    clientLog.warn("perf.start", e);
  }
}
