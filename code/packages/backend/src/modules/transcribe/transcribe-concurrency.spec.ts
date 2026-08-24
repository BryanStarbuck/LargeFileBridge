// The RAM clamp's ADMISSION RACE (to_fix.mdx §6.1).
//
// §6.1 moved this clamp from os.totalmem() to os.freemem(), which was right and not sufficient: free
// memory is a reading of RIGHT NOW, and a whisper job holds nothing until its multi-GB model has finished
// loading. So a batch admitted against one reading was still paging in when the next admission read the
// same free memory again and admitted another wave against RAM the first wave had already spoken for.
// error.err recorded the outcome directly — a MEMORY PRESSURE warning at `free=116567MB`, which is a clamp
// that computed 57 concurrent jobs and then drove a 192 GB box into swap.
import { describe, it, expect } from "vitest";
import { transcribeConcurrency } from "./transcribe-concurrency.js";

const GB = 1024 * 1024 * 1024;
/** `small` is 2 GB/job in the table, and RAM_HEADROOM_BYTES (2 GB) always comes off the top first. */
const base = { budget: 64, whisperThreads: 1, model: "small" };

describe("transcribeConcurrency — the RAM clamp", () => {
  it("sizes against the pool it is given, minus the headroom", () => {
    // (34 - 2) / 2 = 16 jobs, well under the CPU term of 64.
    expect(transcribeConcurrency({ ...base, totalRamBytes: 34 * GB })).toBe(16);
  });

  it("is a TOTAL cap, so an idle machine and one with N running agree while RAM lasts", () => {
    // The caller compares the answer against `running[bucket]`, so charging the in-flight jobs must not
    // silently turn this into a count of ADDITIONAL slots — 16 total either way, here.
    expect(transcribeConcurrency({ ...base, totalRamBytes: 34 * GB, inFlight: 4 })).toBe(16);
  });

  it("CHARGES already-admitted jobs against the pool, so the clamp converges instead of oscillating", () => {
    // The race, reproduced. 12 jobs are admitted but not yet resident, so the OS still reports the full
    // 34 GB free. Without the in-flight charge the clamp re-spends that RAM and answers 16 again — room
    // for 4 MORE jobs it has no memory for. With it, the pool is 34 - 2 - (12 x 2) = 8 GB → 4 additional,
    // + the 12 running = 16, which the caller reads as "you are already at the cap".
    const cap = transcribeConcurrency({ ...base, totalRamBytes: 34 * GB, inFlight: 12 });
    expect(cap).toBe(16);
    // …and once the pool genuinely shrinks as those jobs page in, the cap follows it DOWN to the running
    // count: nothing further is admitted until one finishes.
    expect(transcribeConcurrency({ ...base, totalRamBytes: 10 * GB, inFlight: 12 })).toBe(12);
  });

  it("never returns 0 — a loaded box narrows to serial, it does not stop transcribing", () => {
    // transcribe_engine.mdx §5.1: every machine can do one. A pool below one model's footprint (and even a
    // pool fully consumed by in-flight jobs) must still answer 1.
    expect(transcribeConcurrency({ ...base, totalRamBytes: 1 * GB })).toBe(1);
    expect(transcribeConcurrency({ ...base, totalRamBytes: 0 })).toBe(1);
  });

  it("still honours the CPU term when RAM is plentiful", () => {
    // 4 cores of budget / 4 threads per job = 1, regardless of a 512 GB pool.
    expect(
      transcribeConcurrency({ budget: 4, whisperThreads: 4, model: "small", totalRamBytes: 512 * GB }),
    ).toBe(1);
  });

  it("honours the GPU stream term", () => {
    expect(
      transcribeConcurrency({ ...base, totalRamBytes: 512 * GB, gpuStreams: 2 }),
    ).toBe(2);
  });

  it("prices the heavyweight engine higher than whisper-base", () => {
    const ram = { totalRamBytes: 34 * GB };
    const qwen = transcribeConcurrency({ ...base, ...ram, model: "qwen" }); // 6 GB/job
    const small = transcribeConcurrency({ ...base, ...ram, model: "small" }); // 2 GB/job
    expect(qwen).toBeLessThan(small);
  });
});
