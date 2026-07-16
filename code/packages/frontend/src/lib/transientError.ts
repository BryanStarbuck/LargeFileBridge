// IS THIS FAILURE THE BACKEND SAYING SOMETHING, OR THE BACKEND NOT BEING THERE? (authentication.mdx §5)
//
// One predicate, because the answer drives three separate behaviours and they must never disagree:
//   • main.tsx's retry gate — keep retrying while the backend is merely absent, never retry a real answer.
//   • main.tsx's boot gate — "Reconnecting…" (absent) vs. the "ran into a problem starting up" card (answer).
//   • the global fault trail — a rate-limited WARN (absent) vs. an ERROR (answer).
//
// Axios raises a plain "Network Error" (or ECONNABORTED/ERR_CANCELED) whenever a request can't complete for
// a reason that isn't an app bug: the backend is mid-restart (a `tsx watch`/`just run` reload, an IPFS daemon
// (re)install bouncing the API), a request got aborted by navigation/unmount, or the dev server is cycling.
//
// A RESPONSE IS NOT PROOF THE BACKEND ANSWERED — the bug this module exists to close. The rule was once
// "no response ⇒ transient; any HTTP response ⇒ genuine failure", which is wrong the moment a PROXY sits
// between us and the API, and one always does. In dev, Vite proxies /api → :8787, and when the backend is
// down it does NOT surface a network error: it synthesizes an HTTP **502** of its own. So "the backend is
// mid-restart" — the exact case the predicate exists to absorb — arrived WITH a response, was judged
// authoritative, and took the whole app to the boot-error card with retry disabled, so it stayed there until
// a manual Retry. A one-keystroke `tsx watch` reload was enough. The same holds in prod behind nginx/Caddy.
//
// So the test is on the STATUS, never on the mere existence of a response.

/**
 * Statuses that can ONLY mean "the gateway could not reach the app".
 *
 * 502 Bad Gateway / 504 Gateway Timeout are spoken by a PROXY *about* an upstream that isn't there; our API
 * emits neither (grep: zero sites), so seeing one is positive evidence the backend is unreachable.
 *
 * 503 is deliberately ABSENT. It is a status this app ISSUES for real — transcode.service.ts answers
 * "ffmpeg not installed — install it to stream this codec" with a 503 — and that is a genuine, actionable
 * answer. Retrying it forever would bury it behind an infinite spinner. A status we say ourselves is never
 * transient; only the two a proxy invents on our behalf are.
 */
const TRANSIENT_HTTP_STATUSES = new Set([502, 504]);

/** Codes axios uses when no response ever arrived (or the caller went away). */
const TRANSIENT_CODES = new Set(["ERR_NETWORK", "ECONNABORTED", "ERR_CANCELED"]);

interface AxiosLike {
  isAxiosError?: boolean;
  code?: string;
  message?: string;
  response?: { status?: number };
}

/** True when the failure means "the backend isn't there right now" rather than "the backend said no". */
export function isTransientNetworkError(err: unknown): boolean {
  const e = err as AxiosLike | null;
  if (!e || typeof e !== "object") return false;
  const isAxios = e.isAxiosError === true || (err instanceof Error && err.name === "AxiosError");
  if (!isAxios) return false;
  // A response arrived: transient ONLY if a gateway spoke it on the backend's behalf. Every other status —
  // including a 500 the app itself threw — is an authoritative answer and must surface, not spin.
  if (e.response) {
    const status = e.response.status;
    return status !== undefined && TRANSIENT_HTTP_STATUSES.has(status);
  }
  // No response at all: the classic unreachable/aborted shape.
  return (e.code !== undefined && TRANSIENT_CODES.has(e.code)) || e.message === "Network Error";
}
