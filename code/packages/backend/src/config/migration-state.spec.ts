// THE DATA-MIGRATION LEDGER (database_migration.mdx §2).
//
// Everything this file protects is a "did it already run?" answer, and both wrong answers are expensive:
// saying YES when it did not leaves data unmigrated forever, and saying NO when it did re-runs migrations
// whose once-only execution is their entire safety argument (migrate-sync-repo-default.ts gates a user's
// mirror opt-out on a bare `fs.existsSync`, so a spurious re-run silently re-enables 105 repos).
//
// Every test here passes an EXPLICIT `stateDir` into a fresh `fs.mkdtempSync` directory. That parameter
// exists on every function for exactly this reason — the default is `resolveStateDir()`, and a spec that
// took the default would read and write the developer's real ~/T/_large_files_bridge/migration_state.yaml.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  MIGRATION_STATE_FILE,
  MigrationStateSchema,
  acquireLease,
  adoptSentinel,
  fingerprintSources,
  getEntry,
  loadMigrationState,
  recordDone,
  recordScope,
  recordStart,
  releaseLease,
  saveMigrationState,
  shouldRun,
  type MigrationState,
} from "./migration-state.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-migstate-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const empty = (): MigrationState => MigrationStateSchema.parse({});
const ledgerPath = () => path.join(dir, MIGRATION_STATE_FILE);
const write = (body: string) => fs.writeFileSync(ledgerPath(), body);

