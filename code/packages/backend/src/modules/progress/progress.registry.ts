// The in-process job registry (webapp.mdx §12 source B, §14). Every long-running server job — a manual
// pin, a compress, a hash pass — registers here so GET /api/progress can surface it and the web app's
// progress dock can show a live card, even for work THIS browser tab did not start (e.g. a launchd
// worker run). It is a plain in-memory map: the process is the single API server, and a job that
// outlives a restart is not "in flight" anymore, so persistence would be wrong.
import { randomUUID } from "node:crypto";
import type { ProgressJob, ProgressKind } from "@lfb/shared";
import { bumpTopic, bumpTopicThrottled, PROGRESS_TOPIC } from "../events/state-events.service.js";

// Internal record — the public GET shape is ProgressJob (id/kind/target/startedAt/done?/total?/unit?).
const jobs = new Map<string, ProgressJob>();

/** Register a job at its start and return the id used to report/end it. */
export function begin(kind: ProgressKind, target: string): string {
  const id = randomUUID();
  jobs.set(id, { id, kind, target, startedAt: new Date().toISOString() });
  bumpTopic(PROGRESS_TOPIC); // the dock learns a card exists without waiting for its poll
  return id;
}

/** Update a job's determinate progress (bytes added, ffmpeg %, files walked). No-op if it ended. */
export function report(id: string, p: { done?: number; total?: number; unit?: string }): void {
  const j = jobs.get(id);
  if (!j) return;
  if (p.done !== undefined) j.done = p.done;
  if (p.total !== undefined) j.total = p.total;
  if (p.unit !== undefined) j.unit = p.unit;
  bumpTopicThrottled(PROGRESS_TOPIC); // ticks arrive many times a second — coalesce them
}

/** Remove a job (it finished — success OR error). Idempotent. */
export function end(id: string): void {
  if (jobs.delete(id)) bumpTopic(PROGRESS_TOPIC); // the card must leave at once, not on the next poll
}

/** Snapshot of every in-flight registry job (excludes the scan-job, folded in by the router). */
export function list(): ProgressJob[] {
  return [...jobs.values()];
}

/**
 * Run an async unit as a tracked job: registers it, hands the body a `report` callback, and always
 * ends the job — on success or failure — so a card never gets orphaned. The single helper every
 * instrumented endpoint/service should route its long work through.
 */
export async function track<R>(
  kind: ProgressKind,
  target: string,
  body: (report: (p: { done?: number; total?: number; unit?: string }) => void) => Promise<R>,
): Promise<R> {
  const id = begin(kind, target);
  try {
    return await body((p) => report(id, p));
  } finally {
    end(id);
  }
}
