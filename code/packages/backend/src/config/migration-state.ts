// THE DATA-MIGRATION LEDGER (database_migration.mdx §2): ~/T/_large_files_bridge/migration_state.yaml.
//
// WHY THIS IS THE AUTHORITY AND NOT A POSTGRES TABLE. main.ts runs seven boot migrations, and FOUR of them
// are pure on-disk repairs that must latch correctly on a machine where Postgres was never installed — they
// all run BEFORE the state is bootstrapped, let alone before a pool exists. A ledger that lives in the
// database those migrations do not use cannot be their authority.
//
// It is machine-local, sits beside config.yaml, and is NEVER placed in, mirrored to, or committed from a
// Syncable Data Location: a peer's migration progress is meaningless here and would fight on every pull.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import YAML from "yaml";
import { z } from "zod";
import { resolveStateDir } from "./state-dir.js";
import { log } from "../shared/logging.js";

export const MIGRATION_STATE_FILE = "migration_state.yaml";

const iso = z.string();

/**
 * `kind` decides whether an entry may ever latch.
 *   local    — an on-disk repair, no Postgres involved. Latches.
 *   backfill — YAML → Postgres. Latches, but is EPOCH-GATED (see §2.2): a `done` entry written against a
 *              database that has since been dropped and recreated is not done.
 *   sweep    — NEVER latches. It records the last clean pass instead.
 *
 * `sweep` exists because `repairEmptySyncRepoBlocks` and `migrateSdlLfbridge` WANTED a latch and could not
 * express one — a peer can push the legacy layout back at any time, so "done" is never true — and so they
 * abandoned latching entirely and pay full cost on every boot. "Last swept, and last time it actually found
 * something" is the thing that is true, and it is what those two needed.
 */
export const MigrationKind = z.enum(["local", "backfill", "sweep"]);
export type MigrationKind = z.infer<typeof MigrationKind>;

export const MigrationStatus = z.enum(["pending", "running", "done", "failed", "skipped", "superseded"]);
export type MigrationStatus = z.infer<typeof MigrationStatus>;

const ScopeSchema = z.object({
  status: z.enum(["done", "skipped", "failed"]),
  finished_at: iso.nullable().default(null),
  rows_migrated: z.number().nullable().default(null),
  reason: z.string().nullable().default(null),
});
export type MigrationScope = z.infer<typeof ScopeSchema>;

const VerificationSchema = z.object({
  checked_at: iso.nullable().default(null),
  yaml_rows: z.number().nullable().default(null),
  pg_rows: z.number().nullable().default(null),
  spot_checks: z.number().nullable().default(null),
  mismatches: z.array(z.string()).default([]),
});

const EntrySchema = z.object({
  kind: MigrationKind.default("local"),
  status: MigrationStatus.default("pending"),
  // The version of the LOGIC in code.
  version: z.number().default(1),
  // The version whose run produced `finished_at`. THIS IS THE FIELD THE WHOLE EXERCISE IS FOR: a 24-byte
  // timestamp sentinel cannot say WHICH version of the logic ran, so bumping a migration's logic had no way
  // to re-arm it. `applied_version < version` ⇒ RE-RUN.
  applied_version: z.number().nullable().default(null),
  started_at: iso.nullable().default(null),
  finished_at: iso.nullable().default(null),
  last_swept_at: iso.nullable().default(null), // kind:sweep only
  last_found_at: iso.nullable().default(null), // kind:sweep only — last pass that CHANGED something
  rows_migrated: z.number().default(0),
  rows_expected: z.number().nullable().default(null),
  // sha256 over the sorted (relpath,size,mtime_ms,ino) of every source file. Re-arms a backfill when its
  // SOURCE moves, with no version bump needed.
  source_fingerprint: z.string().nullable().default(null),
  pg_epoch: z.string().nullable().default(null),
  batch_size: z.number().nullable().default(null),
  cursor: z.record(z.string(), z.unknown()).default({}),
  attempts: z.number().default(0),
  last_error: z.string().nullable().default(null),
  // Per-unit outcome. Replaces the 105 `.decisions_migrated` files with ONE map, and makes PARTIAL
  // completion representable — which fixes three latent bugs at once: posix-paths latching over unmounted
  // repos, repo-dir-names discarding `tally.unknown`, and decisions-to-ledger conflating "consent off" with
  // "never ran".
  scopes: z.record(z.string(), ScopeSchema).default({}),
  verification: VerificationSchema.prefault({}),
  rejects: z.number().default(0),
});
export type MigrationEntry = z.infer<typeof EntrySchema>;