describe("round trip — the ledger survives a process restart", () => {
  it("returns a schema-shaped empty state when the file does not exist yet", () => {
    // First boot on a new machine. An absent ledger is NOT an error and must not be confused with a corrupt
    // one (see the quarantine tests below) — everything is simply pending.
    const state = loadMigrationState(null, dir);
    expect(state.migrations).toEqual({});
    expect(state.schema_version).toBe(1);
    expect(fs.existsSync(ledgerPath())).toBe(false); // loading must not create it
  });

  it("saves and loads back the same entries", () => {
    const state = empty();
    recordStart(state, "posix-paths", "local", 3);
    recordDone(state, "posix-paths", 3, { rows: 41 });
    recordScope(state, "posix-paths", "/repos/alpha", {
      status: "done",
      finished_at: "2026-08-01T00:00:00.000Z",
      rows_migrated: 41,
      reason: null,
    });
    saveMigrationState(state, dir);

    const back = loadMigrationState(null, dir);
    const e = back.migrations["posix-paths"];
    expect(e?.status).toBe("done");
    expect(e?.kind).toBe("local");
    expect(e?.version).toBe(3);
    expect(e?.applied_version).toBe(3);
    expect(e?.rows_migrated).toBe(41);
    expect(e?.attempts).toBe(1);
    expect(e?.finished_at).toBe(state.migrations["posix-paths"]?.finished_at);
    // Per-scope outcomes are what make PARTIAL completion representable (§2.4) — they have to survive the
    // round trip or `posix-paths` latches over an unmounted repo all over again.
    expect(e?.scopes["/repos/alpha"]?.rows_migrated).toBe(41);
  });

  it("writes the ledger atomically and leaves no temp file behind", () => {
    // Same temp -> fsync -> rename discipline as every other state writer. A half-written ledger is
    // indistinguishable from a corrupt one, and the corrupt path is a hard throw at boot.
    saveMigrationState(empty(), dir);
    expect(fs.existsSync(ledgerPath())).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("stamps updated_at on every save", () => {
    const state = empty();
    expect(state.updated_at).toBeNull();
    saveMigrationState(state, dir);
    expect(state.updated_at).not.toBeNull();
    expect(Number.isNaN(Date.parse(state.updated_at!))).toBe(false);
  });
});

describe("shouldRun — the version field is the whole exercise (database_migration.mdx §2.1)", () => {
  it("runs a migration that has never been recorded", () => {
    expect(shouldRun(empty(), "never-seen", "local", 1)).toBe(true);
  });

  it("does NOT re-run once done at the same version", () => {
    const state = empty();
    recordDone(state, "posix-paths", 2);
    expect(shouldRun(state, "posix-paths", "local", 2)).toBe(false);
  });

  it("RE-ARMS when the code's version is bumped above applied_version — THE feature", () => {
    // This is the thing a 24-byte timestamp sentinel could not express. The sentinel could say "something
    // ran on Tuesday"; it could not say WHICH version of the logic ran, so fixing a migration's logic had no
    // way to make it run again. `applied_version < version` => RE-RUN.
    const state = empty();
    recordDone(state, "posix-paths", 2);
    expect(shouldRun(state, "posix-paths", "local", 2)).toBe(false); // unchanged logic: stay latched
    expect(shouldRun(state, "posix-paths", "local", 3)).toBe(true); // logic bumped: run again
  });

  it("does not run a migration whose applied_version is AHEAD of the code (a rollback)", () => {
    // Running a v2 code path over data a v3 run already rewrote is how a rollback turns into corruption.
    const state = empty();
    recordDone(state, "posix-paths", 5);
    expect(shouldRun(state, "posix-paths", "local", 3)).toBe(false);
  });

  it("re-runs anything left in a non-terminal state", () => {
    // `running` means the process died mid-migration; `failed` means it threw. Both must be retried, and
    // `pending` is the demoted state the epoch gate produces.
    const state = empty();
    for (const status of ["pending", "running", "failed"] as const) {
      getEntry(state, "backfill-files").status = status;
      getEntry(state, "backfill-files").applied_version = 9;
      expect(shouldRun(state, "backfill-files", "backfill", 1)).toBe(true);
    }
  });

  it("treats `skipped` as latched, like done", () => {
    // "Deliberately not applicable on this machine" is an answer, not an omission; re-asking every boot
    // would make the skip meaningless.
    const state = empty();
    getEntry(state, "decisions-to-ledger").status = "skipped";
    getEntry(state, "decisions-to-ledger").applied_version = 1;
    expect(shouldRun(state, "decisions-to-ledger", "local", 1)).toBe(false);
  });

  it("ALWAYS runs a sweep, even when its status says done", () => {
    // A sweep never latches — that is what makes it a sweep (§2.3). `repairEmptySyncRepoBlocks` and
    // `migrateSdlLfbridge` wanted a latch and could not have one: a peer can push the legacy layout back at
    // any time, so "done" is never true for them. If this ever returned false those two would stop
    // repairing a machine that a pull had just re-broken.
    const state = empty();
    recordDone(state, "repair-empty-sync-repo-blocks", 4);
    getEntry(state, "repair-empty-sync-repo-blocks").kind = "sweep";
    getEntry(state, "repair-empty-sync-repo-blocks").status = "done";
    getEntry(state, "repair-empty-sync-repo-blocks").applied_version = 999;
    expect(shouldRun(state, "repair-empty-sync-repo-blocks", "sweep", 1)).toBe(true);
  });
});

describe("THE EPOCH GATE — a recreated database means the backfill did not happen (§2.2)", () => {
  // Build a ledger on disk holding one finished backfill stamped with `epoch`, complete with the cursor and
  // per-scope results a real half-migrated run would carry.
  const seedBackfill = (epoch: string | null) => {
    const state = empty();
    recordStart(state, "backfill-files", "backfill", 1);
    recordDone(state, "backfill-files", 1, { rows: 29_138, pgEpoch: epoch });
    getEntry(state, "backfill-files").cursor = { last_id: 29_138 };
    recordScope(state, "backfill-files", "files.yaml", {
      status: "done",
      finished_at: "2026-08-01T00:00:00.000Z",
      rows_migrated: 29_138,
      reason: null,
    });
    saveMigrationState(state, dir);
  };

  it("DEMOTES a done backfill whose pg_epoch differs from the live cluster, and clears its cursor+scopes", () => {
    // `just db-reset` drops and recreates the database. The rows are gone but the ledger still says done —
    // and it is a resumable backfill, so a stale cursor would make the retry start 29,138 rows in and
    // migrate NOTHING. The cursor and the per-scope map have to be cleared with the status, or re-arming is
    // worse than not re-arming.
    seedBackfill("A");
    const back = loadMigrationState("B", dir);
    const e = back.migrations["backfill-files"]!;
    expect(e.status).toBe("pending");
    expect(e.applied_version).toBeNull();
    expect(e.rows_migrated).toBe(0);
    expect(e.cursor).toEqual({});
    expect(e.scopes).toEqual({});
    expect(shouldRun(back, "backfill-files", "backfill", 1)).toBe(true);
  });

  it("leaves it done when the live epoch MATCHES", () => {
    // The ordinary boot. Demoting here would re-run the full backfill on every single start.
    seedBackfill("A");
    const e = loadMigrationState("A", dir).migrations["backfill-files"]!;
    expect(e.status).toBe("done");
    expect(e.applied_version).toBe(1);
    expect(e.cursor).toEqual({ last_id: 29_138 });
    expect(e.scopes["files.yaml"]?.rows_migrated).toBe(29_138);
  });

  it("leaves it done when the live epoch is NULL — we cannot see the database", () => {
    // null means no pool, or a probe that failed. "We could not look" is not evidence that the backfill did
    // not happen, and demoting on it would re-arm every backfill on any machine running with
    // LFB_DB_MODE=off — a boot mode that exists precisely so the database can be out of the picture.
    seedBackfill("A");
    const e = loadMigrationState(null, dir).migrations["backfill-files"]!;
    expect(e.status).toBe("done");
    expect(e.applied_version).toBe(1);
  });

  it("leaves it done when the ENTRY has no recorded epoch", () => {
    // A backfill written before epoch stamping existed. We do not know which cluster it ran against, and an
    // unknown must not be read as a mismatch.
    seedBackfill(null);
    expect(loadMigrationState("B", dir).migrations["backfill-files"]!.status).toBe("done");
  });

  it("NEVER demotes a kind:local entry, whatever the epoch says", () => {
    // A `local` migration is an on-disk repair that never touched Postgres, so the cluster's identity is
    // irrelevant to it. This is the guard that keeps the four boot repairs — which run before a pool even
    // exists — from being re-armed by a `just db-reset`.
    const state = empty();
    recordStart(state, "migrate-sync-repo-default", "local", 1);
    recordDone(state, "migrate-sync-repo-default", 1, { pgEpoch: "A" });
    saveMigrationState(state, dir);

    const e = loadMigrationState("B", dir).migrations["migrate-sync-repo-default"]!;
    expect(e.status).toBe("done");
    expect(e.applied_version).toBe(1);
    expect(shouldRun(loadMigrationState("B", dir), "migrate-sync-repo-default", "local", 1)).toBe(false);
  });

  it("never demotes a kind:sweep entry either (it has nothing to re-arm)", () => {
    const state = empty();
    getEntry(state, "sdl-lfbridge").kind = "sweep";
    recordDone(state, "sdl-lfbridge", 1, { pgEpoch: "A" });
    saveMigrationState(state, dir);
    expect(loadMigrationState("B", dir).migrations["sdl-lfbridge"]!.status).toBe("done");
  });

  it("demotes only the MISMATCHED entry, leaving its neighbours alone", () => {
    const state = empty();
    recordDone(state, "backfill-a", 1, { pgEpoch: "A" });
    getEntry(state, "backfill-a").kind = "backfill";
    recordDone(state, "backfill-b", 1, { pgEpoch: "B" });
    getEntry(state, "backfill-b").kind = "backfill";
    saveMigrationState(state, dir);

    const back = loadMigrationState("B", dir);
    expect(back.migrations["backfill-a"]!.status).toBe("pending");
    expect(back.migrations["backfill-b"]!.status).toBe("done");
  });
});

describe("a corrupt ledger THROWS and QUARANTINES — it is never treated as absent", () => {
  it("quarantines a copy and throws when the YAML does not fit the schema", () => {
    // The whole reason this is not a `catch -> return empty`: an empty ledger says every migration is
    // pending, so the next boot re-runs all of them — including the mirror opt-out whose once-only run is
    // its entire safety argument. Failing the boot is the SAFE outcome, and the quarantine copy is what
    // lets a human recover the original after the format problem is understood.
    write(YAML.stringify({ schema_version: 1, migrations: { "posix-paths": { version: "three" } } }));
    expect(() => loadMigrationState(null, dir)).toThrow(/Corrupt migration_state\.yaml/);

    const quarantined = fs.readdirSync(dir).filter((f) => f.includes(".unreadable."));
    expect(quarantined).toHaveLength(1);
    // The copy must be the ORIGINAL bytes, not a re-serialization — that is what makes it recoverable.
    expect(fs.readFileSync(path.join(dir, quarantined[0]!), "utf8")).toContain("three");
    // And the original stays where it was: quarantine is a COPY, so a rollback to a build that can read the
    // file still finds it.
    expect(fs.existsSync(ledgerPath())).toBe(true);
  });

  it("throws on a file that is valid YAML but not a mapping at all", () => {
    write("just a sentence\n");
    expect(() => loadMigrationState(null, dir)).toThrow(/Corrupt migration_state\.yaml/);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".unreadable."))).toHaveLength(1);
  });

  it("throws on a YAML SYNTAX error rather than silently starting over", () => {
    // A truncated write (full disk, power loss) lands here. The syntax-error path throws without writing a
    // quarantine copy — acceptable only because it never deletes or rewrites the original, so nothing is
    // lost; the file itself is still the evidence.
    write("{ unclosed: \n");
    expect(() => loadMigrationState(null, dir)).toThrow(/Corrupt migration_state\.yaml/);
    expect(fs.existsSync(ledgerPath())).toBe(true);
  });

  it("treats an EMPTY file as empty state, not as corruption", () => {
    // `YAML.parse("")` is null, and the loader defaults that to `{}`. A zero-byte file is what an
    // interrupted first write leaves behind and there is nothing in it to lose, so throwing would fail the
    // boot for no gain.
    write("");
    expect(loadMigrationState(null, dir).migrations).toEqual({});
  });
});

