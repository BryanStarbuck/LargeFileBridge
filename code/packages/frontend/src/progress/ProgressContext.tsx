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
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  ProgressJob,
  ProgressKind,
  ProcessingBatch,
  QueuedItemView,
  FailedItemView,
} from "@lfb/shared";
import { api } from "../api/client.js";
import { mapLimit } from "../lib/concurrency.js";
import { clientLog } from "../lib/clientLog.js";

// One unit of browser-initiated work handed to run(). `task` gets a `report` callback for determinate
// jobs; `invalidate` (query keys) refresh grids/counts when the batch succeeds.
export interface JobSpec {
  kind: ProgressKind;
  target: string;
  total?: number;
  unit?: string;
  task: (report: (p: { done?: number; total?: number; unit?: string }) => void) => Promise<unknown>;
}

interface ProgressCtx {
  jobs: ProgressJob[];
  queued: number; // background job-queue backlog (not-yet-started tasks) — the dock's "+ N queued" footer
  queuedByOp: Partial<Record<ProgressKind, number>>; // per-op backlog split (processing.mdx §5)
  batches: ProcessingBatch[]; // active + recently-finished bulk-run batches (processing.mdx §4)
  queuedItems: QueuedItemView[]; // PENDING items as rows for the per-item table (processing.mdx §4.3)
  recentFailures: FailedItemView[]; // FAILED items + reason for the per-item table (processing.mdx §4.3)
  workers: { busy: number; budget: number } | null; // core-budget utilization (processing.mdx §3a)
  processing: boolean; // any running job, pending backlog, OR active batch (processing.mdx §1)
  run: (specs: JobSpec[], opts?: { invalidate?: unknown[][]; batchLabel?: string }) => Promise<void>;
}

const Ctx = createContext<ProgressCtx | null>(null);

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

  // Source B — poll the server job set. Gentle while idle (the dock may be empty), faster while the
  // dock already shows work so a determinate bar updates smoothly.
  const { data: server } = useQuery({
    queryKey: ["progress"],
    queryFn: api.progress,
    refetchInterval: dockBusy ? 1200 : 3000,
    refetchOnWindowFocus: false,
  });

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
  const workers = server?.workers ?? null; // core-budget utilization (processing.mdx §3a)
  // "Processing" (processing.mdx §1): a running job, a pending backlog, OR a still-active batch. Drives
  // the conditional left-bar item + the dock's presence.
  const processing = jobs.length > 0 || queued > 0 || batches.some((b) => !b.finishedAt);

  const value = useMemo<ProgressCtx>(
    () => ({ jobs, queued, queuedByOp, batches, queuedItems, recentFailures, workers, processing, run }),
    [jobs, queued, queuedByOp, batches, queuedItems, recentFailures, workers, processing, run],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProgress(): ProgressCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProgress must be used within <ProgressProvider>");
  return ctx;
}

// The card verb per operation kind (webapp.mdx §11). Exported so the dock renders the same label.
const VERBS: Record<ProgressKind, string> = {
  scan: "Scanning",
  pin: "Pinning",
  publish: "Publishing",
  compress: "Compressing",
  transcribe: "Transcribing",
  describe: "Describing",
  hash: "Hashing",
  fingerprint: "Fingerprinting",
  ignore: "Ignoring",
  import: "Importing",
  install: "Installing",
  download: "Downloading",
  configure: "Configuring",
};
export function verb(kind: ProgressKind): string {
  return VERBS[kind] ?? "Working";
}
