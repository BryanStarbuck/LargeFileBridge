#!/usr/bin/env node
// The `just db-*` recipes' hands (database.mdx §7.2).
//
// WHY THIS IS A NODE SCRIPT AND NOT SIX BASH RECIPES. Same reason as dev.mjs: the justfile is one file on
// macOS, Linux and Windows, and rule 1 in its header forbids shell built-ins in a recipe body. Every
// decision below — is anything listening on 5432, does the role exist, is the schema ledger populated —
// needs a conditional and a captured command output, neither of which a portable one-liner has.
//
// WHAT IT ASSUMES: `psql` on PATH (or in one of the two Homebrew prefixes), and an ADMIN connection that
// can create a role and a database. On this machine that is Homebrew's `postgresql@16`, whose stock
// pg_hba.conf trusts the local OS user over 127.0.0.1 — so provisioning costs zero configuration. A machine
// where that is not true supplies LFB_DB_ADMIN_URL.
//
// WHAT IT WILL NOT DO:
//   * `db-down` NEVER stops the server. The cluster on :5432 is shared — this machine has fifteen other
//     databases on it — so stopping it to "turn off Large File Bridge" would take four other apps down with
//     it. Down means "disconnect us", and it never touches data.
//   * Nothing but `db-reset` drops anything, and `db-reset` refuses without CONFIRM=yes.
//
// Usage: node scripts/dev/db.mjs <up|down|reset|psql|status|migrate-hint> [CONFIRM=yes]
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { bePort } from "./paths.mjs";
import { haveTool, isListening, runTool, runToolCaptured } from "./proc.mjs";

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

// ── the two connection strings ──────────────────────────────────────────────────────────────────────

/**
 * The APP url. Kept in lockstep with the backend's own resolver — `shared/persistence/pool.ts`
 * `resolveDatabaseUrl()` / `LOCAL_DEV_DATABASE_URL` — by hand, because this file has to stay
 * dependency-free: the justfile runs it with bare `node`, before `pnpm install` has necessarily ever run.
 * The same constraint paths.mjs lives under.
 */
export const LOCAL_DEV_DATABASE_URL = "postgresql://lfb:lfb@localhost:5432/largefilebridge";

function appUrl() {
  const file = process.env.LFB_DATABASE_URL_FILE?.trim();
  if (file) {
    try {
      const u = fs.readFileSync(file, "utf8").trim();
      if (u) return u;
    } catch {
      err(`LFB_DATABASE_URL_FILE unreadable (${file}) — falling back to the local development default.`);
    }
  }
  return process.env.DATABASE_URL?.trim() || LOCAL_DEV_DATABASE_URL;
}

/**
 * The ADMIN url: same server, the `postgres` maintenance database, as the current OS user. That is the
 * connection Homebrew hands the person who ran `brew install postgresql@16`, and it is a superuser there.
 */
function adminUrl(target) {
  const explicit = process.env.LFB_DB_ADMIN_URL?.trim();
  const u = new URL(explicit || `postgresql://${encodeURIComponent(os.userInfo().username)}@localhost:5432/postgres`);
  if (target) u.pathname = `/${target}`;
  return u.toString();
}

/** The ONLY form of a connection string allowed to reach a terminal or a log — it carries the password. */
function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable database url>";
  }
}

function parts(url) {
  const u = new URL(url);
  return {
    host: u.hostname || "localhost",
    port: Number(u.port) || 5432,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    user: decodeURIComponent(u.username) || "lfb",
    password: decodeURIComponent(u.password) || "",
  };
}

/** The app's schema name, kept in lockstep with pool.ts `DB_SCHEMA`. */
const schema = (process.env.LFB_DB_SCHEMA ?? "lfb").trim() || "lfb";

// ── psql ────────────────────────────────────────────────────────────────────────────────────────────

