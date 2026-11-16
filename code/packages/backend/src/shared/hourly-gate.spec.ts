import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hourlyGateAllows, hourlyGateDeferredCount, ONE_HOUR_MS, setHourlyGateIntervalMs } from "./hourly-gate.js";

describe("hourly gate (why_slow.txt 2026-11-16: heavy repo passes at most once an hour)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-gate-"));
    process.env.LFB_STATE_DIR = dir;
    vi.useFakeTimers();
    setHourlyGateIntervalMs(ONE_HOUR_MS);
  });
  afterEach(() => {
    setHourlyGateIntervalMs(0);
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("admits the first run, refuses repeats inside the hour, admits again after it", () => {
    expect(hourlyGateAllows("storage.reconcile", "/r/all")).toBe(true);
    expect(hourlyGateAllows("storage.reconcile", "/r/all")).toBe(false);
    vi.advanceTimersByTime(59 * 60_000);
    expect(hourlyGateAllows("storage.reconcile", "/r/all")).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(hourlyGateAllows("storage.reconcile", "/r/all")).toBe(true);
  });

  it("keeps repos and kinds independent", () => {
    expect(hourlyGateAllows("storage.reconcile", "/r/all")).toBe(true);
    expect(hourlyGateAllows("storage.reconcile", "/r/small")).toBe(true);
    expect(hourlyGateAllows("storage.mirror", "/r/all")).toBe(true);
  });

  it("queues exactly ONE catch-up for refused calls and runs it when the window opens", () => {
    const catchUp = vi.fn();
    expect(hourlyGateAllows("storage.mirror", "/r/all", catchUp)).toBe(true);
    for (let i = 0; i < 50; i++) expect(hourlyGateAllows("storage.mirror", "/r/all", catchUp)).toBe(false);
    expect(hourlyGateDeferredCount()).toBe(1);
    vi.advanceTimersByTime(ONE_HOUR_MS);
    expect(catchUp).toHaveBeenCalledTimes(1);
    expect(hourlyGateDeferredCount()).toBe(0);
  });

  it("interval 0 turns the gate off", () => {
    setHourlyGateIntervalMs(0);
    expect(hourlyGateAllows("storage.reconcile", "/r/all")).toBe(true);
    expect(hourlyGateAllows("storage.reconcile", "/r/all")).toBe(true);
  });
});
