// THE FENCE, AS A BUILD FAILURE (database.mdx §2.2).
//
// The fence is a rule about CAUSALITY: a byte another of the user's computers will read must be produced by
// a designated serializer, and Postgres may appear in that write's chain only as the source of the values
// the serializer is handed. A rule like that cannot be enforced by review — every reviewer would have to
// hold the whole import graph in their head — so it is enforced here, the same way
// `sharp-runtime.import-guard.spec.ts` enforces the libvips settings after they were once lost to an
// accidental import.
//
// THE MECHANICAL FORM OF THE RULE: no production module may import BOTH
//
//   * `shared/persistence/pool.js` — the pool and `DB_SCHEMA`, i.e. the ability to write raw SQL; and
//   * a DESIGNATED SERIALIZER — `serializeLedger`, `serializeManifest`, `appendHistory`, or a
//     `YAML.stringify(…, { sortMapEntries: true })` of its own.
//
// `doc-render.service.ts` is the sole exception, and that is the whole design: a `*.repo.ts` holds SQL and
// no serializer, a service holds a serializer and no SQL, and the ONE place they meet is the module whose
// output the render equality gate checks byte for byte.
//
// WHY THE POOL AND NOT `db.js`. `shared/persistence/db.js` exports the GUARDED helpers — `dbEnabled`,
// `tryDb` — and importing them is how a service adds a dual-write without acquiring the ability to emit
// anything. `decisions.service.ts` legitimately imports both `serializeLedger` and `tryDb`: it owns
// `writeLedger` and appends events behind it (slice 6). What it cannot do is compose SQL, and `DB_SCHEMA`
// is the token that would let it. So the pool is the right line: it is exactly the capability that turns
// "I record values" into "I could emit a document".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The one module allowed to hold both halves — it is the fence. */
const OWNER = path.join(SRC, "modules", "storage", "doc-render.service.ts");

/** Importing this is the ability to compose SQL: the pool itself, and the schema name every statement uses. */
const POOL_IMPORT = /from\s+["'][^"']*shared\/persistence\/pool\.js["']/;

/** A designated serializer, reached by an actual import (not a mention in a comment). */
const SERIALIZER_IMPORT = /^import\s[^;]*\b(serializeLedger|serializeManifest|appendHistory)\b[^;]*;/ms;

/** The two anonymous serializers — `repo_storage.yaml` and `files/<rel>.yaml` — are this call shape. */
const ANONYMOUS_SERIALIZER = /sortMapEntries/;

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

describe("the sync fence has exactly one gate", () => {
  it("no production module holds both the pool and a designated serializer", () => {
    const offenders = walk(SRC)
      .filter((f) => f !== OWNER)
      .filter((f) => {
        const src = fs.readFileSync(f, "utf8");
        if (!POOL_IMPORT.test(src)) return false;
        return SERIALIZER_IMPORT.test(src) || ANONYMOUS_SERIALIZER.test(src);
      })
      .map((f) => path.relative(SRC, f));

    expect(
      offenders,
      `These modules import BOTH shared/persistence/pool.js (the ability to compose SQL) AND a designated ` +
        `serializer. That is the sync fence's one forbidden combination (database.mdx §2.2): it is the ` +
        `shape in which Postgres becomes a YAML emitter, and a byte that travels between the user's ` +
        `computers stops having a single producer.\n` +
        `Move the SQL into a *.repo.ts, or route the render through ` +
        `modules/storage/doc-render.service.ts, whose output the render equality gate checks byte for ` +
        `byte.\nOffenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the owner names every designated serializer, and adds none", () => {
    const src = fs.readFileSync(OWNER, "utf8");
    // Guards the fix itself. §2.2 is "one serializer per travelling document, and it does not change";
    // deleting one of these imports and hand-rolling the YAML would produce bytes no other writer produces,
    // and nothing else in the suite would notice.
    expect(src).toMatch(/import\s*\{[^}]*\bserializeLedger\b[^}]*\}\s*from\s*"\.\/ledger-merge\.js"/);
    expect(src).toMatch(/import\s*\{\s*serializeManifest\s*\}\s*from\s*"\.\/manifest-merge\.js"/);
    expect(src).toMatch(/YAML\.stringify\([^)]*\{\s*sortMapEntries:\s*true\s*\}/);

    // …and adds NONE. Every `YAML.stringify` in this file must be one of the three the spec sanctions:
    // `{ sortMapEntries: true }` for repo_storage and the sidecar, and the bare call for
    // decisions_policy (which is what `writeDecisionPolicy` does). A fourth spelling is a new serializer.
    // Comment lines are excluded deliberately: this file DOCUMENTS the two spellings of
    // `decisions_policy.yaml` that exist in the codebase today, and a guard that counted prose would make
    // writing down a known defect fail the build.
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    const stringifyCalls = [...code.matchAll(/YAML\.stringify\(/g)].length;
    expect(
      stringifyCalls,
      "doc-render.service.ts gained a YAML.stringify call. There are exactly three legal ones " +
        "(repo_storage, sidecar, decisions_policy); a fourth is a new serializer, which §2.2 forbids.",
    ).toBe(3);
  });

  it("the Postgres-fed write is OFF unless deliberately armed", () => {
    const src = fs.readFileSync(OWNER, "utf8");
    // §2.3: "ZERO DIFFS, OR THE CUTOVER DOES NOT HAPPEN." The latch must stay an explicit opt-in — a
    // default-true, a config read, or a settings toggle would each make arming something that can happen
    // without anyone having run the gate.
    expect(src).toMatch(/export function renderWritesArmed\(\): boolean \{\s*return process\.env\.LFB_DOC_RENDER_WRITE === "1";\s*\}/);
  });
});