/** PATH first; then the two prefixes Homebrew uses, because a keg-only postgresql@16 is NOT on PATH. */
function psqlBin() {
  if (haveTool("psql")) return "psql";
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    for (const keg of ["postgresql@17", "postgresql@16", "postgresql"]) {
      const p = path.join(prefix, keg, "bin", "psql");
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function requirePsql() {
  const bin = psqlBin();
  if (bin) return bin;
  err("psql not found. Install the PostgreSQL client:");
  err("  macOS   brew install postgresql@16 && brew services start postgresql@16");
  err("  Linux   sudo apt install postgresql-16   (or your distro's package)");
  err("  Windows https://www.postgresql.org/download/windows/");
  process.exit(2);
}

/**
 * Run SQL and CAPTURE the answer. `-X` ignores the user's ~/.psqlrc (a personal `\timing` or `\pset` would
 * otherwise corrupt every value we parse), `-tA` gives unaligned rows with no header, and ON_ERROR_STOP
 * makes a failing statement a non-zero exit instead of a warning nobody reads.
 */
async function sql(url, statement, { quiet = true } = {}) {
  const bin = requirePsql();
  const args = ["-X", "-v", "ON_ERROR_STOP=1", "-tAq", "-d", url, "-c", statement];
  const r = await runToolCaptured(bin, args, { env: { ...process.env, PGCONNECT_TIMEOUT: "5" } });
  if (r.code !== 0 && !quiet) err(r.output.trim());
  return { ok: r.code === 0, code: r.code, text: r.output.trim() };
}

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Terminate every backend attached to ONE database, and return how many.
 *
 * THE `OFFSET 0` IS LOAD-BEARING AND IT IS NOT A STYLE CHOICE. The obvious spelling —
 *
 *     SELECT count(*) FROM pg_stat_activity
 *      WHERE datname = 'largefilebridge' AND pid <> pg_backend_pid() AND pg_terminate_backend(pid)
 *
 * — puts a VOLATILE, side-effecting function in a WHERE clause beside the predicates that are supposed to
 * restrict it, and SQL guarantees no evaluation order between them. Measured here on 16.15, against a
 * database with ZERO connections: it killed this session's own psql AND both idle pool connections
 * belonging to an unrelated app (`wethecitizens`) on the same shared server. The predicate that was meant
 * to scope the blast radius ran after the thing it was scoping.
 *
 * Wrapping the filter in a subquery with `OFFSET 0` is Postgres's documented optimization fence: it blocks
 * subquery pull-up, so the row set is fully restricted to this one database BEFORE `pg_terminate_backend`
 * ever sees a pid. This machine runs fifteen databases on the one server; `just db-down` is not allowed to
 * reach past its own.
 */
function terminateSql(database) {
  return (
    `SELECT count(pg_terminate_backend(pid)) FROM (` +
    `SELECT pid FROM pg_stat_activity WHERE datname = ${literal(database)} AND pid <> pg_backend_pid() OFFSET 0` +
    `) victims`
  );
}

// ── up ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Provision role + database + extensions. IDEMPOTENT: every step checks first, so running it on a machine
 * that is already provisioned changes nothing and still prints the URL.
 *
 * The EXTENSIONS are created here as the admin even though migration 0001 also creates them
 * (`CREATE EXTENSION IF NOT EXISTS … WITH SCHEMA {{S}}`). Doing it here means the migration's copy is a
 * no-op, and it removes the app role's dependence on pg_trgm and citext being *trusted* extensions —
 * they are on 16, but that is a property of the server build, not something a provisioning step should bet
 * a first-run experience on.
 */
async function cmdUp() {
  const url = appUrl();
  const p = parts(url);
  if (!(await ensureServer(p))) process.exit(1);

  const admin = adminUrl();
  const roleExists = await sql(admin, `SELECT 1 FROM pg_roles WHERE rolname = ${literal(p.user)}`);
  if (!roleExists.ok) {
    err(`Cannot reach the server as an administrator (${safeUrl(admin)}).`);
    err(roleExists.text || "(no output)");
    err("Set LFB_DB_ADMIN_URL to a connection that can CREATE ROLE / CREATE DATABASE and retry.");
    process.exit(1);
  }
  if (roleExists.text === "1") {
    out(`role ${p.user}: already exists (left untouched)`);
  } else {
    const r = await sql(admin, `CREATE ROLE ${ident(p.user)} LOGIN PASSWORD ${literal(p.password)}`, { quiet: false });
    if (!r.ok) process.exit(1);
    out(`role ${p.user}: created`);
  }

  const dbExists = await sql(admin, `SELECT 1 FROM pg_database WHERE datname = ${literal(p.database)}`);
  if (dbExists.text === "1") {
    out(`database ${p.database}: already exists (left untouched)`);
  } else {
    // CREATE DATABASE cannot run inside a transaction block, which is why it is its own single-statement
    // invocation rather than part of the batch below.
    const r = await sql(admin, `CREATE DATABASE ${ident(p.database)} OWNER ${ident(p.user)}`, { quiet: false });
    if (!r.ok) process.exit(1);
    out(`database ${p.database}: created (owner ${p.user})`);
  }

  const inDb = adminUrl(p.database);
  const setup = [
    `GRANT ALL ON DATABASE ${ident(p.database)} TO ${ident(p.user)};`,
    `CREATE SCHEMA IF NOT EXISTS ${ident(schema)} AUTHORIZATION ${ident(p.user)};`,
    `GRANT ALL ON SCHEMA ${ident(schema)} TO ${ident(p.user)};`,
    `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA ${ident(schema)};`,
    `CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA ${ident(schema)};`,
  ].join("\n");
  const r = await sql(inDb, setup, { quiet: false });
  if (!r.ok) process.exit(1);
  out(`schema ${schema}: ready, with pg_trgm + citext`);

  // Prove it end to end AS THE APP, not as the admin. "The admin could create it" and "the app can connect
  // to it" are different claims, and only the second one is what `just run` needs.
  const asApp = await sql(url, "SELECT 1");
  if (!asApp.ok) {
    err("");
    err(`Provisioned, but connecting AS THE APP failed: ${safeUrl(url)}`);
    err(asApp.text || "(no output)");
    err(`If the role pre-existed with a different password, reset it:`);
    err(`  psql -d postgres -c 'ALTER ROLE ${ident(p.user)} WITH LOGIN PASSWORD ${literal("<the one in your URL>")}'`);
    process.exit(1);
  }

  out("");
  out(`Large File Bridge database ready: ${safeUrl(url)}`);
  out(`  next: just db-migrate    (apply the schema)   ·   just db-status    ·   just db-psql`);
}

/** Is anything answering on the port at all? The first of the three states `db-status` reports. */
async function ensureServer(p) {
  if (await isListening(p.port, p.host === "localhost" ? "127.0.0.1" : p.host)) return true;
  err(`Nothing is listening on ${p.host}:${p.port}.`);
  err("  macOS   brew services start postgresql@16");
  err("  Linux   sudo systemctl start postgresql");
  err("Large File Bridge runs fine without it (LFB_DB_MODE=auto falls back to the YAML path).");
  return false;
}

// ── down ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Stop USING the database. It does not stop the server and it does not drop a byte.
 *
 * Two deliberate non-actions. The server is shared with every other Postgres app on this machine, so
 * stopping it is not ours to do; and "down" in every other `just` recipe means "our process stops", which
 * for a database means our connections go away, not our data.
 */
async function cmdDown() {
  const url = appUrl();
  const p = parts(url);
  if (!(await isListening(p.port, p.host === "localhost" ? "127.0.0.1" : p.host))) {
    out(`Nothing listening on ${p.host}:${p.port} — nothing to disconnect.`);
    return;
  }
  const r = await sql(adminUrl(), terminateSql(p.database));
  if (!r.ok) {
    err(`Could not disconnect: ${r.text || "(no output)"}`);
    process.exit(1);
  }
  out(`Disconnected ${r.text || 0} connection(s) from ${p.database}. No data was touched.`);
  out("The server itself is left running — it is shared with every other Postgres app on this machine.");
  out("To make the app stop using Postgres entirely, run it with LFB_DB_MODE=off.");
}

// ── reset ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * DROP the database and rebuild it empty. This DESTROYS every row Large File Bridge has in Postgres.
 *
 * It is survivable — the whole storage design keeps YAML as the authoritative copy for the travelling half
 * and treats the Postgres half as rebuildable-by-rescanning (database.mdx §1.3) — but it throws away hours
 * of backfill, so it refuses without an explicit confirmation. The `boot mode="status"` recipe is the
 * justfile's existing idiom for a positional argument, and this follows it.
 */
async function cmdReset(args) {
  if (!args.includes("CONFIRM=yes")) {
    err("db-reset DROPS the largefilebridge database — every row Large File Bridge has in Postgres.");
    err("It is rebuildable (the YAML on disk stays authoritative), but the backfill would have to run again.");
    err("");
    err("  just db-reset CONFIRM=yes");
    process.exit(2);
  }
  const url = appUrl();
  const p = parts(url);
  if (!(await ensureServer(p))) process.exit(1);
  await sql(adminUrl(), terminateSql(p.database));
  const dropped = await sql(adminUrl(), `DROP DATABASE IF EXISTS ${ident(p.database)}`, { quiet: false });
  if (!dropped.ok) process.exit(1);
  out(`database ${p.database}: DROPPED`);
  await cmdUp();
}

// ── psql ────────────────────────────────────────────────────────────────────────────────────────────

/** An interactive prompt against the app database, with the app's own search_path already set. */
async function cmdPsql(args) {
  const url = appUrl();
  const bin = requirePsql();
  out(`${safeUrl(url)}  (search_path=${schema},public)`);
  // PGOPTIONS, not a `-c "SET search_path…"`: `-c` makes psql run one statement and EXIT, so the prompt
  // would never appear. PGOPTIONS sets it on the connection itself, which is the identical mechanism the
  // pool uses (pool.ts `buildPoolConfig`, `options: -c search_path=…`) — so an interactive session and the
  // app resolve unqualified names the same way, which is the whole point of the recipe.
  const code = await runTool(bin, ["-X", "-d", url, ...args], {
    env: { ...process.env, PGOPTIONS: `-c search_path=${schema},public` },
  });
  process.exit(code);
}

// ── status ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The three states database.mdx §7.2 names, in order of how far along the machine is:
 *
 *   1. nothing on :5432               — no server. The app runs on YAML; this is not a fault.
 *   2. listening but unprovisioned    — a server is there, but the role/database/schema is not. `just db-up`.
 *   3. provisioned, N migrations      — ready. N is the row count of the schema ledger.
 *
 * It ALSO asks the running backend for its own view first, because the live process is the only thing that
 * knows which mode it resolved and whether its pool actually connected — a psql probe can say the database
 * is fine while the app is on the YAML path because LFB_DB_MODE=off.
 */
async function cmdStatus() {
  const url = appUrl();
  const p = parts(url);
  out(`url            ${safeUrl(url)}`);
  out(`schema         ${schema}`);
  out(`mode           LFB_DB_MODE=${process.env.LFB_DB_MODE || "auto (default)"}`);

  if (!(await isListening(p.port, p.host === "localhost" ? "127.0.0.1" : p.host))) {
    out("");
    out(`STATE          nothing listening on ${p.host}:${p.port}`);
    out("               Large File Bridge is running on the YAML path (LFB_DB_MODE=auto). Not a fault.");
    out("               brew services start postgresql@16   then   just db-up");
    await reportLiveBackend();
    return;
  }

  const admin = adminUrl();
  const reach = await sql(admin, "SELECT current_setting('server_version'), current_setting('listen_addresses')");
  if (reach.ok) {
    const [version, listen] = reach.text.split("|");
    out(`server         PostgreSQL ${version}   listen_addresses=${listen}`);
    // The charter's no-public-relay posture, applied to Postgres (database.mdx §7.1). Same class of mistake
    // as running a public IPFS gateway, and just as invisible until somebody finds it.
    const loopbackOnly = (listen || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .every((h) => ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(h));
    if (!loopbackOnly) {
      out(`COMPLIANCE     listen_addresses='${listen}' is NOT loopback-only — see database.mdx §7.1`);
    }
  }

  const roleRow = await sql(admin, `SELECT 1 FROM pg_roles WHERE rolname = ${literal(p.user)}`);
  const dbRow = await sql(admin, `SELECT 1 FROM pg_database WHERE datname = ${literal(p.database)}`);
  if (roleRow.text !== "1" || dbRow.text !== "1") {
    out("");
    out(`STATE          listening on ${p.host}:${p.port}, but UNPROVISIONED`);
    out(`               role ${p.user}: ${roleRow.text === "1" ? "present" : "MISSING"}` +
      `   ·   database ${p.database}: ${dbRow.text === "1" ? "present" : "MISSING"}`);
    out("               just db-up");
    await reportLiveBackend();
    return;
  }

  const ledger = await sql(
    url,
    `SELECT count(*), coalesce(max(id), 0) FROM ${ident(schema)}.schema_migration`,
  );
  if (!ledger.ok) {
    out("");
    out(`STATE          provisioned, but the schema ledger is not there yet — 0 migrations applied`);
    out("               just db-migrate");
    await reportLiveBackend();
    return;
  }
  const [applied, head] = ledger.text.split("|");
  out("");
  out(`STATE          PROVISIONED — ${applied} migration(s) applied, ledger head ${head}`);
  await reportLiveBackend();
}

/**
 * What the RUNNING backend says, from /api/health/database. Best-effort by design: the app not running is
 * the normal case for someone provisioning a database, and it must not read as a failure.
 */
async function reportLiveBackend() {
  let body;
  try {
    const res = await fetch(`http://127.0.0.1:${bePort()}/api/health/database`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json())?.data;
  } catch {
    out("");
    out(`backend        not running on :${bePort()} — the report above is a direct probe`);
    return;
  }
  if (!body) return;
  const m = body.migrationLedger || {};
  out("");
  out(`backend        running on :${bePort()} — its own view:`);
  out(`  mode         ${body.mode}   reachable=${body.reachable}   loopbackOnly=${body.loopbackOnly}`);
  out(`  schema       head ${body.schemaLedgerHead}, ${body.schemaMigrationsApplied ?? 0} applied`);
  out(`  ledger       ${m.entries ?? 0} entries — ${m.done ?? 0} done, ${m.pending ?? 0} pending, ${m.failed ?? 0} failed`);
  // The boot line is a HISTORICAL fact — it is what the last boot concluded, not what is true now — so it
  // always carries its timestamp. Without one, `reachable=true` sitting next to a boot error reads as a
  // contradiction rather than as "we provisioned the database after that process started".
  if (body.bootError) out(`  last boot    ${body.bootedAt ?? "?"} FAILED: ${body.bootError} (restart to retry)`);
  else if (body.bootedAt) out(`  last boot    ${body.bootedAt} ok`);
}

// ── dispatch ────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "up":
      return cmdUp();
    case "down":
      return cmdDown();
    case "reset":
      return cmdReset(rest);
    case "psql":
      return cmdPsql(rest);
    case "status":
      return cmdStatus();
    default:
      err(`db.mjs: unknown command "${cmd ?? ""}"`);
      err("Usage: node scripts/dev/db.mjs <up|down|reset|psql|status>");
      process.exitCode = 2;
  }
}

await main();
