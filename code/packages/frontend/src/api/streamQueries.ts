// Progressive query functions for the two screens that used to wait on one fully-composed blob:
// the Repos landing table and the One-repo detail (performance.mdx P-37).
//
// WHY THESE ARE `queryFn`s AND NOT A HOOK. Both screens already keep ALL their state in the React Query
// cache — `["repos"]` and `["repo", repoId]` — and a dozen mutations, the live-refresh stream, the warning
// popups and the optimistic bookmark flip all read and write those exact keys. Moving either page to a
// bespoke store would mean rewriting every one of them. So the stream is driven from INSIDE the queryFn and
// publishes what it has so far with `setQueryData` (the pattern TanStack documents for streamed responses):
// the page keeps one source of truth, every existing mutation keeps working unchanged, and an invalidation
// simply re-opens the stream.
//
// Three rules the code below keeps:
//   • ONE publish per animation frame. A 5,000-row detail arrives as ~20 batches; without coalescing that
//     is 20 cache writes and 20 re-renders of a page whose table then re-derives its row model. The build
//     itself is deferred to flush time, so a burst of events costs ONE object construction (the P-18/P-23
//     rAF discipline, applied to ingest).
//   • A failed stream FALLS BACK to the buffered endpoint, never to a half list. Streaming is a delivery
//     optimization; if a proxy buffers it, an older backend has no such route, or the walk faults, the page
//     must still show the complete, correct answer rather than silently the first N rows.
//   • An ABORT is not a failure. React Query cancels the signal on unmount, on `cancelQueries` (the bookmark
//     mutation does this), and when a newer fetch supersedes this one — those must propagate as
//     cancellations, never trigger the fallback refetch they were cancelling.
import type { QueryClient } from "@tanstack/react-query";
import type {
  FileRow,
  RepoDetail,
  RepoDetailStreamEvent,
  RepoRow,
  RepoRowsStreamEvent,
} from "@lfb/shared";
import { api } from "./client.js";
import { streamNdjson } from "../lib/streamNdjson.js";
import { clientLog } from "../lib/clientLog.js";

/** Coalesce many pushes into at most one `publish(build())` per frame. `build` runs at FLUSH time, so a
 *  burst of stream events costs one object construction, not one per event. */
function framePublisher<T>(build: () => T, publish: (value: T) => void) {
  let handle: number | null = null;
  const schedule =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
  const unschedule =
    typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (h: number) => clearTimeout(h);
  return {
    push(): void {
      if (handle != null) return;
      handle = schedule(() => {
        handle = null;
        publish(build());
      });
    },
    /** Drop any pending frame — used once the final value is returned, so it cannot land after it. */
    cancel(): void {
      if (handle == null) return;
      unschedule(handle);
      handle = null;
    },
  };
}

/** True when this rejection is React Query cancelling us, not the server failing. */
function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (e as { name?: string })?.name === "AbortError";
}

// WHEN A RUN PUBLISHES INTERMEDIATE STATES, AND WHEN IT ONLY PUBLISHES ITS ANSWER.
//
// Progressive rendering exists for a screen with nothing on it. On a REFETCH there is already a COMPLETE
// answer on screen — React Query's whole refetch contract is that it stays there until the new one lands —
// and publishing partials would replace it with a table that empties and refills. Every live-refresh bump
// (a pin pass, a batch settling) triggers a refetch, so that flicker would be near-constant during exactly
// the background work these pages exist to watch.
//
// The test is COMPLETENESS, not emptiness. A run that was cancelled mid-stream (an invalidation arriving
// during the first load is the ordinary way this happens) leaves REAL but PARTIAL data behind, and treating
// that as "already answered" would freeze the table at however many rows it had reached until the next run
// finished. The detail carries its own `partial` flag for this; the row list has nowhere to put one, so the
// module remembers whether the answer it last published was whole.
let repoListComplete = false;

/** The detail's own answer to the question above — `partial` travels in the cached value itself. */
function detailNeedsPartials(cached: RepoDetail | undefined): boolean {
  return !cached || cached.partial === true;
}

// ── The Repos table ───────────────────────────────────────────────────────────

/**
 * `queryFn` for `["repos"]`. Streams `GET /api/repos/stream`, publishing the rows composed so far after
 * every batch, and resolves with the complete list.
 */
