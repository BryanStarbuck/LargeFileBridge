// THE BACKFILL HARNESS — the three mechanics every area shares, implemented once.
//
// database_migration.mdx §4.1 states that all nine backfill areas are resumable and idempotent BY THE SAME
// THREE MECHANICS, "so none of them has to invent its own". That sentence is the whole reason this file
// exists: nine hand-rolled resume schemes would be nine chances to get resume-after-crash subtly wrong, and
// the failure mode of a subtly wrong one is silent — a run that reports success and skipped 3,000 rows.
//
//   (a) A WATERMARK per (area, scope): the source files' identity triple (ino + size + mtime_ms, the same
//       one `yaml-store.ts:63-97` already trusts) plus a cursor. An interrupted run resumes from the
//       cursor. A source that MOVED under the run is re-done from zero — FOR THAT SCOPE ONLY, which is the
//       point of scoping: one repo's status.yaml being rewritten mid-run must not restart the other 104.
//
//   (b) EVERY insert is ON CONFLICT against a real constraint. The clause belongs to the CALLER
//       (`ctx.copyRows(..., { onConflict })`), because four different areas write `lfb.file` and a whole-row
//       upsert would clobber another area's columns.
//
//   (c) A REJECT TABLE, NOT AN ABORT. `ctx.reject(path, reason)` records and the run continues; the count
//       is surfaced in the outcome and in `migration_state.yaml`.
//
// TWO HARD CONSTRAINTS ON WHERE THIS MAY RUN.
//
//   * NEVER ON THE REQUEST PATH. A backfill walks megabytes of YAML synchronously; on the event loop that
//     is the "the pages are spinning" symptom this entire workstream exists to remove (performance.mdx
//     P-40). `runAllBackfills()` is called from boot and from the CLI, never from a router.
//   * IT RESPECTS `backgroundShouldDefer()`. The pool is 8 connections with a 3-connection interactive
//     reserve, and the sister app's 2026-08-15 incident — nineteen admins logged out because batch work ate
//     the pool — is what happens when background work competes with a sign-in. A deferred area is not a
//     failure; it is a run that will happen on the next pass.
//
// THE LEDGER IS `migration_state.yaml`, NOT A TABLE. `lfb.backfill_mirror` is written here and is
// WRITE-ONLY: it is an advisory join surface for SQL and /api/health, and is never read to decide whether
// anything ran (database_migration.mdx §1). The authority has to be a local file because four of the boot
// migrations run before any connection exists.
import { performance } from "node:perf_hooks";
import {
  acquireLease,
  fingerprintSources,
  getEntry,
  loadMigrationState,
  recordDone,
  recordFailure,
  recordProgress,
  recordScope,
  recordStart,
  releaseLease,
  saveMigrationState,
  shouldRun,
  type MigrationState,
} from "../../config/migration-state.js";
import { log } from "../logging.js";
import { copyRows, dbEnabled, exec, q, refreshDbHealth, tryDb, type CopyRowsOptions } from "./db.js";
import { readPgEpoch } from "./migrate.js";
import { backgroundShouldDefer, DB_SCHEMA, getPool } from "./pool.js";

/**
 * One unit of resumable work. Usually ONE PER UNIT (a pin folder, a repo's tracking dir) — small enough
 * that re-doing one after a source moved is cheap, large enough that the ledger is not written per row.
 */
export interface BackfillScope {
  /** Stable across runs, and the key the watermark and the reject rows are filed under. */
  key: string;
  /** The files whose (ino, size, mtime_ms) form this scope's watermark. */
  sources: string[];
  /** Anything the area's `run()` wants to carry through — the pin folder, the resolved abs path, … */
  data?: unknown;
}

