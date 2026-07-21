// The progress dock's state hub (webapp.mdx §10–§13). Holds the active-job set as the UNION of two
// streams and exposes one shared runner for browser-initiated long work:
//
//   A. Browser-initiated jobs (optimistic). Pages route their long actions through useProgress().run()
//      instead of a blocking mutate: on click a card is added, the request fires, and the card leaves
//      when it settles — so "Pin all" / "Compress selected" show every item at once and drain
//      unevenly (bounded by mapLimit, §13).
//   B. Server-initiated jobs (polled). GET /api/progress is polled — gently while idle, faster while
//      the dock is non-empty — and merged in, so a scan/pin started by launchd or ANOTHER TAB also
//      shows. A/B are de-duplicated by job id (a server id is stable; optimistic ids are prefixed).
//
// A card exists iff a job is actually running — never fake progress.
//
// THIS MODULE HOLDS ONLY THE PROVIDER COMPONENT. The context object, the ProgressCtx/JobSpec types,
// useProgress() and verb() live in ./progress-context.ts. That split is load-bearing, not cosmetic:
// a module whose exports are all components is self-accepting under React Fast Refresh, so editing
// the provider can never re-evaluate the context object and hand consumers a SECOND context identity
// (the "useProgress must be used within <ProgressProvider>" crash). See progress-context.ts.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ProgressJob, ProcessingBatch, QueuedItemView, FailedItemView, SessionView } from "@lfb/shared";
import { ProgressReactContext, verb, type ProgressCtx } from "./progress-context.js";
import { api } from "../api/client.js";
import { mapLimit } from "../lib/concurrency.js";
import { useLiveRefresh } from "../lib/useLiveRefresh.js";
import { clientLog } from "../lib/clientLog.js";
import { lastBatchFinishedAt, isRecentlyFinished } from "./linger.js";

const CONCURRENCY = 4; // charter/§13 bounded fan-out
let seq = 0;
const nextOptimisticId = () => `opt-${Date.now()}-${seq++}`;

export function ProgressProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // Optimistic (browser-started) jobs, keyed by id. A ref mirrors the map so run()'s async body can
  // mutate without stale closures; setState drives re-render.
  const [optimistic, setOptimistic] = useState<Record<string, ProgressJob>>({});
  const optimisticRef = useRef(optimistic);
  optimisticRef.current = optimistic;

  const setJob = useCallback((id: string, job: ProgressJob | null) => {
    setOptimistic((prev) => {
      const next = { ...prev };
      if (job) next[id] = job;
      else delete next[id];
      optimisticRef.current = next;
      return next;
    });
  }, []);

  const optimisticJobs = useMemo(() => Object.values(optimistic), [optimistic]);
  const dockBusy = optimisticJobs.length > 0;

  // Source B — the server job set. While work is visibly running, a fast foreground poll keeps the
  // determinate bars smooth; while IDLE there is NO interval at all — the `progress` topic on the
  // event stream announces a job this tab didn't start (performance.mdx Aspect 6b), replacing the old
  // constant 3s idle poll.
  const { data: server } = useQuery({
    queryKey: ["progress"],
    queryFn: api.progress,
    refetchInterval: (q) => (dockBusy || (q.state.data?.jobs.length ?? 0) > 0 ? 1200 : false),
    refetchOnWindowFocus: false,
  });
  useLiveRefresh(["progress", "jobs"], [["progress"]]);

  // Merge A ∪ B, de-duped by id (an optimistic card takes precedence over the same server job so it
  // never doubles). Server jobs this tab did not start are added underneath.
  const jobs = useMemo<ProgressJob[]>(() => {
    const byId = new Map<string, ProgressJob>();
    for (const j of server?.jobs ?? []) byId.set(j.id, j);
    for (const j of optimisticJobs) byId.set(j.id, j); // optimistic wins on id collision
    return [...byId.values()];
  }, [server, optimisticJobs]);

  const run = useCallback<ProgressCtx["run"]>(
    async (specs, opts) => {
      if (specs.length === 0) return;
      const failures: string[] = [];
      await mapLimit(specs, CONCURRENCY, async (spec) => {
        const id = nextOptimisticId();
        // Card is added only when the item ACTUALLY starts (mapLimit gates it) — true in-flight work.
        setJob(id, {
          id,
          kind: spec.kind,
          target: spec.target,
          startedAt: new Date().toISOString(),
          ...(spec.total !== undefined ? { total: spec.total, unit: spec.unit } : {}),
        });
        try {
          await spec.task((p) =>
            setJob(id, {
              ...(optimisticRef.current[id] ?? {
                id,
                kind: spec.kind,
                target: spec.target,
                startedAt: new Date().toISOString(),
              }),
              ...p,
            }),
          );
        } catch (e) {
          clientLog.error("Progress.run", e);
          failures.push(spec.target);
          toast.error(`${verb(spec.kind)} ${spec.target} failed`);
        } finally {
          setJob(id, null); // the card leaves the instant its job finishes (success OR error)
        }
      });

      // Success also refreshes the affected grids/counts (no full reload).
      for (const key of opts?.invalidate ?? []) qc.invalidateQueries({ queryKey: key });
      // One batch "…complete" toast when a user-initiated batch settles; failures already toasted.
      const ok = specs.length - failures.length;
      if (ok > 0) toast.success(opts?.batchLabel ?? `${ok} ${ok === 1 ? "job" : "jobs"} complete`);
    },
    [qc, setJob],
  );

  // The background job queue's pending backlog (job_queue.mdx §4), surfaced by the same poll.
  const queued = server?.queued ?? 0;
  const queuedByOp = server?.queuedByOp ?? {};
  const batches = useMemo<ProcessingBatch[]>(() => server?.batches ?? [], [server]);
  // Per-item rows for the Processing table (processing.mdx §4.3): the head of the pending queue and the
  // recently-failed items, both from the same poll. Absent-safe (default []).
  const queuedItems = useMemo<QueuedItemView[]>(() => server?.queuedItems ?? [], [server]);
  const recentFailures = useMemo<FailedItemView[]>(() => server?.recentFailures ?? [], [server]);
  const session = useMemo<SessionView | null>(() => server?.session ?? null, [server]);
  const workers = server?.workers ?? null; // core-budget utilization (processing.mdx §3a)
  // "Processing" (processing.mdx §1): a running job, a pending backlog, OR a still-active batch. Drives
  // the dock's presence, and the SPINNING state of the left-bar item.
  const processing = jobs.length > 0 || queued > 0 || batches.some((b) => !b.finishedAt);

  // The LINGER (processing.mdx §2.1) — when the most recent batch settled, or null if none has.
  const lastFinishedAt = useMemo(() => lastBatchFinishedAt(batches), [batches]);

  // Expiry needs its OWN clock, not the poll. React Query's structural sharing hands back the SAME data
  // reference when an idle poll returns identical JSON — so a linger that expired purely as a function of
  // the poll would never re-render, and the item would hang around until the next unrelated change.
  const [now, setNow] = useState(() => Date.now());
  const recentlyFinished = isRecentlyFinished({ processing, lastFinishedAt, now });
  useEffect(() => {
    if (!recentlyFinished) return; // running, never ran, or already expired — no clock needed
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [recentlyFinished]);

  const value = useMemo<ProgressCtx>(
    () => ({ jobs, queued, queuedByOp, batches, queuedItems, recentFailures, workers, session, processing, recentlyFinished, run }),
    [jobs, queued, queuedByOp, batches, queuedItems, recentFailures, workers, session, processing, recentlyFinished, run],
  );
  return <ProgressReactContext.Provider value={value}>{children}</ProgressReactContext.Provider>;
}
