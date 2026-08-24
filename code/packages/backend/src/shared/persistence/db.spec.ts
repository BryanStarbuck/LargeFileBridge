// THE QUERY LAYER'S CONTRACT (database.mdx §7).
//
// Everything asserted here is a property the app's "runs locally first" promise rests on. There is no
// Postgres in this suite and there deliberately never will be: the whole point of these tests is what
// happens on a machine that has none, which is the machine every user is on today.
//
//   * `dbEnabled()` is conservative. It says NO until something has actually spoken to a server, because
//     "we have never successfully connected" is not evidence that we can.
//   * `q` / `q1` / `exec` / `copyRows` are safe with no pool. They answer empty, they do not throw.
//   * `tryDb` returns the fallback on ANY error and logs at WARN, throttled. This is the shape every
//     Postgres call site takes, and it is the mechanism that keeps a database error out of a request
//     handler.
//   * `copyRows` builds PARAMETERISED batches. The values it carries are user file paths; a helper that
//     concatenated them into SQL text would be an injection surface on the one input class that must never
//     be one.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  NoDatabaseError,
  copyRows,
  dbEnabled,
  dbHealth,
  exec,
  noteDbHealth,
  q,
  q1,
  resetDbHealth,
  resetDbWarnThrottle,
  tryDb,
  tx,
} from "./db.js";
import { log } from "../logging.js";

beforeEach(() => {
  resetDbHealth();
  resetDbWarnThrottle();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetDbHealth();
});

describe("dbEnabled — THE guard, and it is conservative on purpose", () => {
  it("is false under LFB_DB_MODE=off, without even constructing a pool", () => {
    vi.stubEnv("LFB_DB_MODE", "off");
    expect(dbEnabled()).toBe(false);
  });

  it("is false before anything has spoken to a server, even with a pool available", () => {
    vi.stubEnv("LFB_DB_MODE", "auto");
    // Health starts 'unknown'. A caller that took this as "yes" would issue a query into a machine that has
    // never had Postgres installed and pay a connect timeout per request to learn what it already knew.
    expect(dbHealth().state).toBe("unknown");
    expect(dbEnabled()).toBe(false);
  });

  it("is true once a real interaction reports the server up, and false again when one fails", () => {
    vi.stubEnv("LFB_DB_MODE", "auto");
    noteDbHealth(true);
    expect(dbEnabled()).toBe(true);
    noteDbHealth(false);
    expect(dbEnabled()).toBe(false);
  });
});

describe("no pool: every helper answers, none of them throws", () => {
  beforeEach(() => {
    vi.stubEnv("LFB_DB_MODE", "off");
  });

  it("q returns [] and q1 returns null", async () => {
    await expect(q("SELECT 1")).resolves.toEqual([]);
    await expect(q1("SELECT 1")).resolves.toBeNull();
  });

  it("exec returns 0 — nothing happened, which is exactly what 0 means", async () => {
    await expect(exec("DELETE FROM lfb.unit")).resolves.toBe(0);
  });

  it("copyRows returns 0", async () => {
    await expect(copyRows("lfb.device", ["label"], [["a"], ["b"]])).resolves.toBe(0);
  });

  it("tx is the ONE helper that throws — it has no honest empty answer to invent", async () => {
    await expect(tx(async () => 1)).rejects.toBeInstanceOf(NoDatabaseError);
  });

  it("… and tryDb turns that throw into the caller's fallback, which is how call sites use it", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const out = await tryDb(() => tx(async () => "from-pg"), "from-yaml", "spec.tx");
    expect(out).toBe("from-yaml");
  });
});

