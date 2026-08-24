// BOOTING THE DATABASE — the stage that sits between `bootstrapState()` and the first request
// (database_migration.mdx §6, database.mdx §7).
//
// The order is fixed and each step depends on the one above it:
//
//     connectPool()          → getPool(), which is lazy and returns null under LFB_DB_MODE=off
//     probeDatabase()        → reachability AND the §7.1 loopback compliance assertion
//     runSchemaMigrations()  → advisory-locked, forward-only, checksummed (migrate.ts)
//     readPgEpoch()          → the cluster+database identity that gates every backfill (§2.2)
//     loadMigrationState()   → the local YAML ledger, loaded WITH that epoch so a dropped-and-recreated
//                              database cannot look full
//     adoptSentinel() × 5    → the legacy state-root sentinels become ledger entries, files KEPT
//
// THE CONTRACT THIS FILE HAS TO KEEP, and the reason almost every line below is inside a try:
//
//   * Under `auto` — the default, and the charter's "runs locally first" posture — this whole stage is
//     BEST-EFFORT. A machine with no Postgres installed must still serve every page. That is the same
//     promise the seven existing boot migrations already make ("any failure is logged and swallowed so a
//     broken migration can never crash boot", main.ts), and a database is not allowed to be the first
//     thing in the boot path that breaks it.
//   * Under `required` — server mode — a failure IS a hard boot failure, by design (database.mdx §7):
//     silently serving stale YAML to several logged-in people is worse than not starting.
//
// THE LEDGER STEP RUNS EVEN WITH NO POSTGRES AT ALL. Four of the five sentinels below are pure on-disk
// repairs (database_migration.mdx §1) — their authority has to be a local file precisely because they must
// latch correctly on a machine where Postgres was never installed. So an unreachable server skips the SQL
// stages and still adopts them.
import { performance } from "node:perf_hooks";
import {
  adoptSentinel,
  loadMigrationState,
  saveMigrationState,
  type MigrationKind,
  type MigrationState,
} from "../../config/migration-state.js";
import { blocking, recordCooperative } from "../blocking.js";
import { log } from "../logging.js";
import { ledgerHead, readPgEpoch, runSchemaMigrations, type MigrateResult } from "./migrate.js";
import { activeUrlSafe, getPool, probeDatabase, resolveDbMode, type DbMode, type DbProbe } from "./pool.js";

/**
 * THE VERSION OF THE ADOPTION LOGIC, not of the migrations it adopts.
 *
 * `adoptSentinel` stamps this as both `version` and `applied_version`, and `shouldRun()` re-arms an entry
 * when `applied_version < version`. Bumping it therefore re-reads every sentinel — which is what you want
 * if the adoption mapping itself is ever found to be wrong, and is NOT what you want for any other reason.
 */
const ADOPT_VERSION = 1;

/**
 * The five state-root sentinels, adopted into the ledger and LEFT IN PLACE (database_migration.mdx §1.1).
 *
 * Deleting them is the tempting cleanup and it is the dangerous one: `migrate-sync-repo-default.ts:11-15`
 * makes its once-only run its ENTIRE safety argument and gates on a bare `fs.existsSync`, so with the file
 * gone this ledger would be the only thing standing between a user's mirror opt-out and 105 repos silently
 * re-enabling on the first rollback to a pre-ledger build. `.sync-repo-default-migrated` is permanently
 * exempt from deletion; the other four cost ~2.7 KB between them and are kept for the same reason.
 *
 * The names are the ledger KEYS and are stable forever — the ledger keys on name, never on order, exactly
 * as the schema ledger does (migrate.ts `checksum`).
 */
export const LEGACY_SENTINELS: ReadonlyArray<{ name: string; file: string; kind: MigrationKind }> = [
  { name: "sync_to_pin", file: ".sync-to-pin-migrated", kind: "local" },
  { name: "sync_repo_default", file: ".sync-repo-default-migrated", kind: "local" },
  // A SWEEP, not a local repair, and this is the one classification that is easy to get wrong. A peer can
  // push the legacy empty `sync_repo:` block back at any time, so "done" is never true for it — what IS
  // true is "last swept, and last time it actually found something" (database_migration.mdx §2.3).
  { name: "repair_sync_repo_blocks", file: ".sync-repo-empty-block-repaired", kind: "sweep" },
  { name: "posix_paths", file: ".posix-paths-repaired", kind: "local" },
  { name: "repo_dir_names", file: ".repo-dir-names-migrated", kind: "local" },
];

export interface DatabaseBootReport {
  mode: DbMode;
  ranAt: string;
  /** Password-stripped, always. Nothing in this subsystem may log or serve a raw connection string. */
  url: string | null;
  probe: DbProbe;
  schema: MigrateResult | null;
  pgEpoch: string | null;
  /** The sentinel names newly adopted by THIS boot (empty on every boot after the first). */
  adopted: string[];
  /** Non-null when the Postgres stages failed and `auto` swallowed it — the reason the app is on YAML. */
  error: string | null;
}

