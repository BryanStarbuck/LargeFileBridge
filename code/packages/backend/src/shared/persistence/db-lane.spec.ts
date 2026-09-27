// THE BACKGROUND LANE AND THE FAILURE CLASSIFIER (db.ts), against a fake pool.
//
// The regression these pin down (error.err 2026-09-25 → 09-27): fire-and-forget per-repo bookkeeping took
// every one of the pool's 8 connections, the interactive reads behind it hit pg-pool's 3 s acquire timeout,
// every one of those timeouts flipped the health latch to DOWN on a server that was up, and the log said it
// 190 times under nine different context names. Each `it` below fails on the pre-lane db.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** A stand-in pg Pool: records peak concurrency and can be told to fail. */
const fake = {
  inFlight: 0,
  peak: 0,
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
  gates: [] as Array<() => void>,
  failNext: [] as Error[],
  async query(): Promise<{ rows: unknown[]; rowCount: number }> {
    const err = fake.failNext.shift();
    if (err) throw err;
    fake.inFlight += 1;
    fake.peak = Math.max(fake.peak, fake.inFlight);
    await new Promise<void>((r) => fake.gates.push(r));
    fake.inFlight -= 1;
    return { rows: [{ ok: 1 }], rowCount: 1 };
  },
};

vi.mock("./pool.js", () => ({
  POOL_MAX: 8,
  INTERACTIVE_RESERVE: 3,
  getPool: () => fake,
  probeDatabase: async () => ({ reachable: true }),
  resolveDbMode: () => "auto",
  setPoolErrorObserver: () => {},
}));

const db = await import("./db.js");
const { log } = await import("../logging.js");

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const openAll = (): void => {
  for (const g of fake.gates.splice(0)) g();
};
const connectTimeout = (): Error => new Error("timeout exceeded when trying to connect");

