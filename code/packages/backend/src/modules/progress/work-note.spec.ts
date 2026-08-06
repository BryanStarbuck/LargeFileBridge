// The phase-line composer (webapp.mdx §12a). These lock the four properties the dock depends on:
// the line always names the CURRENT step, it follows the OLDEST in-flight item (not whichever worker
// ticked last), a settled item leaves it at once, and byte ticks are throttled so a fast transfer cannot
// repaint it thousands of times a second.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkNote } from "./work-note.js";

function collect() {
  const notes: string[] = [];
  return {
    notes,
    report: (p: { note?: string }) => {
      if (p.note !== undefined) notes.push(p.note);
    },
  };
}

describe("WorkNote", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the phase alone when nothing is in flight", () => {
    const { notes, report } = collect();
    const n = new WorkNote(report);
    n.phase("reading this computer's pin list");
    expect(notes.at(-1)).toBe("reading this computer's pin list");
  });

  it("names the item, its detail, and how many others are running", () => {
    const { notes, report } = collect();
    const n = new WorkNote(report);
    n.phase("");
    n.start("a/clip.mp4", "fetching clip.mp4");
    n.start("b/other.mov", "fetching other.mov");
    expect(notes.at(-1)).toBe("fetching clip.mp4 (+1 more)");
    // A detail tick is throttled, so advance past the floor before asserting it landed.
    vi.advanceTimersByTime(500);
    n.detail("a/clip.mp4", "≈310 MB of 734 MB (42%)");
    expect(notes.at(-1)).toBe("fetching clip.mp4 · ≈310 MB of 734 MB (42%) (+1 more)");
  });

  it("follows the OLDEST in-flight item — a later worker never steals the line", () => {
    const { notes, report } = collect();
    const n = new WorkNote(report);
    n.start("first", "adding first");
    n.start("second", "adding second");
    vi.advanceTimersByTime(500);
    n.detail("second", "12 MB"); // the newer worker ticks…
    expect(notes.at(-1)).toBe("adding first (+1 more)"); // …and the line still names the older one
  });

  it("drops a settled item from the line immediately", () => {
    const { notes, report } = collect();
    const n = new WorkNote(report);
    n.phase("");
    n.start("a", "adding a");
    n.start("b", "adding b");
    n.finish("a");
    expect(notes.at(-1)).toBe("adding b");
    n.finish("b");
    expect(notes.at(-1)).toBe(""); // nothing in flight and no phase ⇒ the line clears, never goes stale
  });

  it("ignores a detail tick for an item that already finished", () => {
    const { notes, report } = collect();
    const n = new WorkNote(report);
    n.start("a", "adding a");
    n.finish("a");
    const before = notes.length;
    vi.advanceTimersByTime(500);
    n.detail("a", "999 MB");
    expect(notes.length).toBe(before); // a late byte callback must not resurrect a finished file
  });

  it("throttles byte ticks but never throttles a phase or item change", () => {
    const { notes, report } = collect();
    const n = new WorkNote(report);
    n.start("a", "adding a");
    const afterStart = notes.length;
    for (let i = 1; i <= 50; i++) n.detail("a", `${i} MB`); // 50 chunk callbacks inside one tick window
    expect(notes.length).toBe(afterStart); // all coalesced away
    n.finish("a"); // structural — always repaints
    expect(notes.length).toBe(afterStart + 1);
  });

  it("does not repaint when the composed line is unchanged", () => {
    const { notes, report } = collect();
    const n = new WorkNote(report);
    n.phase("checking the IPFS node");
    const after = notes.length;
    n.phase("checking the IPFS node");
    expect(notes.length).toBe(after);
  });

  it("detailLazy does not even BUILD the line while the tick floor is closed", () => {
    const { report } = collect();
    const n = new WorkNote(report);
    n.start("a", "adding a");
    const make = vi.fn(() => "1 MB");
    for (let i = 0; i < 100; i++) n.detailLazy("a", make); // 100 chunk callbacks inside one window
    expect(make).not.toHaveBeenCalled(); // a 4 GB `cat` must not format 65,000 strings nobody sees
    vi.advanceTimersByTime(500);
    n.detailLazy("a", make);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("is inert without a reporter (a background caller with no card)", () => {
    const n = new WorkNote();
    expect(() => {
      n.phase("x");
      n.start("a");
      n.detail("a", "b");
      n.finish("a");
    }).not.toThrow();
  });
});
