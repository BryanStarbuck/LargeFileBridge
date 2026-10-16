import os from "node:os";
import { defineConfig } from "vitest/config";

// Same worker cap as packages/backend/vitest.config.ts (memory incident 2026-10-15): never cores-1 forks.
const TEST_WORKERS = Math.max(
  1,
  Number(process.env.LFB_TEST_WORKERS) ||
    Math.min(6, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 4), Math.floor(os.totalmem() / 2 ** 30 / 16)),
);

// Lean vitest setup, mirroring packages/backend (charter: low dependency surface — vitest only, no extra
// plugins). Node environment, not jsdom: what is tested here is pure derivation logic (e.g. D2's
// three-state rule in pages/processing/sessionState.ts), not rendered components — so no DOM is needed
// and none is pulled in.
export default defineConfig({
  resolve: {
    // This package is TypeScript ESM and its source uses NodeNext-style specifiers (`./sessionState.js`
    // pointing at `sessionState.ts`). Vite resolves a literal `.js` first, finds nothing, and would fail —
    // so rewrite the `.js` suffix on *relative* specifiers to extensionless and let the normal extension
    // list take over. Identical to the backend's config, for the same reason.
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
    maxWorkers: TEST_WORKERS,
  },
});
