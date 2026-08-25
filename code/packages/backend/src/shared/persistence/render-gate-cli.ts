// `just db-render-gate` — THE RENDER EQUALITY GATE (database.mdx §2.3), from a terminal.
//
// For every Category-B document on this machine: render it from Postgres THROUGH ITS DESIGNATED SERIALIZER
// and compare sha256 against the bytes on disk. ZERO DIFFS, OR THE CUTOVER DOES NOT HAPPEN.
//
// It lives beside `migrate-cli.ts` and `backfill-cli.ts` because it is the same kind of thing — a one-shot
// operator command against the local database — and because it must run with NO WEB APP UP. It is not a
// route and must never become one: the sidecar scope walks 29,138 documents and hashes ~150 MB.
//
//   just db-render-gate                # the four whole-unit documents per repo (fast: a second or two)
//   just db-render-gate --sidecars     # + the 29,138-document sidecar plane (minutes)
//   just db-render-gate --record       # also stamp doc_render, seeding the mirror work list
//
// WHY IT PRINTS THE UNSOURCED TALLY AS PROMINENTLY AS THE DIFF COUNT. A document Postgres cannot render is
// not a passing document — it is a document outside the gate. Reporting "0 diffs" while silently skipping
// four of the six document classes would be exactly the dishonest green §2.3 was written to prevent, so the
// summary always names what was NOT covered and why.
import { runRenderGate, type GateReport } from "../../modules/storage/doc-render.service.js";
import { refreshDbHealth } from "./db.js";
import { activeUrlSafe, closePool, probeDatabase, resolveDbMode } from "./pool.js";

function summarize(report: GateReport, sidecars: boolean): void {
  const w = process.stdout.write.bind(process.stdout);
  w(`\n${activeUrlSafe()}\n`);
  w(`scope: ${sidecars ? "whole-unit documents + the sidecar plane" : "whole-unit documents only"}\n`);
  w(`\n  documents on disk examined : ${report.scanned}\n`);
  w(`  rendered and BYTE-IDENTICAL: ${report.matched}\n`);
  w(`  rendered and DIFFERENT     : ${report.diffs.length}   <-- the gate\n`);
  if (report.healed.length) {
    // NOT a failure, and named so nobody has to rediscover why. These are documents whose own `path:` field
    // still carries a pre-heal Windows spelling while the file itself already sits at the healed location;
    // Postgres files them under the POSIX spelling because `rel_posix` is the generated PRIMARY KEY, which
    // is what makes the stray-path fork structurally impossible (database.mdx §3). Postgres is right and the
    // document is stale.
    w(`  stray-path HEALED (intended, not counted): ${report.healed.length}\n`);
    for (const h of report.healed.slice(0, 5)) w(`      ${h.file}\n`);
    if (report.healed.length > 5) w(`      … and ${report.healed.length - 5} more\n`);
  }
  w(`  no lfb.file row (backfill gap, not a renderer fault): ${report.absentInPg}\n`);

  if (report.unsourced.size) {
    w(`\n  NOT COVERED — Postgres has no source for these documents:\n`);
    for (const [reason, n] of [...report.unsourced].sort((a, b) => b[1] - a[1])) {
      w(`    ${String(n).padStart(7)}  ${reason}\n`);
    }
  }

  if (report.diffs.length) {
    // Group by (doc, firstDelta shape) so 20,000 sidecars failing the same way read as ONE finding rather
    // than 20,000 lines nobody scrolls through.
    const byShape = new Map<string, { n: number; example: string; delta: string | null }>();
    for (const d of report.diffs) {
      const shape = `${d.doc}/${d.reason}/${(d.firstDelta ?? "").replace(/"[^"]*"/g, '"…"')}`;
      const hit = byShape.get(shape);
      if (hit) hit.n += 1;
      else byShape.set(shape, { n: 1, example: d.file, delta: d.firstDelta });
    }
    w(`\n  THE DIFFS, grouped by shape (${byShape.size} distinct):\n`);
    for (const [, v] of [...byShape].sort((a, b) => b[1].n - a[1].n)) {
      w(`\n    ${v.n} document(s)\n      example : ${v.example}\n      delta   : ${v.delta ?? "(file absent on disk)"}\n`);
    }
  }

  w(`\n  ${report.diffs.length === 0 ? "GATE PASSES for the scope above." : "GATE FAILS — the Postgres-fed write stays OFF."}\n`);
  w(`  ${report.ms} ms\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sidecars = args.includes("--sidecars");
  const record = args.includes("--record");

  if (resolveDbMode() === "off") {
    process.stderr.write("LFB_DB_MODE=off — there is nothing to render from. Unset it and retry.\n");
    process.exit(2);
  }
  const probe = await probeDatabase();
  if (!probe.reachable) {
    process.stderr.write(`Database not reachable at ${activeUrlSafe()}: ${probe.error}\nRun \`just db-up\` first.\n`);
    await closePool();
    process.exit(1);
  }
  await refreshDbHealth();

  let done = 0;
  const report = await runRenderGate({
    sidecars,
    record,
    onUnit: (u) => {
      done += 1;
      // One line per unit, so a multi-minute sidecar run is visibly progressing rather than apparently hung.
      process.stdout.write(
        `  [${String(done).padStart(3)}] ${String(u.matched).padStart(6)} match  ` +
          `${String(u.diffs.length).padStart(6)} diff  ${String(u.absentInPg).padStart(6)} no-row  ${u.absPath}\n`,
      );
    },
  });
  summarize(report, sidecars);
  await closePool();
  process.exit(report.diffs.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  process.stderr.write(`db-render-gate failed: ${(e as Error).stack ?? (e as Error).message}\n`);
  await closePool();
  process.exit(1);
});