describe("adoptSentinel — additive, one-way, and it KEEPS THE FILE (database_migration.mdx §1.1)", () => {
  const sentinel = ".sync_repo_default_migrated";
  const stamp = "2026-03-14T09:00:00.000Z";

  it("adopts using the SENTINEL'S OWN timestamp as finished_at, not now()", () => {
    // The sentinel's 24 bytes ARE the completion time. Stamping `now()` would record a lie that outlives
    // everyone who remembers otherwise — a migration that ran in March would read as having run at this
    // boot, which is exactly the sort of thing someone later reasons from.
    fs.writeFileSync(path.join(dir, sentinel), `${stamp}\n`);
    const state = empty();
    expect(adoptSentinel(state, "migrate-sync-repo-default", sentinel, 1, "local", dir)).toBe(true);

    const e = state.migrations["migrate-sync-repo-default"]!;
    expect(e.finished_at).toBe(stamp);
    expect(e.status).toBe("done");
    expect(e.applied_version).toBe(1);
    expect(e.kind).toBe("local");
    expect(e.attempts).toBe(1);
    expect(shouldRun(state, "migrate-sync-repo-default", "local", 1)).toBe(false);
  });

  it("LEAVES THE SENTINEL FILE ON DISK — deleting it is the documented hazard", () => {
    // The five sentinels cost 110 inodes and ~2.7 KB between them. Deleting them makes this ledger the ONLY
    // thing standing between a user's mirror opt-out and 105 repos silently re-enabling, because
    // migrate-sync-repo-default.ts gates on a bare `fs.existsSync` and a rollback to any build predating
    // this ledger would re-run every one of them. Keeping the file is the entire cost of being rollback-safe.
    const file = path.join(dir, sentinel);
    fs.writeFileSync(file, `${stamp}\n`);
    adoptSentinel(empty(), "migrate-sync-repo-default", sentinel, 1, "local", dir);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(`${stamp}\n`); // and unmodified
  });

  it("returns false when there is no sentinel — the migration simply has not run", () => {
    // Adoption is not the same as completion. With no sentinel we must leave the entry absent so
    // `shouldRun` says yes, rather than inventing a `done` nobody earned.
    const state = empty();
    expect(adoptSentinel(state, "migrate-sync-repo-default", sentinel, 1, "local", dir)).toBe(false);
    expect(state.migrations["migrate-sync-repo-default"]).toBeUndefined();
    expect(shouldRun(state, "migrate-sync-repo-default", "local", 1)).toBe(true);
  });

  it("does NOT clobber an entry that is already done", () => {
    // Adoption is one-way and additive. A real run recorded at version 4 must not be overwritten by a stale
    // sentinel claiming version 1 — that would re-arm the migration on the next version comparison.
    fs.writeFileSync(path.join(dir, sentinel), `${stamp}\n`);
    const state = empty();
    recordDone(state, "migrate-sync-repo-default", 4, { rows: 105 });
    const before = { ...state.migrations["migrate-sync-repo-default"]! };

    expect(adoptSentinel(state, "migrate-sync-repo-default", sentinel, 1, "local", dir)).toBe(false);
    const after = state.migrations["migrate-sync-repo-default"]!;
    expect(after.applied_version).toBe(4);
    expect(after.rows_migrated).toBe(105);
    expect(after.finished_at).toBe(before.finished_at);
  });

  it("does not clobber a `skipped` entry either", () => {
    fs.writeFileSync(path.join(dir, sentinel), `${stamp}\n`);
    const state = empty();
    getEntry(state, "m").status = "skipped";
    expect(adoptSentinel(state, "m", sentinel, 1, "local", dir)).toBe(false);
    expect(state.migrations["m"]!.status).toBe("skipped");
  });

  it("ADOPTS over a failed or half-finished entry — those are not completions", () => {
    fs.writeFileSync(path.join(dir, sentinel), `${stamp}\n`);
    const state = empty();
    recordStart(state, "m", "local", 1); // status: running, the shape a crash leaves behind
    expect(adoptSentinel(state, "m", sentinel, 1, "local", dir)).toBe(true);
    expect(state.migrations["m"]!.status).toBe("done");
    expect(state.migrations["m"]!.finished_at).toBe(stamp);
  });

  it("falls back to now() when the sentinel's contents are not a date, and still adopts", () => {
    // Some sentinels are zero-byte touch files. The FACT of the file is the signal; the timestamp is a
    // bonus. Refusing to adopt over an unreadable stamp would re-run the migration, which is the outcome
    // this whole mechanism exists to prevent.
    fs.writeFileSync(path.join(dir, sentinel), "yes\n");
    const state = empty();
    expect(adoptSentinel(state, "m", sentinel, 1, "local", dir)).toBe(true);
    const at = Date.parse(state.migrations["m"]!.finished_at!);
    expect(Number.isNaN(at)).toBe(false);
    expect(Math.abs(Date.now() - at)).toBeLessThan(10_000);
  });

  it("records a sweep adoption on last_swept_at, not finished_at", () => {
    // A sweep does not finish, it passes — so the field that carries a sweep's history is the one that must
    // be written, or the adopted sweep looks like it has never run.
    fs.writeFileSync(path.join(dir, sentinel), `${stamp}\n`);
    const state = empty();
    expect(adoptSentinel(state, "sdl-lfbridge", sentinel, 1, "sweep", dir)).toBe(true);
    expect(state.migrations["sdl-lfbridge"]!.last_swept_at).toBe(stamp);
    expect(state.migrations["sdl-lfbridge"]!.finished_at).toBeNull();
  });

  it("accepts an ABSOLUTE sentinel path as well as one relative to the state dir", () => {
    // Callers pass both forms; resolving the relative one against the state dir is what keeps this spec's
    // temp directory (and the LFB_STATE_DIR override generally) honest.
    const abs = path.join(dir, "nested-sentinel");
    fs.writeFileSync(abs, `${stamp}\n`);
    const state = empty();
    expect(adoptSentinel(state, "m", abs, 1, "local", dir)).toBe(true);
    expect(state.migrations["m"]!.finished_at).toBe(stamp);
  });
});

