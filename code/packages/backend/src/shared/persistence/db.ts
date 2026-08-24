// THE QUERY LAYER — small, honest helpers over the pool (database.mdx §7).
//
// Everything in this app that touches Postgres goes through this file, and the reason is one rule from
// database.mdx §7 and the charter's "runs locally first" posture:
//
//     THE APP MUST WORK WITH NO POSTGRES.
//
// `LFB_DB_MODE=auto` is the default. A user who has never heard of Postgres — which is every user today —
// must get a working app, every page, every route. So a database error is NEVER allowed to reach a request
// handler or a boot path. That is not a nice-to-have: `bootDatabase()` already swallows its own failures for
// exactly this reason (boot.ts), and a query helper that threw past it would undo that on the first call.
//
// The shape that enforces it is `tryDb(fn, fallback, ctx)`. It is deliberately the shortest thing to type,
// because the failure mode we are guarding against is a developer reaching for `q()` directly on a request
// path and shipping a 500 that only appears on machines without a database — i.e. on every machine except
// the one it was written on.
//
// `dbEnabled()` is the OTHER half: "should I even try?". It answers from the last observed health, so a call
// site can pick the Postgres path or the YAML path without paying a round trip to find out.
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { getPool, probeDatabase, resolveDbMode } from "./pool.js";
import { log } from "../logging.js";

/**
 * THE HEALTH LATCH.
 *
 * `dbEnabled()` has to be synchronous — every call site that consults it is deciding which of two code paths
 * to take, and half of them (`folderForRepoId`) are synchronous themselves. So health is a remembered fact,
 * not a live probe:
 *
 *   unknown — nobody has looked yet. Treated as NOT enabled, because "we have never successfully spoken to
 *             the database" is not evidence that we can. A background refresh is kicked off (once) so the
 *             very next caller gets a real answer instead of the same shrug.
 *   up      — the last thing we did against the server worked.
 *   down    — the last thing we did failed. Re-probed lazily, throttled, so a server that comes back up is
 *             picked up without every caller paying a failed connect.
 */
type Health = "unknown" | "up" | "down";

let health: Health = "unknown";
let healthAt = 0;
let refreshInFlight: Promise<boolean> | null = null;

/** How long a `down` verdict stands before a caller's `dbEnabled()` triggers another background probe. */
const HEALTH_RECHECK_MS = 30_000;

/**
 * Record what a real interaction with the server just told us. Exported so `bootDatabase()` can hand over
 * the verdict from the probe it already runs (boot.ts `connectAndMigrate`) — without that, the first N
 * callers after boot would all read `unknown` and take the YAML path on a machine whose database is fine.
 */
export function noteDbHealth(ok: boolean): void {
  health = ok ? "up" : "down";
  healthAt = Date.now();
}

/** Forget everything we believe about the server. Tests use this; nothing in the app should need it. */
export function resetDbHealth(): void {
  health = "unknown";
  healthAt = 0;
  refreshInFlight = null;
}

/** The remembered verdict, for /api/health and for tests that want to assert the latch without a server. */
export function dbHealth(): { state: Health; at: number } {
  return { state: health, at: healthAt };
}

/**
 * Probe the server and record the verdict. Await this when you need a CORRECT answer from `dbEnabled()`
 * right now (a CLI, a backfill, a test). Never throws; the verdict is the return value.
 */
export async function refreshDbHealth(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const probe = await probeDatabase();
      noteDbHealth(probe.reachable);
      return probe.reachable;
    } catch {
      noteDbHealth(false);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * THE GUARD every Postgres call site asks first: is there a pool, and did the last thing we tried work?
 *
 * False is never an error — it is the documented `auto` fallback, and the caller's job is to do what it did
 * before Postgres existed. It is deliberately conservative: `unknown` reads as false.
 */
export function dbEnabled(): boolean {
  if (resolveDbMode() === "off") return false;
  if (!getPool()) return false;
  if (health === "up") return true;
  // Never block, never await: kick a refresh so the NEXT caller has a real answer, and answer "no" now.
  if (health === "unknown" || Date.now() - healthAt > HEALTH_RECHECK_MS) void refreshDbHealth();
  return false;
}

/**
 * Thrown by `tx()` alone. Every other helper has an honest empty answer for "there is no database" — no rows,
 * no rows affected — but a transaction returns whatever its body returns and cannot invent one. So it says so,
 * and `tryDb` turns it into the caller's fallback like any other failure.
 */
export class NoDatabaseError extends Error {
  constructor() {
    super("no database (LFB_DB_MODE=off, or no DATABASE_URL configured)");
    this.name = "NoDatabaseError";
  }
}

function poolOrNull(): Pool | null {
  return resolveDbMode() === "off" ? null : getPool();
}

/** Rows for `sql`. Returns `[]` when there is no pool at all — see the file header. */
export async function q<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
  const pool = poolOrNull();
  if (!pool) return [];
  try {
    const r = await pool.query<T>(sql, params as never[]);
    noteDbHealth(true);
    return r.rows;
  } catch (e) {
    noteDbHealth(false);
    throw e;
  }
}

/** The first row, or null. `null` also covers "there is no pool", which is the same thing to every caller. */
export async function q1<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

/** Rows affected. `0` when there is no pool — nothing happened, which is exactly what 0 means. */
export async function exec(sql: string, params?: unknown[]): Promise<number> {
  const pool = poolOrNull();
  if (!pool) return 0;
  try {
    const r = await pool.query(sql, params as never[]);
    noteDbHealth(true);
    return r.rowCount ?? 0;
  } catch (e) {
    noteDbHealth(false);
    throw e;
  }
}