export interface BackfillContext {
  scope: BackfillScope;
  /** Where an interrupted earlier run stopped inside this scope, or null to start from zero. */
  resumeFrom: string | null;
  /** Rows this scope had already written before the interruption `resumeFrom` describes. */
  rowsBefore: number;
  q: typeof q;
  exec: typeof exec;
  copyRows: (
    table: string,
    columns: string[],
    rows: ReadonlyArray<ReadonlyArray<unknown>>,
    opts?: CopyRowsOptions,
  ) => Promise<number>;
  /** Mechanic (c): record and CONTINUE. Never throws, never aborts the run. */
  reject: (sourcePath: string, reason: string) => void;
  /**
   * Mechanic (a): "I have finished everything up to `cursor`, having written `rows` rows in this scope."
   *
   * Call it freely — per record if that is natural. It is CHEAP: the flush to the YAML ledger is rate-limited
   * (see `CHECKPOINT_ROWS` / `CHECKPOINT_MS`) precisely so an area does not have to think about it. Writing
   * the ledger per row would fsync ~30,000 times for one area, which is slower than the work it protects.
   */
  checkpoint: (cursor: string | null, rows: number) => void;
}

export interface BackfillVerification {
  yamlRows: number;
  pgRows: number;
  mismatches: string[];
}

export interface BackfillArea {
  /** The `migration_state.yaml` key. Stable forever — the ledger keys on name, never on order. */
  name: string;
  /** The version of the LOGIC. Bumping it re-arms the area (`shouldRun`, applied_version < version). */
  version: number;
  kind: "backfill";
  /** Every file the area reads, for the whole-area fingerprint that re-arms it when its source moves. */
  sources: () => string[];
  scopes: () => Promise<BackfillScope[]> | BackfillScope[];
  run: (scope: BackfillScope, ctx: BackfillContext) => Promise<{ rows: number }>;
  verify?: () => Promise<BackfillVerification>;
}

export interface BackfillOutcome {
  name: string;
  ran: boolean;
  /** Why it did not run: 'no-database' | 'deferred' | 'up-to-date' | 'lease-held' | 'no-scopes'. */
  skipped: string | null;
  scopesTotal: number;
  scopesDone: number;
  /** Scopes that resumed from a cursor rather than starting at zero. */
  scopesResumed: number;
  /** Scopes whose source MOVED under us and were therefore re-done from zero (mechanic (a)). */
  scopesRedone: number;
  /** Scopes skipped because their watermark says they are already complete and unchanged. */
  scopesUnchanged: number;
  scopesFailed: number;
  rows: number;
  rejects: number;
  ms: number;
  error: string | null;
  verification: BackfillVerification | null;
}

/** Flush the ledger after this many rows … */
const CHECKPOINT_ROWS = 2_000;
/** … or after this long, whichever comes first. A slow scope still leaves a resumable trail. */
const CHECKPOINT_MS = 5_000;

/** The per-scope watermark, stored under `migration_state.yaml` → migrations.<area>.cursor. */
interface Watermark {
  /** `fingerprintSources(scope.sources)` — the identity triple of every source file in the scope. */
  fp: string;
  /** Where we stopped, or null when the scope completed. */
  cursor: string | null;
  rows: number;
  /** True once the scope finished cleanly at `fp`. A later run with the same `fp` skips it entirely. */
  done: boolean;
}

function readWatermarks(state: MigrationState, name: string): Record<string, Watermark> {
  const raw = getEntry(state, name).cursor as Record<string, unknown>;
  const out: Record<string, Watermark> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const w = v as Partial<Watermark> | null;
    if (!w || typeof w.fp !== "string") continue;
    out[k] = {
      fp: w.fp,
      cursor: typeof w.cursor === "string" ? w.cursor : null,
      rows: typeof w.rows === "number" ? w.rows : 0,
      done: w.done === true,
    };
  }
  return out;
}

// ── the runner ──────────────────────────────────────────────────────────────────────────────────────────

