// The nav item's linger (processing.mdx §2.1). Every rule here exists because the obvious version of this
// predicate hid a run the user had just started and watched for.
import { describe, it, expect } from "vitest";
import type { ProcessingBatch } from "@lfb/shared";
import { lastBatchFinishedAt, isRecentlyFinished, FINISHED_LINGER_MS } from "./linger.js";

const batch = (over: Partial<ProcessingBatch> = {}): ProcessingBatch => ({
  batchId: "b1",
  kind: "ocr",
  label: "OCR · 16 checked path(s) · 16 files",
  scope: "16 checked path(s)",
  total: 16,
  ok: 16,
  rejected: 0,
  failed: 0,
  halted: 0,
  running: 0,
  errors: [],
  startedAt: "2026-07-17T00:15:00.522Z",
  finishedAt: "2026-07-17T00:15:04.848Z",
  ...over,
});

describe("lastBatchFinishedAt", () => {
  it("is null when no batch has settled", () => {
    expect(lastBatchFinishedAt([])).toBeNull();
    expect(lastBatchFinishedAt([batch({ finishedAt: null })])).toBeNull();
  });

  it("takes the MOST RECENT finish, not the last in the list", () => {
    const older = batch({ batchId: "old", finishedAt: "2026-07-17T00:10:00.000Z" });
    const newer = batch({ batchId: "new", finishedAt: "2026-07-17T00:15:04.848Z" });
    // Newest-first ordering must give the same answer as newest-last — the list order is not the clock.
    expect(lastBatchFinishedAt([newer, older])).toBe(Date.parse("2026-07-17T00:15:04.848Z"));
    expect(lastBatchFinishedAt([older, newer])).toBe(Date.parse("2026-07-17T00:15:04.848Z"));
  });

  it("ignores an active batch while reading the finished ones", () => {
    const running = batch({ batchId: "running", finishedAt: null });
    const done = batch({ batchId: "done", finishedAt: "2026-07-17T00:15:04.848Z" });
    expect(lastBatchFinishedAt([running, done])).toBe(Date.parse("2026-07-17T00:15:04.848Z"));
  });

  it("skips an unparseable stamp rather than reading it as epoch 0", () => {
    // Date.parse("nonsense") is NaN; a naive max would let it poison the comparison.
    expect(lastBatchFinishedAt([batch({ finishedAt: "nonsense" })])).toBeNull();
  });
});

describe("isRecentlyFinished", () => {
  const finished = Date.parse("2026-07-17T00:15:04.848Z");

  // THE BUG THIS FILE EXISTS FOR. A real 16-image OCR run: queued 00:15:00.9, settled 00:15:04.8 — 4.3s,
  // faster than the 3s idle poll. Gating the only route to /processing on live work meant it blinked past
  // and the user saw nothing at all, while the batch record itself lived on the server for 24h.
  it("keeps a 4-second batch reachable after it settles", () => {
    expect(isRecentlyFinished({ processing: false, lastFinishedAt: finished, now: finished + 30_000 })).toBe(true);
  });

  it("is false while work is still live — §1's predicate owns that case, not this one", () => {
    // Both true would make the spinner-vs-check state ambiguous.
    expect(isRecentlyFinished({ processing: true, lastFinishedAt: finished, now: finished + 1_000 })).toBe(false);
  });

  it("is false when nothing has ever run — an idle machine keeps a clean nav list", () => {
    expect(isRecentlyFinished({ processing: false, lastFinishedAt: null, now: finished })).toBe(false);
  });

  it("expires at the window edge", () => {
    expect(isRecentlyFinished({ processing: false, lastFinishedAt: finished, now: finished + FINISHED_LINGER_MS - 1 })).toBe(true);
    expect(isRecentlyFinished({ processing: false, lastFinishedAt: finished, now: finished + FINISHED_LINGER_MS })).toBe(false);
  });

  it("treats a future finish (clock skew) as just-finished, never as expired", () => {
    // Server stamp ahead of the browser clock. "Finished 2s from now" honestly reads as "just finished";
    // expiring it would hide the exact run the user is waiting on.
    expect(isRecentlyFinished({ processing: false, lastFinishedAt: finished + 2_000, now: finished })).toBe(true);
  });
});
