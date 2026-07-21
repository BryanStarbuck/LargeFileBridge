import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Lean vitest setup (charter: low dependency surface — vitest only, no extra plugins).
//
// The one non-default thing here is `resolve.extensions`: this package is TypeScript ESM and its
// source uses NodeNext-style specifiers (`./perceptual.service.js` pointing at `perceptual.service.ts`).
// Vite resolves a literal `.js` first, finds nothing, and would fail — so we let it fall back to the
// `.ts` file. `resolve.alias` rewrites the `.js` suffix on *relative* specifiers to extensionless,
// which Vite then resolves through the normal extension list.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" },
      // Lets specs still authored against Node's built-in runner execute under vitest unmodified.
      // See vitest/node-test-shim.ts for why. New specs should import from "vitest" directly.
      { find: /^node:test$/, replacement: fileURLToPath(new URL("./vitest/node-test-shim.ts", import.meta.url)) },
    ],
  },
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
    // Specs import the REAL logger (shared/logging.ts), which resolves its files at import time to
    // ~/T/_large_files_bridge/. Without this, every test run appends its fixture WARN/ERROR lines to
    // the PRODUCTION error.err — proven live: sync-trigger.spec's mocked rejection ("git exploded")
    // showed up 37 times in the real error log and was investigated as a backbone failure. Specs that
    // assert on log files (logging.spec, session.spec, heap-watch.spec) set their own LFB_LOG_DIR
    // before import, which overrides this baseline.
    //
    // LFB_STATE_DIR gets the SAME baseline, for the same reason one level down. `resolveLogDir()` falls
    // back to `resolveStateDir()`, and every store path (config.yaml, users/, queue/, _batches/, repos/)
    // resolves through it — so an unredirected spec does not merely log into the user's state root, it
    // READS AND WRITES the user's real state there. Today only four specs remember to redirect it by
    // hand (session, logging, foreign-pin, batch-manifest); the fifth one written is a live-data bug.
    // Note foreign-pin.spec saves/restores the variable around each test: with this baseline in place
    // its restore lands back on a temp dir instead of deleting the var and re-exposing the real root.
    env: {
      LFB_LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "lfb-vitest-logs-")),
      LFB_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "lfb-vitest-state-")),
    },
    // Fingerprint tests decode real images with sharp; the import-graph walk reads the tree.
    // Both are CPU-bound and short — the default pool is fine, just give them room.
    testTimeout: 30_000,
  },
});
