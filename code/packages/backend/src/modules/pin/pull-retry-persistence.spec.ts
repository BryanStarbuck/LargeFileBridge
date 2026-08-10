// A RESTART MUST RESUME THE RETRY, NOT RESET IT.
//
// The pull-retry was a bare in-memory `setTimeout(3h)`, re-armed from scratch at boot. So every restart
// threw away however long the user had already waited and started the three hours over — and restarting is
// exactly what a person does when they are trying to make a stuck transfer happen. Restart more often than
// every three hours and the automatic retry NEVER RUNS.
//
// Measured on Bryan_Tower 2026-08-10: sixteen "pull-retry armed (180 min)" lines in one afternoon, one
// single run, and a pull-down count that sat at 10 looking abandoned the whole time. The user's report was
// exactly that — "I pulled them, then I restarted the web app, and it somehow lost them." The intent was
// never lost (the pull records its decision in the ledger before transferring, so the files stay decided);
// what was lost was the SCHEDULE.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let stateFile: string;

/** Re-import the module with a fresh in-process timer — this is what "the app restarted" means here. */
async function restart(): Promise<typeof import("./pull-retry.service.js")> {
  vi.resetModules();
  return import("./pull-retry.service.js");
}

const readState = (): { dueAt: string | null; lastRunAt: string | null } =>
  JSON.parse(fs.readFileSync(stateFile, "utf8")) as { dueAt: string | null; lastRunAt: string | null };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-pullretry-"));
  process.env.LFB_STATE_DIR = tmp;
  process.env.LFB_PULL_RETRY_MS = String(3 * 60 * 60 * 1000);
  process.env.LFB_PULL_RETRY_BOOT_MS = String(90_000);
  stateFile = path.join(tmp, "pull-retry-state.json");
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_PULL_RETRY_MS;
  delete process.env.LFB_PULL_RETRY_BOOT_MS;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("pull-retry — the schedule is a durable fact, not a setTimeout", () => {
  it("records WHEN the next attempt is due, so something outside this process can know", async () => {
    const { schedulePullRetry } = await restart();
    schedulePullRetry("a pull failed");

    const due = Date.parse(readState().dueAt!);
    expect(Number.isFinite(due)).toBe(true);
    // ~3 hours out, allowing for the milliseconds the call itself took.
    expect(due - Date.now()).toBeGreaterThan(3 * 60 * 60 * 1000 - 5_000);
    expect(due - Date.now()).toBeLessThanOrEqual(3 * 60 * 60 * 1000);
  });

  it("RESUMES the remaining wait across a restart instead of starting three hours over", async () => {
    const first = await restart();
    first.schedulePullRetry("a pull failed");
    const originalDue = readState().dueAt!;

    // The user restarts the app an hour later. The remaining wait is ~2h — it must not become 3h again.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    const second = await restart();
    second.schedulePullRetry("boot", { resume: true });

    const remaining = Date.parse(readState().dueAt!) - Date.now();
    expect(remaining).toBeLessThan(2 * 60 * 60 * 1000 + 5_000);
    expect(remaining).toBeGreaterThan(2 * 60 * 60 * 1000 - 5_000);
    expect(Date.parse(readState().dueAt!)).toBeLessThanOrEqual(Date.parse(originalDue) + 5_000);
  });

  it("runs SHORTLY after boot when the retry is already overdue — the restarted-again-and-again case", async () => {
    const first = await restart();
    first.schedulePullRetry("a pull failed");

    // Four hours pass with the app closed: the attempt came due while nothing was running.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
    const second = await restart();
    second.schedulePullRetry("boot", { resume: true });

    const wait = Date.parse(readState().dueAt!) - Date.now();
    expect(wait).toBeLessThanOrEqual(90_000);
    expect(wait).toBeGreaterThan(0); // not zero — the IPFS daemon is still coming up right after boot
  });

  it("never EXTENDS a wait on resume — a restart can only ever bring the retry closer", async () => {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ dueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), lastRunAt: null, lastReason: null }),
    );
    const { schedulePullRetry } = await restart();
    schedulePullRetry("boot", { resume: true });

    expect(Date.parse(readState().dueAt!) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000 + 5_000);
  });

  it("treats an absent or corrupt state file as 'nothing scheduled' and starts a fresh wait", async () => {
    fs.writeFileSync(stateFile, "{ this is not json");
    const { schedulePullRetry } = await restart();
    schedulePullRetry("boot", { resume: true });

    const wait = Date.parse(readState().dueAt!) - Date.now();
    expect(wait).toBeGreaterThan(3 * 60 * 60 * 1000 - 5_000);
  });

  it("is idempotent while armed — a burst of failed pulls does not stack timers or push the due time out", async () => {
    const { schedulePullRetry } = await restart();
    schedulePullRetry("failure 1");
    const due = readState().dueAt;
    for (let i = 2; i <= 5; i++) schedulePullRetry(`failure ${i}`);
    expect(readState().dueAt).toBe(due);
  });
});