export async function runBackfill(area: BackfillArea): Promise<BackfillOutcome> {
  const t0 = performance.now();
  const outcome: BackfillOutcome = {
    name: area.name,
    ran: false,
    skipped: null,
    scopesTotal: 0,
    scopesDone: 0,
    scopesResumed: 0,
    scopesRedone: 0,
    scopesUnchanged: 0,
    scopesFailed: 0,
    rows: 0,
    rejects: 0,
    ms: 0,
    error: null,
    verification: null,
  };
  const finish = (): BackfillOutcome => {
    outcome.ms = Math.round(performance.now() - t0);
    return outcome;
  };

  // A backfill with no database is not a failure and not a warning — it is the documented `auto` posture.
  // `refreshDbHealth()` first, because `dbEnabled()` answers from a remembered verdict and a CLI process has
  // never spoken to the server before this line.
  await refreshDbHealth();
  if (!dbEnabled()) {
    outcome.skipped = "no-database";
    return finish();
  }
  if (backgroundShouldDefer()) {
    // The interactive reserve is not negotiable — see the file header. Next pass.
    log.info("migrate", `${area.name}: deferring, the pool's interactive reserve is in use`);
    outcome.skipped = "deferred";
    return finish();
  }

  const pool = getPool();
  const epoch = pool ? await readPgEpoch(pool) : null;

  // Loading WITH the epoch is what applies the gate: a `done` entry stamped against a database that has
  // since been dropped and recreated is demoted to `pending` inside the loader, so no caller can forget
  // (database_migration.mdx §2.2).
  let state: MigrationState;
  try {
    state = loadMigrationState(epoch);
  } catch (e) {
    outcome.error = (e as Error).message;
    return finish();
  }

  const fp = fingerprintSources(area.sources());
  const entry = getEntry(state, area.name);
  const armedByVersion = shouldRun(state, area.name, area.kind, area.version);
  const armedBySource = entry.source_fingerprint !== fp;
  if (!armedByVersion && !armedBySource) {
    outcome.skipped = "up-to-date";
    return finish();
  }
  /**
   * A BUMPED LOGIC VERSION INVALIDATES EVERY WATERMARK, and this is the one that is easy to miss.
   *
   * The per-scope watermark asks "have the SOURCE BYTES moved?", and after a version bump the answer is no —
   * so without this flag every scope would be skipped as `unchanged` and the re-arm would migrate nothing.
   * That is the failure `applied_version` exists to prevent (database_migration.mdx §2.1): bumping a
   * migration's logic has to actually re-run it. A source-fingerprint re-arm is different and keeps the
   * per-scope skipping, because there the bytes ARE the question.
   */
  const versionBumped = entry.applied_version !== null && entry.applied_version < area.version;

  // The lease is a CROSS-PROCESS mutex. `backend.lock` guarantees one backend, not one writer: the CLI and
  // the launchd workers can be mid-run while the backend boots, and a backfill is resumable but not
  // re-entrant — two writers sharing one cursor would each believe they owned it.
  if (!acquireLease(state)) {
    log.info("migrate", `${area.name}: another process holds the migration lease — skipping this pass`);
    outcome.skipped = "lease-held";
    return finish();
  }
  saveMigrationState(state); // publish the lease before doing any work

  let scopes: BackfillScope[];
  try {
    scopes = await area.scopes();
  } catch (e) {
    outcome.error = `scopes() failed: ${(e as Error).message}`;
    recordFailure(state, area.name, e);
    releaseLease(state);
    saveMigrationState(state);
    return finish();
  }
  // Alphabetical, always. The cursor in the plan for area 2 is literally "pin folder, alphabetical", and a
  // stable order is what makes "resume where we stopped" mean anything at all.
  scopes = [...scopes].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  outcome.scopesTotal = scopes.length;

  recordStart(state, area.name, area.kind, area.version);
  outcome.ran = true;
  const marks = readWatermarks(state, area.name);
  // The area's own rows carry over across an interrupted run; count from the watermarks we are keeping.
  let totalRows = 0;
  // Rejects recorded in THIS pass. Not cumulative across runs — `lfb.backfill_reject` is the authority (its
  // PK dedupes a re-rejected file), and a ledger counter that only ever grew would say "412 rejects" for the
  // same two unreadable sidecars after 206 boots.
  let totalRejects = 0;
  let lastFlush = Date.now();
  let rowsSinceFlush = 0;

  const flush = (): void => {
    recordProgress(state, area.name, { rows: totalRows, cursor: marks as unknown as Record<string, unknown>, rejects: totalRejects });
    saveMigrationState(state);
    lastFlush = Date.now();
    rowsSinceFlush = 0;
  };

  for (const scope of scopes) {
    const scopeFp = fingerprintSources(scope.sources);
    const prior = marks[scope.key];
    let resumeFrom: string | null = null;
    let rowsBefore = 0;

    if (prior && prior.fp === scopeFp && prior.done && !versionBumped) {
      // Unchanged and complete. Its rows still count toward the area's total.
      totalRows += prior.rows;
      outcome.scopesUnchanged += 1;
      continue;
    }
    if (prior && prior.fp === scopeFp && !prior.done && !versionBumped) {
      resumeFrom = prior.cursor;
      rowsBefore = prior.rows;
      if (resumeFrom !== null) outcome.scopesResumed += 1;
    } else if (prior) {
      // MECHANIC (a), the half that is easy to skip: the source moved under us. Re-do this scope from zero
      // — and ONLY this scope. Its rejects go with it, or a re-done scope would keep reporting rejects it
      // no longer produces.
      outcome.scopesRedone += 1;
      await clearRejects(area.name, scope.key);
    }

    const rejected: Array<{ path: string; reason: string }> = [];
    let scopeRows = rowsBefore;
    let scopeCursor: string | null = resumeFrom;

    const ctx: BackfillContext = {
      scope,
      resumeFrom,
      rowsBefore,
      q,
      exec,
      copyRows,
      reject: (sourcePath: string, reason: string) => {
        rejected.push({ path: sourcePath, reason });
      },
      checkpoint: (cursor: string | null, rows: number) => {
        scopeCursor = cursor;
        scopeRows = rows;
        marks[scope.key] = { fp: scopeFp, cursor, rows, done: false };
        rowsSinceFlush += 1;
        if (rowsSinceFlush >= CHECKPOINT_ROWS || Date.now() - lastFlush >= CHECKPOINT_MS) {
          // totalRows is only accurate at scope boundaries mid-run; the cursor is the part that matters for
          // resume, and it is exact.
          flush();
        }
      },
    };

    try {
      const res = await area.run(scope, ctx);
      scopeRows = res.rows;
      totalRows += scopeRows;
      marks[scope.key] = { fp: scopeFp, cursor: null, rows: scopeRows, done: true };
      recordScope(state, area.name, scope.key, {
        status: "done",
        finished_at: new Date().toISOString(),
        rows_migrated: scopeRows,
        reason: null,
      });
      outcome.scopesDone += 1;
    } catch (e) {
      // A scope that throws is a FAILED SCOPE, not a failed area. The other 104 repos are still worth
      // migrating, and the ledger's per-scope map is what makes partial completion representable at all
      // (database_migration.mdx §2.4).
      marks[scope.key] = { fp: scopeFp, cursor: scopeCursor, rows: scopeRows, done: false };
      recordScope(state, area.name, scope.key, {
        status: "failed",
        finished_at: new Date().toISOString(),
        rows_migrated: scopeRows,
        reason: (e as Error).message,
      });
      outcome.scopesFailed += 1;
      outcome.error ??= `${scope.key}: ${(e as Error).message}`;
      log.warn("migrate", `${area.name}/${scope.key} failed (other scopes continue): ${(e as Error).message}`);
    }

    if (rejected.length) {
      await writeRejects(area.name, scope.key, rejected);
      totalRejects += rejected.length;
      outcome.rejects += rejected.length;
    }
    if (rowsSinceFlush > 0 || Date.now() - lastFlush >= CHECKPOINT_MS) flush();
  }

  outcome.rows = totalRows;
  recordProgress(state, area.name, {
    rows: totalRows,
    cursor: marks as unknown as Record<string, unknown>,
    rejects: totalRejects,
  });

  if (outcome.scopesFailed === 0) {
    recordDone(state, area.name, area.version, { rows: totalRows, pgEpoch: epoch });
    // The fingerprint is stamped only on a CLEAN pass. Stamping it after a partial one would tell the next
    // boot the source had already been fully consumed at these bytes, and the failed scopes would never be
    // retried.
    getEntry(state, area.name).source_fingerprint = fp;
  } else {
    recordFailure(state, area.name, new Error(outcome.error ?? `${outcome.scopesFailed} scope(s) failed`));
  }

  if (area.verify) {
    try {
      const v = await area.verify();
      outcome.verification = v;
      const e2 = getEntry(state, area.name);
      e2.verification = {
        checked_at: new Date().toISOString(),
        yaml_rows: v.yamlRows,
        pg_rows: v.pgRows,
        spot_checks: null,
        mismatches: v.mismatches,
      };
      if (v.mismatches.length) {
        log.warn(
          "migrate",
          `${area.name}: verification found ${v.mismatches.length} mismatch(es) — the read cutover for this ` +
            `area stays blocked (database_migration.mdx §4.5): ${v.mismatches.slice(0, 5).join("; ")}`,
        );
      }
    } catch (e) {
      log.warn("migrate", `${area.name}: verify() failed: ${(e as Error).message}`);
    }
  }

  releaseLease(state);
  saveMigrationState(state);
  await mirrorToPostgres(state, area.name);

  log.info(
    "migrate",
    `${area.name}: ${outcome.rows} row(s), ${outcome.scopesDone} scope(s) done ` +
      `(${outcome.scopesUnchanged} unchanged, ${outcome.scopesResumed} resumed, ${outcome.scopesRedone} re-done, ` +
      `${outcome.scopesFailed} failed), ${outcome.rejects} reject(s) in ${Math.round(performance.now() - t0)}ms`,
  );
  return finish();
}

