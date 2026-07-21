// The reconnect POLICY of the shared live stream (liveStream.ts).
//
// What matters here is the property, not the numbers: a dropped connection must retry soon, must back off
// as failures pile up, must cap, and must never retry in lockstep with every other tab and every other one
// of the user's computers — a synchronized retry storm on a backend that is coming back up is how a
// recoverable blip turns into an outage.
import { describe, it, expect } from "vitest";
import { backoffDelay } from "./liveStream.js";

describe("liveStream backoff", () => {
  it("grows with each attempt and caps at 30s", () => {
    const noJitter = () => 1; // upper edge of the jitter band = the ceiling itself
    expect(backoffDelay(0, noJitter)).toBe(1_000);
    expect(backoffDelay(1, noJitter)).toBe(2_000);
    expect(backoffDelay(2, noJitter)).toBe(4_000);
    expect(backoffDelay(5, noJitter)).toBe(30_000); // 32s clamped
    expect(backoffDelay(50, noJitter)).toBe(30_000); // never grows past the cap
  });

  it("jitters within half-to-full of the ceiling, so tabs never retry in lockstep", () => {
    for (const attempt of [0, 1, 3, 9]) {
      const ceiling = backoffDelay(attempt, () => 1);
      const low = backoffDelay(attempt, () => 0);
      const mid = backoffDelay(attempt, () => 0.5);
      expect(low).toBeGreaterThanOrEqual(Math.min(250, ceiling));
      expect(low).toBeLessThan(ceiling);
      expect(mid).toBeGreaterThanOrEqual(low);
      expect(mid).toBeLessThanOrEqual(ceiling);
    }
  });

  it("never busy-loops — even the smallest delay leaves the backend room", () => {
    expect(backoffDelay(0, () => 0)).toBeGreaterThanOrEqual(250);
    expect(backoffDelay(-5, () => 0)).toBeGreaterThanOrEqual(250);
  });
});
