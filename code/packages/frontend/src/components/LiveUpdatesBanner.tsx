// "Live updates paused" — the visible truth when the state-event stream is not connected.
//
// WHY THIS EXISTS. Every page in the app refreshes itself off the live state-event stream (no polling —
// performance.mdx locks that). When the stream drops, pin status, sync progress and scan results simply
// STOP moving while the page still looks perfectly alive. A user watching a sync then sees stale truth and
// cannot tell it from a broken sync. This strip says it out loud instead.
//
// It is deliberately quiet: a grace delay keeps a one-second blip (a backend restart, a laptop waking) from
// flashing a scary banner, and it disappears by itself the moment the stream is back.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { useLiveStatus } from "../lib/useLiveRefresh.js";

/** Don't shout about a blip. Reconnect backoff starts at ~1s, so anything shorter than this self-heals
 *  before a user could act on the message. */
const GRACE_MS = 4_000;

export function LiveUpdatesBanner() {
  const status = useLiveStatus();
  const qc = useQueryClient();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (status === "live") {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [status]);

  if (!show || status === "live") return null;

  return (
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-8 py-2 text-sm text-amber-900">
      <WifiOff className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        Live updates are paused — Large File Bridge is reconnecting. What you see may be out of date until it
        comes back.
      </span>
      <button
        onClick={() => void qc.invalidateQueries()}
        className="shrink-0 rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
      >
        Refresh now
      </button>
    </div>
  );
}
