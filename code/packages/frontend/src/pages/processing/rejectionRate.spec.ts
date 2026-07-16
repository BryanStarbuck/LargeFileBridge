// The rejection rate + the Rejected column's applicability (processing_batches.mdx §4.4 / §4.5).
//
// `rejected` is the counter the product owner asked for, and every rule here exists because a plausible
// simplification of it is wrong in a way that costs the user money or sends them to debug a healthy batch.
import { describe, it, expect } from "vitest";
import type { ProcessingBatch } from "@lfb/shared";
import { rejectionRate, isProviderJudged } from "./ProcessingBatchesTable.js";

const batch = (over: Partial<ProcessingBatch> = {}): ProcessingBatch => ({
  batchId: "b1",
  kind: "describe",
  label: "Describe · ~/Movies · 100 files",
  scope: "~/Movies",
  total: 100,
  ok: 0,
  rejected: 0,
  failed: 0,
  halted: 0,
  running: 0,
  errors: [],
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ...over,
});

describe("rejectionRate — the denominator is ANSWERED, not total (§4.4)", () => {
  it("excludes failed and halted from BOTH sides — they never got a verdict", () => {
    // A file that timed out tells you NOTHING about whether the provider would have refused it. Letting it
    // vote either way corrupts the one number that describes the PROVIDER'S JUDGMENT, not our plumbing.
    const b = batch({ ok: 30, rejected: 10, failed: 40, halted: 20 });
    const { answered, rate } = rejectionRate(b);
    expect(answered).toBe(40); // 30 ok + 10 rejected — NOT 100
    expect(rate).toBeCloseTo(0.25); // 10/40, not 10/100
  });

  it("suppresses the percentage below 20 answered — a percentage over a handful is noise", () => {
    // The first file coming back refused would read "100% rejected" and send the user to debug a healthy run.
    const { answered, rate } = rejectionRate(batch({ ok: 0, rejected: 1 }));
    expect(answered).toBe(1);
    expect(rate).toBeNull();
  });

  it("still COUNTS a rejection below the threshold — the threshold is a DISPLAY rule, not a measurement rule", () => {
    const b = batch({ ok: 2, rejected: 2 });
    expect(b.rejected).toBe(2);
    expect(rejectionRate(b).rate).toBeNull(); // the count shows; only the percentage waits
  });

  it("shows the percentage from exactly 20 answered", () => {
    expect(rejectionRate(batch({ ok: 19, rejected: 1 })).rate).toBeCloseTo(0.05);
  });

  it("reports no rate for a batch nothing has answered yet (never divides by zero)", () => {
    expect(rejectionRate(batch({ running: 100 })).rate).toBeNull();
    expect(rejectionRate(batch({ running: 100 })).answered).toBe(0);
  });
});

describe("isProviderJudged — only a provider-judged op has a Rejected column (§4.5)", () => {
  it("is true for describe, and for a mixed batch that may contain describe", () => {
    expect(isProviderJudged(batch({ kind: "describe" }))).toBe(true);
    expect(isProviderJudged(batch({ kind: "mixed" }))).toBe(true);
  });

  it("is false for local ops — ffmpeg does not decline a video on taste", () => {
    // Rendering `0` down every compress batch would imply we checked and found none, training the user to
    // ignore the column exactly where it carries the number they asked for. `—` means "does not apply".
    expect(isProviderJudged(batch({ kind: "compress" }))).toBe(false);
    expect(isProviderJudged(batch({ kind: "transcribe" }))).toBe(false);
    expect(isProviderJudged(batch({ kind: "ocr" }))).toBe(false);
  });
});
