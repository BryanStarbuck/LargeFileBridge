// `DescribeBatchResult`'s four counts (ai_description.mdx §5, processing_batches.mdx §4.2).
//
// The shape's whole claim is that the counts SUM — every file lands in exactly one bucket. `rejected` got
// its own bucket because the three plausible homes are each wrong: `failed` paints a healthy tree red and
// feeds the retry ceiling; `described` claims a description that does not exist; `skipped` (where it
// briefly lived) keeps the sum right but says WE didn't ask, when the file was asked and answered.
import { describe, it, expect } from "vitest";
import type { DescribeResult } from "@lfb/shared";
import { summarizeDescribe } from "./describe.service.js";

const r = (status: DescribeResult["status"]): DescribeResult => ({
  path: `/m/${status}.png`,
  status,
  descriptionPath: null,
  model: null,
  reason: null,
});

describe("summarizeDescribe — every file lands in exactly one bucket", () => {
  it("counts a refusal as `rejected` — not described, not skipped, not failed", () => {
    const s = summarizeDescribe([r("rejected")]);
    expect(s).toMatchObject({ described: 0, rejected: 1, skipped: 0, failed: 0 });
  });

  it("keeps the counts summing across every status", () => {
    const all: DescribeResult["status"][] = [
      "described",
      "rejected",
      "skipped",
      "needs_setup",
      "no_provider",
      "unsupported",
      "failed",
    ];
    const results = all.map(r);
    const s = summarizeDescribe(results);
    expect(s.described + s.rejected + s.skipped + s.failed).toBe(results.length);
  });

  it("counts needs_setup with skipped — nothing produced, but not an error", () => {
    expect(summarizeDescribe([r("needs_setup")])).toMatchObject({ skipped: 1, failed: 0 });
  });

  it("counts no_provider and unsupported as failed", () => {
    expect(summarizeDescribe([r("no_provider"), r("unsupported")])).toMatchObject({ failed: 2 });
  });

  it("does not let a refusal inflate the success count", () => {
    // "1,440 described" on a batch where 41 files have no description is a false statement.
    const s = summarizeDescribe([r("described"), r("described"), r("rejected")]);
    expect(s.described).toBe(2);
    expect(s.rejected).toBe(1);
  });
});
