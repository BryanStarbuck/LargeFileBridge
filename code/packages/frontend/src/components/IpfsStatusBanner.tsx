// The app-wide IPFS nudge (ipfs_ui.mdx §10 + §17). Mounted in the AppShell, shown on EVERY page but
// only when there's something to do — and it routes the user to the right help for the three start-up
// scenarios (§17). It reads the CHEAP liveness endpoint (installed / running / autostart / config
// blocker), never the pinset, and is suppressed on the /ipfs pages (which already tell the full story).
//
// Scenario priority (first true wins):
//   A. NOT INSTALLED       → blocking "can't sync" banner → Install (routes to /ipfs/off)
//   B. NOT RUNNING         → blocking "can't sync" banner → Start / Fix (routes to /ipfs/off; the
//                            off-page shows the Config-health card when a config blocker exists, §14)
//   C. RUNNING, no reboot  → a GENTLE, dismissible, ONE-TIME encouragement (the node is healthy right
//      auto-start           now, so NO alarming banner — no nagging). One click turns on auto-start.
//   healthy + auto-starting → nothing.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api/client.js";
import { clientLog } from "../lib/clientLog.js";

// Persist the scenario-C dismissal so the gentle nudge is genuinely one-time (ipfs_ui.mdx §17.3).
const AUTOSTART_NUDGE_DISMISSED = "lfb.ipfs.autostartNudgeDismissed";
function nudgeDismissed(): boolean {
  try {
    return localStorage.getItem(AUTOSTART_NUDGE_DISMISSED) === "1";
  } catch {
    return false;
  }
}

export function IpfsStatusBanner() {
  const qc = useQueryClient();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data, error } = useQuery({
    queryKey: ["ipfsLiveness"],
    queryFn: api.ipfsLiveness,
    refetchInterval: 20_000,
  });

  // The liveness poll fails silently (the banner just won't render) — log it so a broken endpoint still
  // leaves a fault trail. Warn, not error: a down node is an expected transient state.
  useEffect(() => {
    if (error) clientLog.warn("IpfsStatusBanner.liveness", error);
  }, [error]);

  // Turn on reboot auto-start in place (scenario C) — no page change, no daemon restart.
  const enableAutostart = useMutation({
    mutationFn: () => api.ipfsAutostart("install"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ipfsLiveness"] });
      qc.invalidateQueries({ queryKey: ["ipfsNode"] });
      toast.success("IPFS will now start automatically on reboot");
    },
    onError: (e: Error) => { clientLog.error("IpfsStatusBanner.autostart", e); toast.error(e.message); },
  });

  // Suppress on the IPFS pages themselves (they own the full story).
  if (path.startsWith("/ipfs")) return null;
  if (!data) return null;

  // Scenario A / B — the node can't sync. One blocking amber banner; the off-page sorts install vs. start
  // vs. the config-fix. When a config blocker is the reason, say so and route into the guided repair.
  if (!data.installed || !data.running) {
    const label = !data.installed ? "Install IPFS" : data.configBlocker ? "Fix IPFS" : "Start IPFS";
    const msg = !data.installed
      ? "IPFS isn't installed — your files can't sync until it's set up."
      : data.configBlocker
        ? "IPFS can't start — its configuration needs a quick fix before your files can sync."
        : "IPFS isn't running — your files can't sync until it's started.";
    return (
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-8 py-2 text-sm text-amber-900">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="flex-1">{msg}</span>
        <Link
          to="/ipfs/off"
          className="shrink-0 rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
        >
          {label}
        </Link>
      </div>
    );
  }

  // Scenario C — running fine, but it won't come back after a reboot. GENTLE (the node is healthy):
  // a low-key, dismissible, one-time strip — never the alarming red/amber "can't sync" banner.
  if (data.autostartSupported && !data.autostartEnabled && !nudgeDismissed()) {
    const dismiss = () => {
      try {
        localStorage.setItem(AUTOSTART_NUDGE_DISMISSED, "1");
      } catch {
        /* ignore */
      }
      qc.invalidateQueries({ queryKey: ["ipfsLiveness"] });
    };
    return (
      <div className="flex items-center gap-2 border-b border-[var(--lfb-border)] bg-slate-50 px-8 py-2 text-sm text-black/70">
        <RotateCw className="h-4 w-4 shrink-0 text-[var(--lfb-primary)]" />
        <span className="flex-1">
          IPFS is on, but it won't restart automatically after you reboot. Turn on auto-start so your files keep syncing.
        </span>
        <button
          onClick={() => enableAutostart.mutate()}
          disabled={enableAutostart.isPending}
          className="shrink-0 rounded-md bg-[var(--lfb-primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Turn on auto-start
        </button>
        <button onClick={dismiss} title="Dismiss" className="shrink-0 rounded p-1 text-black/40 hover:bg-slate-200 hover:text-black/70">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // Healthy and auto-starting (or auto-start unsupported / nudge dismissed) → silent.
  return null;
}
