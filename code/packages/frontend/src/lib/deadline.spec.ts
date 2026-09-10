// The contract that makes the hang fix work — not just "the timeout fires", but "the timeout is a shape
// the existing recovery already recognises". `main.tsx`'s boot gate and react-query's retry predicate both
// read `isTransientNetworkError()`, so a deadline that produced any other error shape would trade an
// infinite spinner for a permanent error card.
import { describe, expect, it, vi } from "vitest";
import { AUTH_DEADLINE_MS, READ_DEADLINE_MS, timeoutError, withDeadline, withDeadlineOr } from "./deadline.js";
import { isTransientNetworkError } from "./transientError.js";

describe("withDeadline", () => {
  it("resolves a prompt promise untouched", async () => {
    await expect(withDeadline(Promise.resolve("ok"), 1_000, "x")).resolves.toBe("ok");
  });

  it("rejects once the deadline passes, even though the promise never settles", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const p = withDeadline(never, 5_000, "the mint");
    const assertion = expect(p).rejects.toThrow(/the mint timed out after 5000ms/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    vi.useRealTimers();
  });

  it("propagates the original rejection rather than masking it with a timeout", async () => {
    await expect(withDeadline(Promise.reject(new Error("real failure")), 1_000, "x")).rejects.toThrow(
      "real failure",
    );
  });
});

describe("withDeadlineOr", () => {
  it("falls back instead of throwing when the wait blows the deadline", async () => {
    vi.useFakeTimers();
    const p = withDeadlineOr(new Promise<string | null>(() => {}), 5_000, null);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("still returns the real value when it arrives in time", async () => {
    await expect(withDeadlineOr(Promise.resolve("token"), 1_000, null)).resolves.toBe("token");
  });
});

describe("the timeout error is classified as the backend being absent", () => {
  // THE LOAD-BEARING ASSERTION. If this ever goes false, a deadline stops arming "Reconnecting…" and
  // react-query stops retrying — the app would show the "ran into a problem starting up" card for a
  // condition it is supposed to ride out. api/axios.ts's `unwrap` header explains the same trap.
  it("reads as transient, exactly like a real network failure", () => {
    expect(isTransientNetworkError(timeoutError("read", 100))).toBe(true);
  });

  it("carries axios's own discriminants", () => {
    const e = timeoutError("read", 100);
    expect(e.isAxiosError).toBe(true);
    expect(e.code).toBe("ECONNABORTED");
    expect(e.name).toBe("AxiosError");
  });
});

describe("the deadlines themselves", () => {
  // A read deadline BELOW the slowest response this app has ever logged would cut off healthy work and
  // retry it forever. The worst `[request] SLOW` line on record is 8382ms (/api/ipfs/liveness behind a
  // busy reconcile window), so the read deadline must keep real headroom over that.
  it("leaves the slowest observed read (8.4s) a wide margin", () => {
    expect(READ_DEADLINE_MS).toBeGreaterThan(8_382 * 3);
  });

  // Auth sits in front of every other request, so its deadline must be the tighter of the two.
  it("bounds auth more tightly than a read", () => {
    expect(AUTH_DEADLINE_MS).toBeLessThan(READ_DEADLINE_MS);
  });
});
