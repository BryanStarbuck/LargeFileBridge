// The TWO clocks behind the Start-Scan pop-up (duplicates.mdx §5.2, LOCKED): the 4-day staleness
// RECOMMENDATION and the 2-day QUIET window that suppresses the prompt entirely.
//
// THE ANNOYANCE THESE TESTS PIN DOWN: a `complete: false` stamp never clears on its own, so before the
// quiet window a scan killed an hour ago re-opened the modal on EVERY visit — over fresh results that
// were already on screen behind it. `recommend` may stay true (a rescan would still help); only
// `promptOnEntry` may interrupt.
//
// Same per-test temp LFB_STATE_DIR isolation rule as dedupe-store.spec.ts — never the real state root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let savedStateDir: string | undefined;

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  savedStateDir = process.env.LFB_STATE_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-scan-status-"));
  process.env.LFB_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = savedStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Stamp a last run of the given age/completeness, then read the status the page would get. */
async function statusAfter(stamp: { lastRunAt: string; complete: boolean } | null) {
  const store = await import("./dedupe-store.js");
  const { dedupeStatus } = await import("./dedupe.service.js");
  if (stamp) {
    store.writeDedupeRunStamp({
      lastRunAt: stamp.lastRunAt,
      ok: true,
      complete: stamp.complete,
      phase: "fingerprint",
      counts: { candidates: 10, files: 2, groups: 1 },
      durationMs: 1000,
    });
  }
  return dedupeStatus();
}

describe("dedupeStatus — the pop-up's two clocks (duplicates.mdx §5.2)", () => {
  it("never scanned: recommends AND prompts", async () => {
    const s = await statusAfter(null);
    expect(s.lastRunAt).toBeNull();
    expect(s.recommend).toBe(true);
    expect(s.promptOnEntry).toBe(true);
  });

  it("scanned an hour ago but INCOMPLETE: still recommends, but does NOT prompt (the quiet window)", async () => {
    const s = await statusAfter({ lastRunAt: daysAgo(1 / 24), complete: false });
    expect(s.lastRunComplete).toBe(false);
    expect(s.recommend).toBe(true); // finishing the job is still worth offering — via the action row
    expect(s.promptOnEntry).toBe(false); // …but never by interrupting
  });

  it("complete run 1 day old: neither recommends nor prompts", async () => {
    const s = await statusAfter({ lastRunAt: daysAgo(1), complete: true });
    expect(s.recommend).toBe(false);
    expect(s.promptOnEntry).toBe(false);
  });

  it("complete run 3 days old: inside the 4-day staleness clock, so still silent", async () => {
    const s = await statusAfter({ lastRunAt: daysAgo(3), complete: true });
    expect(s.recommend).toBe(false);
    expect(s.promptOnEntry).toBe(false);
  });

  it("incomplete run 3 days old: past the quiet window, so it prompts", async () => {
    const s = await statusAfter({ lastRunAt: daysAgo(3), complete: false });
    expect(s.recommend).toBe(true);
    expect(s.promptOnEntry).toBe(true);
  });

  it("complete run 5 days old: stale, so it prompts", async () => {
    const s = await statusAfter({ lastRunAt: daysAgo(5), complete: true });
    expect(s.recommend).toBe(true);
    expect(s.promptOnEntry).toBe(true);
  });

  it("an unparseable timestamp reads as infinitely old (prompt), never as fresh", async () => {
    const s = await statusAfter({ lastRunAt: "not-a-date", complete: true });
    expect(s.promptOnEntry).toBe(true);
  });
});
