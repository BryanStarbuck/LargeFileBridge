// UNWRAPPING THE ENVELOPE MUST NOT DESTROY THE EVIDENCE THAT THE BACKEND WAS ABSENT.
//
// The bug this guards (2026-08-19, reported as the boot card "Large File Bridge ran into a problem
// starting up. / backend unavailable"). `backend unavailable` is not a message this API can produce —
// grep says it exists in exactly one place, vite.config.ts, where the DEV PROXY synthesizes a 502 for
// a backend it cannot reach. So the app showed a hard, manual-retry-only error card for the one
// condition it is designed to ride out silently: the backend restarting.
//
// transientError.ts had already closed this exact hole ("A RESPONSE IS NOT PROOF THE BACKEND
// ANSWERED") — it tests the STATUS, and 502 is in its transient set. The hole reopened one layer
// UPSTREAM: unwrap() caught the AxiosError, lifted `.response.data.error` out of the body, and
// re-threw a PLAIN `new Error(serverError)`. That discards `isAxiosError`, `code` and
// `response.status` — every field the predicate reads. So by the time isTransientNetworkError() saw
// it, the proof that a GATEWAY (not the app) spoke was gone, the failure was judged authoritative,
// and both consumers broke together: react-query stopped retrying (no self-heal when the backend came
// back) and the boot gate skipped "Reconnecting…" for the error card.
//
// The predicate cannot defend itself here — it is only as good as what reaches it. So the seam is
// tested at the seam.
import { describe, it, expect } from "vitest";
import { AxiosError } from "axios";
import { unwrap } from "./axios.js";
import { isTransientNetworkError } from "../lib/transientError.js";

/** An axios rejection shaped exactly like the one the Vite proxy's 502 produces. */
function proxyError(status: number, body: unknown): AxiosError {
  const e = new AxiosError("Request failed with status code " + status);
  e.response = { status, data: body, statusText: "", headers: {}, config: {} as never };
  return e;
}

/** Reject with `e` the way `http.get(...)` would. */
const rejecting = (e: unknown) => Promise.reject(e) as Promise<never>;

describe("unwrap() preserves what isTransientNetworkError() needs", () => {
  it("keeps a DEV-PROXY 502 classified as transient (the bug)", async () => {
    const err = await unwrap(rejecting(proxyError(502, { ok: false, error: "backend unavailable" }))).catch(
      (e: unknown) => e,
    );

    // Still the server's reason, not axios's generic "Request failed with status code 502" — that is
    // why unwrap() reaches into the body at all, and it must keep doing so.
    expect((err as Error).message).toBe("backend unavailable");
    // ...and still recognizable as "the backend isn't there", which is what was lost.
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("keeps a 504 gateway timeout transient too", async () => {
    const err = await unwrap(rejecting(proxyError(504, { ok: false, error: "backend unavailable" }))).catch(
      (e: unknown) => e,
    );
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("still surfaces a REAL app error as authoritative, not transient", async () => {
    // A 503 this app issues itself (transcode.service.ts: "ffmpeg not installed") is a genuine answer.
    // Retrying it forever would bury it behind an infinite spinner.
    const err = await unwrap(rejecting(proxyError(503, { ok: false, error: "ffmpeg not installed" }))).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe("ffmpeg not installed");
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("still surfaces a 500 the app threw as authoritative", async () => {
    const err = await unwrap(rejecting(proxyError(500, { ok: false, error: "boom" }))).catch((e: unknown) => e);
    expect((err as Error).message).toBe("boom");
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("throws the envelope's reason on a 200 that says ok:false", async () => {
    // An authoritative 'no' from the app, delivered with a 2xx — never transient.
    const err = await unwrap(
      Promise.resolve({ data: { ok: false, error: "the computer holding it looks offline" } }),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe("the computer holding it looks offline");
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("returns the payload on success", async () => {
    await expect(unwrap(Promise.resolve({ data: { ok: true, data: { hi: 1 } } }))).resolves.toEqual({ hi: 1 });
  });

  it("rethrows a bodyless network error untouched (no envelope to lift)", async () => {
    const e = new AxiosError("Network Error");
    e.code = "ERR_NETWORK";
    const err = await unwrap(rejecting(e)).catch((x: unknown) => x);
    expect(err).toBe(e); // same object — nothing to improve on, so nothing is rebuilt
    expect(isTransientNetworkError(err)).toBe(true);
  });
});
