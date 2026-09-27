// A REQUEST THAT SPANNED A LID-CLOSE IS NOT A HUNG REQUEST (error catalog #19/#20).
//
// `STILL OPEN after 670328ms: POST /api/v1/client/sessions/…/tokens` was logged at ERROR in the same
// millisecond as loop-watch's `PROCESS SUSPENDED for about 612s`, and the request completed 3 ms later.
// request-watch now keeps a ledger of frozen time (sweep ticks that land minutes late while the process
// burned ~no CPU) and judges requests on AWAKE age — while a busy loop, which burns CPU, is never mistaken
// for sleep.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import { observeFreeze, requestWatch, startRequestWatch, stopRequestWatch } from "./request-watch.js";
import { log } from "./logging.js";

afterEach(() => {
  stopRequestWatch();
  vi.restoreAllMocks();
});

function fakeExchange(method: string, url: string): { req: Request; res: Response & EventEmitter } {
  const res = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: true }) as unknown as Response &
    EventEmitter;
  const req = { method, originalUrl: url, url } as unknown as Request;
  return { req, res };
}

describe("observeFreeze — which late ticks were sleep", () => {
  it("a tick ten minutes late with almost no CPU used is frozen time", () => {
    observeFreeze(1_000_000, 50);
    expect(observeFreeze(1_000_000 + 670_000, 60)).toBeGreaterThan(600_000);
  });
  it("a tick ten minutes late that burned the CPU the whole time is a BLOCKED loop, not sleep", () => {
    observeFreeze(2_000_000, 0);
    expect(observeFreeze(2_000_000 + 670_000, 660_000)).toBe(0);
  });
  it("an on-time tick is nothing", () => {
    observeFreeze(3_000_000, 0);
    expect(observeFreeze(3_000_000 + 5_000, 1)).toBe(0);
  });
});

describe("requestWatch — suspension is reported as suspension", () => {
  it("a request that spanned a freeze is an INFO, not a SLOW WARN", () => {
    startRequestWatch();
    const warn = vi.spyOn(log, "warn");
    const info = vi.spyOn(log, "info");
    const { req, res } = fakeExchange("POST", "/api/v1/client/sessions/sess_x/tokens");
    requestWatch(req, res, () => {});
    // The laptop sleeps for ~11 minutes with the request open (the sweep's overdue tick records it)...
    const cpu = process.cpuUsage();
    observeFreeze(Date.now() + 670_000, (cpu.user + cpu.system) / 1000);
    // ...and the request completes on thaw.
    res.emit("finish");
    expect(warn.mock.calls.filter(([ctx]) => ctx === "request")).toEqual([]);
    expect(info.mock.calls.some(([ctx, m]) => ctx === "request" && /spanned a process suspension/.test(m))).toBe(true);
  });

  it("a request with no freeze that is slow is still a SLOW WARN", () => {
    let t = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    const warn = vi.spyOn(log, "warn");
    const { req, res } = fakeExchange("GET", "/api/ipfs/liveness");
    requestWatch(req, res, () => {});
    t += 5_000;
    res.emit("finish");
    expect(warn.mock.calls.some(([ctx, m]) => ctx === "request" && /SLOW: GET \/api\/ipfs\/liveness/.test(m))).toBe(true);
  });

  it("the sweep does not raise STILL OPEN for a request that was only open across a sleep", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      let t = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => t); // this Mac's hrtime counts the freeze too
      startRequestWatch();
      const error = vi.spyOn(log, "error");
      const { req, res } = fakeExchange("POST", "/api/v1/client/sessions/sess_x/tokens");
      requestWatch(req, res, () => {});
      t += 670_000;
      vi.setSystemTime(Date.now() + 670_000); // lid closed ~11 minutes; no tick could run
      vi.advanceTimersByTime(5_000); // the overdue sweep fires on thaw
      expect(error).not.toHaveBeenCalled();
      // ...but a request still unanswered 10 AWAKE seconds later is a real hang, and is reported.
      t += 15_000;
      vi.advanceTimersByTime(15_000);
      expect(error.mock.calls.some(([ctx, m]) => ctx === "request" && /STILL OPEN/.test(m))).toBe(true);
      res.emit("finish");
    } finally {
      vi.useRealTimers();
    }
  });
});
