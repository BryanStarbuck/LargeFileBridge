// GUARD (memory.mdx — the RSS incident). `sharp.cache()` / `sharp.concurrency()` are PROCESS-GLOBAL
// libvips settings. shared/sharp-runtime.ts applies them once and re-exports the configured instance.
//
// A module that imports "sharp" directly gets the SAME global libvips — so it does not get its own bad
// settings, it gets whatever settings happened to be applied by then. That is exactly the bug this guard
// exists to prevent: before sharp-runtime existed, the settings were a side effect of importing
// media/perceptual.service.ts, and any process that used sharp without pulling that module in ran libvips
// on full defaults (measured: +46% RSS, none of it visible in `heapUsed`).
//
// So: production code imports the configured instance, never the package. Specs are exempt — they are
// short-lived processes that sometimes need the raw package to build fixtures.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The one module allowed to import the sharp package — it is what configures it. */
const OWNER = path.join(SRC, "shared", "sharp-runtime.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.includes(".spec.")) {
      out.push(p);
    }
  }
  return out;
}

describe("sharp is configured in exactly one place", () => {
  it("no production module imports the sharp package directly", () => {
    const offenders = walk(SRC)
      .filter((f) => f !== OWNER)
      .filter((f) => /from\s+["']sharp["']|require\(\s*["']sharp["']\s*\)/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));

    expect(
      offenders,
      `These modules import "sharp" directly and so bypass shared/sharp-runtime.ts, which is what applies ` +
        `libvips' process-global cache(false)/concurrency(1). Import the configured instance instead:\n` +
        `  import sharp from "<relative>/shared/sharp-runtime.js";\n` +
        `Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the owner module actually applies both global settings", () => {
    const src = fs.readFileSync(OWNER, "utf8");
    // Guards the fix itself: deleting either line silently restores the leak, and nothing else would fail.
    expect(src).toMatch(/^\s*sharp\.cache\(false\);/m);
    expect(src).toMatch(/^\s*sharp\.concurrency\(1\);/m);
  });
});
