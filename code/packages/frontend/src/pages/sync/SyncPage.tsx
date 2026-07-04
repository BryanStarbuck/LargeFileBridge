// The Scans page (scan.mdx §7, storage.mdx §13, use_cases.mdx §5.2 + UC-6). Leads with the verdict:
// "will my files keep syncing on their own?" — then one DiagnosticCard per background job with a
// plain purpose line, Installed/On pills, last-run health, control actions, and the launchd mechanics
// tucked behind the chevron.
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { WorkerKind, WorkerState } from "@lfb/shared";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";
import { relativeTime } from "../../lib/format.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner } from "../../components/ui/StatusBanner.js";
import { DiagnosticCard } from "../../components/ui/DiagnosticCard.js";
import { type Health } from "../../components/ui/health.js";

function workerHealth(s: WorkerState): Health {
  if (!s.installed) return "neutral";
  if (!s.enabled) return "warn";
  if (s.lastRunOk === false) return "bad";
  return "ok";
}

export function SyncPage() {
  const { data, error } = useQuery({ queryKey: ["syncPage"], queryFn: api.syncPage, refetchInterval: 10_000 });
  // The Scans payload poll runs every 10s; a fetch failure otherwise stays invisible (no toast on a
  // background refetch), so mirror it to error.err. Warn (not error) — a transient poll miss self-heals.
  useEffect(() => {
    if (error) clientLog.warn("SyncPage.syncPage.poll", error);
  }, [error]);
  const ipfsDown = data?.ipfs !== "ok";

  // The verdict is about the every-15-min transfer job — that's what keeps files moving on their own.
  const verdict: { state: Health; headline: string; sub: string } = (() => {
    if (!data) return { state: "neutral", headline: "Loading…", sub: "" };
    const t = data.sync;
    if (!t.installed)
      return {
        state: "warn",
        headline: "Automatic syncing isn't installed yet",
        sub: "Install the background job below so your big files sync every 15 minutes without you opening the app.",
      };
    if (!t.enabled)
      return {
        state: "warn",
        headline: "Automatic syncing is installed but turned off",
        sub: "Turn it on below to keep your files synced in the background.",
      };
    if (t.lastRunOk === false)
      return {
        state: "bad",
        headline: "The last background sync failed",
        sub: "Automatic syncing is on, but the most recent run hit an error — see the transfer job below.",
      };
    return {
      state: ipfsDown ? "bad" : "ok",
      headline: ipfsDown
        ? "Automatic syncing is on, but the IPFS engine is down"
        : "Your big files sync automatically",
      sub: ipfsDown
        ? "The 15-minute job is running, but transfers can't move until the IPFS engine starts."
        : `Runs every 15 minutes on this computer (${data.computerLabel}).`,
    };
  })();

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Scans"
        subtitle={
          data
            ? `Background jobs that keep your big files discovered and synced on this computer (${data.computerLabel}).`
            : "Background jobs that keep your big files discovered and synced on this computer."
        }
      />

      <StatusBanner state={verdict.state} headline={verdict.headline} sub={verdict.sub} />

      {data && (
        <div className="space-y-4">
          <WorkerCard
            worker="sync"
            title="Transfer — moves your files"
            purpose="Every 15 minutes: pushes and pulls bytes over IPFS for the repos you sync."
            state={data.sync}
          />
          <WorkerCard
            worker="scan"
            title="Discovery — finds new big files"
            purpose="Every 4 hours: walks your repos to spot new large files and changes (metadata only — no bytes move)."
            state={data.scan}
          />
        </div>
      )}
    </div>
  );
}

function WorkerCard({
  worker,
  title,
  purpose,
  state,
}: {
  worker: WorkerKind;
  title: string;
  purpose: string;
  state: WorkerState;
}) {
  const qc = useQueryClient();
  const control = useMutation({
    mutationFn: (action: "install" | "uninstall" | "enable" | "disable") => api.controlWorker(worker, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["syncPage"] });
      toast.success(`${title} updated`);
    },
    onError: (e: Error) => {
      // A worker install/uninstall/enable/disable failed — surface to the user AND log to error.err.
      clientLog.error(`SyncPage.controlWorker.${worker}`, e);
      toast.error(e.message);
    },
  });

  const h = workerHealth(state);
  const lastRun =
    state.lastRunAt == null
      ? "never run"
      : `last run ${relativeTime(state.lastRunAt)}${state.lastRunOk === false ? " — failed" : ""}`;

  return (
    <DiagnosticCard
      state={h}
      title={title}
      summary={purpose}
      pills={
        <>
          <Pill on={state.installed} onLabel="Installed" offLabel="Not installed" />
          {state.installed && <Pill on={state.enabled} onLabel="On" offLabel="Off" />}
        </>
      }
      fix={
        <div className="flex gap-2">
          {!state.installed ? (
            <Btn primary onClick={() => control.mutate("install")}>
              Install
            </Btn>
          ) : (
            <>
              {state.enabled ? (
                <Btn onClick={() => control.mutate("disable")}>Turn off</Btn>
              ) : (
                <Btn primary onClick={() => control.mutate("enable")}>
                  Turn on
                </Btn>
              )}
              <Btn onClick={() => control.mutate("uninstall")}>Uninstall</Btn>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-1">
        <div>{lastRun}</div>
        <div className="text-xs text-black/45">
          Scheduled as a macOS <code>launchd</code> job ({state.label}), every{" "}
          {Math.round(state.intervalSeconds / 60)} min. Installing creates the job; turning it on/off is
          a separate choice.
        </div>
      </div>
    </DiagnosticCard>
  );
}

function Pill({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${on ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-600"}`}>
      {on ? onLabel : offLabel}
    </span>
  );
}

function Btn({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm ${primary ? "bg-[var(--lfb-primary)] text-white" : "border border-[var(--lfb-border)] hover:bg-slate-100"}`}
    >
      {children}
    </button>
  );
}
