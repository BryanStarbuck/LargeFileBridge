// Web-session render ping (sessions.mdx §2.1). Reports "a page was rendered" to the backend on app
// open and on every route navigation, so the server can track web sessions and auto-sync a stale
// return. Throttled — the windows we drive are measured in hours (4h idle / 48h stale), so at most one
// ping per THROTTLE_MS is plenty; the FIRST render after mount is always reported so a fresh return is
// detected immediately. Fire-and-forget: a failed ping must never disturb the page.
import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { api } from "../api/client.js";
import { clientLog } from "./clientLog.js";

const THROTTLE_MS = 60_000; // ≤ 1 ping/min — hour-scale windows don't need finer resolution

export function useSessionPing(): void {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const lastPingAt = useRef(0);

  useEffect(() => {
    const now = Date.now();
    // Always ping on the first render (lastPingAt === 0); afterwards throttle to once per THROTTLE_MS.
    if (lastPingAt.current !== 0 && now - lastPingAt.current < THROTTLE_MS) return;
    lastPingAt.current = now;
    api.recordActivity().catch((e) => clientLog.warn("sessionPing", e));
  }, [pathname]);
}
