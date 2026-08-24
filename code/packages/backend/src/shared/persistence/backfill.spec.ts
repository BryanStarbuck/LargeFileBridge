// THE THREE MECHANICS (database_migration.mdx §4.1), tested where they actually live.
//
// The point of the harness is that no area invents its own resume scheme, so the resume scheme has to be
// right ONCE. These tests are that "once": a run that is interrupted picks up where it stopped, a source
// that moved under the run re-does ONE scope and not the other 104, a record that cannot be parsed is
// recorded rather than fatal, and running twice produces the same rows.
//
// Postgres is MOCKED here, deliberately and not for convenience. The mechanics under test are the ledger's
// — watermarks, cursors, scope outcomes — and they live in `migration_state.yaml`, which is a real file
// written to a real temp directory in every test below. The SQL is exercised for real against a scratch
// database by `src/shared/persistence/backfill-cli.ts`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const sqlCalls: Array<{ kind: string; sql: string }> = [];

vi.mock("./db.js", () => ({
  dbEnabled: () => true,
  refreshDbHealth: async () => true,
  q: async (sql: string) => {
    sqlCalls.push({ kind: "q", sql });
    return [];
  },
  exec: async (sql: string) => {
    sqlCalls.push({ kind: "exec", sql });
    return 0;
  },
  copyRows: async (table: string) => {
    sqlCalls.push({ kind: "copyRows", sql: table });
    return 0;
  },
  // The real `tryDb` swallows and falls back; the mock must too, or a spec would pass for the wrong reason.
  tryDb: async <T>(fn: () => Promise<T>, fallback: T | (() => T)): Promise<T> => {
    try {
      return await fn();
    } catch {
      return typeof fallback === "function" ? (fallback as () => T)() : fallback;
    }
  },
}));

vi.mock("./pool.js", () => ({
  DB_SCHEMA: "lfb",
  getPool: () => null,
  backgroundShouldDefer: () => false,
}));

vi.mock("./migrate.js", () => ({ readPgEpoch: async () => "epoch:1" }));

const { runBackfill, clearBackfillRegistry, listBackfills, registerBackfill, runAllBackfills } = await import(
  "./backfill.js"
);
type Area = Parameters<typeof runBackfill>[0];
type Ctx = Parameters<Area["run"]>[1];

let stateDir = "";
let srcA = "";
let srcB = "";

function ledger(): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(stateDir, "migration_state.yaml"), "utf8");
  return (YAML.parse(raw) as { migrations: Record<string, unknown> }).migrations;
}

/** Change a source file's identity triple the way a re-scan would. */
function touch(file: string, body: string): void {
  fs.writeFileSync(file, body);
  const t = new Date(Date.now() + 60_000);
  fs.utimesSync(file, t, t);
}

beforeEach(() => {
  sqlCalls.length = 0;
  clearBackfillRegistry();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-backfill-spec-"));
  vi.stubEnv("LFB_STATE_DIR", stateDir);
  srcA = path.join(stateDir, "a.yaml");
  srcB = path.join(stateDir, "b.yaml");
  fs.writeFileSync(srcA, "a: 1\n");
  fs.writeFileSync(srcB, "b: 1\n");
});

