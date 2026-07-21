// The Scans page (scan.mdx §7, storage.mdx §13, use_cases.mdx §5.2 + UC-6). Leads with the verdict:
// "will my files keep pinning on their own?" — then one DiagnosticCard per background job with a
// plain purpose line, Installed/On pills, last-run health, control actions, and the launchd mechanics
// tucked behind the chevron.
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { WorkerKind, WorkerState, WatcherState } from "@lfb/shared";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";
import { relativeTime } from "../../lib/format.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { StatusBanner } from "../../components/ui/StatusBanner.js";
import { DiagnosticCard } from "../../components/ui/DiagnosticCard.js";
import { type Health } from "../../components/ui/health.js";
import { useLiveRefresh } from "../../lib/useLiveRefresh.js";

function workerHealth(s: WorkerState): Health {
  if (!s.installed) return "neutral";
  if (!s.enabled) return "warn";
  if (s.lastRunOk === false) return "bad";
  if (s.overdue) return "warn"; // installed + on but hasn't run when it should (backbone_resilience.mdx §7)
  return "ok";
}

export function ScansPage() {
  // No interval: the constant 10s poll is replaced by the event stream (performance.mdx Aspect 6b) —
  // scan/job lifecycle bumps `scans`/`jobs`, live progress ticks bump `progress` (throttled server-side).
  const { data, error } = useQuery({ queryKey: ["jobs"], queryFn: api.jobsPage });
  useLiveRefresh(["scans", "jobs", "progress"], [["jobs"]]);
  // A fetch failure otherwise stays invisible (no toast on a background refetch), so mirror it to
  // error.err. Warn (not error) — a transient miss self-heals on the next bump.
  useEffect(() => {
    if (error) clientLog.warn("ScansPage.jobsPage.poll", error);
  }, [error]);
  const ipfsDown = data?.ipfs !== "ok";

  // The verdict is about the every-15-min transfer job — that's what keeps files moving on their own.
  const verdict: { state: Health; headline: string; sub: string } = (() => {
    if (!data) return { state: "neutral", headline: "Loading…", sub: "" };
    const t = data.pin;
    if (!t.installed)
      return {
        state: "warn",
        headline: "Automatic pinning isn't installed yet",
        sub: "Install the background job below so your big files pin every 15 minutes without you opening the app.",
      };
    if (!t.enabled)
      return {
        state: "warn",
        headline: "Automatic pinning is installed but turned off",
        sub: "Turn it on below to keep your files pinned in the background.",
      };
    if (t.lastRunOk === false)
      return {
        state: "bad",
        headline: "The last background pin failed",
        sub: "Automatic pinning is on, but the most recent run hit an error — see the transfer job below.",
      };
    if (t.overdue)
      return {
        state: "warn",
        headline: "Automatic pinning is overdue",
        sub: "The background job hasn't run when it should have. The app is retrying it in the background and repairing the schedule; if it stays overdue, reinstall the transfer job below.",
      };
    return {
      state: ipfsDown ? "bad" : "ok",
      headline: ipfsDown
        ? "Automatic pinning is on, but the IPFS engine is down"
        : "Your big files pin automatically",
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
            ? `Background jobs that keep your big files discovered and pinned on this computer (${data.computerLabel}).`
            : "Background jobs that keep your big files discovered and pinned on this computer."
        }
      />

      <StatusBanner state={verdict.state} headline={verdict.headline} sub={verdict.sub} />

      {data && (
        <div className="space-y-4">
          <WorkerCard
            worker="pin"
            title="Transfer — moves your files"
            purpose="Every 15 minutes: pushes and pulls bytes over IPFS for the repos you pin."
            state={data.pin}
          />
          <WorkerCard
            worker="device"
            title="Device registration — keeps your computers in the loop"
            purpose="Every 10 minutes: makes sure this computer's device info is written to your personal Git repo — git pull + merge first, then commit + push. Runs even when there's nothing to change, so edits from your other computers are pulled down."
            state={data.device}
          />
          <WorkerCard
            worker="scan"
            title="Discovery — finds new big files"
            purpose="Every 4 hours: walks your repos to spot new large files and changes (metadata only — no bytes move)."
            state={data.scan}
          />
          <WatcherCard state={data.watcher} />
        </div>
      )}
    </div>
  );
}

// The live filesystem watcher (scan.mdx §2.2). NOT a scheduled job — no Install step: it runs only
// while the web app is open and reacts the instant a big or video/image/audio file is added or deleted,
// updating tracking + the File System tree without waiting for the 4-hour Discovery pass. So this card
// mirrors the WorkerCard's Installed/On layout but drops "Installed" for a live "Watching N folders"
// pill and offers only Turn on / Turn off.
function watcherHealth(s: WatcherState): Health {
  if (!s.enabled) return "warn";
  if (!s.watching) return "warn"; // enabled but nothing bound (no roots / all unwatchable)
  return "ok";
}

function WatcherCard({ state }: { state: WatcherState }) {
  const qc = useQueryClient();
  const control = useMutation({
    mutationFn: (action: "enable" | "disable") => api.controlWatcher(action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("Live watch updated");
    },
    onError: (e: Error) => {
      clientLog.error("ScansPage.controlWatcher", e);
      toast.error(e.message);
    },
  });

  const h = watcherHealth(state);
  const rootCount = state.roots.length;
  const status = !state.enabled
    ? "off — changes are picked up by the 4-hour Discovery pass instead"
    : state.watching
      ? `watching ${rootCount} ${rootCount === 1 ? "folder" : "folders"} for added/deleted big & media files`
      : "on, but no folders are being watched yet — set your scan roots in Settings";

  return (
    <DiagnosticCard
      state={h}
      title="Live watch — reacts instantly"
      summary="While the app is open: the moment a big file or a video/image/audio file is added or deleted, it updates your tracking and the File System tree — no waiting for the 4-hour scan."
      pills={
        <>
          <Pill on={state.enabled} onLabel="On" offLabel="Off" />
          {state.enabled && (
            <Pill on={state.watching} onLabel={`Watching ${rootCount}`} offLabel="Idle" />
          )}
        </>
      }
      fix={
        <div className="flex gap-2">
          {state.enabled ? (
            <Btn onClick={() => control.mutate("disable")}>Turn off</Btn>
          ) : (
            <Btn primary onClick={() => control.mutate("enable")}>
              Turn on
            </Btn>
          )}
        </div>
      }
    >
      <div className="space-y-1">
        <div>{status}</div>
        <div className="text-xs text-black/45">
          Not a scheduled job — it runs only while the web app is open, using your operating system's
          native file-change notifications. It reacts to files being <strong>added or deleted</strong>,
          never to edits, and moves no bytes. Changes made while the app is closed are caught by the
          Discovery pass above.
        </div>
      </div>
    </DiagnosticCard>
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
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success(`${title} updated`);
    },
    onError: (e: Error) => {
      // A worker install/uninstall/enable/disable failed — surface to the user AND log to error.err.
      clientLog.error(`ScansPage.controlWorker.${worker}`, e);
      toast.error(e.message);
    },
  });

  const h = workerHealth(state);
  const lastRun =
    state.lastRunAt == null
      ? "never run"
      : `last run ${relativeTime(state.lastRunAt)}${
          state.lastRunOk === false ? " — failed" : state.overdue ? " — overdue" : ""
        }`;

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
