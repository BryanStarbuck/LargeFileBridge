// Single axios instance. In production the AuthBridge registers getToken (OpenAuthFederated);
// in localhost dev mode no token is attached and the backend authenticates the dev user.
import axios from "axios";
import { toast } from "sonner";
import { queryClient } from "./queryClient.js";
import { READ_DEADLINE_MS } from "../lib/deadline.js";

/**
 * EVERY READ CARRIES A DEADLINE. Axios's default `timeout` is 0 — wait forever — and that default is what
 * turned an unanswered socket into a permanent spinner: `error.err` 2026-09-09 shows `PAGE STILL SPINNING
 * after 80264ms` on `/repos/…` with NO matching `[request] STILL OPEN`, `[request] SLOW` or
 * `[client:perf.longtask]` line, i.e. neither the server nor the tab's main thread was busy — the request
 * had simply gone out and never come back (lib/deadline.ts has the full write-up).
 *
 * WHY THE DEADLINE IS THE FIX AND NOT JUST A BANDAGE: the boot gate in main.tsx rides out an absent
 * backend by reading `q.failureCount > 0 && isTransientNetworkError(q.failureReason)`. A request that
 * never fails has `failureCount === 0`, so the gate never reached "Reconnecting…" and never retried. A
 * timeout raises `ECONNABORTED`, which `lib/transientError.ts` already classifies as transient, so the
 * existing recovery arms itself with no second code path.
 *
 * READS ONLY. A GET is a bounded, idempotent read of state that exists; a POST/PUT/DELETE is a COMMAND
 * that may legitimately run for minutes (`/ipfs/rescan` walks the whole pinset, `/repos/:id/pin` pins a
 * repo, `/ipfs/daemon` starts Kubo), and cutting one off at 45 s would abandon work that is still running
 * server-side — the opposite of a fix. Commands keep axios's no-deadline behaviour; the interceptor below
 * applies the deadline to safe methods alone.
 */
export const http = axios.create({ baseURL: "/api", withCredentials: true });

/** HTTP methods that are reads: safe, idempotent, and expected to answer promptly. */
const READ_METHODS = new Set(["get", "head", "options"]);

http.interceptors.request.use((config) => {
  // An explicit per-call `timeout` always wins — a caller that knows its read is slow can say so.
  if (config.timeout === undefined || config.timeout === 0) {
    if (READ_METHODS.has((config.method ?? "get").toLowerCase())) config.timeout = READ_DEADLINE_MS;
  }
  return config;
});

/**
 * What the auth layer lends the transport (wired in api/authCore.ts):
 *   • getToken      — refresh-before-use Bearer for the request interceptor
 *   • refreshToken  — force ONE fresh mint (single-flight in authCore), the cheap 401 recovery
 *   • reloadSession — rehydrate the session from the cookie, the deeper 401 recovery
 *   • isSignedIn    — is there still a live session at all (i.e. is a re-login the only way out)
 */
export interface AuthBridge {
  getToken: () => Promise<string | null>;
  refreshToken: () => Promise<string | null>;
  reloadSession: () => Promise<void>;
  isSignedIn: () => boolean;
}

let bridge: AuthBridge | null = null;

export function registerAuthBridge(b: AuthBridge): void {
  bridge = b;
}