beforeEach(() => {
  Object.assign(fake, { inFlight: 0, peak: 0, totalCount: 0, idleCount: 0, waitingCount: 0, gates: [], failNext: [] });
  db.resetDbHealth();
  db.resetDbWarnThrottle();
  db.resetBackgroundLane(2);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the background lane enforces INTERACTIVE_RESERVE", () => {
  it("is POOL_MAX - INTERACTIVE_RESERVE wide by default", () => {
    expect(db.BACKGROUND_SLOTS).toBe(5);
  });

  it("caps concurrent background statements at the lane width, however many jobs fire at once", async () => {
    const jobs = Array.from({ length: 12 }, () => db.runInBackground(() => db.q("SELECT 1")));
    await tick();
    expect(fake.inFlight).toBe(2);
    expect(db.backgroundLaneStats()).toMatchObject({ active: 2, waiting: 10 });
    while (fake.gates.length) {
      openAll();
      await tick();
    }
    await Promise.all(jobs);
    expect(fake.peak).toBe(2);
  });

  it("never makes a REQUEST wait behind background work — interactive statements bypass the lane", async () => {
    const bg = Array.from({ length: 6 }, () => db.runInBackground(() => db.exec("UPDATE x")));
    await tick();
    expect(fake.inFlight).toBe(2); // lane full, 4 background statements queued
    const request = db.q("SELECT session");
    await tick();
    expect(fake.inFlight).toBe(3); // the request went straight to the pool
    while (fake.gates.length) {
      openAll();
      await tick();
    }
    await Promise.all([...bg, request]);
  });

  it("gates a background tx as ONE slot, and nested helpers inside it do not deadlock on a second", async () => {
    db.resetBackgroundLane(1);
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
    (fake as unknown as { connect: () => Promise<unknown> }).connect = async () => client;
    const out = db.runInBackground(() =>
      db.tx(async () => {
        const p = db.q("SELECT inside"); // pool path, same async context — must not wait on the held slot
        await tick();
        openAll();
        return p;
      }),
    );
    await expect(out).resolves.toEqual([{ ok: 1 }]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("retries a background statement's CONNECT timeout once — the statement never ran", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      fake.failNext.push(connectTimeout());
      const p = db.runInBackground(() => db.q("SELECT 1"));
      await vi.advanceTimersByTimeAsync(300);
      openAll();
      await expect(p).resolves.toEqual([{ ok: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT retry on a request path — the user gets the YAML answer now", async () => {
    fake.failNext.push(connectTimeout());
    await expect(db.q("SELECT 1")).rejects.toThrow(/timeout exceeded/);
  });
});

describe("pool starvation is contention, not an outage", () => {
  it("a connect timeout on a SATURATED pool leaves the health latch up", async () => {
    db.noteDbHealth(true);
    Object.assign(fake, { totalCount: 8, idleCount: 0, waitingCount: 4 });
    fake.failNext.push(connectTimeout());
    vi.spyOn(log, "warn").mockImplementation(() => {});
    await expect(db.q("SELECT 1")).rejects.toThrow();
    expect(db.dbHealth().state).toBe("up");
  });

  it("a connect timeout with free connections, or a refused socket, still marks it down", () => {
    expect(db.errorMeansServerDown(connectTimeout(), false)).toBe(true);
    expect(db.errorMeansServerDown(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), false)).toBe(true);
    expect(db.errorMeansServerDown(Object.assign(new Error("admin shutdown"), { code: "57P01" }), false)).toBe(true);
  });

  it("an error Postgres itself returned proves the server is answering", () => {
    expect(db.errorMeansServerDown(Object.assign(new Error("dup"), { code: "23505" }), false)).toBe(false);
    expect(
      db.errorMeansServerDown(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }), false),
    ).toBe(false);
  });

  it("logs ONE saturation line for every context in the window, naming the busiest on the next", async () => {
    Object.assign(fake, { totalCount: 8, idleCount: 0, waitingCount: 9 });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const boom = async (): Promise<number> => {
      throw connectTimeout();
    };
    for (let i = 0; i < 30; i++) await db.tryDb(boom, 0, "storage.sdlIngest");
    for (let i = 0; i < 5; i++) await db.tryDb(boom, 0, "foreignPin.recordsUnder");
    expect(warn).toHaveBeenCalledTimes(1);
    const [, line] = warn.mock.calls[0]!;
    expect(line).toMatch(/connection pool saturated \(8\/8 connections busy, 9 waiting/);
    expect(line).toMatch(/not an outage/);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    await db.tryDb(boom, 0, "storage.syncFence");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]![1]).toMatch(/\+34 more in the last minute: storage\.sdlIngest 29, foreignPin\.recordsUnder 5/);
  });

  it("announces a GENUINE outage even when that context warned seconds ago", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await db.tryDb(async () => Promise.reject(Object.assign(new Error("dup key"), { code: "23505" })), 0, "units.x");
    expect(warn).toHaveBeenCalledTimes(1);
    await db.tryDb(async () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), 0, "units.x");
    expect(warn).toHaveBeenCalledTimes(2); // not swallowed into units.x's suppressed count
    expect(warn.mock.calls[1]![1]).toMatch(/POSTGRES UNREACHABLE/);
    await db.tryDb(async () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), 0, "units.x");
    expect(warn).toHaveBeenCalledTimes(2); // and then throttled like anything else
  });
});

describe("isTransientDbError — what a backfill scope may retry", () => {
  it("covers acquire timeouts, statement_timeout and a dropped connection", () => {
    expect(db.isTransientDbError(connectTimeout())).toBe(true);
    expect(db.isTransientDbError(new Error("canceling statement due to statement timeout"))).toBe(true);
    expect(db.isTransientDbError(Object.assign(new Error("x"), { code: "57014" }))).toBe(true);
    expect(db.isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("does not retry a genuine bug", () => {
    expect(db.isTransientDbError(Object.assign(new Error("violates check"), { code: "23514" }))).toBe(false);
    expect(db.isTransientDbError(new Error("column does not exist"))).toBe(false);
  });
});
