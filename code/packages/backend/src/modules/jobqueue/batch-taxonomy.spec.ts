// The batch outcome taxonomy (processing_batches.mdx §4) — the mapping every batch counter depends on.
//
// These are pure-function tests over the two mappers at the settle choke point. The defect they lock out:
// a `rejected` describe used to reach the settle point as `"done"`, so the Rejected column had nothing to
// count and the durable manifest recorded a refusal as "described" — the file on disk asserting a
// description exists when only a `.ai_description_rejected` does.
import { describe, it, expect } from "vitest";
import { __test } from "./jobqueue.service.js";

const { batchResultState, manifestOutcome } = __test;

describe("batchResultState — the five-way taxonomy (§4)", () => {
  it("counts a REFUSAL as rejected — never failed, never ok", () => {
    // Slate, not red: the provider considered the file and said no, after every retry was spent. Counting
    // it as failed paints a tree of copyrighted slides red when nothing is broken AND feeds the §2.7
    // ceiling — which is exactly what halted 483 files on 2026-07-16.
    expect(batchResultState("rejected")).toBe("rejected");
  });

  it("counts a HALT as halted — never failed", () => {
    // "Not attempted" costs nothing to re-run. Reporting 1,440 failures for work never tried would make
    // the user conclude their files are bad.
    expect(batchResultState("halted")).toBe("halted");
  });

  it("counts done and skipped as ok — the output is present and correct", () => {
    expect(batchResultState("done")).toBe("ok");
    expect(batchResultState("skipped")).toBe("ok");
  });

  it("counts failed and quarantined as failed", () => {
    expect(batchResultState("failed")).toBe("failed");
    expect(batchResultState("quarantined")).toBe("failed");
  });
});

describe("manifestOutcome — what the DURABLE record on disk says happened (§4.2)", () => {
  it("records a refusal as `rejected`, not as `described`", () => {
    expect(manifestOutcome("describe", "rejected")).toBe("rejected");
  });

  it("names the per-op success outcome", () => {
    expect(manifestOutcome("describe", "done")).toBe("described");
    expect(manifestOutcome("transcribe", "done")).toBe("transcribed");
    expect(manifestOutcome("compress", "done")).toBe("compressed");
    expect(manifestOutcome("ocr", "done")).toBe("ocred");
  });

  it("keeps halted distinct from failed on disk too", () => {
    expect(manifestOutcome("describe", "halted")).toBe("halted");
    expect(manifestOutcome("describe", "failed")).toBe("failed");
    expect(manifestOutcome("describe", "quarantined")).toBe("failed");
  });
});
