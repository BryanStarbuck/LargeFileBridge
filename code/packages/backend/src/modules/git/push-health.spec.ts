// BUG #16 — "attempt 3/3; giving up this cycle" must not mean the work is lost.
//
// The retry loop exhausted its attempts against a peer computer pushing to the same remote, and then
// nothing re-armed the push and nothing told the user. These tests pin the three properties that fix:
// the backoff is JITTERED (so two machines cannot stay phase-locked), a failure is a DURABLE record with a
// growing consecutive count, and a success ERASES it so the surfaced warning self-clears.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import {
  recordPushFailure,
  recordPushSuccess,
  backbonePushStates,
  unpushedRetryDelayMs,
  pushHealthFile,
} from "./push-health.service.js";
import { pushRetryDelayMs } from "./git.service.js";

const DIR = "/tmp/does-not-need-to-exist/act3_large_files_bridge";

beforeEach(() => {
  try {
    fs.rmSync(pushHealthFile(), { force: true });
  } catch {
    /* nothing recorded yet */
  }
});

describe("push retry backoff — jitter is what breaks the lockstep", () => {
  it("grows exponentially and never returns the same value twice for the same attempt", () => {
    // Deterministic bounds: attempt 1 ≈ 2s ±40%, attempt 2 ≈ 8s ±40%.
    expect(pushRetryDelayMs(1, () => 0)).toBe(1200);
    expect(pushRetryDelayMs(1, () => 1)).toBe(2800);
    expect(pushRetryDelayMs(2, () => 0)).toBe(4800);
    expect(pushRetryDelayMs(2, () => 1)).toBe(11200);
    // Live randomness: a hundred draws must not all be one fixed ladder value.
    const draws = new Set(Array.from({ length: 100 }, () => pushRetryDelayMs(1)));
    expect(draws.size).toBeGreaterThan(10);
  });

  it("re-arms a given-up cycle in minutes, backing off but never slower than the scheduled workers", () => {
    expect(unpushedRetryDelayMs(1, () => 0.5)).toBe(60_000);
    expect(unpushedRetryDelayMs(3, () => 0.5)).toBe(240_000);
    expect(unpushedRetryDelayMs(99, () => 0.5)).toBe(15 * 60_000); // capped
    expect(unpushedRetryDelayMs(1, () => 0)).toBeLessThan(unpushedRetryDelayMs(1, () => 1));
  });
});

describe("unpushed-state record — the user must be able to SEE that this computer stopped sharing", () => {
  it("counts consecutive failures and surfaces the storage until a push lands", () => {
    expect(backbonePushStates()).toEqual([]);

    expect(recordPushFailure("act3", DIR, "Git remote error — …", 4)).toBe(1);
    expect(recordPushFailure("act3", DIR, "Git remote error — …", 5)).toBe(2);

    const [row] = backbonePushStates();
    expect(row).toBeDefined();
    expect(row!.storageId).toBe("act3");
    expect(row!.repoName).toBe("act3_large_files_bridge");
    expect(row!.consecutiveFailures).toBe(2);
    expect(row!.unpushedCommits).toBe(5);
    expect(row!.lastPushAt).toBeNull();

    recordPushSuccess("act3", DIR);
    // Self-clearing: a single good push means this computer is sharing again, so the warning goes away.
    expect(backbonePushStates()).toEqual([]);
  });

  it("keeps the last-good-push time across a later failure, so the UI can say how long it has been", () => {
    recordPushSuccess("personal", DIR);
    recordPushFailure("personal", DIR, "Git remote error — …", 1);
    const [row] = backbonePushStates();
    expect(row!.lastPushAt).not.toBeNull();
    expect(row!.consecutiveFailures).toBe(1);
  });

  it("reports the worst backbone first — the page leads with the machine's biggest silence", () => {
    recordPushFailure("a", "/tmp/x/repo_a", "e", 1);
    recordPushFailure("b", "/tmp/x/repo_b", "e", 1);
    recordPushFailure("b", "/tmp/x/repo_b", "e", 1);
    expect(backbonePushStates().map((r) => r.storageId)).toEqual(["b", "a"]);
  });
});