describe("recordDone on a sweep — last_swept_at always, last_found_at only on a find (§2.3)", () => {
  it("moves last_swept_at on every pass and leaves last_found_at null when nothing was found", () => {
    // The distinction IS the feature. "Swept" says the cost was paid; "found" says the cost was worth
    // paying. Collapsing them would make the sweep look permanently productive and nobody would ever
    // retire it.
    const state = empty();
    getEntry(state, "repair-empty-sync-repo-blocks").kind = "sweep";
    recordDone(state, "repair-empty-sync-repo-blocks", 1, { foundSomething: false });

    const e = state.migrations["repair-empty-sync-repo-blocks"]!;
    expect(e.last_swept_at).not.toBeNull();
    expect(e.last_found_at).toBeNull();
    expect(e.finished_at).toBeNull(); // a sweep never "finishes"
  });

  it("moves last_found_at when the pass CHANGED something", () => {
    const state = empty();
    getEntry(state, "repair-empty-sync-repo-blocks").kind = "sweep";
    recordDone(state, "repair-empty-sync-repo-blocks", 1, { foundSomething: true });
    const e = state.migrations["repair-empty-sync-repo-blocks"]!;
    expect(e.last_found_at).toBe(e.last_swept_at);
  });

  it("keeps a PREVIOUS last_found_at when a later pass finds nothing", () => {
    // The signal is "when did this last earn its keep", so a quiet pass must not erase the answer.
    const state = empty();
    getEntry(state, "s").kind = "sweep";
    recordDone(state, "s", 1, { foundSomething: true });
    const found = state.migrations["s"]!.last_found_at;
    recordDone(state, "s", 1, { foundSomething: false });
    expect(state.migrations["s"]!.last_found_at).toBe(found);
    expect(state.migrations["s"]!.last_swept_at).not.toBeNull();
  });

  it("uses finished_at, NOT last_swept_at, for a non-sweep", () => {
    const state = empty();
    recordDone(state, "posix-paths", 1, { foundSomething: true });
    const e = state.migrations["posix-paths"]!;
    expect(e.finished_at).not.toBeNull();
    expect(e.last_swept_at).toBeNull();
    expect(e.last_found_at).toBeNull();
  });

  it("clears a previous last_error so a recovered migration does not look broken forever", () => {
    const state = empty();
    getEntry(state, "m").last_error = "boom at 2026-08-01T00:00:00.000Z";
    recordDone(state, "m", 1);
    expect(state.migrations["m"]!.last_error).toBeNull();
  });
});

