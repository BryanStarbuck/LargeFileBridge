// WHICH PIECE OF A PROGRESS CARD IS ALLOWED TO BE SHORTENED.
//
// The card is narrower than the things it reports on, so something is always cut. The count must never be
// the thing that is cut — it is the whole reason the card exists — and whatever IS cut has to remain
// readable on hover. These pin the text side of that; the CSS side (`shrink-0 whitespace-nowrap` on the
// count, `truncate` + `title` on the name) lives in ProgressDock.tsx beside them.
import { describe, it, expect } from "vitest";
import type { ProgressJob } from "@lfb/shared";
import { metricText, cardTooltip } from "./cardText.js";

const job = (over: Partial<ProgressJob> = {}): ProgressJob =>
  ({ id: "j1", kind: "pin", target: "charlie-kirk", startedAt: new Date().toISOString(), ...over }) as ProgressJob;

describe("metricText — the count is never abbreviated", () => {
  it("keeps BOTH sides of the ratio and its unit", () => {
    expect(metricText(job({ done: 476, total: 687, unit: "files" }))).toBe("476 / 687 files");
  });

  it("groups thousands rather than dropping digits — 1234/5678 must not read as 1.2k", () => {
    const text = metricText(job({ done: 1234, total: 5678, unit: "files" }))!;
    expect(text).toContain("5,678");
    expect(text).not.toContain("k");
  });

  it("still answers with no unit set", () => {
    expect(metricText(job({ done: 1, total: 5 }))).toBe("1 / 5");
  });

  it("is null — not '0 / 0' — for an indeterminate job, so no bar and no count is claimed", () => {
    expect(metricText(job())).toBeNull();
    expect(metricText(job({ done: 3 }))).toBeNull();
  });

  it("renders a percentage as one number", () => {
    expect(metricText(job({ done: 41.6, total: 100, unit: "%" }))).toBe("42%");
  });
});

describe("cardTooltip — nothing on the card is unreadable, only abbreviated", () => {
  it("carries the full target, which is the part that truncates on screen", () => {
    const long = "files still waiting from another computer";
    expect(cardTooltip(job({ target: long, done: 1, total: 5, unit: "repos" }))).toBe(
      `Pinning ${long} — 1 / 5 repos`,
    );
  });

  it("puts the phase line on its OWN line — it is a different sentence, not a continuation", () => {
    const note = "pulling Scene77_Batch1_Proj_YourMothSho2.mp4 · ≈2.5 GB of 3.0 GB";
    const text = cardTooltip(job({ target: "all", done: 476, total: 687, unit: "files", note }));
    expect(text.split("\n")).toEqual(["Pinning all — 476 / 687 files", note]);
  });

  it("does not leave a dangling separator when there is no count to show", () => {
    expect(cardTooltip(job({ target: "all" }))).toBe("Pinning all");
  });
});
