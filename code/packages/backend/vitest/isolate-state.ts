// KEEP THE TEST SUITE OUT OF THE USER'S REAL STATE ROOT.
//
// vitest.config.ts sets LFB_LOG_DIR / LFB_STATE_DIR to temp dirs so a spec's fixture WARN/ERROR lines
// cannot land in the production error.err and no spec can read or write the user's real
// ~/T/_large_files_bridge. That baseline was being defeated: ~20 specs redirect the variables to their
// OWN temp dir and then, in afterEach/afterAll, `delete process.env.LFB_STATE_DIR`. Deleting does not
// restore the baseline — it removes it. Every spec that runs later in that worker and does not set the
// variables itself resolves straight back to the real home directory, which is how fixture CIDs
// ("bafywanted", "bafy9-1") and mocked failures ("git exploded") kept showing up in the live error.err
// and were investigated as production faults.
//
// RESTORE-IF-MISSING, never overwrite: a spec that deliberately sets its own dir keeps it (several
// assert on the files they write there). Only an absent variable — the deleted case — is refilled.
import { beforeEach, afterEach, beforeAll, afterAll } from "vitest";

// Read once, at worker start, before any spec has had the chance to delete them.
const BASELINE: Record<string, string | undefined> = {
  LFB_STATE_DIR: process.env.LFB_STATE_DIR,
  LFB_LOG_DIR: process.env.LFB_LOG_DIR,
  LFB_IPFS_API_ADDR: process.env.LFB_IPFS_API_ADDR,
};

function restoreMissing(): void {
  for (const [k, v] of Object.entries(BASELINE)) if (v && !process.env[k]) process.env[k] = v;
}

// All four hooks, and `afterAll` is the one that actually closes the hole. A test FILE is imported —
// and its module-level code runs, registering units, resolving the state root — BEFORE any of its own
// hooks fire. So the window that matters is between one file's teardown and the next file's import, and
// most of the offenders delete in `afterAll`. Vitest runs "after" hooks in reverse registration order,
// and a setup file registers before any spec does, so this `afterAll` runs LAST: after the spec deleted
// the variables, before the next file is imported. `beforeEach`/`afterEach` cover the same trick done
// per-test; `beforeAll` covers a worker whose first file deleted them during collection.
beforeAll(restoreMissing);
beforeEach(restoreMissing);
afterEach(restoreMissing);
afterAll(restoreMissing);