describe("the lease — a cross-process mutex the CLI and launchd workers also respect", () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();
  const past = () => new Date(Date.now() - 60_000).toISOString();

  it("grants the lease when nobody holds it", () => {
    const state = empty();
    expect(acquireLease(state)).toBe(true);
    expect(state.engine.lease_owner).toContain(String(process.pid));
    expect(Date.parse(state.engine.lease_expires_at!)).toBeGreaterThan(Date.now());
  });

  it("REFUSES a live lease held by a different owner", () => {
    // `backend.lock` guarantees one backend per machine but says nothing about the CLI or the launchd
    // workers, either of which can be mid-backfill while the backend boots. A backfill is resumable but not
    // re-entrant: two writers sharing one cursor would each believe they owned it, and the rows between
    // their positions would never be migrated.
    const state = empty();
    state.engine.lease_owner = "9999@other-host";
    state.engine.lease_expires_at = future();
    expect(acquireLease(state)).toBe(false);
    expect(state.engine.lease_owner).toBe("9999@other-host"); // and we did not steal it
  });

  it("TAKES an expired lease, so a crashed holder cannot wedge migrations forever", () => {
    // The lease is time-boxed precisely because a holder can be SIGKILLed with no chance to release. Without
    // expiry, one crash would block every future migration on the machine permanently.
    const state = empty();
    state.engine.lease_owner = "9999@other-host";
    state.engine.lease_expires_at = past();
    expect(acquireLease(state)).toBe(true);
    expect(state.engine.lease_owner).not.toBe("9999@other-host");
  });

  it("lets the SAME owner renew its own live lease", () => {
    // A long backfill re-acquires as it goes. Refusing here would make a migration lock itself out halfway.
    const state = empty();
    expect(acquireLease(state)).toBe(true);
    const first = state.engine.lease_expires_at;
    expect(acquireLease(state)).toBe(true);
    expect(Date.parse(state.engine.lease_expires_at!)).toBeGreaterThanOrEqual(Date.parse(first!));
  });

  it("takes the lease when an owner is recorded with no expiry at all", () => {
    // A ledger written by an older build, or truncated mid-update. An owner with no deadline is not a
    // holder we can wait out, so it must not be able to block forever.
    const state = empty();
    state.engine.lease_owner = "9999@other-host";
    state.engine.lease_expires_at = null;
    expect(acquireLease(state)).toBe(true);
  });

  it("releaseLease hands it straight back to another owner", () => {
    const state = empty();
    acquireLease(state);
    releaseLease(state);
    expect(state.engine.lease_owner).toBeNull();
    expect(state.engine.lease_expires_at).toBeNull();

    // Prove the release is effective from a foreign process's point of view, not just cosmetic.
    state.engine.lease_owner = null;
    expect(acquireLease(state)).toBe(true);
  });

  it("survives the round trip to disk — the mutex is only useful ACROSS processes", () => {
    const state = empty();
    acquireLease(state);
    saveMigrationState(state, dir);
    const back = loadMigrationState(null, dir);
    expect(back.engine.lease_owner).toBe(state.engine.lease_owner);
    expect(back.engine.lease_expires_at).toBe(state.engine.lease_expires_at);
  });
});

