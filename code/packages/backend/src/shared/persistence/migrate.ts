// THE SCHEMA MIGRATION RUNNER (database_migration.mdx §3). Forward-only, checksummed, one BEGIN..COMMIT
// each, under an advisory lock so two processes starting together cannot both apply migration N.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { DB_SCHEMA } from "./pool.js";
import { log } from "../logging.js";

/** One lock id for the whole app. Arbitrary but FIXED — changing it defeats the lock. */
const ADVISORY_LOCK_ID = 2306411;

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * THE CHECKSUM COVERS NAME + SQL, AND DELIBERATELY NOT THE ID.
 *
 * Inherited straight from the sister app's 2026-08-18 incident. Two branches each authored a migration as
 * id 11; the merge kept both and renumbered one — the obvious, correct-looking resolution. Because the hash
 * included the id, every install that had ALREADY applied the renumbered migration now had a ledger row that
 * disagreed with the code, and the runner reported the one thing that had definitely not happened:
 * "migration 11 was edited after it was applied". Nothing was edited. The bytes of the SQL were identical;
 * only its position in the list had moved.
 *
 * A migration's IDENTITY is its NAME; its id is only where it sits in the order. Hashing the id conflated
 * the two and made a legal merge resolution look like tampering.
 */
export function checksum(m: Pick<Migration, "name" | "sql">): string {
  return createHash("sha256").update(`${m.name}:${m.sql}`).digest("hex").slice(0, 32);
}

function render(sql: string): string {
  return sql.replace(/\{\{S\}\}/g, DB_SCHEMA);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load `NNNN_name.sql` from ./migrations, ordered by the numeric prefix.
 *
 * Files on disk rather than a TypeScript array so the SQL stays reviewable as SQL, and so `just db-psql` can
 * be pointed at the same bytes the runner applies.
 */
export function loadMigrations(dir = path.join(HERE, "migrations")): Migration[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
  } catch (e) {
    log.error("db", `no migrations directory at ${dir}: ${(e as Error).message}`);
    return [];
  }
  const out: Migration[] = [];
  for (const f of names) {
    const m = /^(\d{4})_(.+)\.sql$/.exec(f);
    if (!m) {
      log.warn("db", `ignoring non-migration file in migrations/: ${f}`);
      continue;
    }
    out.push({ id: Number(m[1]), name: m[2], sql: fs.readFileSync(path.join(dir, f), "utf8") });
  }
  out.sort((a, b) => a.id - b.id);
  // Two files with the same numeric prefix is exactly the merge accident the checksum rule above is about.
  // It is legal for the NAMES to be stable and the ids to collide, but the runner needs a total order, so
  // say so loudly rather than picking one arbitrarily.
  for (let i = 1; i < out.length; i++) {
    if (out[i].id === out[i - 1].id) {
      log.warn("db", `migrations ${out[i - 1].id}_${out[i - 1].name} and ${out[i].id}_${out[i].name} share an id`);
    }
  }
  return out;
}

const LEDGER_DDL = `
CREATE SCHEMA IF NOT EXISTS {{S}};
CREATE TABLE IF NOT EXISTS {{S}}.schema_migration (
  id          int  NOT NULL,
  name        text NOT NULL PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms int  NOT NULL DEFAULT 0
);`;

export interface MigrateResult {
  applied: number;
  head: number;
  alreadyApplied: number;
}

/**
 * Apply every pending migration. Returns how many ran.
 *
 * A checksum mismatch on an ALREADY-APPLIED migration is a HARD FAILURE: the schema is not what the code
 * believes it is, and continuing would run queries against a shape nobody has verified.
 */
export async function runSchemaMigrations(pool: Pool, dir?: string): Promise<MigrateResult> {
  const migrations = loadMigrations(dir);
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query(render(LEDGER_DDL));
    // Session-level lock, released explicitly in `finally`. A deploy rolls replicas that all boot at once;
    // this is what stops two of them applying migration N together.
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    locked = true;

    const { rows } = await client.query<{ id: number; name: string; checksum: string }>(
      `SELECT id, name, checksum FROM ${DB_SCHEMA}.schema_migration`,
    );
    const applied = new Map(rows.map((r) => [r.name, r]));

    let count = 0;
    for (const m of migrations) {
      const prior = applied.get(m.name);
      const sum = checksum(m);
      if (prior) {
        if (prior.checksum !== sum) {
          throw new Error(
            `migration '${m.name}' was EDITED after it was applied (checksum ${prior.checksum} != ${sum}). ` +
              `The database schema is not what this build expects. Refusing to continue.`,
          );
        }
        // The id moving is legal (a merge renumbered it) and is NOT tampering — heal the bookkeeping and
        // say so, rather than reporting an edit that did not happen.
        if (prior.id !== m.id) {
          await client.query(`UPDATE ${DB_SCHEMA}.schema_migration SET id = $1 WHERE name = $2`, [m.id, m.name]);
          log.info("db", `migration '${m.name}' renumbered ${prior.id} -> ${m.id}; ledger healed (SQL unchanged)`);
        }
        continue;
      }
      const started = Date.now();
      await applyOne(client, m, sum);
      count += 1;
      log.info("db", `applied migration ${String(m.id).padStart(4, "0")}_${m.name} in ${Date.now() - started}ms`);
    }
    const head = migrations.length ? migrations[migrations.length - 1].id : 0;
    return { applied: count, head, alreadyApplied: applied.size };
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
      } catch (e) {
        log.warn("db", `advisory unlock failed: ${(e as Error).message}`);
      }
    }
    client.release();
  }
}

async function applyOne(client: PoolClient, m: Migration, sum: string): Promise<void> {
  const started = Date.now();
  await client.query("BEGIN");
  try {
    await client.query(render(m.sql));
    await client.query(
      `INSERT INTO ${DB_SCHEMA}.schema_migration (id, name, checksum, duration_ms) VALUES ($1,$2,$3,$4)`,
      [m.id, m.name, sum, Date.now() - started],
    );
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection may already be unusable; the throw below is the real signal */
    }
    // Name the migration in the rethrow: a bare pg error in error.err does not say which of fifteen failed.
    throw new Error(`migration ${String(m.id).padStart(4, "0")}_${m.name} failed: ${(e as Error).message}`);
  }
}

/**
 * The cluster + database identity that gates every backfill (database_migration.mdx §2.2). If this changes,
 * the database was dropped and recreated, and a `done` backfill is not done.
 */
export async function readPgEpoch(pool: Pool): Promise<string | null> {
  try {
    const r = await pool.query<{ sid: string; oid: string }>(
      "SELECT system_identifier::text AS sid, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid FROM pg_control_system()",
    );
    const row = r.rows[0];
    return row ? `${row.sid}:${row.oid}` : null;
  } catch (e) {
    log.warn("db", `could not read pg epoch: ${(e as Error).message}`);
    return null;
  }
}

export async function ledgerHead(pool: Pool): Promise<number> {
  try {
    const r = await pool.query<{ head: number | null }>(
      `SELECT max(id) AS head FROM ${DB_SCHEMA}.schema_migration`,
    );
    return r.rows[0]?.head ?? 0;
  } catch {
    return 0;
  }
}