// ── the reject table (mechanic c) ───────────────────────────────────────────────────────────────────────

async function writeRejects(
  area: string,
  scope: string,
  rows: Array<{ path: string; reason: string }>,
): Promise<number> {
  return tryDb(
    async () =>
      copyRows(
        `${DB_SCHEMA}.backfill_reject`,
        ["area", "scope", "source_path", "reason", "last_seen_at"],
        rows.map((r) => [area, scope, r.path, r.reason, new Date()]),
        {
          // Re-rejecting the same file must refresh the record, not add a row — that is what keeps "run
          // twice, identical row counts" true for this table too.
          onConflict:
            "ON CONFLICT (area, scope, source_path) DO UPDATE SET " +
            "reason = EXCLUDED.reason, last_seen_at = EXCLUDED.last_seen_at, " +
            `seen_count = ${DB_SCHEMA}.backfill_reject.seen_count + 1`,
        },
      ),
    0,
    `backfill.${area}.rejects`,
  );
}

/** Clear one scope's rejects — only when that scope is restarting from zero. See 0016's header. */
async function clearRejects(area: string, scope: string): Promise<void> {
  await tryDb(
    () => exec(`DELETE FROM ${DB_SCHEMA}.backfill_reject WHERE area = $1 AND scope = $2`, [area, scope]),
    0,
    `backfill.${area}.clearRejects`,
  );
}

