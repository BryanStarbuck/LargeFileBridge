// `just db-backfill` — run the YAML → Postgres backfill from a terminal, with no web app running.
//
// WHY A TERMINAL ENTRY POINT AND NOT (yet) A BOOT STAGE. A backfill walks megabytes of YAML; boot is the one
// moment the user is already waiting. Running it here first means the numbers are measured before anybody
// decides to put it on the boot path, and it keeps the slice reversible — nothing about the running app
// changes until the areas are registered somewhere the app calls.
//
// The lease in `migration_state.yaml` is what makes this safe to run while the backend is up: the two
// processes cannot both hold it, so whichever gets there second reports `lease-held` and does nothing
// (config/migration-state.ts `acquireLease`).
import { runAllBackfills, rejectCount } from "./backfill.js";
import { registerUnitBackfills } from "../../modules/store-model/unit-backfill.js";
import { activeUrlSafe, closePool, probeDatabase, resolveDbMode } from "./pool.js";

async function main(): Promise<void> {
  if (resolveDbMode() === "off") {
    process.stderr.write("LFB_DB_MODE=off — refusing to backfill. Unset it (or use auto/required) and retry.\n");
    process.exit(2);
  }
  const probe = await probeDatabase();
  if (!probe.reachable) {
    process.stderr.write(`Database not reachable at ${activeUrlSafe()}: ${probe.error}\nRun \`just db-up\` first.\n`);
    await closePool();
    process.exit(1);
  }

  registerUnitBackfills();
  // Everything after `--only` is an area name; with none, every registered area runs in registration order.
  const args = process.argv.slice(2);
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? args.slice(onlyAt + 1) : undefined;

  const outcomes = await runAllBackfills(only);
  process.stdout.write(`${activeUrlSafe()}\n`);
  for (const o of outcomes) {
    const head = o.ran ? "ran" : `skipped (${o.skipped ?? o.error ?? "unknown"})`;
    process.stdout.write(
      `  ${o.name.padEnd(20)} ${head}\n` +
        `      rows=${o.rows} scopes=${o.scopesDone}/${o.scopesTotal} ` +
        `(unchanged=${o.scopesUnchanged} resumed=${o.scopesResumed} redone=${o.scopesRedone} failed=${o.scopesFailed})\n` +
        `      rejects=${o.rejects} (${await rejectCount(o.name)} on record) ms=${o.ms}\n` +
        (o.verification
          ? `      verify: yaml=${o.verification.yamlRows} pg=${o.verification.pgRows} ` +
            `mismatches=${o.verification.mismatches.length}` +
            (o.verification.mismatches.length
              ? `\n        - ${o.verification.mismatches.slice(0, 10).join("\n        - ")}\n`
              : "\n")
          : "") +
        (o.error ? `      error: ${o.error}\n` : ""),
    );
  }
  await closePool();
}

main().catch(async (e) => {
  process.stderr.write(`db-backfill failed: ${(e as Error).message}\n`);
  await closePool();
  process.exit(1);
});
