// A tiny, dependency-free bounded-concurrency runner (webapp.mdx §13). The SAME shape lives in
// frontend/src/lib/concurrency.ts — the single "task view" the browser fan-out and the server runner
// share. No worker threads / piscina: scan, IPFS, hashing and even ffmpeg supervision are I/O- or
// process-bound, so bounded async concurrency on the event loop is the right, lightweight tool.
//
// This file also owns the canonical CORE BUDGET (parallelization.mdx §1): the ONE definition of "how
// parallel" every bulk operation draws from, so a many-core machine actually gets used and there is no
// second, drifting core-count math. The `limit` callers pass to mapLimit/Limiter now comes from these
// helpers rather than a hardcoded small number.
import os from "node:os";
import { getAppConfig } from "../modules/store-model/config.service.js";

/** Logical cores on this machine — one source, floored at 1 (parallelization.mdx §1). */
export function logicalCores(): number {
  const n = os.availableParallelism?.() ?? os.cpus()?.length ?? 4;
  return Math.max(1, n | 0);
}

/**
 * The MASS-COMPUTE budget (parallelization.mdx §1): `round(cores × max_core_fraction)`, default fraction
 * 0.9 — "use up to ~90% of cores". For pure batch CPU work the user explicitly kicked off and is watching
 * drain (compression, fingerprinting, batch transcode). The fraction is read LIVE from the app config
 * (`performance.max_core_fraction`, parallelization.mdx §4), so a Settings change takes effect on the next
 * bulk operation with NO restart. `fraction` overrides the config for a specific call site if needed.
 */
export function coreBudget(fraction?: number): number {
  let f = fraction;
  if (f == null) {
    try {
      f = getAppConfig().performance.max_core_fraction;
    } catch {
      f = 0.9; // config not readable yet (very early boot) → the documented default
    }
  }
  const clamped = Math.min(1, Math.max(0.01, Number.isFinite(f) ? (f as number) : 0.9));
  return Math.max(1, Math.round(logicalCores() * clamped));
}

/**
 * The RESPONSIVE budget (parallelization.mdx §1): `cores − 2`, leaving 2 cores for the HTTP loop + the
 * IPFS node. For work that runs ALONGSIDE interactive use (the sync pass — sync_process.mdx §4, the
 * scan/index walks). NOT user-tunable — a fixed safety floor.
 */
export function responsiveBudget(): number {
  return Math.max(1, logicalCores() - 2);
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const n = items.length;
  const cap = Math.max(1, Math.min(limit | 0 || 1, n || 1));
  let next = 0;
  async function worker(): Promise<void> {
    while (next < n) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
