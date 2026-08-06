// THE CLIENT HALF of the progressive repo queries (performance.mdx P-37).
//
// The backend spec (`backend/src/modules/repos/repos-stream.spec.ts`) proves the WIRE carries everything.
// This one proves the reducer that folds it back:
//
//   • the folded result is the whole detail, not a fraction of it;
//   • intermediate states reach the cache on a COLD screen (that is the feature) and do NOT on a warm,
//     already-complete one (a refetch must not blink the table empty and refill it);
//   • a stream that breaks falls back to the buffered endpoint rather than leaving a partial list on
//     screen dressed as a whole one;
//   • an ABORT is a cancellation, never a failure — it must not trigger the fallback refetch that the
//     cancellation was there to avoid.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { FileRow, RepoDetail, RepoDetailStreamEvent, RepoRow, RepoRowsStreamEvent } from "@lfb/shared";

// The transport is scripted per test; `onEvent` is fed the sequence and then the call resolves (or throws).
const script: { events: unknown[]; failAfter?: number; abort?: boolean; delayMs: number } = {
  events: [],
  delayMs: 0,
};
vi.mock("../lib/streamNdjson.js", () => ({
  streamNdjson: async (_p: string, o: { signal?: AbortSignal; onEvent: (e: unknown) => void }) => {
    for (let i = 0; i < script.events.length; i++) {
      // A real stream arrives over time; `delayMs` models that, which is what gives the frame publisher a
      // gap to flush into. With everything delivered in one synchronous tick there is nothing INTERMEDIATE
      // to publish — the final answer is already in hand — so a zero-delay script tests the fold only.
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      if (script.failAfter !== undefined && i === script.failAfter) throw new Error("stream broke");
      o.onEvent(script.events[i]);
    }
    if (script.abort) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (script.failAfter !== undefined && script.failAfter >= script.events.length) throw new Error("stream broke");
  },
}));

const bufferedRows: RepoRow[] = [{ repoId: "buffered" } as RepoRow];
const bufferedDetail = { repoId: "buffered", name: "from-the-buffered-route" } as RepoDetail;
vi.mock("./client.js", () => ({
  api: { repos: async () => bufferedRows, repo: async () => bufferedDetail },
}));
vi.mock("../lib/clientLog.js", () => ({ clientLog: { warn: () => {}, error: () => {} } }));

const { streamRepoRows, streamRepoDetail } = await import("./streamQueries.js");

/** The frame publisher coalesces on rAF (or a 16ms timeout in this node environment) — let it land. */
const settle = () => new Promise((r) => setTimeout(r, 40));

const row = (path: string): FileRow => ({ path, fileId: `x:${path}` }) as FileRow;

const head = (): RepoDetailStreamEvent => ({
  t: "head",
  detail: { repoId: "r1", name: "demo", files: [], partial: true, counts: {} } as unknown as RepoDetail,
});

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient();
  script.events = [];
  script.failAfter = undefined;
  script.abort = false;
  script.delayMs = 0;
});

