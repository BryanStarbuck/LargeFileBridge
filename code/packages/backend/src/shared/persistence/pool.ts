// The Postgres connection: URL resolution, the loopback decision, TLS, and pool sizing (database.mdx §7).
//
// NOTHING in this file may log a URL that has not been through `safeUrl` — the connection string carries the
// database password. That is the same rule the credentials file follows, and it is the reason every log line
// below interpolates `safeUrl(...)` and never the raw value.
import { readFileSync } from "node:fs";
import { Pool, type PoolConfig } from "pg";
import { log } from "../logging.js";

export const DB_SCHEMA = (process.env.LFB_DB_SCHEMA ?? "lfb").trim() || "lfb";

/**
 * database.mdx §7.2 — the localhost development default. `just db-up` creates exactly this role and
 * database, so the fast path costs one command and zero configuration. It is never used in server mode, and
 * it carries a throwaway password on loopback by design: a real deployment always supplies
 * DATABASE_URL_FILE.
 */
export const LOCAL_DEV_DATABASE_URL = "postgresql://lfb:lfb@localhost:5432/largefilebridge";

/**
 * How hard we insist on Postgres (database.mdx §7).
 *   auto     — the DEFAULT and the charter's posture ("runs locally first"). Use Postgres when it is
 *              reachable; otherwise fall back to the YAML path with a loud WARN. A user who has never heard
 *              of Postgres gets a working app.
 *   required — server mode. An unusable database is a HARD BOOT FAILURE, because silently serving stale
 *              YAML to several logged-in people is worse than not starting.
 *   off      — never connect. The escape hatch for bisecting a suspected database regression.
 */
export type DbMode = "auto" | "required" | "off";

export function resolveDbMode(): DbMode {
  const raw = (process.env.LFB_DB_MODE ?? "").trim().toLowerCase();
  if (raw === "required" || raw === "off" || raw === "auto") return raw;
  if (raw !== "") log.warn("db", `LFB_DB_MODE=${raw} is not one of auto|required|off — using auto`);
  return "auto";
}

/**
 * §7 — DATABASE_URL contains a password and is therefore a SECRET. It follows the same rule as every other
 * credential in this app: delivered as a FILE, never as an inspectable service environment variable. The
 * plain env var is supported only for local development against a throwaway database.
 */
export function resolveDatabaseUrl(): string | null {
  const file = process.env.LFB_DATABASE_URL_FILE?.trim();
  if (file) {
    try {
      const url = readFileSync(file, "utf8").trim();
      if (url) return url;
      log.error("db", `LFB_DATABASE_URL_FILE is empty: ${file}`);
    } catch (e) {
      // Returning null makes the caller fall back to YAML or fail the boot; either way the REASON has to be
      // on the trail, because "no database" is otherwise indistinguishable from "database not configured".
      log.error("db", `reading LFB_DATABASE_URL_FILE ${file} failed: ${(e as Error).message}`);
    }
    return null;
  }
  const env = process.env.DATABASE_URL?.trim();
  if (env) return env;
  return resolveDbMode() === "auto" ? LOCAL_DEV_DATABASE_URL : null;
}

/** A connection string with the password removed — the ONLY form that may reach a log line. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable database url>";
  }
}

/**
 * §7.1 — is this connection string pointed at THIS machine?
 *
 * The answer decides whether TLS may be skipped, so it is a SECURITY decision: it is PARSED, never
 * pattern-matched, and it FAILS CLOSED (an unparseable URL is "not loopback", so it gets TLS).
 *
 * The sister app shipped `/@(localhost|127\.0\.0\.1|\[::1\])[:/]/` against the raw string and it was wrong in
 * the dangerous direction: the pattern searched the WHOLE string, so a REMOTE url whose PASSWORD contained
 * `@localhost:` matched and had its TLS silently disabled. Only the host may be consulted, and only after
 * the URL has been parsed.
 */
export function isLoopbackDatabaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false; // fail CLOSED
  }
  // URL.hostname KEEPS the brackets on an IPv6 literal — WHATWG serializes the host as `[::1]`, and the
  // `hostname` getter is that serialization minus the port (verified on node v26.7.0: `new
  // URL("postgresql://u:p@[::1]:5432/x").hostname === "[::1]"`). An earlier comment here claimed the
  // opposite and the comparison was written against the unbracketed form, so a genuine IPv6 loopback URL
  // answered FALSE and got `ssl: {rejectUnauthorized:true}` — which a local `ssl=off` server refuses, so the
  // app fell to the YAML path on a machine whose database was running fine. Wrong in the SAFE direction, but
  // still wrong. Strip the brackets, then compare.
  //
  // Note the parser also NORMALIZES `[0:0:0:0:0:0:0:1]` to `[::1]`; the long form is kept below only so that
  // a caller passing an already-unbracketed host string (not a URL) still gets the right answer.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "0:0:0:0:0:0:0:1";
}

