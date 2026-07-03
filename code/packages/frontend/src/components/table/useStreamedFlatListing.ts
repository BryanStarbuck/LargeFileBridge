// Progressive, non-blocking consumption of the flat large-file stream (performance.mdx P-23).
//
// Opens GET /api/fs/flat/stream and feeds the Full Paths table as rows arrive, instead of a single
// blocking useQuery blob. The design keeps renders bounded no matter how many rows stream:
//   • incoming `batch` rows accumulate into a useRef array (NO React render per batch);
//   • the ref is flushed into state COALESCED on requestAnimationFrame — at most one render per frame
//     (the P-18 windowing discipline, applied to ingest). A 5000-row stream costs a handful of
//     renders, not 5000;
//   • the stream ABORTS on unmount / root change, which the backend observes (req "close") and stops
//     walking — no orphaned walks (Aspect 7 scaling).
//
// The return shape mirrors the useQuery(api.fsFlat) fields FullPathsPage already read, plus setFiles
// for the optimistic pin/unpin badge patch (P-08) that used to setQueryData the React Query cache.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FsEntry, FlatStreamEvent } from "@lfb/shared";
import { streamNdjson } from "../../lib/streamNdjson.js";
import { subscribeFlatBadgePatch } from "../../lib/flatListingPatch.js";

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
  const rafRef = useRef<number | null>(null);
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

    const flush = () => {
      rafRef.current = null;
      setState((prev) => ({
        ...prev,
        files: bufRef.current.slice(),
        loading: false,
        root: metaRef.current?.root ?? prev.root,
        thresholdBytes: metaRef.current?.thresholdBytes ?? prev.thresholdBytes,
      }));
    };
    const scheduleFlush = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(flush);
    };
    const cancelPending = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
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
          cancelPending();
          setState((prev) => ({ ...prev, error: ev.error, loading: false, done: true }));
        }
      },
    }).catch((e: unknown) => {
      if (ac.signal.aborted) return; // unmount / root change — expected, not an error
      cancelPending();
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
