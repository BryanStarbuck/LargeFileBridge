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
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  INTERACTIVE_RESERVE,
  POOL_MAX,
  getPool,
  probeDatabase,
  resolveDbMode,
  setPoolErrorObserver,
} from "./pool.js";
import { Semaphore } from "./lane.js";
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
/** True once the current outage has had its one unthrottled announcement (see `tryDb`). */
let outageAnnounced = false;
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
  // A server that answered again ends the outage episode, so the NEXT outage is announced afresh.
  if (ok) outageAnnounced = false;
}

/**
 * The pool tells us the moment an idle connection dies — a Postgres restart, `just db-down`, a crash. That
 * is the earliest possible evidence, and acting on it is what stops the next fan-out of call sites from
 * each spending `connectionTimeoutMillis` (3 s) on a request path rediscovering it (pool.ts
 * `setPoolErrorObserver`). `dbEnabled()` answers false from here on, and `HEALTH_RECHECK_MS` later a
 * background probe picks the server back up when it returns.
 */
setPoolErrorObserver(() => noteDbHealth(false));

/** Forget everything we believe about the server. Tests use this; nothing in the app should need it. */
export function resetDbHealth(): void {
  health = "unknown";
  healthAt = 0;
  refreshInFlight = null;
  outageAnnounced = false;
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

// ── the background lane: how INTERACTIVE_RESERVE is actually enforced ────────────────────────────────────
//
// pool.ts documents a 3-connection interactive reserve "enforced by convention at the call site", and until
// this lane existed no call site enforced it. The mirror and reconcile passes fire `syncFenceBeforeMirror`
// and `recordSdlIngestForRepo` fire-and-forget, once per repo per pass — 100+ jobs a minute — and each took
// a pooled connection the moment it asked. All 8 went to bookkeeping, pg-pool's 3 s acquire timeout expired
// for everyone queued behind them, and the user-facing reads (`foreignPin.recordsUnder`,
// `manifest.project.unit`) fell back to YAML alongside the background work that starved them (error.err
// 2026-09-25 → 09-27: 190 lines, thousands more suppressed, Postgres up throughout).
//
// Work wrapped in `runInBackground` now takes a LANE SLOT per statement (per transaction for `tx`), and the
// lane is `POOL_MAX - INTERACTIVE_RESERVE` wide. Background work therefore never holds more than 5 of the 8
// connections, and a request always finds the reserve free. Per statement rather than per job, so a job
// that spends most of its time hashing files on the event loop does not sit on a slot it is not using.
//
// AsyncLocalStorage carries the flag, so a job marks itself once at its entry point and every helper it
// reaches — however many modules deep — is gated without being told. Unmarked work (every request handler)
// goes straight to the pool, exactly as before.

interface LaneState {
  /** True while this async context already holds a lane slot (inside a gated statement or a `tx`). */
  holding: boolean;
}
const lane = new AsyncLocalStorage<LaneState>();

/** Connections background work may hold at once. The rest of the pool is the interactive reserve. */
export const BACKGROUND_SLOTS = Math.max(1, POOL_MAX - INTERACTIVE_RESERVE);
let bgSlots = new Semaphore(BACKGROUND_SLOTS);

/**
 * Run `fn` as BACKGROUND database work: every statement it issues waits for a lane slot instead of taking a
 * connection outright. Nesting is free — an inner call joins the outer lane. Never use it on a request path:
 * a request must be able to use the reserve this exists to protect.
 */
export function runInBackground<T>(fn: () => Promise<T>): Promise<T> {
  if (lane.getStore()) return fn();
  return lane.run({ holding: false }, fn);
}

/** Is the current async context background work? */
export function inBackgroundLane(): boolean {
  return lane.getStore() !== undefined;
}

/** Lane occupancy, for the saturation WARN and /api/health. */
export function backgroundLaneStats(): { slots: number; active: number; waiting: number } {
  return { slots: bgSlots.limit, active: bgSlots.active, waiting: bgSlots.waiting };
}

/** TEST-ONLY: a fresh lane of `slots` width (the pool-derived default when omitted). */
export function resetBackgroundLane(slots = BACKGROUND_SLOTS): void {
  bgSlots = new Semaphore(slots);
}

/** How long a background statement waits before its one retry of a connect-phase timeout. */
const CONNECT_RETRY_MS = 250;

/**
 * Did this error happen while ACQUIRING a connection, before any SQL was sent? pg-pool's acquire timeout
 * and pg's handshake timeout are the two spellings. Both are safe to retry: the statement never ran.
 */
export function isConnectTimeout(e: unknown): boolean {
  const m = (e as Error)?.message ?? "";
  return /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(m);
}

/**
 * Gate one statement (or one transaction) through the lane when the caller is background work.
 *
 * A background statement whose ACQUIRE times out is retried once. 147 of the 190 starvation lines sat within
 * ±70 s of an event-loop stall: pg-pool's 3 s timer fires the moment the loop unblocks, ahead of the socket
 * callback that would have handed over a connection, so the "timeout" is a scheduling artefact and the
 * second attempt finds the connection waiting. Request paths are NOT retried — a user should see the YAML
 * answer now, not 3 s later.
 */
async function viaLane<T>(fn: () => Promise<T>): Promise<T> {
  const st = lane.getStore();
  if (!st || st.holding) return fn();
  const release = await bgSlots.acquire();
  try {
    return await lane.run({ holding: true }, async () => {
      try {
        return await fn();
      } catch (e) {
        if (!isConnectTimeout(e)) throw e;
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
        return await fn();
      }
    });
  } finally {
    release();
  }
}

/** Every pooled connection checked out, or callers already queued for one. */
function poolSaturated(): boolean {
  const p = poolOrNull();
  if (!p) return false;
  return p.waitingCount > 0 || (p.totalCount >= POOL_MAX && p.idleCount === 0);
}

/**
 * DOES THIS FAILURE MEAN THE SERVER IS GONE? Only then may it flip the health latch.
 *
 * Marking the database down on ANY error — as every helper here used to — turned pool starvation into an
 * outage: one acquire timeout flipped `dbEnabled()` to false, every surface in the app took the YAML path for
 * the next 30 s, and the recheck probe queued behind the same saturated pool. Two classes of error prove the
 * server is fine and must leave the latch alone:
 *   * a connect timeout while the pool is saturated — that is contention on OUR side of the socket;
 *   * any SQLSTATE outside class 08 (connection exception) and 57P01-03 (shutdown / cannot connect now) —
 *     the server parsed, planned or cancelled our statement, so it is demonstrably answering.
 */
export function errorMeansServerDown(e: unknown, saturated = poolSaturated()): boolean {
  if (isConnectTimeout(e)) return !saturated;
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03";
  }
  return true; // ECONNREFUSED, ENOTFOUND, a socket torn down mid-query — nothing proves the server answered
}