const UNREACHABLE: DbProbe = {
  reachable: false,
  serverVersion: null,
  listenAddresses: null,
  loopbackOnly: true,
  error: null,
};

let last: DatabaseBootReport | null = null;

/** What the last `bootDatabase()` concluded. Read by /api/health so the answer is the boot's, not a guess. */
export function lastDatabaseBoot(): DatabaseBootReport | null {
  return last;
}

/**
 * Run the whole stage. Never throws under `auto`; always throws under `required`.
 *
 * TIMING. The neighbours in main.ts are wrapped in `blocking()` (synchronous) or hand-timed into
 * `recordBlocking()` (the async decisions-ledger migration), so the boot window is fully attributed and the
 * stall report can name a culprit instead of a symptom (blocking.ts). This stage is split between the two
 * recorders on purpose:
 *
 *   * the awaited Postgres stages go to `recordCooperative`, which ranks their wall time in the window but
 *     NEVER warns — an `await` on a loopback round trip hands the event loop back, so calling it "held the
 *     event loop for 900ms" would be false, and teaching a reader to discount that WARN would cost us the
 *     ones that mean something;
 *   * the ledger read/adopt/write is genuinely synchronous fs work and goes through `blocking()`, where a
 *     WARN would be true and worth having.
 */
export async function bootDatabase(): Promise<DatabaseBootReport> {
  const mode = resolveDbMode();
  const report: DatabaseBootReport = {
    mode,
    ranAt: new Date().toISOString(),
    url: null,
    probe: UNREACHABLE,
    schema: null,
    pgEpoch: null,
    adopted: [],
    error: null,
  };

  try {
    await connectAndMigrate(report);
  } catch (e) {
    report.error = (e as Error).message;
    if (mode === "required") {
      // No swallow here, and no fallback: `required` is the mode whose whole meaning is "an unusable
      // database is a hard boot failure" (database.mdx §7). Rethrow with the mode named so the fatal line
      // in error.err says WHY the boot refused rather than just what the query error was.
      last = report;
      throw new Error(`LFB_DB_MODE=required and the database is unusable: ${report.error}`);
    }
    log.warn(
      "db",
      `Postgres is unavailable (${report.error}) — Large File Bridge is running on the YAML path. This is ` +
        `the documented LFB_DB_MODE=auto fallback, not a fault; run \`just db-up\` to provision one.`,
    );
  }

  // Deliberately OUTSIDE the block above: the four `local` sentinels never needed Postgres, and a machine
  // that has never installed it must still get a correct ledger.
  try {
    blocking("boot.db.ledger", () => adoptLedger(report));
  } catch (e) {
    report.error ??= (e as Error).message;
    if (mode === "required") {
      last = report;
      throw new Error(`LFB_DB_MODE=required and the migration ledger is unusable: ${(e as Error).message}`);
    }
    log.warn("db", `migration ledger update skipped: ${(e as Error).message}`);
  }

  last = report;
  return report;
}

async function connectAndMigrate(report: DatabaseBootReport): Promise<void> {
  if (report.mode === "off") {
    log.info("db", "LFB_DB_MODE=off — not connecting. Large File Bridge is running on the YAML path.");
    return;
  }

  // Lazily constructs the pool (and logs `pool ready` with a password-stripped URL). Null means "no URL
  // configured", which under `auto` is indistinguishable from "no database" and is treated the same.
  const t0 = performance.now();
  const pool = getPool();
  report.url = activeUrlSafe();
  if (!pool) {
    recordCooperative("boot.db.connect", performance.now() - t0);
    throw new Error("no database URL configured (LFB_DATABASE_URL_FILE / DATABASE_URL)");
  }

  // The probe is also the COMPLIANCE ASSERTION (database.mdx §7.1): the charter forbids this machine
  // offering a service to anyone but us, and a Postgres bound to a routable address on a laptop is the same
  // class of mistake as running a public IPFS gateway — just as invisible until someone finds it.
  report.probe = await probeDatabase();
  recordCooperative("boot.db.connect", performance.now() - t0);
  if (!report.probe.reachable) throw new Error(report.probe.error ?? "not reachable");

  const t1 = performance.now();
  report.schema = await runSchemaMigrations(pool);
  recordCooperative("boot.db.schema-migrate", performance.now() - t1);
  log.info(
    "db",
    `schema up to date: head=${report.schema.head}, applied ${report.schema.applied} now, ` +
      `${report.schema.alreadyApplied} already there (${report.url})`,
  );

  // Read AFTER the migrations, so the epoch we stamp belongs to the database the schema now describes.
  report.pgEpoch = await readPgEpoch(pool);
}