export async function streamRepoRows(qc: QueryClient, signal?: AbortSignal): Promise<RepoRow[]> {
  const rows: RepoRow[] = [];
  const live = !repoListComplete;
  // Publishing partials is what makes the cache incomplete, so say so before the first one lands.
  if (live) repoListComplete = false;
  const pub = framePublisher(
    () => rows.slice(),
    (v) => qc.setQueryData(["repos"], v),
  );
  try {
    await streamNdjson("/repos/stream", {
      signal,
      onEvent: (raw) => {
        const ev = raw as RepoRowsStreamEvent;
        if (ev.t === "batch") {
          for (const r of ev.rows) rows.push(r);
          if (live) pub.push();
        } else if (ev.t === "error") {
          throw new Error(ev.error);
        }
      },
    });
  } catch (e) {
    pub.cancel();
    if (isAbort(e, signal)) throw e;
    // Complete-and-correct beats fast-and-partial: re-ask the buffered endpoint rather than leaving the
    // table showing however many rows happened to arrive before the break.
    clientLog.warn("streamRepoRows.fallback", e);
    const full = await api.repos();
    repoListComplete = true;
    return full;
  }
  pub.cancel();
  repoListComplete = true;
  return rows;
}

// ── The One-repo detail ───────────────────────────────────────────────────────

/**
 * `queryFn` for `["repo", repoId]`. Streams `GET /api/repos/:repoId/detail/stream`, publishing after every
 * event, and resolves with the finished detail.
 *
 * Everything published before `done` carries `partial: true` — the header and the rows so far are real, the
 * aggregates beside them are running subtotals, and the IPFS health is not yet known. The page reads that
 * flag to hold back the one thing an intermediate value would state WRONGLY rather than merely early.
 */
export async function streamRepoDetail(
  qc: QueryClient,
  repoId: string,
  signal?: AbortSignal,
): Promise<RepoDetail> {
  const key = ["repo", repoId];
  const live = detailNeedsPartials(qc.getQueryData<RepoDetail>(key));
  let head: RepoDetail | null = null;
  let files: FileRow[] = [];
  const build = (): RepoDetail => ({ ...(head as RepoDetail), files });
  const pub = framePublisher(build, (v) => qc.setQueryData(key, v));
  const emit = (): void => {
    if (live) pub.push();
  };

  try {
    await streamNdjson(`/repos/${encodeURIComponent(repoId)}/detail/stream`, {
      signal,
      onEvent: (raw) => {
        const ev = raw as RepoDetailStreamEvent;
        if (ev.t === "head") {
          head = ev.detail;
          files = [];
          emit();
          return;
        }
        // Every event below patches the head; one that arrives without it is a protocol break, and
        // silently dropping it would show an empty page rather than an error.
        if (!head) {
          if (ev.t === "error") throw new Error(ev.error);
          throw new Error(`repo detail stream sent "${ev.t}" before its header`);
        }
        if (ev.t === "files") {
          for (const f of ev.files) files.push(f);
        } else if (ev.t === "enrich") {
          // The late-arriving per-row fields (git-ignore axis, decision provenance). A path ABSENT from
          // the patch keeps what it has — for `gitignore` that is UNDETERMINED, which the ⊘ column renders
          // as an inert "not determined" icon rather than claiming the file is not ignored.
          const rows = ev.rows;
          files = files.map((f) => (rows[f.path] ? { ...f, ...rows[f.path] } : f));
        } else if (ev.t === "totals") {
          head = {
            ...head,
            counts: ev.counts,
            peerCount: ev.peerCount,
            status: ev.status,
            // The server omits the metrics only if it had none to send — keep what we already showed
            // rather than blanking the strip.
            taskMetrics: ev.taskMetrics ?? head.taskMetrics,
          };
        } else if (ev.t === "pins") {
          // The live pin reality, patched onto the rows it applies to. A path absent from the map keeps
          // `pinnedHere: undefined` — the defined "not known" state, never a false red.
          const map = ev.pinnedHere;
          files = files.map((f) => (f.path in map ? { ...f, pinnedHere: map[f.path] } : f));
          head = { ...head, ipfs: ev.ipfs };
        } else if (ev.t === "extras") {
          head = {
            ...head,
            missingPinned: ev.missingPinned,
            deletedHere: ev.deletedHere,
            syncBlocked: ev.syncBlocked ?? undefined,
          };
        } else if (ev.t === "done") {
          const { partial: _partial, ...final } = head;
          head = final;
        } else if (ev.t === "error") {
          throw new Error(ev.error);
        }
        emit();
      },
    });
  } catch (e) {
    pub.cancel();
    if (isAbort(e, signal)) throw e;
    clientLog.warn("streamRepoDetail.fallback", e);
    return api.repo(repoId);
  }
  pub.cancel();
  // A stream that ended without a header never told us anything — the buffered route is the honest answer.
  if (!head) return api.repo(repoId);
  return build();
}