/**
 * A failure worth ONE retry of idempotent background work: nothing about the statement was wrong, the
 * moment was. Acquire/handshake timeouts, a statement cancelled by `statement_timeout` (57014 — on this
 * laptop, overwhelmingly a statement that was in flight when the lid closed: the server's timer is wall
 * clock, so a 15-minute sleep expires it on wake), and a connection lost mid-statement.
 */
export function isTransientDbError(e: unknown): boolean {
  if (isConnectTimeout(e)) return true;
  const code = (e as { code?: unknown })?.code;
  if (code === "57014" || code === "57P01" || (typeof code === "string" && code.startsWith("08"))) return true;
  const m = (e as Error)?.message ?? "";
  return /canceling statement due to statement timeout|Connection terminated unexpectedly/i.test(m);
}

function noteFailure(e: unknown): void {
  if (errorMeansServerDown(e)) noteDbHealth(false);
}

/** Rows for `sql`. Returns `[]` when there is no pool at all — see the file header. */
export async function q<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
  const pool = poolOrNull();
  if (!pool) return [];
  try {
    const r = await viaLane(() => pool.query<T>(sql, params as never[]));
    noteDbHealth(true);
    return r.rows;
  } catch (e) {
    noteFailure(e);
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
    const r = await viaLane(() => pool.query(sql, params as never[]));
    noteDbHealth(true);
    return r.rowCount ?? 0;
  } catch (e) {
    noteFailure(e);
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
  // One lane slot for the whole transaction: it holds ONE connection from BEGIN to COMMIT.
  return viaLane(() => txOn(pool, fn));
}