http.interceptors.request.use(async (config) => {
  if (bridge) {
    // Token mint failed — log and proceed unauthenticated (backend may still accept cookie/dev auth).
    // NOTE: this file is imported BY clientLog, so use console.error here to avoid a circular import.
    const token = await bridge.getToken().catch((e) => {
      console.error("[axios.getToken]", e);
      return null;
    });
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// SINGLE-FLIGHT 401 RECOVERY. A page load fans out many queries at once; when the Bearer has lapsed they
// ALL 401 together. Recovering per-request would fire N /tokens mints (and N /client reloads) for one
// lapse — the mint storms visible in log.log. Every concurrent 401 instead awaits ONE recovery and then
// retries with whatever Bearer that recovery produced.
let recoveryInFlight: Promise<boolean> | null = null;

/** Try to make the session usable again. Resolves true when a fresh Bearer is available. */
async function recoverSession(): Promise<boolean> {
  if (!bridge) return false;
  if (!recoveryInFlight) {
    const b = bridge;
    recoveryInFlight = (async () => {
      // 1) Cheap path: the session cookie is still good and only the access token lapsed → re-mint.
      const minted = await b.refreshToken().catch(() => null);
      if (minted) return true;
      // 2) Deeper path: rehydrate the session from the cookie, then mint against the restored session.
      //    A failed rehydrate is logged, not fatal — isSignedIn() below is the authoritative answer.
      await b.reloadSession().catch((e) => {
        console.error("[axios.reloadSession]", e);
      });
      if (!b.isSignedIn()) return false;
      return (await b.refreshToken().catch(() => null)) != null;
    })().finally(() => {
      recoveryInFlight = null;
    });
  }
  return recoveryInFlight;
}

// A genuinely lapsed session must land on the sign-in screen, not on a page quietly rendering failed
// data. Invalidating the two auth probes re-runs the boot gate in main.tsx, which then renders the
// sign-in page (where the Google round-trip is started). Latched so a fan-out of 401s produces ONE
// notice and ONE re-gate.
let lapseAnnounced = false;

function announceSessionLapsed(): void {
  if (lapseAnnounced) return;
  lapseAnnounced = true;
  toast.error("Your Large File Bridge session has expired. Please sign in again.");
  void queryClient.invalidateQueries({ queryKey: ["authInit"] });
  void queryClient.invalidateQueries({ queryKey: ["me"] });
}

http.interceptors.response.use(
  (r) => r,
  async (error) => {
    const status = error?.response?.status;
    if (status === 401 && bridge && error.config && !error.config.__retried) {
      error.config.__retried = true;
      const recovered = await recoverSession();
      if (!recovered) {
        // No live session left: send the user through a clean re-login instead of retrying a call that
        // can only 401 again and leave the page half-rendered with failed data.
        announceSessionLapsed();
        return Promise.reject(error);
      }
      // Drop the STALE Bearer before retrying: the request interceptor re-runs on retry and only
      // overwrites the header when it gets a token — if the re-mint fails it would otherwise re-send
      // the very expired token that just 401'd (a second guaranteed-failed verification).
      delete error.config.headers?.Authorization;
      return http.request(error.config);
    }
    if (status === 403) toast.error("You don't have permission to do that.");
    return Promise.reject(error);
  },
);

// Unwrap the { ok, data } envelope; throw the error string on failure.
export async function unwrap<T>(p: Promise<{ data: { ok: boolean; data?: T; error?: string } }>): Promise<T> {
  let res: { data: { ok: boolean; data?: T; error?: string } };
  try {
    res = await p;
  } catch (e) {
    // A non-2xx response still carries our { ok:false, error } envelope — surface the SERVER'S reason
    // ("the computer holding it looks offline"), not axios's generic "Request failed with status 502".
    //
    // OVERRIDE THE MESSAGE ON THE AXIOS ERROR — NEVER REBUILD THE ERROR. Throwing `new Error(reason)`
    // is the obvious-looking way to do this and it silently broke both backend-down gates: a plain
    // Error carries no `isAxiosError`, no `code` and no `response.status`, which is precisely what
    // isTransientNetworkError() reads to tell "a GATEWAY says the backend is absent" (a proxy 502/504
    // — ride it out) from "the backend answered no" (surface it). Stripped of those fields the dev
    // proxy's own 502 was judged authoritative, so react-query stopped retrying (no self-heal when the
    // backend came back) and the boot gate showed "…ran into a problem starting up. / backend
    // unavailable" instead of "Reconnecting…" — for the one condition the app exists to ride out.
    // Mutating the message preserves every discriminant, including any axios adds later, where
    // hand-copying a field list would drift out of step with the predicate.
    const serverError = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
    if (!serverError) throw e;
    if (e instanceof Error) {
      e.message = serverError;
      throw e;
    }
    throw new Error(serverError); // a non-Error rejection has no metadata to preserve
  }
  if (!res.data.ok) throw new Error(res.data.error || "request failed");
  return res.data.data as T;
}