const EngineSchema = z.object({
  // `SELECT system_identifier FROM pg_control_system()` + the database oid.
  pg_epoch: z.string().nullable().default(null),
  schema_ledger_head: z.number().default(0),
  lease_owner: z.string().nullable().default(null),
  lease_expires_at: iso.nullable().default(null),
});

export const MigrationStateSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.nullable().default(null),
  engine: EngineSchema.prefault({}),
  migrations: z.record(z.string(), EntrySchema).default({}),
});
export type MigrationState = z.infer<typeof MigrationStateSchema>;

function stateFile(stateDir = resolveStateDir()): string {
  return path.join(stateDir, MIGRATION_STATE_FILE);
}

/**
 * Load the ledger, applying the EPOCH GATE.
 *
 * The gate lives HERE, inside the loader, and never at a call site — so a dropped-and-recreated database
 * cannot look full to a caller that forgot to check. Any `backfill` entry whose recorded `pg_epoch` differs
 * from the live cluster's is demoted to `pending`, whatever its status said.
 *
 * `liveEpoch` is null when we have not connected (or there is no database at all); in that case nothing is
 * demoted, because "we cannot see the database" is not evidence that a backfill did not happen.
 */
export function loadMigrationState(liveEpoch: string | null = null, stateDir = resolveStateDir()): MigrationState {
  const file = stateFile(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("migrate", `migration_state read failed (using empty): ${file}: ${(e as Error).message}`);
    }
    return MigrationStateSchema.parse({});
  }
  let state: MigrationState;
  try {
    const parsed = MigrationStateSchema.safeParse(YAML.parse(raw) ?? {});
    if (!parsed.success) {
      // NEVER silently reset: an unreadable ledger that we replace with an empty one would re-run every
      // adopted migration, including the mirror opt-out one whose once-only run is its entire safety
      // argument. Quarantine the file and refuse to treat it as absent.
      const quarantine = `${file}.unreadable.${Date.now()}`;
      try {
        fs.copyFileSync(file, quarantine);
      } catch {
        /* best effort */
      }
      log.error(
        "migrate",
        `migration_state INVALID — quarantined to ${quarantine}. Refusing to treat it as absent, because that ` +
          `would re-run every adopted migration: ${parsed.error.message}`,
      );
      throw new Error(`Corrupt ${MIGRATION_STATE_FILE}`);
    }
    state = parsed.data;
  } catch (e) {
    if ((e as Error).message.startsWith("Corrupt ")) throw e;
    log.error("migrate", `migration_state parse failed: ${file}: ${(e as Error).message}`);
    throw new Error(`Corrupt ${MIGRATION_STATE_FILE}`);
  }

  if (liveEpoch !== null) {
    for (const [name, entry] of Object.entries(state.migrations)) {
      if (entry.kind !== "backfill") continue;
      if (entry.pg_epoch !== null && entry.pg_epoch !== liveEpoch) {
        log.warn(
          "migrate",
          `${name}: recorded pg_epoch ${entry.pg_epoch} != live ${liveEpoch} — the database was recreated, ` +
            `so this backfill is NOT applied. Re-arming it.`,
        );
        entry.status = "pending";
        entry.applied_version = null;
        entry.rows_migrated = 0;
        entry.cursor = {};
        entry.scopes = {};
      }
    }
  }
  return state;
}

