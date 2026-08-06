// OUR OWN WRITES ARE NOT NEWS (scan.mdx §2.2.1, performance.mdx P-38).
//
// A pin pass writes pulled-down media straight into the working tree, and every landing file looks to the
// watcher exactly like a user dropping a video in — so a six-file pull kicked six discovery rescans, each
// walking every repo and recalculating the TO DO batches, all while the remaining transfers were still
// competing for the same disk (the 2026-08-06 report: 619 MB in 22 minutes).
//
// Two things are pinned here, and the SECOND matters as much as the first: the claim must expire. A
// suppression that outlived its window would quietly stop the watcher noticing a real user edit of that
// same file — trading a noisy rescan for a missing one.
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { noteOwnWrite, isOwnRecentWrite, ownWriteCount, resetOwnWrites, SELF_WRITE_TTL_MS } from "./self-writes.js";

const FILE = path.join(path.sep, "repo", "videos", "clip.mp4");

beforeEach(() => resetOwnWrites());
afterEach(() => vi.useRealTimers());

describe("claiming a path we wrote", () => {
  it("claims exactly the path it was given, and nothing else", () => {
    noteOwnWrite(FILE);
    expect(isOwnRecentWrite(FILE)).toBe(true);
    // The user's OWN drop, in the same directory, during the same pass — still news.
    expect(isOwnRecentWrite(path.join(path.sep, "repo", "videos", "their-own.mp4"))).toBe(false);
  });

  it("matches a path spelled differently by whichever API reported it", () => {
    // The watcher's event and our write can come from different layers; `a/./b` and `a/b` are one file.
    noteOwnWrite(path.join(path.sep, "repo", "videos", "..", "videos", "clip.mp4"));
    expect(isOwnRecentWrite(FILE)).toBe(true);
  });

  it("an unclaimed path is never suppressed", () => {
    expect(isOwnRecentWrite(FILE)).toBe(false);
  });
});

describe("the claim expires on its own", () => {
  it("stops suppressing once the window passes — a later user edit is news again", () => {
    vi.useFakeTimers();
    noteOwnWrite(FILE);
    vi.advanceTimersByTime(SELF_WRITE_TTL_MS - 1000);
    expect(isOwnRecentWrite(FILE)).toBe(true); // still inside the window
    vi.advanceTimersByTime(2000);
    expect(isOwnRecentWrite(FILE)).toBe(false); // the file is the user's again
  });

  it("sheds expired claims without a timer, so an idle process does not accumulate them", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 50; i++) noteOwnWrite(path.join(path.sep, "repo", `f${i}.mp4`));
    expect(ownWriteCount()).toBe(50);
    vi.advanceTimersByTime(SELF_WRITE_TTL_MS + 1);
    expect(ownWriteCount()).toBe(0);
  });

  it("re-claiming refreshes the window rather than leaving the original expiry in place", () => {
    vi.useFakeTimers();
    noteOwnWrite(FILE);
    vi.advanceTimersByTime(SELF_WRITE_TTL_MS - 1000);
    noteOwnWrite(FILE); // a retry, or a second pass writing the same file
    vi.advanceTimersByTime(2000);
    expect(isOwnRecentWrite(FILE)).toBe(true);
  });
});

describe("the claim set is bounded", () => {
  it("drops the OLDEST claims rather than growing without bound", () => {
    // 20,000 is the ceiling; go past it and the earliest paths must be the ones released. Losing a claim
    // costs one extra rescan — unbounded growth in a long-lived daemon costs the machine.
    for (let i = 0; i < 20_050; i++) noteOwnWrite(path.join(path.sep, "repo", `f${i}.mp4`));
    expect(ownWriteCount()).toBe(20_000);
    expect(isOwnRecentWrite(path.join(path.sep, "repo", "f0.mp4"))).toBe(false); // evicted
    expect(isOwnRecentWrite(path.join(path.sep, "repo", "f20049.mp4"))).toBe(true); // newest kept
  });
});
