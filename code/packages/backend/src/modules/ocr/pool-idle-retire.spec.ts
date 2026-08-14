// REGRESSION (memory.mdx — resident memory on an idle process).
//
// The tesseract.js pool holds up to `tessPoolSize()` WASM workers, each budgeted at ~200MB, and that memory
// lives inside the workers — invisible to `heapUsed` and `external`, visible only as RSS. Before this test,
// `shutdownOcrWorkers()` had NO callers anywhere in the tree, so one OCR pass that fell back to tesseract
// pinned the whole reservation for the life of a daemon meant to run for weeks.
//
// These assertions are deliberately STRUCTURAL rather than behavioural: spinning up real WASM workers in a
// unit test would cost the very seconds-and-gigabytes this code exists to avoid. What must never regress is
// that the retirement path exists, is armed from the job path, and is guarded by an in-flight count.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "engines.ts"),
  "utf8",
);

describe("tesseract pool is retired when idle", () => {
  it("the recognize path runs inside withPoolJob", () => {
    // Without this, the sweep has no idea work is happening and could terminate a pool mid-job.
    expect(SRC).toMatch(/return withPoolJob\(async \(\) => \{/);
  });

  it("retirement is gated on zero in-flight jobs", () => {
    // Terminating a scheduler while a job is queued on it would reject real OCR work. A memory fix must
    // never cost a result, so the guard is the load-bearing line of the whole mechanism.
    expect(SRC).toMatch(/if \(activeJobs > 0[^)]*\) return;/);
  });

  it("the idle timer is unref'd so it can never hold the process open", () => {
    expect(SRC).toMatch(/idleTimer\.unref\?\.\(\)/);
  });

  it("shutdownOcrWorkers clears the pool map as well as terminating", () => {
    // Clearing is what makes the next call rebuild lazily; terminating alone would leave resolved promises
    // pointing at dead schedulers and every later OCR job would fail.
    expect(SRC).toMatch(/schedulerPool\.clear\(\)/);
  });

  it("the idle window is at least a minute", () => {
    // A short window would thrash: each rebuild is a multi-second cold start of N WASM workers.
    const m = /const POOL_IDLE_MS = Math\.max\((\d+)_?(\d*)/.exec(SRC);
    expect(m, "POOL_IDLE_MS floor not found").not.toBeNull();
    expect(Number(`${m![1]}${m![2]}`)).toBeGreaterThanOrEqual(60000);
  });
});
