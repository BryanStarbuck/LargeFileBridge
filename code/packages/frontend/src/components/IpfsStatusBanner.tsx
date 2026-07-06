// The app-wide "IPFS is not running" nudge (ipfs_ui.mdx §10). Shown on EVERY page (mounted in the
// AppShell) but ONLY when the local node isn't answering — a healthy node is silent. It reads the
// CHEAP liveness endpoint (GET /api/health → { ipfs }), never the pinset, and is suppressed on the
// /ipfs pages (which already tell the full story). The action routes straight to the IPFS-off page
// (/ipfs/off), where the user installs or turns the node on — and can keep it on across reboots.
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { api } from "../api/client.js";
import { clientLog } from "../lib/clientLog.js";

export function IpfsStatusBanner() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data, error } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 20_000,
    select: (d) => d.ipfs,
  });

  // The liveness poll fails silently (the banner just won't render) — log it so a broken health
  // endpoint still leaves a fault trail. Warn, not error: a down node is an expected transient state.
  useEffect(() => {
    if (error) clientLog.warn("IpfsStatusBanner.health", error);
  }, [error]);

  // Suppress on the IPFS pages themselves; only nudge when the node isn't answering.
  if (path.startsWith("/ipfs")) return null;
  if (!data || data === "ok") return null;

  return (
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-8 py-2 text-sm text-amber-900">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">IPFS isn't running — your files can't sync until it's set up.</span>
      <Link
        to="/ipfs/off"
        className="shrink-0 rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
      >
        Set up IPFS
      </Link>
    </div>
  );
}
