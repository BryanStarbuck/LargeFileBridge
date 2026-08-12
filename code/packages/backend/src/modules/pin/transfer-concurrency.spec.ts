// The transfer ceiling is a property of the LINK, not the CPU (pin_process.mdx §4). `ipfsLimiter` used
// `cores − 2`, so a many-core machine on a slow uplink starved its own pulls: each passed `pullMissing`'s
// 120s idle budget with no progress record and failed as "the transfer never started", for files that were
// live on IPFS the whole time.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { responsiveBudget } from "../../shared/concurrency.js";

const ENV_KEY = "LFB_IPFS_TRANSFER_CONCURRENCY";

/** Re-read the module with a fresh registry so the module-level constant is recomputed from the env. */
async function loadLimit(): Promise<number> {
  vi.resetModules();
  return (await import("./pin.service.js")).ipfsTransferConcurrency;
}

describe("IPFS transfer concurrency", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  });

  it("is a HARD 8, not the core count", async () => {
    expect(await loadLimit()).toBe(8);
  });

  it("does NOT scale with cores — a 20-core box must not open 18 transfers", async () => {
    const limit = await loadLimit();
    expect(limit).toBeLessThanOrEqual(8);
    if (responsiveBudget() > 8) expect(limit).toBeLessThan(responsiveBudget());
  });

  it("stays widenable for a link that can take it, without a rebuild", async () => {
    process.env[ENV_KEY] = "24";
    expect(await loadLimit()).toBe(24);
  });

  it("falls back to 8 for a junk or zero value rather than to unlimited", async () => {
    for (const junk of ["0", "", "not-a-number"]) {
      process.env[ENV_KEY] = junk;
      expect(await loadLimit()).toBe(8);
    }
  });
});
