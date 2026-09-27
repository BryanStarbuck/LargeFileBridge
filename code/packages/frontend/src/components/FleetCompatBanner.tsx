// The FLEET COMPATIBILITY nudge (backward_compatibility.md §6). Mounted in the AppShell beside the IPFS
// banner; renders nothing unless there is something the user can act on:
//   * another of their computers runs an OLDER Large File Bridge whose build is known to do something to
//     shared data (re-stamping, re-ordering, line-union merges), or
//   * this computer's tug-of-war breaker is HOLDING a shared file because another computer keeps turning
//     it back (sync-fight.ts).
// It says what the older build does and what this computer does about it, so "update that computer" comes
// with a reason. Dismissible per situation — a NEW stale computer or a new held file shows it again.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, X } from "lucide-react";
import { api } from "../api/client.js";

const DISMISSED_KEY = "lfb.fleetCompat.dismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function FleetCompatBanner() {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const { data } = useQuery({
    queryKey: ["fleetCompat"],
    queryFn: api.fleetCompat,
    // A peer's build changes when someone updates that computer — minutes-to-days, never seconds.
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
  if (!data) return null;
  const affected = data.stalePeers.filter((p) => p.defects.length > 0);
  if (affected.length === 0 && data.fights.length === 0) return null;
  // The situation's identity: which computers at which builds, and which files are held.
  const signature = JSON.stringify([affected.map((p) => [p.device, p.build]), data.fights.map((f) => f.file)]);
  if (dismissed === signature) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISSED_KEY, signature);
    } catch {
      /* private window — dismiss for this page view only */
    }
    setDismissed(signature);
  };
  const names = affected.map((p) => `${p.device} (build ${p.build || "older"})`).join(", ");

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-8 py-2 text-sm text-amber-900">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          {affected.length > 0
            ? `${affected.length === 1 ? "Another of your computers runs" : `${affected.length} of your computers run`} an older Large File Bridge (${names}) that rewrites shared data in ways this build no longer does. Large File Bridge on this computer ignores those rewrites — update ${affected.length === 1 ? "that computer" : "those computers"} to stop them.`
            : `Large File Bridge stopped rewriting ${data.fights.length} shared file(s) that another computer keeps changing back.`}
        </span>
        <button type="button" className="lfb-btn lfb-btn-sm shrink-0" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Details
        </button>
        <button type="button" aria-label="Dismiss" className="shrink-0 rounded p-1 hover:bg-amber-100" onClick={dismiss}>
          <X className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 pl-6 text-xs">
          <div>This computer is on build {data.build} — {data.label}.</div>
          {affected.map((p) => (
            <div key={p.device}>
              <div className="font-medium">
                {p.device} — build {p.build || "older than build tracking"}
              </div>
              <ul className="list-disc pl-5">
                {p.defects.map((d) => (
                  <li key={d.id}>
                    It {d.does}. This computer: {d.defended}.
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {data.fights.length > 0 && (
            <div>
              <div className="font-medium">Shared files this computer has stopped rewriting</div>
              <ul className="list-disc pl-5">
                {data.fights.map((f) => (
                  <li key={f.file} className="break-all">
                    {f.file} — since {new Date(f.since).toLocaleString()}, {f.held} write(s) declined. Nothing is lost: this
                    computer keeps its copy, and any new change here is still written.
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
