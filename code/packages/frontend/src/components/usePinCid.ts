// Optimistic pin/unpin for a single CID against the local node (POST /api/ipfs/pin, ipfs.mdx §3).
// Used by any surface that shows a real CID (the IPFS pins table today). Keeps a per-CID override so
// the toggle flips instantly, then settles on the node's VERIFIED state; reverts + toasts on error.
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api } from "../api/client.js";
import { clientLog } from "../lib/clientLog.js";

export function usePinCid() {
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const toggle = useCallback((cid: string, currentlyPinned: boolean) => {
    const next = !currentlyPinned;
    setOverride((o) => ({ ...o, [cid]: next }));
    setBusy((b) => new Set(b).add(cid));
    api
      .ipfsPin({ cid, pinned: next })
      .then((r) => {
        setOverride((o) => ({ ...o, [cid]: r.pinned }));
        toast.success(r.pinned ? "Pinned" : "Unpinned");
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