/**
 * Load the ledger with the live epoch, adopt the five sentinels, and save.
 *
 * `loadMigrationState(epoch)` is where the epoch gate lives — inside the loader and never at a call site,
 * so a dropped-and-recreated database cannot look full to a caller that forgot to check
 * (database_migration.mdx §2.2). Passing `null` (no database, or `off`) demotes nothing, because "we cannot
 * see the database" is not evidence that a backfill did not happen.
 */
function adoptLedger(report: DatabaseBootReport): void {
  const state: MigrationState = loadMigrationState(report.pgEpoch);
  for (const s of LEGACY_SENTINELS) {
    if (adoptSentinel(state, s.name, s.file, ADOPT_VERSION, s.kind)) report.adopted.push(s.name);
  }
  if (report.pgEpoch) state.engine.pg_epoch = report.pgEpoch;
  if (report.schema) state.engine.schema_ledger_head = report.schema.head;
  saveMigrationState(state);
  if (report.adopted.length) {
    log.info("db", `adopted ${report.adopted.length} legacy sentinel(s): ${report.adopted.join(", ")} (files kept)`);
  }
}

// ── health ──────────────────────────────────────────────────────────────────────────────────────────

/** How the ledger's entries currently stand. `just db-status` and /api/health both read exactly this. */
export interface MigrationLedgerSummary {
  entries: number;
  done: number;
  pending: number;
  failed: number;
  skipped: number;
  running: number;
  superseded: number;
  updatedAt: string | null;
  pgEpoch: string | null;
  schemaLedgerHead: number;
  /** Set when the ledger file could not be read at all — an unreadable ledger is not an empty one. */
  error: string | null;
}

export interface DatabaseHealth {
  mode: DbMode;
  /** Password-stripped (pool.ts `safeUrl`). The raw connection string never leaves this process. */
  url: string | null;
  reachable: boolean;
  serverVersion: string | null;
  listenAddresses: string | null;
  /** database.mdx §7.1 — false means this machine is offering Postgres beyond loopback. */
  loopbackOnly: boolean;
  error: string | null;
  /** max(id) in `lfb.schema_migration`, and how many rows it holds. */
  schemaLedgerHead: number;
  schemaMigrationsApplied: number | null;
  bootedAt: string | null;
  bootError: string | null;
  migrationLedger: MigrationLedgerSummary;
}

/**
 * The database section of /api/health — and the answer `just db-status` prefers when the backend is up,
 * because it is the LIVE process's own view rather than a second opinion assembled by a shell script.
 *
 * The probe is re-run rather than replayed from `lastDatabaseBoot()`: "was it reachable when we booted six
 * hours ago" is not the question anybody asks a health endpoint.
 */
export async function databaseHealth(): Promise<DatabaseHealth> {
  const boot = lastDatabaseBoot();
  const mode = resolveDbMode();
  const probe = mode === "off" ? UNREACHABLE : await probeDatabase();
  let schemaLedgerHead = 0;
  let schemaMigrationsApplied: number | null = null;
  const pool = mode === "off" ? null : getPool();
  if (pool && probe.reachable) {
    schemaLedgerHead = await ledgerHead(pool);
    schemaMigrationsApplied = await appliedCount(pool);
  }
  return {
    mode,
    url: activeUrlSafe(),
    reachable: probe.reachable,
    serverVersion: probe.serverVersion,
    listenAddresses: probe.listenAddresses,
    loopbackOnly: probe.loopbackOnly,
    error: probe.error,
    schemaLedgerHead,
    schemaMigrationsApplied,
    bootedAt: boot?.ranAt ?? null,
    bootError: boot?.error ?? null,
    migrationLedger: summarizeLedger(),
  };
}

async function appliedCount(pool: NonNullable<ReturnType<typeof getPool>>): Promise<number | null> {
  try {
    const r = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM schema_migration");
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    // The ledger table not existing is the "listening but unprovisioned" state, not an error worth a log
    // line on every health poll.
    return null;
  }
}

/**
 * Fold the ledger to counts.
 *
 * The live epoch is deliberately NOT passed to `loadMigrationState` here: the gate REWRITES entries it
 * demotes, and a read-only health call must not have a side effect on what the next boot believes.
 */
export function summarizeLedger(): MigrationLedgerSummary {
  const empty: MigrationLedgerSummary = {
    entries: 0,
    done: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    superseded: 0,
    updatedAt: null,
    pgEpoch: null,
    schemaLedgerHead: 0,
    error: null,
  };
  let state: MigrationState;
  try {
    state = loadMigrationState(null);
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  }
  const out: MigrationLedgerSummary = {
    ...empty,
    updatedAt: state.updated_at,
    pgEpoch: state.engine.pg_epoch,
    schemaLedgerHead: state.engine.schema_ledger_head,
  };
  for (const entry of Object.values(state.migrations)) {
    out.entries += 1;
    out[entry.status] += 1;
  }
  return out;
}
