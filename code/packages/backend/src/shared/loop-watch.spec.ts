// A LAPTOP THAT SLEPT MUST NOT READ AS A BLOCKED EVENT LOOP.
//
// The lines this guards against are real, from error.err on 2026-09-09:
//   `EVENT LOOP BLOCKED: … stopped for up to 935229.1ms in the last 60s`
//   `EVENT LOOP BLOCKED: … stopped for up to 352187.3ms in the last 60s` (BLOCKED BY totalled 23ms)
// Both are self-contradictory — 935 seconds of blockage inside a 60-second window — and both were the lid
// closing. `monitorEventLoopDelay` is a libuv histogram that keeps accumulating while the PROCESS is
// frozen, so it cannot tell the two apart; only WALL TIME can, and that is what `suspensionGapMs` reads.
//
// This matters beyond tidiness: debugging.mdx Node 0 tells a reader to start every hang investigation at
// these lines, and a false one sends them after a section that did nothing wrong.
import { describe, expect, it } from "vitest";
import { suspensionGapMs } from "./loop-watch.js";

const WINDOW_MS = 60_000; // the default LFB_LOOP_WINDOW_MS this module is compiled with

describe("suspensionGapMs", () => {
  it("calls a window that took its expected time no suspension", () => {
    expect(suspensionGapMs(WINDOW_MS)).toBe(0);
  });

  it("tolerates ordinary timer jitter and heavy load without crying sleep", () => {
    expect(suspensionGapMs(WINDOW_MS + 500)).toBe(0);
    expect(suspensionGapMs(WINDOW_MS + 20_000)).toBe(0);
  });

  it("still calls a genuine multi-second STALL a stall, not a suspension", () => {
    // The whole point: a window that really did block for 30s is only 30s long in wall time, so it must
    // fall through to the EVENT LOOP BLOCKED branch and keep naming its culprit sections.
    expect(suspensionGapMs(WINDOW_MS + 30_000)).toBe(0);
  });

  it("names the gap when the process was frozen for minutes", () => {
    // The 935-second line: a 60s window that actually took ~16 minutes.
    const gap = suspensionGapMs(WINDOW_MS + 935_000);
    expect(gap).toBe(935_000);
  });

  it("catches a shorter sleep too, once the overrun is past the slack", () => {
    expect(suspensionGapMs(WINDOW_MS + 121_000)).toBe(121_000);
  });

  it("never reports a negative gap when a window closes early", () => {
    expect(suspensionGapMs(WINDOW_MS - 5_000)).toBe(0);
  });
});
