// THE BACKGROUND LANE'S TWO PRIMITIVES — a counting semaphore and a per-key coalescer. Pure, no pg import,
// so both are testable without a database (the persistence specs never have one).
//
// WHY THEY EXIST (error.err, 2026-09-25 → 09-27): 190 `[db] <ctx>: timeout exceeded when trying to connect`
// lines, with up to +103 suppressed per minute, on a machine whose Postgres was up the whole time. The pool
// is 8 connections with a 3 s acquire timeout, and the mirror/reconcile passes fired `syncFenceBeforeMirror`
// and `recordSdlIngestForRepo` fire-and-forget, once per repo per pass, with no bound at all — 100+ jobs a
// minute, each issuing several statements. Every slot went to background bookkeeping, the waiters timed
// out, and the interactive reads queued behind them (`foreignPin.recordsUnder`, `manifest.project.unit`)
// fell back to YAML with them. `INTERACTIVE_RESERVE` was documented as "enforced by convention at the call
// site", and no call site did.

/** A FIFO counting semaphore. `acquire()` resolves to a release function; releasing twice is a no-op. */
export class Semaphore {
  private readonly queue: Array<() => void> = [];
  private held = 0;

  constructor(readonly limit: number) {
    if (!(limit >= 1)) throw new Error(`Semaphore limit must be >= 1 (got ${limit})`);
  }

  get active(): number {
    return this.held;
  }

  get waiting(): number {
    return this.queue.length;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.held += 1;
        let released = false;
        resolve(() => {
          if (released) return; // a double release would silently widen the lane
          released = true;
          this.held -= 1;
          this.queue.shift()?.();
        });
      };
      if (this.held < this.limit) grant();
      else this.queue.push(grant);
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * AT MOST ONE RUNNING AND ONE TRAILING RUN PER KEY.
 *
 * For idempotent "bring Postgres up to date with the bytes on disk NOW" jobs (the sync fence, the SDL
 * ingest record). A call that arrives while one is running cannot simply share the running promise — the
 * running job may have read the disk before the change that prompted this call — so it gets ONE trailing
 * run, started after the current one finishes. Every further call in that window shares the trailing run,
 * because it will read the disk after all of them. That turns "N passes × 105 repos" of queued work into
 * at most 2 × 105, without ever skipping the read that sees the latest bytes.
 */
export class Coalescer<T> {
  private readonly flights = new Map<string, { running: Promise<T>; trailing: Promise<T> | null }>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const f = this.flights.get(key);
    if (!f) {
      const running = this.start(key, fn);
      this.flights.set(key, { running, trailing: null });
      return running;
    }
    if (f.trailing) return f.trailing;
    // `.then(fn, fn)`: the trailing run happens whether the running one resolved or rejected.
    const trailing = f.running.then(
      () => this.promote(key, fn),
      () => this.promote(key, fn),
    );
    f.trailing = trailing;
    return trailing;
  }

  /** Keys with work in flight — for tests and /api/health. */
  get size(): number {
    return this.flights.size;
  }

  private start(key: string, fn: () => Promise<T>): Promise<T> {
    const p = (async () => fn())();
    const settle = (): void => {
      const f = this.flights.get(key);
      // Only the entry THIS run owns is cleared; a trailing run promoted in the meantime owns it now.
      if (f && f.running === p && !f.trailing) this.flights.delete(key);
    };
    p.then(settle, settle);
    return p;
  }

  private promote(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.start(key, fn);
    this.flights.set(key, { running, trailing: null });
    return running;
  }
}
