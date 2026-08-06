// The Scans page (scan.mdx §7, storage.mdx §13, use_cases.mdx §5.2 + UC-6). Leads with the verdict:
// "will my files keep pinning on their own?" — then one DiagnosticCard per background job with a
// plain purpose line, Installed/On pills, last-run health, control actions, and the launchd mechanics
// tucked behind the chevron.
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { WorkerKind, WorkerState, WatcherState, BackbonePushState } from "@lfb/shared";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";
import { relativeTime, absoluteTime } from "../../lib/format.js";
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
  if (s.lastMiss !== null) return "warn"; // fires happened but never reached the app — see missedCycleNote
  return "ok";
}

// A scheduled fire that never reached the app, in the user's words. The charter's background-process
// transparency has to cover the cycles the app itself could not see: the launchd job fired, the work did
// not happen, and before this the only trace was a line in error.err. Each reason is a genuinely different
// story and gets a genuinely different sentence — the old code called all of them "app not running".
function missedCycleNote(s: WorkerState): string | null {
  if (s.lastMiss === null) return null;
  const { reason, consecutive, at } = s.lastMiss;
  const many = consecutive > 1 ? `${consecutive} scheduled runs in a row` : "A scheduled run";
  const when = `(most recently ${relativeTime(at)})`;
  if (reason === "app-not-running")
    return `${many} couldn't start because Large File Bridge wasn't running ${when}. Now that it's open, Large File Bridge is catching the missed work up in the background.`;
  if (reason === "ack-timeout")
    return `${many} didn't get an answer from Large File Bridge in time ${when} — the app was reachable, so the work may already have run. Large File Bridge is re-checking in the background.`;
  if (reason === "socket-error")
    return `${many} lost the connection to Large File Bridge before it could start ${when}. Large File Bridge is re-running the missed work in the background.`;
  return `${many} was turned away by Large File Bridge ${when}. If this keeps happening, reinstall the job below.`;
}

// One backbone that is failing to push, in the user's words. Says the three things that matter: WHAT is
// stuck (this computer's file list), FOR HOW LONG, and that Large File Bridge is still retrying it.
function unsharedNote(s: BackbonePushState): string {
  const since = s.lastPushAt
    ? `The last update that reached them was ${relativeTime(s.lastPushAt)}.`
    : `No update from this computer has ever reached them.`;
  const held =
    s.unpushedCommits > 0
      ? ` ${s.unpushedCommits} update${s.unpushedCommits === 1 ? "" : "s"} ${s.unpushedCommits === 1 ? "is" : "are"} waiting to go out.`
      : "";
  return (
    `Large File Bridge could not send this computer's tracking updates for "${s.repoName}" — ` +
    `${s.consecutiveFailures} attempt${s.consecutiveFailures === 1 ? "" : "s"} in a row were rejected. ${since}${held} ` +
    `Nothing is lost: Large File Bridge keeps the updates and keeps retrying in the background.`
  );
}

