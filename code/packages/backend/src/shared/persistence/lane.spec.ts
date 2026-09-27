// The background lane's primitives (lane.ts). The semaphore is what keeps background statements off the
// interactive reserve; the coalescer is what turns "every repo, every pass, fire-and-forget" into a bounded
// amount of queued work without skipping the run that reads the latest bytes.
import { describe, it, expect } from "vitest";
import { Coalescer, Semaphore } from "./lane.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Semaphore", () => {
  it("never lets more than `limit` holders in at once, and admits waiters FIFO", async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    const runs = gates.map((g, i) =>
      sem.run(async () => {
        order.push(i);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await g.promise;
        inFlight -= 1;
      }),
    );
    await tick();
    expect(sem.active).toBe(2);
    expect(sem.waiting).toBe(4);
    for (const g of gates) {
      g.resolve();
      await tick();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sem.active).toBe(0);
  });

  it("releases the slot when the holder throws, and a double release cannot widen the lane", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(sem.active).toBe(0);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.active).toBe(0);
    const a = await sem.acquire();
    let second = false;
    void sem.acquire().then(() => (second = true));
    await tick();
    expect(second).toBe(false); // still width 1
    a();
    await tick();
    expect(second).toBe(true);
  });
});

describe("Coalescer — at most one running and one trailing run per key", () => {
  it("collapses a burst of calls into the running job plus ONE trailing job", async () => {
    const c = new Coalescer<number>();
    let runs = 0;
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const job = async (): Promise<number> => {
      runs += 1;
      const g = deferred<void>();
      gates.push(g);
      await g.promise;
      return runs;
    };
    const first = c.run("repo", job);
    // 50 more passes arrive while the first is still running — the 2026-09 fan-out shape.
    const burst = Array.from({ length: 50 }, () => c.run("repo", job));
    await tick();
    expect(runs).toBe(1);
    gates[0]!.resolve();
    expect(await first).toBe(1);
    await tick();
    expect(runs).toBe(2); // the trailing run started only after the first finished
    gates[1]!.resolve();
    const results = await Promise.all(burst);
    expect(new Set(results)).toEqual(new Set([2])); // every burst caller shares the trailing run
    expect(runs).toBe(2);
    await tick();
    expect(c.size).toBe(0);
  });

  it("still runs the trailing job when the running one rejected", async () => {
    const c = new Coalescer<string>();
    const g = deferred<string>();
    const failing = c.run("k", () => g.promise);
    const trailing = c.run("k", async () => "fresh");
    g.reject(new Error("pool timeout"));
    await expect(failing).rejects.toThrow("pool timeout");
    await expect(trailing).resolves.toBe("fresh");
  });

  it("keeps keys independent — one slow repo does not hold up another", async () => {
    const c = new Coalescer<string>();
    const slow = deferred<string>();
    void c.run("a", () => slow.promise);
    await expect(c.run("b", async () => "b-done")).resolves.toBe("b-done");
    slow.resolve("a-done");
  });
});