async function txOn<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (e) {
    noteFailure(e);
    throw e;
  }
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
    noteFailure(e);
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
      // A caller-supplied client is already a held connection (usually inside `tx`, which took the lane slot);
      // only the pool path is gated, one statement at a time.
      const r = opts.client
        ? await runner.query(sql, params as never[])
        : await viaLane(() => runner.query(sql, params as never[]));
      affected += r.rowCount ?? 0;
    } catch (e) {
      noteFailure(e);
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
 *
 * THREE KINDS OF FAILURE, THREE LINES, because they mean three different things to whoever reads the log:
 *   * CONTENTION — a connect timeout while every pooled connection is checked out. Postgres is up; our own
 *     callers are queued. One shared line per window for ALL contexts, naming the busiest ones, rather than
 *     one per context: 190 per-context lines on 2026-09-25 → 09-27 all said the same thing.
 *   * OUTAGE — the first failure that proves the server is gone gets ONE unthrottled announcement per
 *     episode, whatever context hit it, so an outage is never hidden inside a context's suppressed count.
 *     The episode ends when anything succeeds again (`noteDbHealth(true)`).
 *   * everything else — per context, throttled, as before.
 */
const WARN_WINDOW_MS = 60_000;
const warned = new Map<string, { at: number; suppressed: number }>();

/** The shared contention line's window, and which contexts it swallowed since it last spoke. */
let contention: { at: number; byCtx: Map<string, number> } | null = null;

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

function warnContention(ctx: string): void {
  const now = Date.now();
  if (contention && now - contention.at < WARN_WINDOW_MS) {
    contention.byCtx.set(ctx, (contention.byCtx.get(ctx) ?? 0) + 1);
    return;
  }
  const prior = contention?.byCtx;
  let also = "";
  if (prior && prior.size > 0) {
    const total = [...prior.values()].reduce((a, b) => a + b, 0);
    const top = [...prior.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    also = ` (+${total} more in the last minute: ${top})`;
  }
  contention = { at: now, byCtx: new Map() };
  const p = poolOrNull();
  const ln = backgroundLaneStats();
  const busy = p ? `${p.totalCount - p.idleCount}/${POOL_MAX} connections busy, ${p.waitingCount} waiting` : "pool gone";
  log.warn(
    "db",
    `${ctx}: connection pool saturated (${busy}; background lane ${ln.active}/${ln.slots}, ${ln.waiting} queued)` +
      `${also} — falling back to the YAML path. Postgres is up; this is contention, not an outage.`,
  );
}

/** Drop the throttle memory. Tests only. */
export function resetDbWarnThrottle(): void {
  warned.clear();
  contention = null;
  outageAnnounced = false;
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
    const message = (e as Error)?.message ?? String(e);
    if (isConnectTimeout(e) && !errorMeansServerDown(e)) {
      warnContention(ctx);
    } else if (!(e instanceof NoDatabaseError) && errorMeansServerDown(e) && !outageAnnounced) {
      // The episode's announcement bypasses this context's window, so a context that last warned 20 s ago
      // cannot swallow the first sign of an outage into a "(+N more suppressed)" nobody reads.
      outageAnnounced = true;
      warned.delete(ctx);
      warnThrottled(
        ctx,
        `${message} [POSTGRES UNREACHABLE — every Postgres-backed surface is on the YAML path until it answers ` +
          `again; further lines are throttled per surface]`,
      );
    } else {
      warnThrottled(ctx, message);
    }
    return typeof fallback === "function" ? await (fallback as () => T | Promise<T>)() : fallback;
  }
}
