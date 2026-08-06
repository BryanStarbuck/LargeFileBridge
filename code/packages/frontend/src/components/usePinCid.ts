// Optimistic pin/unpin for a single CID against the local node (POST /api/ipfs/pin, ipfs.mdx §3).
// Used by any surface that shows a real CID (the IPFS pins table today). Keeps a per-CID override so
// the toggle flips instantly, then settles on the node's VERIFIED state; reverts + toasts on error.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../api/client.js";
import { clientLog } from "../lib/clientLog.js";

/**
 * @param serverStamp Changes whenever fresh server data lands (a refetch, a live bump). Overrides for
 *   CIDs with nothing in flight are dropped on that change: an override is a claim about a click that
 *   the server has now answered for itself, and one held past its refresh is just stale UI that
 *   outranks the truth — a CID re-pinned by the pin pass would keep reading "not pinned" forever.
 */
export function usePinCid(serverStamp?: unknown) {
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // The drop-stale effect below must not re-run when `busy` changes (that would drop overrides the moment
  // a request settles, before the refetch it settled into). So it reads the in-flight set through a ref,
  // synced by its own effect ABOVE it — declaration order is what guarantees the ref is already current
  // when a single render changes both.
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    setOverride((o) => {
      const inFlight = busyRef.current;
      const next = Object.fromEntries(Object.entries(o).filter(([cid]) => inFlight.has(cid)));
      return Object.keys(next).length === Object.keys(o).length ? o : next;
    });
  }, [serverStamp]);

  const toggle = useCallback((cid: string, currentlyPinned: boolean) => {
    const next = !currentlyPinned;
    setOverride((o) => ({ ...o, [cid]: next }));
    setBusy((b) => new Set(b).add(cid));
    api
      .ipfsPin({ cid, pinned: next })
      .then((r) => {
        setOverride((o) => ({ ...o, [cid]: r.pinned }));
        // An unpin of a file still set to sync would be undone by the next pin pass, so the server clears
        // that decision with it (ipfs.mdx §3). Say so — the file leaving the sync set is a bigger
        // consequence than the pin dropping, and it is the half the user did not click on.
        if (r.unsynced.length > 0) {
          const what =
            r.unsynced.length === 1 ? r.unsynced[0] : `${r.unsynced.length} files`;
          toast.success(`Unpinned — ${what} will no longer sync across your computers`);
        } else {
          toast.success(next ? "Pinned" : "Unpinned");
        }
      })
      .catch((e: Error) => {
        setOverride((o) => ({ ...o, [cid]: currentlyPinned })); // revert
        clientLog.error("usePinCid.toggle", e);
        toast.error(e.message);
      })
      .finally(() =>
        setBusy((b) => {
          const n = new Set(b);
          n.delete(cid);
          return n;
        }),
      );
  }, []);

  /** Effective pinned state: an in-flight/settled override wins over the server fallback. */
  const isPinned = useCallback((cid: string, fallback: boolean) => override[cid] ?? fallback, [override]);
  const isBusy = useCallback((cid: string) => busy.has(cid), [busy]);

  return { toggle, isPinned, isBusy };
}
