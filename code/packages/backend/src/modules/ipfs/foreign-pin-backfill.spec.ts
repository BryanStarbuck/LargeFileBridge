// BACKFILL AREA 9 — the transform, exercised end to end with NO DATABASE.
//
// `LFB_DB_MODE=off` here is not a shortcut, it is the point twice over. It is R2 in miniature (the area
// streams its sources, applies its transform and reports its rows with no server anywhere — `copyRows`
// answers 0 and nothing throws), and it is what lets the interesting branches be tested at all: rejects,
// resume-from-cursor, and the negative cache, none of which need a row to have landed to be observable.
//
// The row counts against the REAL 36,103-entry corpus, the FK relationship to `lfb.cid`, and the
// twice-run-identical-counts property are verified against a live scratch database instead — that is a
// property of Postgres, not of this transform.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackfillContext, BackfillScope } from "../../shared/persistence/backfill.js";

let tmpDir: string;
let priorState: string | undefined;
let priorMode: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-fpbf-"));
  priorState = process.env.LFB_STATE_DIR;
  priorMode = process.env.LFB_DB_MODE;
  process.env.LFB_STATE_DIR = tmpDir;
  process.env.LFB_DB_MODE = "off";
});
afterEach(() => {
  if (priorState === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = priorState;
  if (priorMode === undefined) delete process.env.LFB_DB_MODE;
  else process.env.LFB_DB_MODE = priorMode;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const V0 = "QmTo4HtjkqvEMCvAUMDo6eP6FwroAp8r2btv1mqGSwyFFa";

interface Recorded {
  rejects: Array<{ path: string; reason: string }>;
  checkpoints: Array<{ cursor: string | null; rows: number }>;
}

function ctxFor(scope: BackfillScope, resumeFrom: string | null = null): { ctx: BackfillContext; rec: Recorded } {
  const rec: Recorded = { rejects: [], checkpoints: [] };
  const ctx = {
    scope,
    resumeFrom,
    rowsBefore: 0,
    // Unused by this area's transform; the harness supplies the real ones.
    q: (async () => []) as unknown as BackfillContext["q"],
    exec: (async () => 0) as unknown as BackfillContext["exec"],
    copyRows: (async () => 0) as unknown as BackfillContext["copyRows"],
    reject: (p: string, reason: string) => rec.rejects.push({ path: p, reason }),
    checkpoint: (cursor: string | null, rows: number) => rec.checkpoints.push({ cursor, rows }),
  } satisfies BackfillContext;
  return { ctx, rec };
}

function writeStores(pins: unknown[], cache: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tmpDir, "foreign-pins.json"), JSON.stringify(pins, null, 2));
  fs.writeFileSync(path.join(tmpDir, "foreign-pin-cache.json"), JSON.stringify(cache));
}

async function area() {
  return (await import("./foreign-pin-backfill.js")).ADOPT_FOREIGN_PINS;
}
async function scopeNamed(key: string): Promise<BackfillScope> {
  const scopes = await (await area()).scopes();
  const s = scopes.find((x) => x.key === key);
  if (!s) throw new Error(`no scope ${key}`);
  return s;
}

describe("area 9 scopes", () => {
  it("is exactly two scopes, one per source file", async () => {
    writeStores([], {});
    const scopes = await (await area()).scopes();
    expect(scopes.map((s) => s.key).sort()).toEqual(["fingerprint_probes", "foreign_pins"]);
    // Each scope fingerprints only ITS OWN file: a rewritten cache must not re-do the pin index, and the
    // pin index is rewritten on every scan while the cache is not.
    expect(scopes.flatMap((s) => s.sources).map((f) => path.basename(f)).sort()).toEqual([
      "foreign-pin-cache.json",
      "foreign-pins.json",
    ]);
  });

  it("reports zero rows on a machine that has never scanned — an absent store is not a failure", async () => {
    // No files written at all. `openSync` would throw ENOENT and mark the scope failed, which would keep the
    // ledger from ever stamping a clean pass on a machine that simply has nothing to migrate.
    const a = await area();
    for (const key of ["foreign_pins", "fingerprint_probes"]) {
      const scope = await scopeNamed(key);
      const { ctx, rec } = ctxFor(scope);
      await expect(a.run(scope, ctx)).resolves.toEqual({ rows: 0 });
      expect(rec.rejects).toEqual([]);
    }
  });
});

describe("area 9 — the probe cache, negatives and all", () => {
  it("migrates every entry and rejects only the keys it cannot split", async () => {
    writeStores([], {
      "/Users/b/a.mp4::100:1700000000000": { cid: null, at: "2026-08-01T00:00:00.000Z" },
      "/Users/b/rec 09:41:07.mp4::200:1700000000001": { cid: null, at: "2026-08-01T00:00:00.000Z" },
      "/Users/b/c.mp4::300:1700000000002": { cid: V0, profile: "v0-dag-pb", at: "2026-08-01T00:00:00.000Z" },
      "no-fingerprint-tail": { cid: null, at: "2026-08-01T00:00:00.000Z" },
    });
    const scope = await scopeNamed("fingerprint_probes");
    const { ctx, rec } = ctxFor(scope);
    const out = await (await area()).run(scope, ctx);

    // Three usable entries — INCLUDING the two negatives, which are 91.8% of the real file and the only
    // thing that stops the next scan re-hashing those files.
    expect(out.rows).toBe(3);
    expect(rec.rejects).toEqual([
      { path: "no-fingerprint-tail", reason: "cache key does not split into (absPath, size, mtimeMs)" },
    ]);
    // A path containing ':' survives with its colons intact (parseFpKey works in from the right).
    expect(rec.checkpoints.at(-1)?.cursor).toBeNull(); // the scope-complete checkpoint
  });

  it("resumes from the cursor, skipping what an interrupted run already inserted", async () => {
    writeStores([], {
      "/a.mp4::1:1": { cid: null, at: "x" },
      "/b.mp4::2:2": { cid: null, at: "x" },
      "/c.mp4::3:3": { cid: null, at: "x" },
      "/d.mp4::4:4": { cid: null, at: "x" },
    });
    const scope = await scopeNamed("fingerprint_probes");
    // "I stopped having inserted /b.mp4::2:2" ⇒ /c and /d remain, /a and /b must not be re-sent.
    const { ctx } = ctxFor(scope, "/b.mp4::2:2");
    await expect((await area()).run(scope, ctx)).resolves.toEqual({ rows: 2 });
  });
});

describe("area 9 — the pin index", () => {
  it("migrates records and rejects the ones with no path or no cid", async () => {
    writeStores(
      [
        { cid: V0, profile: "v0-dag-pb", absPath: "/repo/a.mp4", size: 10, repoRoot: "/repo", at: "2026-08-01T00:00:00.000Z" },
        { cid: "", profile: "p", absPath: "/repo/no-cid.mp4", size: 1, repoRoot: "/repo" },
        { cid: V0, profile: "p", absPath: "", size: 1, repoRoot: "/repo" },
      ],
      {},
    );
    const scope = await scopeNamed("foreign_pins");
    const { ctx, rec } = ctxFor(scope);
    await expect((await area()).run(scope, ctx)).resolves.toEqual({ rows: 1 });
    expect(rec.rejects.map((r) => r.reason).sort()).toEqual(["record has no absPath", "record has no cid"]);
  });

  it("leaves unit_id NULL rather than failing when no unit owns the path", async () => {
    // "A foreign pin can be discovered outside every unit" (0008's header). With no database there are no
    // units at all, which is the same code path — the run must still produce the row.
    writeStores([{ cid: V0, profile: "p", absPath: "/loose/x.mp4", size: 1, repoRoot: null }], {});
    const scope = await scopeNamed("foreign_pins");
    const { ctx, rec } = ctxFor(scope);
    await expect((await area()).run(scope, ctx)).resolves.toEqual({ rows: 1 });
    expect(rec.rejects).toEqual([]);
  });

  it("resumes from the last abs path inserted", async () => {
    writeStores(
      ["/1", "/2", "/3"].map((p) => ({ cid: V0, profile: "p", absPath: p, size: 1, repoRoot: null })),
      {},
    );
    const scope = await scopeNamed("foreign_pins");
    const { ctx } = ctxFor(scope, "/2");
    await expect((await area()).run(scope, ctx)).resolves.toEqual({ rows: 1 });
  });
});

describe("area 9 verification", () => {
  it("counts the source and reports a mismatch when Postgres is behind it", async () => {
    writeStores([{ cid: V0, profile: "p", absPath: "/repo/a.mp4", size: 1, repoRoot: "/repo" }], {
      "/a.mp4::1:1": { cid: null, at: "x" },
      "unparseable": { cid: null, at: "x" },
    });
    const v = await (await area()).verify!();
    // yamlRows counts what the area considers MIGRATABLE: one pin plus one parseable probe. The unparseable
    // key is a reject, not a missing row, so counting it would make a clean run look broken forever.
    expect(v.yamlRows).toBe(2);
    expect(v.pgRows).toBe(0); // no database
    expect(v.mismatches.join(" ")).toMatch(/foreign_pin has 0 row/);
    expect(v.mismatches.join(" ")).toMatch(/fingerprint_probe has 0 row/);
  });
});