describe("fingerprintSources — re-arms a backfill when its SOURCE moves (§2)", () => {
  const file = (name: string, body: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  };

  it("is STABLE across calls on an unchanged set", () => {
    // Instability here would re-run every backfill on every boot — the fingerprint has to be a fact about
    // the files, never about the moment it was taken.
    const a = file("a.yaml", "one");
    const b = file("b.yaml", "two");
    const first = fingerprintSources([a, b]);
    expect(fingerprintSources([a, b])).toBe(first);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not depend on the ORDER the files are listed in", () => {
    // Callers build the list by globbing, and glob order is not guaranteed across platforms.
    const a = file("a.yaml", "one");
    const b = file("b.yaml", "two");
    expect(fingerprintSources([b, a])).toBe(fingerprintSources([a, b]));
  });

  it("CHANGES when a file's size changes", () => {
    const a = file("a.yaml", "one");
    const before = fingerprintSources([a]);
    fs.writeFileSync(a, "one plus considerably more content");
    expect(fingerprintSources([a])).not.toBe(before);
  });

  it("CHANGES when only the mtime moves, with the size identical", () => {
    // Deliberately NOT a content hash — the point is to stay cheap enough to run over 29,138 files at every
    // boot, so it trusts the same (size, mtime, ino) identity triple `yaml-store.ts` already trusts for its
    // parse cache. That only works if mtime alone is enough to move it.
    const a = file("a.yaml", "same-length!");
    const before = fingerprintSources([a]);
    const then = new Date(Date.now() - 86_400_000);
    fs.utimesSync(a, then, then);
    expect(fs.statSync(a).size).toBe(12); // the size really is unchanged
    expect(fingerprintSources([a])).not.toBe(before);
  });

  it("INCLUDES an absent file rather than ignoring it", () => {
    // A source that has been DELETED is a change to the source set, and one of the strongest reasons to
    // re-arm a backfill. Skipping missing files would make "a.yaml plus a deleted b.yaml" fingerprint
    // identically to "a.yaml alone", so the deletion would never be noticed.
    const a = file("a.yaml", "one");
    const missing = path.join(dir, "gone.yaml");
    expect(fingerprintSources([a, missing])).not.toBe(fingerprintSources([a]));
  });

  it("notices a previously-absent file APPEARING", () => {
    // The other direction of the same rule, and the one that matters at boot: a source that shows up must
    // re-arm the backfill that consumes it.
    const a = file("a.yaml", "one");
    const late = path.join(dir, "late.yaml");
    const before = fingerprintSources([a, late]);
    fs.writeFileSync(late, "arrived");
    expect(fingerprintSources([a, late])).not.toBe(before);
  });

  it("uses the RELATIVE path when a base is given, so the fingerprint survives a move", () => {
    // Two checkouts of the same tree at different absolute paths must agree; without the base they would
    // never match and the backfill would re-arm on every machine.
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-migbase-"));
    try {
      const here = file("a.yaml", "same");
      const there = path.join(sub, "a.yaml");
      fs.copyFileSync(here, there);
      fs.utimesSync(there, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      fs.utimesSync(here, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      // Same relpath, same size, same mtime — the inode still differs, so this asserts the SHAPE of the
      // input (a relative path is hashed, not an absolute one) rather than equality of the two digests.
      expect(fingerprintSources([here], dir)).not.toBe(fingerprintSources([here]));
      expect(fingerprintSources([here], dir)).toBe(fingerprintSources([here], dir));
    } finally {
      fs.rmSync(sub, { recursive: true, force: true });
    }
  });

  it("returns a stable digest for an empty source list", () => {
    expect(fingerprintSources([])).toBe(fingerprintSources([]));
    expect(fingerprintSources([])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