function num(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * THE INTERACTIVE RESERVE (database.mdx §7).
 *
 * The pool is deliberately small — this is a desktop app, not a web tier — but small pools have a specific
 * failure mode, and the sister app hit it on 2026-08-15: batch work consumed every pooled connection and
 * NINETEEN ADMINS WERE LOGGED OUT, because the session read could not get a connection and "cannot reach the
 * session store" is indistinguishable from "not signed in".
 *
 * So background work never gets the whole pool. `POOL_MAX` is the ceiling for everything; `INTERACTIVE_RESERVE`
 * is the slice that background callers must leave alone. Enforcement is by convention at the call site
 * (`acquireBackground` below), which is enough because there is exactly ONE backend process per machine
 * (single-instance.ts).
 */
export const POOL_MAX = num("LFB_DB_POOL_MAX", 8);
export const INTERACTIVE_RESERVE = Math.min(num("LFB_DB_POOL_RESERVE", 3), Math.max(POOL_MAX - 1, 1));

let pool: Pool | null = null;
let poolUrl: string | null = null;

export function buildPoolConfig(url: string): PoolConfig {
  const loopback = isLoopbackDatabaseUrl(url);
  return {
    connectionString: url,
    max: POOL_MAX,
    // A desktop app is idle most of the time; holding sockets open against a local server buys nothing and
    // keeps a postgres backend resident per connection.
    idleTimeoutMillis: num("LFB_DB_IDLE_MS", 30_000),
    // Fail fast on `auto`: a machine with nothing on :5432 must reach the YAML fallback in milliseconds, not
    // after the OS connect timeout.
    connectionTimeoutMillis: num("LFB_DB_CONNECT_MS", 3_000),
    application_name: "lfb-web",
    // search_path so unqualified names resolve to our schema; statement_timeout so a pathological query can
    // never become the event-loop stall this whole workstream exists to remove.
    options: `-c search_path=${DB_SCHEMA},public -c statement_timeout=${num("LFB_DB_STATEMENT_TIMEOUT_MS", 15_000)}`,
    // TLS off is correct ONLY on loopback, where the socket never leaves the machine. Anywhere else it is
    // required, and `rejectUnauthorized` stays on.
    ssl: loopback ? undefined : { rejectUnauthorized: true },
  };
}

/**
 * Get (or lazily create) the pool. Returns null when `LFB_DB_MODE=off` or no URL is configured — callers
 * treat null as "use the YAML path", which is the documented `auto` behaviour.
 */
/**
 * WHO TO TELL WHEN THE SERVER GOES AWAY WHILE WE WERE NOT LOOKING.
 *
 * `pg` raises 'error' on the POOL the instant an idle connection dies — `terminating connection due to
 * unexpected postmaster exit` when someone runs `just db-down`, restarts Postgres, or the server crashes.
 * That event is the EARLIEST evidence the database is gone, and until now it was only logged.
 *
 * Why that mattered: `db.ts`'s health latch only learns of a failure when a QUERY fails, and a query fails
 * by waiting out `connectionTimeoutMillis` (3 s). So between the postmaster dying and the first call
 * noticing, every `dbEnabled()` still answered "up" and every call site that trusted it paid a full 3 s
 * before falling back to YAML — concurrently, so a fan-out of them all paid it at once. `error.err`
 * 2026-09-09 shows the shape: `storage.syncFence: timeout exceeded when trying to connect (+16 more
 * suppressed in the last minute)`, seventeen call sites each blocking a request path for 3 s to discover a
 * fact the pool already knew.
 *
 * A callback rather than a direct call because `db.ts` imports THIS file — importing it back would be a
 * cycle. `db.ts` registers `noteDbHealth(false)` at module load.
 */
let onIdleError: ((e: Error) => void) | null = null;

/** Register the health observer for pool-level errors. Called once, by `db.ts`. */
export function setPoolErrorObserver(cb: (e: Error) => void): void {
  onIdleError = cb;
}

export function getPool(): Pool | null {
  if (resolveDbMode() === "off") return null;
  if (pool) return pool;
  const url = resolveDatabaseUrl();
  if (!url) return null;
  pool = new Pool(buildPoolConfig(url));
  poolUrl = url;
  // An idle client erroring (server restart, `just db-down`) must NOT take the process down. `pg` emits this
  // on the POOL, and an unhandled 'error' event on an EventEmitter is a hard crash — which on this app would
  // read to the user as the app dying for no reason while they were not even using it.
  pool.on("error", (e) => {
    log.warn("db", `idle client error (pool stays up): ${(e as Error).message}`);
    // Mark the server down NOW rather than letting the next 17 callers each discover it by timing out.
    try {
      onIdleError?.(e as Error);
    } catch {
      // An observer that throws must never be the reason an idle-client error becomes a crash.
    }
  });
  log.info("db", `pool ready: ${safeUrl(url)} schema=${DB_SCHEMA} max=${POOL_MAX} reserve=${INTERACTIVE_RESERVE}`);
  return pool;
}

/** The URL the live pool was built from, password-stripped. For /api/health and `just db-status`. */
export function activeUrlSafe(): string | null {
  return poolUrl ? safeUrl(poolUrl) : null;
}

/**
 * A background caller's gate: true when taking a connection now would eat into the interactive reserve.
 * Background work checks this and defers rather than competing with a sign-in (see INTERACTIVE_RESERVE).
 */
export function backgroundShouldDefer(): boolean {
  const p = pool;
  if (!p) return false;
  return p.totalCount - p.idleCount >= POOL_MAX - INTERACTIVE_RESERVE;
}

export interface DbProbe {
  reachable: boolean;
  serverVersion: string | null;
  listenAddresses: string | null;
  /** database.mdx §7.1 — false means this machine is offering Postgres beyond loopback. */
  loopbackOnly: boolean;
  error: string | null;
}

/**
 * Probe the server, and ASSERT THE LOOPBACK POSTURE while we are there (database.mdx §7.1).
 *
 * This mirrors the existing `ipfs.public_gateway=false` compliance check, and for the same reason the charter
 * gives for it: we do not want this computer offering a service to anyone but us. A database bound to a
 * routable address on a laptop is the same class of mistake as running a public IPFS gateway, and it is just
 * as invisible until someone finds it.
 */
export async function probeDatabase(): Promise<DbProbe> {
  const p = getPool();
  if (!p) return { reachable: false, serverVersion: null, listenAddresses: null, loopbackOnly: true, error: "no pool" };
  try {
    const r = await p.query<{ v: string; listen: string }>(
      "SELECT version() AS v, current_setting('listen_addresses') AS listen",
    );
    const listen = r.rows[0]?.listen ?? null;
    const loopbackOnly = listenAddressesAreLoopbackOnly(listen);
    if (!loopbackOnly) {
      log.warn(
        "db",
        `COMPLIANCE: postgres listen_addresses='${listen}' — this machine is offering Postgres beyond ` +
          `loopback. database.mdx §7.1 requires localhost-only in local mode. Set listen_addresses='localhost' ` +
          `in postgresql.conf unless you deliberately chose otherwise on this computer.`,
      );
    }
    return { reachable: true, serverVersion: r.rows[0]?.v ?? null, listenAddresses: listen, loopbackOnly, error: null };
  } catch (e) {
    return {
      reachable: false,
      serverVersion: null,
      listenAddresses: null,
      loopbackOnly: true,
      error: (e as Error).message,
    };
  }
}

/**
 * `listen_addresses` is a COMMA-SEPARATED LIST, and `'*'` means every interface. Every element must be a
 * loopback name for the posture to hold — one routable entry in a list of five is still exposure.
 */
export function listenAddressesAreLoopbackOnly(listen: string | null): boolean {
  if (listen === null) return true; // nothing to judge — do not cry wolf
  const parts = listen
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  if (parts.length === 0) return true; // '' means no TCP at all: unix socket only, which is stricter
  return parts.every((h) => h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0:0:0:0:0:0:0:1");
}

/** Close the pool. Idempotent; used by the shutdown hook and by tests. */
export async function closePool(): Promise<void> {
  const p = pool;
  pool = null;
  poolUrl = null;
  if (!p) return;
  try {
    await p.end();
  } catch (e) {
    log.warn("db", `pool close failed: ${(e as Error).message}`);
  }
}
