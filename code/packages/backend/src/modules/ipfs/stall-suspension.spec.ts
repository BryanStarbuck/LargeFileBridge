// A LID-CLOSE IS NOT A WEDGED DAEMON, AND ONE FAILED `pin ls` IS ONE WARN (error catalog #17).
//
// Overnight, error.err filled with `pin ls (recursive) failed after 3040059ms … stall cap 120000ms`, each
// followed by five more WARNs restating it. log.log showed the cause every time: `PROCESS SUSPENDED for about
// 612s` and, in the same millisecond, `pin ls (recursive) stalled after 672233ms`. The 120 s idle timer came
// due while macOS had the process frozen and fired the instant it thawed — "proving" 120 s of daemon silence
// during a span when we were not listening at all. These specs pin both halves of the fix:
//   • a stall watchdog that fires LATE re-arms for a fresh window instead of aborting, and still aborts on a
//     real, awake silence;
//   • a failed enumeration throws the already-reported `PinsetUnavailableError` after exactly ONE WARN.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.LFB_IPFS_RETRY_MS = "1";

vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({ ipfs: { api_addr: "/ip4/127.0.0.1/tcp/5001" } }),
}));
vi.mock("../events/state-events.service.js", () => ({ bumpTopicThrottled: () => {}, IPFS_TOPIC: "ipfs" }));

const { stallGuard, timerFiredLate, listPins, invalidatePinsetCache, isPinsetUnavailable } = await import(
  "./ipfs.service.js"
);
const { log } = await import("../../shared/logging.js");

describe("timerFiredLate — the judgement", () => {
  it("ordinary jitter is not lateness", () => {
    expect(timerFiredLate(0, 120_000, 120_050)).toBe(false);
    expect(timerFiredLate(0, 120_000, 129_000)).toBe(false); // under the 10 s slack for a 2-minute window
  });
  it("a timer that ran minutes after it came due means the process was not running", () => {
    expect(timerFiredLate(0, 120_000, 672_233)).toBe(true); // the 09:33Z line from log.log
  });
  it("tiny windows get a 1 s floor, so a busy test runner is never read as a thaw", () => {
    expect(timerFiredLate(0, 20, 300)).toBe(false);
  });
});

describe("stallGuard — judged only on time we were awake to hear the daemon", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does NOT abort when the timer fires late after a suspension — it re-arms a full window", () => {
    const g = stallGuard(120_000);
    g.touch();
    // The lid closes: wall time jumps ten minutes while no timer could run, then the overdue timer fires.
    vi.setSystemTime(Date.now() + 600_000);
    vi.advanceTimersByTime(120_000);
    expect(g.signal.aborted).toBe(false);
    expect(g.stalled).toBe(false);
    expect(g.suspendedMs).toBeGreaterThanOrEqual(590_000);
    g.clear();
  });

  it("still aborts a genuine awake silence of the full window after the thaw", () => {
    const g = stallGuard(120_000);
    g.touch();
    vi.setSystemTime(Date.now() + 600_000);
    vi.advanceTimersByTime(120_000); // late fire → re-armed
    vi.advanceTimersByTime(120_000); // on-time fire → the daemon really said nothing for 2 awake minutes
    expect(g.signal.aborted).toBe(true);
    expect(g.stalled).toBe(true);
  });

  it("aborts on time when there was no suspension at all (the watchdog keeps its teeth)", () => {
    const g = stallGuard(120_000);
    g.touch();
    vi.advanceTimersByTime(120_000);
    expect(g.stalled).toBe(true);
  });

  it("gives up re-arming after a bounded number of thaws", () => {
    const g = stallGuard(1_000);
    g.touch();
    for (let i = 0; i < 20 && !g.signal.aborted; i++) {
      vi.setSystemTime(Date.now() + 60_000);
      vi.advanceTimersByTime(1_000);
    }
    expect(g.signal.aborted).toBe(true);
  });
});

describe("listPins failure — one enumeration, one WARN", () => {
  beforeEach(() => invalidatePinsetCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws the already-reported PinsetUnavailableError after exactly one WARN, however many callers wait", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    const warn = vi.spyOn(log, "warn");
    const results = await Promise.allSettled([listPins(), listPins(), listPins()]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect(isPinsetUnavailable((r as PromiseRejectedResult).reason)).toBe(true);
    }
    const ipfsWarns = warn.mock.calls.filter(([ctx]) => ctx === "ipfs");
    expect(ipfsWarns).toHaveLength(1);
    expect(ipfsWarns[0]![1]).toMatch(/pin ls \(recursive\) failed/);
  });
});
