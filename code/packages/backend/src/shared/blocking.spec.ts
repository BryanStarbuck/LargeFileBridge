// A FROZEN PROCESS IS NOT A BLOCKED SECTION (blocking.ts, performance.mdx T3).
//
// `error.err` carried `storage.mirror held the event loop for 967706ms` — sixteen minutes, for a pass whose
// real cost is under a second. macOS had suspended the app with that section on the stack, and
// `performance.now()` kept counting. loop-watch already knew to say `PROCESS SUSPENDED` instead
// (`suspensionGapMs`); `blocking` did not, so the one tool whose whole job is naming a culprit named a real
// section with a fictional number — and the same number poisoned the window tally's `worstMs`.
//
// The rule is a judgement about two numbers, so it is pinned here rather than by suspending a machine. The
// asymmetry is deliberate and is the property worth guarding: a genuine stall must NEVER be written off as
// a suspension, so anything below the floor is taken at face value even when its CPU time is near zero
// (which is what a disk-bound section looks like).
import { describe, it, expect } from "vitest";
import { looksSuspended } from "./blocking.js";

describe("looksSuspended", () => {
  it("calls a 16-minute span with no CPU a suspension", () => {
    expect(looksSuspended(967_706, 40)).toBe(true);
  });

  it("calls a 16-minute span that actually burned CPU a real stall", () => {
    expect(looksSuspended(967_706, 900_000)).toBe(false);
  });

  it("never writes off a stall below the floor, however little CPU it used", () => {
    // This is the disk-bound shape — `sameBytes` reads two files per tracked file, so wall ≫ cpu — and it
    // is REAL blocking. Mis-flagging it would hide exactly the faults this module exists to find.
    expect(looksSuspended(10_000, 5)).toBe(false);
    expect(looksSuspended(59_999, 0)).toBe(false);
  });

  it("treats the 79-second mirror stall that started this work as a stall, not a sleep", () => {
    // Measured on the reference machine: 79 s wall, and it was all CPU (YAML parses and byte compares).
    expect(looksSuspended(79_087, 74_000)).toBe(false);
  });
});