/** Atomic write, same temp→fsync→rename discipline as every other state writer in the app. */
export function saveMigrationState(state: MigrationState, stateDir = resolveStateDir()): void {
  state.updated_at = new Date().toISOString();
  const file = stateFile(stateDir);
  const body = YAML.stringify(MigrationStateSchema.parse(state), { sortMapEntries: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    log.error("migrate", `migration_state write failed: ${file}: ${(e as Error).message}`);
  }
}

export function getEntry(state: MigrationState, name: string): MigrationEntry {
  const existing = state.migrations[name];
  if (existing) return existing;
  const fresh = EntrySchema.parse({});
  state.migrations[name] = fresh;
  return fresh;
}

/**
 * Should `name` at logic `version` run now?
 *
 * A `sweep` ALWAYS runs — that is what makes it a sweep. Everything else runs unless it finished at a
 * version at least as new as the one the code is now carrying.
 */
export function shouldRun(state: MigrationState, name: string, kind: MigrationKind, version: number): boolean {
  const e = state.migrations[name];
  if (!e) return true;
  if (kind === "sweep") return true;
  if (e.status !== "done" && e.status !== "skipped") return true;
  return (e.applied_version ?? -1) < version;
}

export function recordStart(state: MigrationState, name: string, kind: MigrationKind, version: number): void {
  const e = getEntry(state, name);
  e.kind = kind;
  e.version = version;
  e.status = "running";
  e.started_at = new Date().toISOString();
  e.attempts += 1;
  e.last_error = null;
}

export function recordProgress(
  state: MigrationState,
  name: string,
  patch: { rows?: number; cursor?: Record<string, unknown>; rejects?: number },
): void {
  const e = getEntry(state, name);
  if (patch.rows !== undefined) e.rows_migrated = patch.rows;
  if (patch.cursor !== undefined) e.cursor = patch.cursor;
  if (patch.rejects !== undefined) e.rejects = patch.rejects;
}

export function recordScope(state: MigrationState, name: string, scope: string, outcome: MigrationScope): void {
  getEntry(state, name).scopes[scope] = ScopeSchema.parse(outcome);
}

export function recordReject(state: MigrationState, name: string): void {
  getEntry(state, name).rejects += 1;
}

export function recordDone(
  state: MigrationState,
  name: string,
  version: number,
  extra: { rows?: number; pgEpoch?: string | null; foundSomething?: boolean } = {},
): void {
  const e = getEntry(state, name);
  const now = new Date().toISOString();
  e.status = "done";
  e.applied_version = version;
  e.last_error = null;
  if (extra.rows !== undefined) e.rows_migrated = extra.rows;
  if (extra.pgEpoch !== undefined) e.pg_epoch = extra.pgEpoch;
  if (e.kind === "sweep") {
    // A sweep does not "finish" — it passes. `last_found_at` only moves when the pass CHANGED something,
    // which is the signal that tells a human whether the sweep is still earning its cost.
    e.last_swept_at = now;
    if (extra.foundSomething) e.last_found_at = now;
  } else {
    e.finished_at = now;
  }
}

export function recordFailure(state: MigrationState, name: string, error: unknown): void {
  const e = getEntry(state, name);
  e.status = "failed";
  e.last_error = `${(error as Error)?.message ?? String(error)} at ${new Date().toISOString()}`;
}

/**
 * ADOPT A LEGACY SENTINEL — and LEAVE THE FILE IN PLACE (database_migration.mdx §1.1).
 *
 * The five state-root sentinels cost 110 inodes and ~2.7 KB between them. Deleting them would make this
 * ledger the only thing standing between a user's mirror opt-out and 105 repos silently re-enabling:
 * migrate-sync-repo-default.ts makes its once-only run its ENTIRE safety argument, and its gate is a bare
 * `fs.existsSync`. A rollback to any build predating this file would then re-run all of them.
 *
 * So adoption is additive and one-way: if the sentinel exists and the ledger has no finished entry, record
 * one using the sentinel's own timestamp as `finished_at`.
 */
export function adoptSentinel(
  state: MigrationState,
  name: string,
  sentinelFile: string,
  version: number,
  kind: MigrationKind = "local",
  stateDir = resolveStateDir(),
): boolean {
  const e = state.migrations[name];
  if (e && (e.status === "done" || e.status === "skipped")) return false;
  const full = path.isAbsolute(sentinelFile) ? sentinelFile : path.join(stateDir, sentinelFile);
  let stamp: string | null = null;
  try {
    stamp = fs.readFileSync(full, "utf8").trim() || null;
  } catch {
    return false; // no sentinel: nothing to adopt, the migration simply has not run
  }
  const entry = getEntry(state, name);
  entry.kind = kind;
  entry.version = version;
  entry.applied_version = version;
  entry.status = "done";
  entry.attempts = Math.max(entry.attempts, 1);
  // The sentinel's own 24-byte content IS the completion time. Prefer it over "now", which would be a lie.
  const when = stamp && !Number.isNaN(Date.parse(stamp)) ? new Date(stamp).toISOString() : new Date().toISOString();
  if (kind === "sweep") entry.last_swept_at = when;
  else entry.finished_at = when;
  log.info("migrate", `adopted legacy sentinel ${path.basename(full)} as '${name}' (finished ${when}); file kept`);
  return true;
}

/** Re-stamp the legacy sentinel so a rollback to a pre-ledger build still sees the migration as done. */
export function restampSentinel(sentinelFile: string, stateDir = resolveStateDir()): void {
  const full = path.isAbsolute(sentinelFile) ? sentinelFile : path.join(stateDir, sentinelFile);
  try {
    fs.writeFileSync(full, `${new Date().toISOString()}\n`);
  } catch (e) {
    log.warn("migrate", `could not re-stamp sentinel ${full}: ${(e as Error).message}`);
  }
}

/**
 * A source fingerprint over a set of files: sha256 of the sorted (relpath, size, mtimeMs, ino) tuples.
 *
 * This is what re-arms a backfill when its SOURCE changes without anyone bumping a version — the same
 * identity triple `yaml-store.ts` already trusts for its parse cache. Deliberately NOT a content hash: the
 * point is to be cheap enough to run on 29,138 files at every boot.
 */
export function fingerprintSources(files: string[], base?: string): string {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort()) {
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(f);
    } catch {
      /* a missing source is part of the fingerprint too — record it as such */
    }
    const rel = base ? path.relative(base, f) : f;
    h.update(st ? `${rel}\0${st.size}\0${Math.trunc(st.mtimeMs)}\0${st.ino}\n` : `${rel}\0ABSENT\n`);
  }
  return `sha256:${h.digest("hex")}`;
}

/**
 * The data-migration LEASE — a cross-process mutex.
 *
 * `backend.lock` already guarantees one BACKEND per machine, which covers the web app. It does not cover the
 * CLI, and it does not cover the launchd workers, both of which can be running while the backend boots. A
 * backfill is resumable but not re-entrant: two writers sharing one cursor would each think they owned it.
 *
 * The lease is time-boxed so a crashed holder cannot wedge migrations forever.
 */
const LEASE_MS = 10 * 60 * 1000;

export function acquireLease(state: MigrationState): boolean {
  const now = Date.now();
  const expires = state.engine.lease_expires_at ? Date.parse(state.engine.lease_expires_at) : 0;
  const mine = `${process.pid}@${os.hostname()}`;
  if (state.engine.lease_owner && state.engine.lease_owner !== mine && expires > now) return false;
  state.engine.lease_owner = mine;
  state.engine.lease_expires_at = new Date(now + LEASE_MS).toISOString();
  return true;
}

export function releaseLease(state: MigrationState): void {
  state.engine.lease_owner = null;
  state.engine.lease_expires_at = null;
}