/** How many rejects an area currently holds. For the outcome report and `just db-status`. */
export async function rejectCount(area?: string): Promise<number> {
  return tryDb(
    async () => {
      const rows = await q<{ n: string }>(
        area
          ? `SELECT count(*)::text AS n FROM ${DB_SCHEMA}.backfill_reject WHERE area = $1`
          : `SELECT count(*)::text AS n FROM ${DB_SCHEMA}.backfill_reject`,
        area ? [area] : undefined,
      );
      return Number(rows[0]?.n ?? 0);
    },
    0,
    "backfill.rejectCount",
  );
}

// ── the advisory mirror (WRITE-ONLY) ────────────────────────────────────────────────────────────────────

/**
 * Copy one ledger entry into `lfb.backfill_mirror` so SQL and /api/health can join on backfill progress.
 *
 * WRITE-ONLY, and the emphasis is the point: nothing may ever READ this table to decide whether a backfill
 * ran. The YAML ledger is the authority because four of the boot migrations run before a connection exists
 * (database_migration.mdx §1), and a mirror that starts being consulted is a second source of truth that
 * disagrees the first time somebody drops the database.
 */
async function mirrorToPostgres(state: MigrationState, name: string): Promise<void> {
  const e = state.migrations[name];
  if (!e) return;
  await tryDb(
    () =>
      exec(
        `INSERT INTO ${DB_SCHEMA}.backfill_mirror
           (name, kind, status, version, applied_version, rows_migrated, rows_expected, pg_epoch, last_error, mirrored_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (name) DO UPDATE SET
           kind = EXCLUDED.kind, status = EXCLUDED.status, version = EXCLUDED.version,
           applied_version = EXCLUDED.applied_version, rows_migrated = EXCLUDED.rows_migrated,
           rows_expected = EXCLUDED.rows_expected, pg_epoch = EXCLUDED.pg_epoch,
           last_error = EXCLUDED.last_error, mirrored_at = now()`,
        [
          name,
          e.kind,
          e.status,
          e.version,
          e.applied_version,
          e.rows_migrated,
          e.rows_expected,
          e.pg_epoch,
          e.last_error,
        ],
      ),
    0,
    `backfill.${name}.mirror`,
  );
}

