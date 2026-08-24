// `just db-migrate` — apply the schema migrations from a terminal, with no web app running.
//
// WHY A SEPARATE ENTRY POINT AND NOT `psql -f`: the runner is the only thing that knows the ledger rules —
// forward-only ordering, the `pg_advisory_lock(2306411)` that stops two starts applying migration N
// together, and the `sha256(name || ':' || sql)` checksum whose deliberate omission of the id is what keeps
// a legal merge renumbering from reading as tampering (migrate.ts). Running the .sql files by hand would
// leave the ledger empty and the next boot would apply them all again.
//
// It shares the app's pool and its `{{S}}` substitution, so a developer at a `just db-psql` prompt and the
// booting backend are looking at the same schema by construction.
import { runSchemaMigrations, ledgerHead } from "./migrate.js";
import { activeUrlSafe, getPool, closePool, probeDatabase, resolveDbMode } from "./pool.js";

async function main(): Promise<void> {
  const mode = resolveDbMode();
  if (mode === "off") {
    // Refuse rather than quietly do nothing: someone who typed `just db-migrate` wants migrations applied,
    // and "0 applied" would look like success.
    process.stderr.write("LFB_DB_MODE=off — refusing to migrate. Unset it (or use auto/required) and retry.\n");
    process.exit(2);
  }
  const pool = getPool();
  if (!pool) {
    process.stderr.write("No database URL configured (LFB_DATABASE_URL_FILE / DATABASE_URL).\n");
    process.exit(2);
  }
  const probe = await probeDatabase();
  if (!probe.reachable) {
    process.stderr.write(`Database not reachable at ${activeUrlSafe()}: ${probe.error}\nRun \`just db-up\` first.\n`);
    await closePool();
    process.exit(1);
  }
  const before = await ledgerHead(pool);
  const result = await runSchemaMigrations(pool);
  process.stdout.write(
    `${activeUrlSafe()}\n` +
      `  applied now      : ${result.applied}\n` +
      `  already applied  : ${result.alreadyApplied}\n` +
      `  ledger head      : ${before} -> ${result.head}\n`,
  );
  await closePool();
}

main().catch(async (e) => {
  process.stderr.write(`db-migrate failed: ${(e as Error).message}\n`);
  await closePool();
  process.exit(1);
});