describe("streamRepoDetail — folding the events back into one RepoDetail", () => {
  it("assembles head + files + totals + pins + extras and clears `partial` on done", async () => {
    script.events = [
      head(),
      { t: "files", files: [row("a.mp4"), row("b.mp4")] },
      { t: "files", files: [row("c.mp4")] },
      { t: "totals", counts: { pinned: 1 }, peerCount: 2, status: "behind", taskMetrics: { undecided: 3 } },
      { t: "pins", ipfs: "ok", pinnedHere: { "a.mp4": true, "c.mp4": false } },
      { t: "extras", missingPinned: [{ path: "z" }], deletedHere: [], syncBlocked: null },
      { t: "done" },
    ] as RepoDetailStreamEvent[];

    const d = await streamRepoDetail(qc, "r1");
    expect(d.files.map((f) => f.path)).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    expect(d.counts).toEqual({ pinned: 1 });
    expect(d.peerCount).toBe(2);
    expect(d.status).toBe("behind");
    expect(d.taskMetrics).toEqual({ undecided: 3 });
    expect(d.ipfs).toBe("ok");
    // The pins patch reaches exactly the rows it named, and leaves the rest UNKNOWN rather than false.
    expect(d.files[0].pinnedHere).toBe(true);
    expect(d.files[1].pinnedHere).toBeUndefined();
    expect(d.files[2].pinnedHere).toBe(false);
    expect(d.missingPinned).toEqual([{ path: "z" }]);
    expect(d.syncBlocked).toBeUndefined(); // null on the wire means "not blocked", not a block of null
    // `done` is the ONLY thing that promises completeness.
    expect(d.partial).toBeUndefined();
  });

  it("publishes intermediate states to the cache while the screen is still empty", async () => {
    const seen: number[] = [];
    script.delayMs = 25;
    script.events = [head(), { t: "files", files: [row("a.mp4")] }, { t: "files", files: [row("b.mp4")] }, { t: "done" }] as RepoDetailStreamEvent[];
    const unsub = qc.getQueryCache().subscribe(() => {
      const n = qc.getQueryData<RepoDetail>(["repo", "r1"])?.files.length;
      if (n !== undefined) seen.push(n);
    });
    await streamRepoDetail(qc, "r1");
    unsub();
    // Something reached the screen BEFORE the last row did — that is the whole point of the feature.
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeLessThan(2);
  });

  it("publishes NOTHING mid-flight when the cache already holds a complete detail", async () => {
    qc.setQueryData(["repo", "r1"], { repoId: "r1", name: "old", files: [row("old.mp4")] } as RepoDetail);
    script.delayMs = 25;
    script.events = [head(), { t: "files", files: [row("a.mp4")] }, { t: "done" }] as RepoDetailStreamEvent[];
    const p = streamRepoDetail(qc, "r1");
    await settle();
    // The previous complete answer is still on screen — no empty-then-refill blink.
    expect(qc.getQueryData<RepoDetail>(["repo", "r1"])?.files.map((f) => f.path)).toEqual(["old.mp4"]);
    await p;
  });

  it("resumes publishing when the cached detail is itself partial (a cancelled earlier run)", async () => {
    qc.setQueryData(["repo", "r1"], { repoId: "r1", files: [row("old.mp4")], partial: true } as RepoDetail);
    script.delayMs = 25;
    script.events = [head(), { t: "files", files: [row("a.mp4")] }, { t: "done" }] as RepoDetailStreamEvent[];
    const p = streamRepoDetail(qc, "r1");
    await settle();
    expect(qc.getQueryData<RepoDetail>(["repo", "r1"])?.partial).toBe(true);
    await p;
  });

  it("falls back to the buffered route when the stream breaks", async () => {
    script.events = [head(), { t: "files", files: [row("a.mp4")] }] as RepoDetailStreamEvent[];
    script.failAfter = 1; // break after the head, with rows still owed
    const d = await streamRepoDetail(qc, "r1");
    expect(d).toBe(bufferedDetail);
  });

  it("surfaces a server-sent error by falling back, never by returning half a page", async () => {
    script.events = [head(), { t: "error", error: "walk failed" }] as RepoDetailStreamEvent[];
    const d = await streamRepoDetail(qc, "r1");
    expect(d).toBe(bufferedDetail);
  });

  it("re-throws an abort instead of refetching what was just cancelled", async () => {
    script.events = [head()] as RepoDetailStreamEvent[];
    script.abort = true;
    await expect(streamRepoDetail(qc, "r1")).rejects.toThrow(/abort/i);
  });
});

describe("streamRepoRows — the Repos table", () => {
  it("concatenates the batches in order", async () => {
    script.events = [
      { t: "meta", total: 3 },
      { t: "batch", rows: [{ repoId: "a" }, { repoId: "b" }] },
      { t: "batch", rows: [{ repoId: "c" }] },
      { t: "done", total: 3 },
    ] as RepoRowsStreamEvent[];
    const rows = await streamRepoRows(qc);
    expect(rows.map((r) => r.repoId)).toEqual(["a", "b", "c"]);
  });

  it("falls back to the buffered list rather than leaving a partial one on screen", async () => {
    script.events = [{ t: "meta", total: 2 }, { t: "batch", rows: [{ repoId: "a" }] }] as RepoRowsStreamEvent[];
    script.failAfter = 2;
    const rows = await streamRepoRows(qc);
    expect(rows).toBe(bufferedRows);
  });

  it("re-throws an abort instead of refetching what was just cancelled", async () => {
    script.events = [{ t: "meta", total: 0 }] as RepoRowsStreamEvent[];
    script.abort = true;
    await expect(streamRepoRows(qc)).rejects.toThrow(/abort/i);
  });
});