/**
 * BEGIN / COMMIT / ROLLBACK around `fn`, and the client is released on EVERY path.
 *
 * The release is the part that matters and the part that is easy to get wrong. `POOL_MAX` is 8 with a
 * 3-connection interactive reserve (pool.ts), so a single leaked client is 1/8th of this machine's capacity
 * gone until the process restarts — and the sister app's 2026-08-15 incident (nineteen admins logged out
 * because batch work ate the pool) is what that ends as. Hence `finally`, not a release at the end of the
 * happy path.
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const pool = poolOrNull();
  if (!pool) throw new NoDatabaseError();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    noteDbHealth(true);
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection may already be unusable (that is often WHY we are here). The rethrow below is the
      // real signal; a failed rollback on a dead socket is noise that would mask it.
    }
    noteDbHealth(false);
    throw e;
  } finally {
    client.release();
  }
}

/** Postgres refuses more than 65535 bind parameters in one statement. Everything below stays under it. */
const MAX_BIND_PARAMS = 65535;

export interface CopyRowsOptions {
  /**
   * The caller's own `ON CONFLICT …` clause, verbatim — e.g.
   * `ON CONFLICT (label) DO UPDATE SET folder_key = EXCLUDED.folder_key`.
   *
   * It is the CALLER's because of the rule that four separate backfills write `lfb.file`: a whole-row
   * upsert would clobber another slice's columns, so each one names only what it owns
   * (database_migration.mdx §4.1(b)). A shared helper cannot know which columns those are, and guessing
   * would produce exactly the silent cross-slice data loss the rule exists to prevent.
   */
  onConflict?: string;
  /** Rows per statement. 500 measured as the knee — past it the parse cost of the VALUES list dominates. */
  batchRows?: number;
  /** Run inside an open transaction rather than on a pooled connection of our own. */
  client?: PoolClient;
}

/**
 * Batched multi-row INSERT — the backfill's bulk writer.
 *
 * DELIBERATELY NOT `pg-copy-streams`. COPY is faster, and it is a new dependency, a second error surface and
 * a second escaping regime for data we are already holding in memory as JS values. The largest single area
 * is 30,758 rows; at 500 rows per statement that is 62 round trips on a loopback socket. The dependency
 * would buy milliseconds and cost a supply-chain edge, which is not a trade this app makes.
 *
 * DELIBERATELY NOT string concatenation either. Every value is a bind parameter — the row data here is
 * user file paths, which is precisely the input class that must never be spliced into SQL text.
 */
export async function copyRows(
  table: string,
  columns: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  opts: CopyRowsOptions = {},
): Promise<number> {
  if (rows.length === 0 || columns.length === 0) return 0;
  const pool = poolOrNull();
  if (!pool && !opts.client) return 0;

  const perStatement = Math.max(1, Math.min(opts.batchRows ?? 500, Math.floor(MAX_BIND_PARAMS / columns.length)));
  const colList = columns.join(", ");
  const tail = opts.onConflict ? ` ${opts.onConflict}` : "";
  const runner = opts.client ?? pool!;

  let affected = 0;
  for (let start = 0; start < rows.length; start += perStatement) {
    const slice = rows.slice(start, start + perStatement);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const row of slice) {
      if (row.length !== columns.length) {
        throw new Error(`copyRows(${table}): row has ${row.length} values for ${columns.length} columns`);
      }
      const marks: string[] = [];
      for (const v of row) {
        params.push(v);
        marks.push(`$${params.length}`);
      }
      tuples.push(`(${marks.join(",")})`);
    }
    const sql = `INSERT INTO ${table} (${colList}) VALUES ${tuples.join(",")}${tail}`;
    try {
      const r = await runner.query(sql, params as never[]);
      affected += r.rowCount ?? 0;
    } catch (e) {
      noteDbHealth(false);
      throw e;
    }
  }
  noteDbHealth(true);
  return affected;
}

// ── tryDb: how R2 is enforced at a call site ────────────────────────────────────────────────────────────

/**
 * A failing database must not also fill `error.err`. One WARN per context per window, with the count of what
 * was suppressed, so a server that is down for an hour costs a handful of lines and still says how bad it was
 * — the same posture the pool's idle-client handler takes (pool.ts).
 */
const WARN_WINDOW_MS = 60_000;
const warned = new Map<string, { at: number; suppressed: number }>();

function warnThrottled(ctx: string, message: string): void {
  const now = Date.now();
  const prior = warned.get(ctx);
  if (prior && now - prior.at < WARN_WINDOW_MS) {
    prior.suppressed += 1;
    return;
  }
  const also = prior && prior.suppressed > 0 ? ` (+${prior.suppressed} more suppressed in the last minute)` : "";
  warned.set(ctx, { at: now, suppressed: 0 });
  log.warn("db", `${ctx}: ${message}${also} — falling back to the YAML path`);
}

/** Drop the throttle memory. Tests only. */
export function resetDbWarnThrottle(): void {
  warned.clear();
}

/**
 * RUN `fn`; ON ANY ERROR, LOG AND RETURN `fallback`. This is the shape every Postgres call site takes.
 *
 * `fallback` may be a value or a thunk. The thunk form is the important one: the fallback for a cut-over read
 * is usually the OLD implementation (`folderForRepoId`'s linear scan over 105 pin configs), and evaluating
 * that eagerly on every call would make the Postgres path slower than the path it replaced.
 *
 * `ctx` names the call site in the log line. Make it specific — "units.folderForRepoId", not "db read" —
 * because the whole value of the line is telling whoever reads `error.err` which surface just degraded.
 */
export async function tryDb<T>(fn: () => Promise<T>, fallback: T | (() => T | Promise<T>), ctx: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    warnThrottled(ctx, (e as Error)?.message ?? String(e));
    return typeof fallback === "function" ? await (fallback as () => T | Promise<T>)() : fallback;
  }
}
