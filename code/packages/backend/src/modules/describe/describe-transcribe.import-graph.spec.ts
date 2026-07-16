// IMPORT-GRAPH GUARD — describe ⊥ transcribe (2_2_do.mdx row D1, to_fix.mdx §5 / §5.1).
//
// THE CLAIM BEING ENFORCED. to_fix.mdx §5 records a hand-done audit: "describe never invokes
// transcription". §5.1 then names the problem with that audit — "It holds by convention. A future edit
// could couple them silently, and the symptom (huge local memory during a 'cloud' job) is exactly what a
// hidden Whisper run looks like — indistinguishable from §3's bomb without a trace." This file is the
// enforcement that §5.1 asks for: the audit, re-run automatically, forever.
//
// WHY IT MATTERS CONCRETELY. A 'describe' job is supposed to be a cloud API call — a few tens of MB of
// image bytes, then a network round trip. A Whisper transcription is a local model load: gigabytes,
// resident, per worker. If a describe job ever reached transcription, a "cloud" batch would silently
// become a local memory bomb that looks exactly like the 2026-07-15 OOM. Static coupling is the cheap
// thing to rule out, so we rule it out mechanically.
//
// ── THE ONE BOUNDARY, AND WHY IT IS NOT A LOOPHOLE ─────────────────────────────────────────────────
// The job queue imports BOTH describe and transcribe on purpose — it is the dispatcher. So a naive
// transitive walk finds `describe.service.ts → jobqueue.service.ts → transcribe.service.ts` and fails on
// day one, reporting a chain that is not a coupling at all. That would be a false alarm, and a test that
// cries wolf gets deleted.
//
// The queue is where the two ops become MUTUALLY EXCLUSIVE rather than connected: it branches on `t.op`
// (`jobqueue.service.ts` — `if (t.op === "transcribe")` at the dispatch site, `t.op === "describe"` at the
// budget site), so one task takes exactly one arm and never both. to_fix.mdx §5 says this in as many
// words: "The queue imports both and branches on t.op — mutually exclusive."
//
// So traversal STOPS at the queue: reaching the dispatcher is legal, passing THROUGH it is not modelled.
// That single concession is bounded two ways, and the second is what keeps it honest:
//   1. Only the queue is a boundary — nothing else in the graph gets this treatment.
//   2. `describe/**` may not import the queue's transcribe arm DIRECTLY (asserted separately below), so
//      describe cannot smuggle a transcription call in by routing it through a queue-internal helper.
// If a second legitimate hub ever appears, add it here WITH its mutual-exclusion argument written out.
// Do not widen this list to make a red test green — a real coupling is exactly what it is built to catch.
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", ".."); // …/backend/src
const DESCRIBE_DIR = path.join(SRC, "modules", "describe");

// The forbidden destinations, as paths relative to `src`.
const FORBIDDEN = [path.join("modules", "transcribe"), path.join("tools", "transcribe")];

// The dispatcher hub — reaching it is fine, traversing through it is out of scope (see the header).
const TRAVERSAL_BOUNDARY = [path.join("modules", "jobqueue")];

const under = (file: string, dirs: string[]): boolean => {
  const rel = path.relative(SRC, file);
  return dirs.some((d) => rel === d || rel.startsWith(d + path.sep));
};

/**
 * Every module specifier in a source file: static `import`/`export … from`, bare side-effect `import "x"`,
 * and dynamic `import("x")` — the last being the one a hidden coupling would most likely hide behind.
 * Regex rather than a real parser is deliberate (to_fix.mdx §5.1 asks for something "cheap, permanent"):
 * it over-matches into comments/strings at worst, which can only ever produce a false ALARM we would
 * investigate — never a false pass that lets a real coupling through.
 */
function specifiersOf(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[^;\n]*?from\s*["']([^"']+)["']/g, // import x from "y" / export … from "y"
    /(?:^|\n)\s*import\s+["']([^"']+)["']/g, //                          import "y"  (side-effect)
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, //                         import("y") (dynamic)
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, //                        require("y") (CJS interop)
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

/** Resolve a RELATIVE specifier to a real file on disk, undoing the NodeNext ".js" → ".ts" convention. */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // bare/package specifiers leave our source tree
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base,
    base + ".ts",
    base + ".tsx",
    path.join(base, "index.ts"),
  ];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** Walk the graph breadth-first from `roots`, returning the first chain that lands in `FORBIDDEN`. */
function findForbiddenChain(roots: string[]): string[] | null {
  const seen = new Set<string>(roots);
  const queue: Array<{ file: string; chain: string[] }> = roots.map((f) => ({ file: f, chain: [f] }));

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    for (const spec of specifiersOf(fs.readFileSync(file, "utf8"))) {
      const target = resolveRelative(file, spec);
      if (target === null) continue;
      const nextChain = [...chain, target];
      if (under(target, FORBIDDEN)) return nextChain; // the violation — report the whole path to it
      if (under(target, TRAVERSAL_BOUNDARY)) continue; // legal to reach; not traversed (see header)
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push({ file: target, chain: nextChain });
    }
  }
  return null;
}

const describeSources = (): string[] =>
  fs
    .readdirSync(DESCRIBE_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
    .map((f) => path.join(DESCRIBE_DIR, f));

const rel = (f: string) => path.relative(SRC, f);

test("D1: modules/describe/** never reaches transcription, statically or dynamically (to_fix.mdx §5.1)", () => {
  const roots = describeSources();
  // Guard the guard: if describe/ were ever moved or renamed, an empty root set would make this test
  // pass vacuously forever — the classic way an import-graph assertion rots into decoration.
  assert.ok(roots.length > 0, `no source files found under ${rel(DESCRIBE_DIR)} — this guard is not looking at anything`);

  const chain = findForbiddenChain(roots);
  assert.equal(
    chain,
    null,
    chain === null
      ? ""
      : `describe reaches transcription — to_fix.mdx §5's "describe never invokes transcription" is BROKEN.\n` +
          `A 'cloud' describe job that can reach a local Whisper run is indistinguishable from a memory bomb.\n` +
          `Chain:\n    ${chain.map(rel).join("\n → ")}`,
  );
});

test("D1: no file under modules/describe/** imports a transcribe module directly", () => {
  // The direct-edge check the traversal boundary above leans on. Kept separate from the transitive walk so
  // that a direct `import { transcribeOne } from "../transcribe/…"` inside describe/ fails LOUDLY and
  // specifically, rather than arriving as one anonymous link in a long chain.
  for (const file of describeSources()) {
    for (const spec of specifiersOf(fs.readFileSync(file, "utf8"))) {
      const target = resolveRelative(file, spec);
      if (target !== null && under(target, FORBIDDEN)) {
        assert.fail(`${rel(file)} imports "${spec}" → ${rel(target)} — describe must never import transcription`);
      }
      // A bare specifier can't resolve on disk, so catch the textual form too (e.g. a path alias).
      assert.ok(
        !/(^|\/)(modules\/transcribe|tools\/transcribe)(\/|$)/.test(spec),
        `${rel(file)} references a transcribe module via "${spec}" — describe must never import transcription`,
      );
    }
  }
});