describe("tryDb — the mechanism that keeps a database error out of a request handler", () => {
  it("returns the fallback on ANY error and logs one WARN naming the call site", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const out = await tryDb(
      async () => {
        throw new Error("connection refused");
      },
      ["yaml-row"],
      "units.folderForRepoId",
    );
    expect(out).toEqual(["yaml-row"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [scope, message] = warn.mock.calls[0];
    expect(scope).toBe("db");
    expect(message).toContain("units.folderForRepoId");
    expect(message).toContain("connection refused");
  });

  it("evaluates a THUNK fallback lazily — the fallback is usually the expensive old path", async () => {
    const scan = vi.fn(() => "folder-from-scan");
    const ok = await tryDb(async () => "folder-from-pg", scan, "spec.lazy");
    expect(ok).toBe("folder-from-pg");
    expect(scan).not.toHaveBeenCalled(); // the whole point: no 105-config scan on the happy path

    vi.spyOn(log, "warn").mockImplementation(() => {});
    const fell = await tryDb(
      async () => {
        throw new Error("boom");
      },
      scan,
      "spec.lazy",
    );
    expect(fell).toBe("folder-from-scan");
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("throttles: a server that is down for a minute costs ONE line, with the suppressed count on the next", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const boom = async (): Promise<number> => {
      throw new Error("down");
    };
    for (let i = 0; i < 25; i++) await tryDb(boom, 0, "spec.throttle");
    expect(warn).toHaveBeenCalledTimes(1);

    // A different call site is throttled independently — one surface degrading must not silence another.
    await tryDb(boom, 0, "spec.other");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("copyRows — parameterised batches, never string concatenation", () => {
  /** A stand-in for a PoolClient: records what it was asked to run. */
  function recorder(): { calls: Array<{ sql: string; params: unknown[] }>; query: (s: string, p: unknown[]) => Promise<{ rowCount: number }> } {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return {
      calls,
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rowCount: (params.length || 0) / Math.max(1, sql.split("$").length - 1) || 1 };
      },
    };
  }

  it("puts every VALUE in a bind parameter — a path with a quote in it never reaches the SQL text", async () => {
    const rec = recorder();
    const nasty = "videos/it's a '); DROP TABLE lfb.unit;--.mp4";
    await copyRows("lfb.file", ["unit_id", "rel_posix"], [[1, nasty]], {
      client: rec as never,
    });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].sql).not.toContain("DROP TABLE");
    expect(rec.calls[0].sql).toContain("VALUES ($1,$2)");
    expect(rec.calls[0].params).toEqual([1, nasty]);
  });

  it("batches at 500 rows per statement by default, and honours an override", async () => {
    const rec = recorder();
    const rows = Array.from({ length: 1_100 }, (_, i) => [i]);
    await copyRows("lfb.device", ["device_id"], rows, { client: rec as never });
    expect(rec.calls).toHaveLength(3); // 500 + 500 + 100

    const rec2 = recorder();
    await copyRows("lfb.device", ["device_id"], rows, { client: rec2 as never, batchRows: 250 });
    expect(rec2.calls).toHaveLength(5);
  });

  it("never exceeds Postgres's 65535 bind-parameter ceiling, whatever batchRows says", async () => {
    const rec = recorder();
    const cols = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 9_000 }, () => cols.map(() => 1));
    await copyRows("lfb.wide", cols, rows, { client: rec as never, batchRows: 100_000 });
    for (const call of rec.calls) expect(call.params.length).toBeLessThanOrEqual(65_535);
  });

  it("appends the CALLER's ON CONFLICT clause verbatim — R5 lives at the call site, not in here", async () => {
    const rec = recorder();
    await copyRows("lfb.file", ["unit_id", "rel_posix", "size_bytes"], [[1, "a.mp4", 5]], {
      client: rec as never,
      onConflict: "ON CONFLICT (unit_id, rel_posix) DO UPDATE SET size_bytes = EXCLUDED.size_bytes",
    });
    expect(rec.calls[0].sql).toContain("ON CONFLICT (unit_id, rel_posix) DO UPDATE SET size_bytes = EXCLUDED.size_bytes");
    // and NOT a whole-row update, which is the clobber R5 exists to prevent
    expect(rec.calls[0].sql).not.toContain("rel_posix = EXCLUDED.rel_posix");
  });

  it("refuses a row whose width disagrees with the column list, rather than shifting every value left", async () => {
    const rec = recorder();
    await expect(
      copyRows("lfb.device", ["label", "folder_key"], [["a", "b"], ["c"]], { client: rec as never }),
    ).rejects.toThrow(/2 columns/);
  });

  it("is a no-op for zero rows — a backfill scope with nothing to write must not issue a statement", async () => {
    const rec = recorder();
    await expect(copyRows("lfb.device", ["label"], [], { client: rec as never })).resolves.toBe(0);
    expect(rec.calls).toHaveLength(0);
  });
});
