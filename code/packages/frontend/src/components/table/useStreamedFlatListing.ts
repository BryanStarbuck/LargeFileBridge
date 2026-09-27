// Progressive, non-blocking consumption of the flat large-file stream (performance.mdx P-23).
//
// Opens GET /api/fs/flat/stream and feeds the Full Paths table as rows arrive, instead of a single
// blocking useQuery blob. The design keeps renders bounded no matter how many rows stream:
//   • incoming `batch` rows accumulate into a useRef array (NO React render per batch);
//   • the ref is flushed into state THROTTLED — the first flush on the next frame, then at most one every
//     FLUSH_INTERVAL_MS (~4 a second). Every flush makes the page re-filter and re-sort the WHOLE growing
//     list, so flushing once per animation frame cost O(n log n) sixty times a second for the length of the
//     walk; four times a second keeps the table visibly filling at a fraction of that. The final `done`
//     flush is immediate, so the finished (and finally sorted) list never waits on the throttle;
//   • the stream ABORTS on unmount / root change, which the backend observes (req "close") and stops
//     walking — no orphaned walks (Aspect 7 scaling).
//
// The return shape mirrors the useQuery(api.fsFlat) fields FullPathsPage already read, plus setFiles
// for the optimistic pin/unpin badge patch (P-08) that used to setQueryData the React Query cache.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FsEntry, FlatStreamEvent } from "@lfb/shared";
import { streamNdjson } from "../../lib/streamNdjson.js";
import { subscribeFlatBadgePatch } from "../../lib/flatListingPatch.js";
import { clientLog } from "../../lib/clientLog.js";

export interface StreamedFlatListing {
  files: FsEntry[];
  root: string | null;
  thresholdBytes: number | null;
  truncated: boolean;
  done: boolean; // the walk finished (success or error) — distinguishes "still streaming" from "empty"
  loading: boolean; // true until the first rows (or done/error) land
  error: string | null;
  /** Patch the accumulated rows in place (optimistic badge flip — P-08) without a re-walk. */
  setFiles: (updater: (prev: FsEntry[]) => FsEntry[]) => void;
}

/** Minimum gap between two intermediate flushes while the walk streams (see the header). */
const FLUSH_INTERVAL_MS = 250;

const EMPTY: Omit<StreamedFlatListing, "setFiles"> = {
  files: [],
  root: null,
  thresholdBytes: null,
  truncated: false,
  done: false,
  loading: false,
  error: null,
};

export function useStreamedFlatListing(root: string | null, hidden: boolean): StreamedFlatListing {
  const [state, setState] = useState<Omit<StreamedFlatListing, "setFiles">>(EMPTY);
  const bufRef = useRef<FsEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaRef = useRef<{ root: string; thresholdBytes: number } | null>(null);

  // Stable patch handler for the optimistic badge flip — mutates the buffer AND the visible state.
  const setFiles = useCallback((updater: (prev: FsEntry[]) => FsEntry[]) => {
    bufRef.current = updater(bufRef.current);
    setState((prev) => ({ ...prev, files: bufRef.current.slice() }));
  }, []);

  // Receive per-entity badge patches from the ⋯ / right-click menu (P-17) — the streamed listing left
  // React Query, so patchEntityBadges reaches it through this bridge instead of setQueryData.
  useEffect(
    () =>
      subscribeFlatBadgePatch((path, badges) => {
        setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, badges } : f)));
      }),
    [setFiles],
  );

  useEffect(() => {
    if (!root) {
      setState(EMPTY);
      return;
    }
    bufRef.current = [];
    metaRef.current = null;
    setState({ ...EMPTY, loading: true });
    const ac = new AbortController();

    let lastFlush = 0; // 0 = nothing flushed yet — the first rows go out on the next frame
    const flush = () => {
      timerRef.current = null;
      lastFlush = Date.now();
      setState((prev) => ({
        ...prev,
        files: bufRef.current.slice(),
        loading: false,
        root: metaRef.current?.root ?? prev.root,
        thresholdBytes: metaRef.current?.thresholdBytes ?? prev.thresholdBytes,
      }));
    };
    const scheduleFlush = () => {
      if (timerRef.current != null) return;
      const wait = lastFlush === 0 ? 16 : Math.max(16, lastFlush + FLUSH_INTERVAL_MS - Date.now());
      timerRef.current = setTimeout(flush, wait);
    };
    const cancelPending = () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    streamNdjson(`/fs/flat/stream?${query(root, hidden)}`, {
      signal: ac.signal,
      onEvent: (raw) => {
        const ev = raw as FlatStreamEvent;
        if (ev.t === "meta") {
          metaRef.current = { root: ev.root, thresholdBytes: ev.thresholdBytes };
          scheduleFlush();
        } else if (ev.t === "batch") {
          for (const f of ev.files) bufRef.current.push(f);
          scheduleFlush();
        } else if (ev.t === "done") {
          cancelPending();
          setState((prev) => ({
            ...prev,
            files: bufRef.current.slice(),
            truncated: ev.truncated,
            done: true,
            loading: false,
            root: metaRef.current?.root ?? prev.root,
            thresholdBytes: metaRef.current?.thresholdBytes ?? prev.thresholdBytes,
          }));
        } else if (ev.t === "error") {
          // The backend walk reported a failure mid-stream — surface it to error.err, not just the UI.
          cancelPending();
          clientLog.error("useStreamedFlatListing.streamError", ev.error);
          setState((prev) => ({ ...prev, error: ev.error, loading: false, done: true }));
        }
      },
    }).catch((e: unknown) => {
      if (ac.signal.aborted) return; // unmount / root change — expected, not an error
      cancelPending();
      clientLog.error("useStreamedFlatListing.stream", e);
      setState((prev) => ({ ...prev, error: (e as Error).message, loading: false, done: true }));
    });

    return () => {
      ac.abort();
      cancelPending();
    };
  }, [root, hidden]);

  return { ...state, setFiles };
}

function query(root: string, hidden: boolean): string {
  const params = new URLSearchParams({ path: root });
  if (hidden) params.set("hidden", "1");
  return params.toString();
}