// ── the registry ────────────────────────────────────────────────────────────────────────────────────────

const registry = new Map<string, BackfillArea>();

/**
 * Register an area. Later slices append theirs here (areas 3-9); the order of registration is the order they
 * run, which matters because area 2's `unit` rows are the FK target every later area needs.
 */
export function registerBackfill(area: BackfillArea): void {
  if (registry.has(area.name)) {
    // A duplicate name would silently make one of the two areas unreachable, and the ledger keys on name, so
    // the two would also share a watermark. Refuse loudly at import time rather than at 3am.
    throw new Error(`backfill area '${area.name}' is already registered`);
  }
  registry.set(area.name, area);
}

export function listBackfills(): BackfillArea[] {
  return [...registry.values()];
}

/** Tests only — the registry is module state and a spec that registers a fixture must be able to undo it. */
export function clearBackfillRegistry(): void {
  registry.clear();
}

/**
 * Run every registered area, in registration order.
 *
 * NEVER CALL THIS FROM A REQUEST HANDLER. It walks megabytes of YAML; on the event loop that is the
 * "pages are spinning" symptom this workstream exists to remove. Boot and the CLI, nothing else.
 *
 * `backgroundShouldDefer()` is re-checked per area (inside `runBackfill`), not once at the top: a sign-in
 * arriving between area 2 and area 3 must be able to stop area 3, and a single check at the top would let
 * the whole run through on a snapshot taken before anybody was using the app.
 */
export async function runAllBackfills(only?: string[]): Promise<BackfillOutcome[]> {
  const out: BackfillOutcome[] = [];
  for (const area of registry.values()) {
    if (only && !only.includes(area.name)) continue;
    try {
      out.push(await runBackfill(area));
    } catch (e) {
      // `runBackfill` is written not to throw; this is the belt to its braces, because a throw escaping into
      // `bootDatabase()` would be the one thing allowed to crash a boot on a machine with no database.
      log.warn("migrate", `${area.name}: unexpected backfill failure (swallowed): ${(e as Error).message}`);
      out.push({
        name: area.name,
        ran: false,
        skipped: null,
        scopesTotal: 0,
        scopesDone: 0,
        scopesResumed: 0,
        scopesRedone: 0,
        scopesUnchanged: 0,
        scopesFailed: 0,
        rows: 0,
        rejects: 0,
        ms: 0,
        error: (e as Error).message,
        verification: null,
      });
    }
  }
  return out;
}