// The card. Only appears when something is actually stuck — a backbone that is sharing normally is not
// news. Never a "check the log" instruction: the remote's own words are behind the chevron.
function BackbonePushCard({ states }: { states: BackbonePushState[] }) {
  const worst = states[0]!;
  return (
    <DiagnosticCard
      state={worst.consecutiveFailures >= 3 ? "bad" : "warn"}
      title="Sharing with your other computers"
      summary={unsharedNote(worst)}
      pills={<Pill on={false} onLabel="Sharing" offLabel="Not sharing" />}
    >
      <div className="space-y-2">
        {states.map((s) => (
          <div key={s.storageId}>
            <div className="font-medium text-black/80">{s.repoName}</div>
            <div className="text-xs text-black/60">
              {s.consecutiveFailures} rejected attempt{s.consecutiveFailures === 1 ? "" : "s"} in a row
              {s.lastFailureAt ? `, most recently ${relativeTime(s.lastFailureAt)}` : ""}
              {s.unpushedCommits > 0 ? ` · ${s.unpushedCommits} update(s) held locally` : ""}
            </div>
            {s.problem && <div className="mt-0.5 text-xs text-black/45">{s.problem}</div>}
          </div>
        ))}
        <div className="text-xs text-black/45">
          This usually means another of your computers pushed to the same shared repository at the same
          moment. Large File Bridge retries on its own, waiting a little longer each time. If it keeps
          failing, the message above says what the shared repository is complaining about — an
          authentication problem is the one case that needs you.
        </div>
      </div>
    </DiagnosticCard>
  );
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
    // THIS COMPUTER HAS STOPPED SHARING (bug #16). The jobs can all be healthy while every push is being
    // rejected — and then the other computers never learn about the new large files and the machines drift
    // apart silently, which is the one failure this product exists to prevent. It outranks a missed fire.
    if (data.backbonePush.length > 0) {
      const worst = data.backbonePush[0]!;
      return {
        state: worst.consecutiveFailures >= 3 ? "bad" : "warn",
        headline: "This computer hasn't shared its file list with your other computers",
        sub: unsharedNote(worst),
      };
    }
    // Fires that were TRIGGERED but never reached the app. Distinct from "overdue": the schedule is alive
    // and firing on time — the delivery is what failed — so the fix is different and the wording must be too.
    if (t.lastMiss !== null)
      return {
        state: "warn",
        headline: "Some scheduled pin runs didn't reach Large File Bridge",
        sub: missedCycleNote(t) ?? "",
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
        // The page's ONE primary button, top right: run the Discovery pass now. It says "Scan" until this
        // computer has ever scanned and "Rescan" after that, so the label itself tells the user whether
        // there is anything behind the numbers on the rest of the site yet.
        actions={data ? <RunNowButton worker="scan" state={data.scan} /> : undefined}
      />

      {/* WHEN this computer last discovered its files — the question the button above answers, so it is
          stated right next to it in full (date AND time), not only as "3h ago". */}
      {data && (
        <p className="-mt-1 mb-3 text-xs text-black/50">
          Last scan: {data.scan.lastRunAt ? `${absoluteTime(data.scan.lastRunAt)} (${relativeTime(data.scan.lastRunAt)})` : "never"}
          {data.scan.running && " · scanning now"}
        </p>
      )}

      <StatusBanner state={verdict.state} headline={verdict.headline} sub={verdict.sub} />

      {data && (
        <div className="space-y-4">
          {data.backbonePush.length > 0 && <BackbonePushCard states={data.backbonePush} />}
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
  if (s.truncated) return "warn"; // bound, but part of the tree is past the watch limit — say so
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
        {state.watching && state.mode === "pruned" && (
          <div className="text-xs text-black/45">
            Listening to {state.watchedDirs.toLocaleString()}{" "}
            {state.watchedDirs === 1 ? "folder" : "folders"} directly. Build and dependency folders (
            <code>node_modules</code>, <code>.git</code>, <code>dist</code>, …) and anything your scan
            ignore list covers are skipped, so they cost nothing.
            {state.truncated && (
              <>
                {" "}
                <strong>
                  Some folders are past the live-watch limit — the Discovery pass above covers those
                  instead.
                </strong>
              </>
            )}
          </div>
        )}
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

/**
 * Run this job NOW. Same button in two places: the page header (Discovery — the "Scan"/"Rescan" the user
 * came here for) and each job card. It kicks the very pass launchd would have kicked, so it is a fully
 * legitimate substitute when the schedule is off or overdue — and it is single-flighted server-side, so a
 * second press during a run coalesces onto the pass already going rather than starting a competing one.
 *
 * The label carries the state: "Scan" before this computer has ever run the job, "Rescan" after, and
 * "Scanning…"/"Running…" while a pass is in flight (when it is also disabled — pressing it again would
 * do nothing, and a button that appears to do nothing reads as broken).
 */
function RunNowButton({ worker, state }: { worker: WorkerKind; state: WorkerState }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.runWorker(worker),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success(worker === "scan" ? "Scanning now" : "Running now");
    },
    onError: (e: Error) => {
      clientLog.error(`ScansPage.runWorker.${worker}`, e);
      toast.error(e.message);
    },
  });
  const isScan = worker === "scan";
  const label = state.running
    ? isScan
      ? "Scanning…"
      : "Running…"
    : isScan
      ? state.lastRunAt
        ? "Rescan"
        : "Scan"
      : "Run now";
  return (
    <button
      onClick={() => run.mutate()}
      disabled={state.running || run.isPending}
      title={
        state.running
          ? "A pass is already running — this button comes back when it finishes."
          : "Run this job right now, without waiting for its schedule."
      }
      className="lfb-btn lfb-btn-primary"
    >
      {(state.running || run.isPending) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {label}
    </button>
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
  // The full date AND time, with the relative reading in parentheses. "3h ago" alone is not enough to
  // reason about a schedule — a user checking whether the every-4-hours pass actually fired overnight
  // needs the clock time it fired at, not an approximation of the gap.
  const stamp = (iso: string) => `${absoluteTime(iso)} (${relativeTime(iso)})`;
  const lastRun = state.running
    ? // A pass is detached from whatever kicked it and can legitimately run for minutes (run-job.ts) —
      // show that it is working rather than leaving a stale "last run" reading as if nothing is happening.
      `running now${state.lastRunAt == null ? "" : ` — last finished ${stamp(state.lastRunAt)}`}`
    : state.lastRunAt == null
      ? "never run"
      : `last run ${stamp(state.lastRunAt)}${
          state.lastRunOk === false ? " — failed" : state.overdue ? " — overdue" : ""
        }`;
  const missed = missedCycleNote(state);

  return (
    <DiagnosticCard
      state={h}
      title={title}
      summary={purpose}
      pills={
        <>
          <Pill on={state.installed} onLabel="Installed" offLabel="Not installed" />
          {state.installed && <Pill on={state.enabled} onLabel="On" offLabel="Off" />}
          {state.running && <Pill on onLabel="Running now" offLabel="" />}
        </>
      }
      fix={
        <div className="flex gap-2">
          {/* Run-now sits FIRST and is available whether or not the launchd job is installed — the
              schedule being absent or off is exactly when a user most wants to run the pass by hand. */}
          <RunNowButton worker={worker} state={state} />
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
        {missed && <div className="text-xs text-amber-700">{missed}</div>}
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
      className={`lfb-btn ${primary ? "lfb-btn-primary" : "lfb-btn-secondary"}`}
    >
      {children}
    </button>
  );
}
