// THE REGRESSION GUARD for the boot gate's hardest question: absent backend vs. real answer.
//
// The bug this locks closed (reported as: "Large File Bridge ran into a problem starting up. Request failed
// with status code 502"): a `tsx watch` reload bounced the backend, Vite's /api proxy answered the in-flight
// request with its OWN 502, and the predicate — which returned false for anything carrying a `response` —
// called that an authoritative failure. Retry was therefore refused and the whole app fell to the boot-error
// card mid-session, where it stayed until a manual Retry.
//
// The two directions matter equally, so both are asserted here:
//   • a gateway status MUST be transient  → the app reconnects instead of dying (the reported bug);
//   • an app-spoken status MUST NOT be    → a real answer surfaces instead of spinning forever (the bug the
//     naive "just retry all 5xx" fix would introduce, and the reason 503 is excluded by name).
import { describe, expect, test } from "vitest";
import { isTransientNetworkError } from "./transientError.js";

/** An axios error the way axios actually shapes one when a RESPONSE arrived. */
const withResponse = (status: number): unknown =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    name: "AxiosError",
    isAxiosError: true,
    response: { status },
  });

/** An axios error for a request that never got a response at all. */
const noResponse = (code: string, message = "Network Error"): unknown =>
  Object.assign(new Error(message), { name: "AxiosError", isAxiosError: true, code });

describe("isTransientNetworkError", () => {
  test("a proxy's 502 is transient — the reported boot-card bug", () => {
    // Vite (and nginx/Caddy) answer for an upstream that isn't there. This MUST retry, not surface.
    expect(isTransientNetworkError(withResponse(502))).toBe(true);
  });

  test("a gateway timeout (504) is transient", () => {
    expect(isTransientNetworkError(withResponse(504))).toBe(true);
  });

  test("503 is NOT transient — the app issues it itself", () => {
    // transcode.service.ts: "ffmpeg not installed — install it to stream this codec". A real, actionable
    // answer; retrying it forever would hide it behind a spinner.
    expect(isTransientNetworkError(withResponse(503))).toBe(false);
  });

  test("a 500 the app threw is a genuine failure, not a restart blip", () => {
    expect(isTransientNetworkError(withResponse(500))).toBe(false);
  });

  test("4xx answers are authoritative", () => {
    // 401 in particular: treating it as transient would spin instead of showing the sign-in page.
    for (const s of [400, 401, 403, 404]) expect(isTransientNetworkError(withResponse(s))).toBe(false);
  });

  test("the classic no-response shapes stay transient", () => {
    expect(isTransientNetworkError(noResponse("ERR_NETWORK"))).toBe(true);
    expect(isTransientNetworkError(noResponse("ECONNABORTED"))).toBe(true);
    expect(isTransientNetworkError(noResponse("ERR_CANCELED"))).toBe(true);
  });

  test("non-axios errors are never transient", () => {
    // A thrown app bug must reach the fault trail as an ERROR, never be swallowed as a network blip.
    expect(isTransientNetworkError(new Error("boom"))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError("502")).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });
});
