// `node:test` → vitest compatibility shim.
//
// WHY THIS EXISTS. Before vitest landed, this package's `test` script was a stub (`echo "(no tests)"`),
// so the spec files that existed were authored against Node's built-in runner (`node:test`) and were
// never actually executed by anything. Vitest cannot run those files as-is: importing `node:test`
// registers with Node's runner, and vitest sees a file that declared no suite and fails it.
//
// Rewriting every such file to `import { test } from "vitest"` is the tidy end state, and new specs
// should be written that way. But this shim is what lets that migration happen file-by-file instead of
// in one flag-day commit — an unconverted `node:test` spec keeps running, correctly, under the one
// runner. It is a bridge, not a second framework: the mapped names below are exactly vitest's own.
//
// Wired in vitest.config.ts via `resolve.alias` on the literal specifier "node:test".
export { it as test, it, describe, beforeAll as before, afterAll as after, beforeEach, afterEach } from "vitest";
