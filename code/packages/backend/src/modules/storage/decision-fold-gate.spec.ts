// THE GATE — `lfb.file_decision` MUST EQUAL `foldLedger(readLedger(root))`, FOR EVERY UNIT.
//
// This is the assertion the read cutover rests on, and it is mandatory (database_migration.mdx §4.5). The
// fold is implemented TWICE by necessity: once in TypeScript (`decisions.service.ts foldLedger` — latest
// `decided_at` wins, ties broken by `decided_by` with NULL sorting as '') and once in plpgsql
// (`lfb.fold_decision`, migration 0006 — a row comparison with plain `>`, deliberately NOT `localeCompare`,
// so two computers cannot disagree because of collation). Two implementations of one rule agree only if
// somebody runs both over real data and compares, so that is what this file does.
//
// IT COMPARES THE FULL TUPLE, NOT A ROW COUNT. `sid`, both axes, `asked`, `decided_by` and the `decided_at`
// SPELLING — because the cutover hands these values straight to the One-Repo row's provenance columns, and a
// count-only check would pass while every row showed the wrong person and the wrong day.
//
// IT SKIPS, LOUDLY, WITHOUT A DATABASE. `LFB_DB_MODE=off`, no `DATABASE_URL`, or an unreachable server are
// all the documented `auto` posture (R2) and not a test failure — on such a machine `foldLedgerForRepo` uses
// the oracle directly and there is nothing to compare it against. Point it at a migrated database to make it
// mean something:
//
//     LFB_GATE_DATABASE_URL=postgresql://localhost:5432/<db> LFB_GATE_STATE_DIR=<state root> \
//       CI=true ./node_modules/.bin/vitest run src/modules/storage/decision-fold-gate.spec.ts
//
// THE `LFB_GATE_*` SPELLING IS NOT A WHIM. `vitest.config.ts` pins `LFB_STATE_DIR` to a throwaway temp dir
// and `LFB_DB_MODE` to `off` for the WHOLE suite, deliberately — an unredirected spec would otherwise read
// and write the user's real state root and the user's real `largefilebridge` database mid-run, which has
// already happened once and was investigated as a production fault. `test.env` WINS over the shell, so a
// gate run cannot simply export the normal variables; it hands them in under names the baseline does not
// clamp, and this file opts in explicitly.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { DecisionsLedgerSchema } from "@lfb/shared";
import { decisionScopes, gateEveryUnit } from "./decision-backfill.js";
import { readRawYaml } from "../../shared/persistence/raw-yaml.js";
import { countDecisionEvents, foldedDecisionsForUnit, unitIdForAbsPath } from "./decision.repo.js";
import { refreshDbHealth } from "../../shared/persistence/db.js";
import { probeDatabase, resolveDbMode } from "../../shared/persistence/pool.js";

// Opt in to the real corpus and the real (scratch) database, BEFORE anything resolves a path or a pool.
// Both resolvers read `process.env` on every call — nothing here is cached at import time — so assigning at
// module scope is enough and no module needs re-importing.
if (process.env.LFB_GATE_STATE_DIR) process.env.LFB_STATE_DIR = process.env.LFB_GATE_STATE_DIR;
if (process.env.LFB_GATE_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.LFB_GATE_DATABASE_URL;
  process.env.LFB_DB_MODE = "required";
}

const reachable = resolveDbMode() !== "off" && (await probeDatabase()).reachable;
if (reachable) await refreshDbHealth();

describe.skipIf(!reachable)("file_decision equals foldLedger(readLedger(root)) for EVERY unit", () => {
  it("agrees on every path, every axis, every attribution and every timestamp", async () => {
    const results = await gateEveryUnit();
    expect(results.length).toBeGreaterThan(0);

    const failures = results.filter((r) => r.mismatches.length > 0);
    const sized = results.filter((r) => r.unitId !== null && r.yamlPaths !== r.pgPaths);

    // The per-unit report, printed whether it passes or fails — "which repos does this cover, and how big
    // are they" is the question anyone reading a green gate asks next.
    const covered = results.filter((r) => r.unitId !== null);
    const nonEmpty = covered.filter((r) => r.yamlPaths > 0);
    process.stdout.write(
      `\n  gate: ${covered.length} unit(s) with a Postgres row, ${nonEmpty.length} carrying decisions, ` +
        `${results.length - covered.length} not yet adopted (those fall back to the ledger)\n`,
    );
    for (const r of nonEmpty.sort((a, b) => b.yamlPaths - a.yamlPaths)) {
      process.stdout.write(`    ${String(r.yamlPaths).padStart(5)} paths  ${r.absPath}\n`);
    }

    expect(failures.map((f) => `${f.absPath}: ${f.mismatches.join(" | ")}`)).toEqual([]);
    expect(sized.map((s) => `${s.absPath}: pg ${s.pgPaths} != yaml ${s.yamlPaths}`)).toEqual([]);
  });

  it("keeps every event — the 5.2x write amplification is history, not noise to compact away", async () => {
    // `serializeLedger` (ledger-merge.ts:141-143) already compacted this log before it reached disk, and it
    // is the ONE spelling shared by `writeLedger`, the mirror and the reconcile. A backfill that compacted
    // AGAIN would hold fewer events than the file it read, and no later reader could reconstruct why.
    const perUnit: string[] = [];
    let expected = 0;
    for (const scope of decisionScopes()) {
      const data = scope.data as { absPath: string; legs: { key: string; file: string }[] };
      const local = data.legs.find((l) => l.key === "local");
      if (!local || !fs.existsSync(local.file)) continue;
      const onDisk = readRawYaml(local.file, DecisionsLedgerSchema).events.length;
      expected += onDisk;
      if (onDisk === 0) continue;
      const unitId = await unitIdForAbsPath(data.absPath);
      if (unitId === null) continue;
      const folded = await foldedDecisionsForUnit(unitId);
      perUnit.push(`${path.basename(data.absPath)}: ${onDisk} events -> ${folded.size} folded paths`);
    }
    process.stdout.write(`\n  ${perUnit.join("\n  ")}\n`);
    expect(await countDecisionEvents("local")).toBe(expected);
  });
});
