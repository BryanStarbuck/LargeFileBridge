// requestInvalidate — the live-refresh coalescer (useLiveRefresh.ts). A burst of topic bumps must turn into
// at most one invalidation per window per key, and must never cancel a fetch already in flight (the churn
// loop that kept a slow repo-detail stream restarting forever).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { requestInvalidate } from "./useLiveRefresh.js";

function fakeClient(fetching: () => number) {
  const calls: { key: unknown; opts: unknown }[] = [];
  const qc = {
    isFetching: () => fetching(),
    invalidateQueries: (filters: { queryKey: unknown }, opts: unknown) => {
      calls.push({ key: filters.queryKey, opts });
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  return { qc, calls };
}

let n = 0;
const freshKey = () => ["spec", n++]; // the coalescer is module-level, so every test uses its own key

describe("requestInvalidate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("acts at once on the first bump, and folds a burst into ONE trailing invalidation", () => {
    const { qc, calls } = fakeClient(() => 0);
    const key = freshKey();
    requestInvalidate(qc, key);
    vi.advanceTimersByTime(0);
    expect(calls).toHaveLength(1);
    // A batch bumping once a second for five seconds.
    for (let i = 0; i < 5; i++) {
      requestInvalidate(qc, key);
      vi.advanceTimersByTime(1000);
    }
    // Leading one + at most one per 2 s window afterwards — never one per bump.
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("never cancels an in-flight fetch", () => {
    const { qc, calls } = fakeClient(() => 0);
    requestInvalidate(qc, freshKey());
    vi.advanceTimersByTime(0);
    expect(calls[0].opts).toEqual({ cancelRefetch: false });
  });

  it("waits for an in-flight fetch to land, then invalidates", () => {
    let inFlight = 1;
    const { qc, calls } = fakeClient(() => inFlight);
    requestInvalidate(qc, freshKey());
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(0); // still fetching — nothing issued, nothing cancelled
    inFlight = 0;
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(1);
  });
});
