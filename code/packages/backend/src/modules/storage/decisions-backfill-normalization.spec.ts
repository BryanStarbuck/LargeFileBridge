// Pins the 2026-08-04 commit-storm defect: the reconcile() cache-only backfill compared RAW frozen-enum
// keys against foldLedger's POSIX-normalized keys. A Windows-era enum key (`jfk\training\...`) therefore
// never matched its own folded event (`jfk/training/...`), so every reconcile re-appended the same
// "migrated" events with a fresh mtime — the union merge (keyed on byte-exact identity incl. decided_at)
// kept every duplicate, and the backbone committed "LFB: 1 decisions" 1,500+ times a day while
// decisions.yaml grew past 122k lines. The fix normalizes the enum key before the folded.has() check
// (and heals backslash enum keys in place); these tests pin the predicate both ways.
import { describe, it, expect } from "vitest";
import type { DecisionEvent } from "@lfb/shared";
import { foldLedger } from "./decisions.service.js";

function ev(path: string, decidedAt: string, over: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    sid: "r:c2a759acab00",
    path,
    fingerprint: null,
    asked: true,
    ipfs: true,
    gitignore: false,
    decided_by: "migrated",
    decided_at: decidedAt,
    ...over,
  };
}

describe("cache-only backfill path normalization", () => {
  it("a Windows-recorded event and its POSIX twin fold to ONE decision under the POSIX key", () => {
    const folded = foldLedger([
      ev("jfk\\training\\videos\\a.mp4", "2026-08-04T21:05:00.000Z"),
      ev("jfk/training/videos/a.mp4", "2026-08-04T21:06:00.000Z"),
    ]);
    expect(folded.size).toBe(1);
    expect(folded.has("jfk/training/videos/a.mp4")).toBe(true);
  });

  it("a backslash enum key is NOT cache-only when its normalized form is already folded", () => {
    const folded = foldLedger([ev("jfk/training/videos/a.mp4", "2026-08-04T21:05:00.000Z")]);
    const enumMap: Record<string, string> = { "jfk\\training\\videos\\a.mp4": "sync" };
    // The exact predicate reconcile() now uses: normalize the enum key before folded.has().
    const cacheOnly = Object.keys(enumMap).filter((p) => !folded.has(p.replace(/\\/g, "/")));
    expect(cacheOnly).toEqual([]); // before the fix this was ["jfk\\training\\videos\\a.mp4"] forever
  });
});