afterEach(() => {
  // The guard specs below spy on the mocked `dbEnabled` / `backgroundShouldDefer`. Without this the first one
  // that stubs `dbEnabled -> false` silently turns every later spec in the file into "no-database", and they
  // pass for the wrong reason (or, worse, keep passing after the code stops working).
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** A two-scope area whose `run()` is a spy, so a spec can assert exactly which scopes were re-done. */
function twoScopeArea(run: Area["run"], version = 1): Area {
  return {
    name: "spec_area",
    version,
    kind: "backfill",
    sources: () => [srcA, srcB],
    scopes: () => [
      { key: "a", sources: [srcA], data: srcA },
      { key: "b", sources: [srcB], data: srcB },
    ],
    run,
  };
}

describe("the ledger: a clean run records, and a second run does not repeat it", () => {
  it("records done + applied_version + a per-scope outcome, and skips as up-to-date next time", async () => {
    const run = vi.fn(async (_s, ctx: Ctx) => {
      ctx.checkpoint("done", 3);
      return { rows: 3 };
    });
    const area = twoScopeArea(run);

    const first = await runBackfill(area);
    expect(first.ran).toBe(true);
    expect(first.scopesDone).toBe(2);
    expect(first.rows).toBe(6);
    expect(run).toHaveBeenCalledTimes(2);

    const entry = ledger().spec_area as Record<string, unknown>;
    expect(entry.status).toBe("done");
    expect(entry.applied_version).toBe(1);
    expect((entry.scopes as Record<string, { status: string }>).a.status).toBe("done");

    // IDEMPOTENCY, the version that matters most: not "the rows are the same after re-inserting them" but
    // "we did not even go and look". Nothing on disk moved, so there is nothing to do.
    const second = await runBackfill(area);
    expect(second.ran).toBe(false);
    expect(second.skipped).toBe("up-to-date");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("re-arms when the LOGIC version is bumped, and reports the same row count", async () => {
    const run = vi.fn(async () => ({ rows: 3 }));
    await runBackfill(twoScopeArea(run, 1));
    expect(run).toHaveBeenCalledTimes(2);

    const bumped = await runBackfill(twoScopeArea(run, 2));
    expect(bumped.ran).toBe(true);
    expect(run).toHaveBeenCalledTimes(4);
    expect(bumped.rows).toBe(6); // run twice, same row count
  });
});

describe("mechanic (a): resume from the cursor an interrupted run left behind", () => {
  it("hands the next run the cursor and the row count the crashed one checkpointed", async () => {
    const seen: Array<{ scope: string; resumeFrom: string | null; rowsBefore: number }> = [];
    const crashing = vi.fn(async (s, ctx: Ctx) => {
      seen.push({ scope: s.key, resumeFrom: ctx.resumeFrom, rowsBefore: ctx.rowsBefore });
      if (s.key === "a") {
        ctx.checkpoint("row-42", 42); // got this far …
        throw new Error("process killed mid-scope"); // … then died
      }
      return { rows: 7 };
    });
    const first = await runBackfill(twoScopeArea(crashing));
    expect(first.scopesFailed).toBe(1);
    expect(first.scopesDone).toBe(1); // scope b still completed — a failed scope is not a failed area
    expect(seen).toEqual([
      { scope: "a", resumeFrom: null, rowsBefore: 0 },
      { scope: "b", resumeFrom: null, rowsBefore: 0 },
    ]);

    // The failed area is `failed`, so the next pass re-arms it. Scope `b` is unchanged and complete, so it is
    // skipped entirely; scope `a` resumes from exactly where it stopped.
    seen.length = 0;
    const healthy = vi.fn(async (s, ctx: Ctx) => {
      seen.push({ scope: s.key, resumeFrom: ctx.resumeFrom, rowsBefore: ctx.rowsBefore });
      return { rows: 99 };
    });
    const second = await runBackfill(twoScopeArea(healthy));
    expect(second.ran).toBe(true);
    expect(seen).toEqual([{ scope: "a", resumeFrom: "row-42", rowsBefore: 42 }]);
    expect(second.scopesUnchanged).toBe(1);
    expect(second.scopesResumed).toBe(1);
  });
});

describe("mechanic (a): a source that MOVED is re-done from zero — for that scope only", () => {
  it("re-runs just the scope whose file changed, and leaves the other one alone", async () => {
    const keys: string[] = [];
    const run = vi.fn(async (s) => {
      keys.push(s.key);
      return { rows: 1 };
    });
    await runBackfill(twoScopeArea(run));
    expect(run).toHaveBeenCalledTimes(2);
    run.mockClear();
    keys.length = 0;

    // Only `b`'s source moves. `a` must not be touched: re-doing all 105 repos because one repo re-scanned
    // is precisely the cost the per-scope watermark exists to avoid.
    touch(srcB, "b: 2\n");
    const second = await runBackfill(twoScopeArea(run));
    expect(second.ran).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(keys).toEqual(["b"]);
    expect(second.scopesRedone).toBe(1);
    expect(second.scopesUnchanged).toBe(1);
    // Re-doing a scope from zero clears ITS rejects and nobody else's.
    expect(sqlCalls.some((c) => c.kind === "exec" && /DELETE FROM lfb\.backfill_reject/.test(c.sql))).toBe(true);
  });

  it("a scope that resumes from a cursor does NOT have its rejects cleared", async () => {
    // The distinction the reject table's PK is built around: a resumed scope must keep the rejects its
    // earlier half already recorded, or a resumed run reports two rejects as zero.
    const crashing = vi.fn(async (s, ctx: Ctx) => {
      if (s.key === "a") {
        ctx.checkpoint("half", 5);
        throw new Error("killed");
      }
      return { rows: 1 };
    });
    await runBackfill(twoScopeArea(crashing));
    sqlCalls.length = 0;
    await runBackfill(twoScopeArea(async () => ({ rows: 1 })));
    expect(sqlCalls.some((c) => /DELETE FROM lfb\.backfill_reject/.test(c.sql))).toBe(false);
  });
});

describe("mechanic (c): a reject records and CONTINUES — it never aborts the run", () => {
  it("finishes every scope, surfaces the count, and writes the reject rows", async () => {
    const area = twoScopeArea(async (s, ctx: Ctx) => {
      // The measured real case: 2 of 29,138 sidecars raise BLOCK_AS_IMPLICIT_KEY on a Windows-separator path.
      ctx.reject(`${s.key}/broken.yaml`, "BLOCK_AS_IMPLICIT_KEY at line 3");
      return { rows: 10 };
    });
    const out = await runBackfill(area);

    expect(out.ran).toBe(true);
    expect(out.scopesFailed).toBe(0); // NOT an abort
    expect(out.scopesDone).toBe(2); // every scope still finished
    expect(out.rows).toBe(20); // and the good rows still landed
    expect(out.rejects).toBe(2);
    expect(sqlCalls.filter((c) => c.sql === "lfb.backfill_reject")).toHaveLength(2);

    const entry = ledger().spec_area as { status: string; rejects: number };
    expect(entry.status).toBe("done"); // a rejected record is not a failed migration
    expect(entry.rejects).toBe(2);
  });
});

describe("verification is recorded, and a mismatch is loud rather than fatal", () => {
  it("stores yaml/pg counts and the mismatch list on the ledger entry", async () => {
    const area: Area = {
      ...twoScopeArea(async () => ({ rows: 1 })),
      verify: async () => ({ yamlRows: 105, pgRows: 104, mismatches: ["r/charlie-kirk: no unit row"] }),
    };
    const out = await runBackfill(area);
    expect(out.verification).toEqual({ yamlRows: 105, pgRows: 104, mismatches: ["r/charlie-kirk: no unit row"] });
    const entry = ledger().spec_area as { verification: { pg_rows: number; mismatches: string[] } };
    expect(entry.verification.pg_rows).toBe(104);
    expect(entry.verification.mismatches).toEqual(["r/charlie-kirk: no unit row"]);
    // §4.5: a non-empty mismatch list blocks the read CUTOVER. It does not fail the migration — the rows
    // that did land are still correct and still worth having.
    expect(out.ran).toBe(true);
  });
});

describe("the guards that decide whether a backfill may run at all", () => {
  it("skips with 'no-database' rather than failing, which is the documented auto fallback", async () => {
    const db = await import("./db.js");
    vi.spyOn(db, "dbEnabled").mockReturnValue(false);
    const run = vi.fn(async () => ({ rows: 1 }));
    const out = await runBackfill(twoScopeArea(run));
    expect(out.skipped).toBe("no-database");
    expect(out.ran).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("defers to the pool's interactive reserve — background work never competes with a sign-in", async () => {
    const pool = await import("./pool.js");
    vi.spyOn(pool, "backgroundShouldDefer").mockReturnValue(true);
    const run = vi.fn(async () => ({ rows: 1 }));
    const out = await runBackfill(twoScopeArea(run));
    expect(out.skipped).toBe("deferred");
    expect(run).not.toHaveBeenCalled();
  });

  it("stands aside when another process holds the migration lease", async () => {
    const file = path.join(stateDir, "migration_state.yaml");
    fs.writeFileSync(
      file,
      YAML.stringify({
        schema_version: 1,
        engine: { lease_owner: "999999@someone-else", lease_expires_at: new Date(Date.now() + 60_000).toISOString() },
        migrations: {},
      }),
    );
    const run = vi.fn(async () => ({ rows: 1 }));
    const out = await runBackfill(twoScopeArea(run));
    expect(out.skipped).toBe("lease-held");
    expect(run).not.toHaveBeenCalled();
  });

  it("releases the lease when it is done, so the next process is not locked out", async () => {
    await runBackfill(twoScopeArea(async () => ({ rows: 1 })));
    const doc = YAML.parse(fs.readFileSync(path.join(stateDir, "migration_state.yaml"), "utf8")) as {
      engine: { lease_owner: string | null };
    };
    expect(doc.engine.lease_owner).toBeNull();
  });
});

describe("the registry", () => {
  it("runs areas in registration order and refuses a duplicate name", async () => {
    const order: string[] = [];
    const make = (name: string): Area => ({
      name,
      version: 1,
      kind: "backfill",
      sources: () => [srcA],
      scopes: () => [{ key: "only", sources: [srcA] }],
      run: async () => {
        order.push(name);
        return { rows: 1 };
      },
    });
    registerBackfill(make("first"));
    registerBackfill(make("second"));
    expect(listBackfills().map((a) => a.name)).toEqual(["first", "second"]);
    expect(() => registerBackfill(make("first"))).toThrow(/already registered/);

    const outcomes = await runAllBackfills();
    expect(order).toEqual(["first", "second"]);
    expect(outcomes.map((o) => o.name)).toEqual(["first", "second"]);

    // `--only` runs one area without disturbing the other's ledger entry.
    order.length = 0;
    await runAllBackfills(["second"]);
    expect(order).toEqual([]); // both are already up to date; the filter did not re-arm anything
  });
});
