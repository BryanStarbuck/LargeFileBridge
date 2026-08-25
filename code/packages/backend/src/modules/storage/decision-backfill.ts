// BACKFILL AREA 4 — THE DECISION LEDGER (`backfill_decisions`, database_migration.mdx §4.3 area 4).
//
// WHAT IT MOVES, measured on this machine: 105 × `decisions.yaml`, 4,974,877 B, 18,234 events. The largest
// single ledger is 3,110,794 B / 11,423 events folding to 2,189 distinct paths — 5.2× write amplification,
// all of it real history and NONE of it compacted away here (see "no compaction" below).
//
// AND THEN THE SAME PARSER OVER THE SDL MIRRORS, with `origin='wire'`. `<sdl>/repos/<slug>-<uid>/
// decisions.yaml` is the copy that travels between the user's computers, and `copyTreeGen` unions it with
// the local ledger on EVERY mirror pass (`tracking-sync.service.ts:761` — `unionLedgerEvents` over two
// multi-megabyte parses). Running the same union ONCE here, resolved by the `decision_event_identity`
// UNIQUE instead of by re-parsing YAML, is the point of the leg.
//
// MEASURED BEFORE IT WAS WRITTEN, and the number is worth recording because it is the difference between a
// migration and a no-op: all 105 local ledgers have a matching mirror subtree, and those mirrors contribute
// ZERO events the local ledger does not already carry. The wire leg on THIS corpus is therefore a pure
// idempotency exercise — which is exactly what it should be on a fleet whose mirror passes are up to date,
// and which is why the equality gate below can be asserted against the LOCAL ledger alone.
//
// THREE RULES THIS AREA IS EASY TO GET WRONG:
//
//   1. `rel_path` IS BYTE-EXACT. Event identity is byte-exact (`ledger-merge.ts:24-26` joins the RAW path),
//      so a normalized copy is a DIFFERENT event and would re-insert beside the original on every run. The
//      generated `rel_posix` column is what the fold and every read key on.
//   2. NO COMPACTION, AND NO HAND-WRITTEN SORT. The ledger on disk is ALREADY post-compaction —
//      `serializeLedger` (`ledger-merge.ts:141-143`) compacts and sorts, and it is the ONE spelling shared
//      by `writeLedger`, the mirror and the reconcile. Re-compacting here would drop events that are on
//      disk, and the row count would then disagree with the file for reasons nobody could reconstruct.
//   3. `decision_event_identity` IS `UNIQUE NULLS NOT DISTINCT` AND INCLUDES `sid`. Both halves matter:
//      `decided_by` and `fingerprint` are `.nullable().default(null)` (schemas.ts:607/611), so without
//      NULLS NOT DISTINCT every re-run re-inserts them; and omitting `sid` — as one area analysis proposed
//      — would collapse genuinely distinct events, since the live charlie-kirk ledger carries FIVE distinct
//      sids for one storage.
//
// `file_decision` IS NEVER WRITTEN HERE. The `lfb_decision_fold` trigger maintains it from the events, so
// there is exactly one implementation of the fold rule and two computers cannot fold differently (0006).
import fs from "node:fs";
import path from "node:path";
import { DecisionsLedgerSchema, RepoUnitConfigSchema, type DecisionEvent } from "@lfb/shared";
import {
  registerBackfill,
  type BackfillArea,
  type BackfillContext,
  type BackfillScope,
  type BackfillVerification,
} from "../../shared/persistence/backfill.js";
import { readRawYaml } from "../../shared/persistence/raw-yaml.js";
import { isDirForKey } from "../../shared/store/keyed-dir.js";
import { expandHome } from "../../shared/home-path.js";
import { log } from "../../shared/logging.js";
import {
  listDirs,
  pinReposRoot,
  readMarker,
  sdlRoots,
  trackingDirFor,
} from "../store-model/unit-backfill.js";
import { repoKeyFor } from "./tracking-root.service.js";
import { foldLedger, readLedger, type FoldedDecision } from "./decisions.service.js";
import {
  countDecisionEvents,
  countFileDecisions,
  foldedDecisionsForUnit,
  insertDecisionEvents,
  unitIdForAbsPath,
} from "./decision.repo.js";

/** Rows per INSERT. `decision_event` has 10 columns, so `copyRows`' 65535-bind ceiling is far away; 500 is
 *  the knee the shared helper documents, and it makes the largest ledger 23 statements on a loopback socket. */
const BATCH = 500;

/** The local ledger's leg key. Legs are ordered `local` first, then the SDL roots alphabetically. */
const LOCAL_LEG = "local";

interface Leg {
  /** `local`, or the SDL root's directory name (`act3_large_files_bridge`, `personal_large_files_bridge`). */
  key: string;
  file: string;
}

interface DecisionScopeData {
  /** The `pin/r/<folder>` name — the same scope spelling and alphabetical cursor area 2 uses. */
  folder: string;
  /** The repo root, which is `unit.abs_path`. The only key this area needs to find its `unit_id`. */
  absPath: string;
  legs: Leg[];
}

/**
 * Every `decisions.yaml` this repo has, local first.
 *
 * THE MIRROR SUBTREE IS MATCHED BY `repoUid` SUFFIX, NEVER BY EXACT DIRECTORY NAME (`keyed-dir.ts
 * isDirForKey`) — `<sdl>/repos/` holds a mix of `<slug>-<uid>` and legacy bare `<uid>` directories, and
 * matching on the name would silently skip every subtree written before the rename.
 *
 * BOTH SDLs ARE SEARCHED, not just the one this repo's `.sync-repo` marker names. A repo that moved between
 * the company and Personal storage has a subtree in each, and the older one still holds events; leaving it
 * out would mean the union `copyTreeGen` performs is NOT the union this area performs, which is the one
 * thing that would make "done once here" untrue.
 */
function legsFor(trackingDir: string, roots: string[]): Leg[] {
  const legs: Leg[] = [];
  const local = path.join(trackingDir, "decisions.yaml");
  if (fs.existsSync(local)) legs.push({ key: LOCAL_LEG, file: local });

  const uid = readMarker(trackingDir)?.repoUid;
  if (!uid) return legs; // no shared identity → no mirror subtree can be named (see area 2's reject)

  const used = new Set<string>([LOCAL_LEG]);
  for (const root of roots) {
    const reposDir = path.join(root, "repos");
    const match = listDirs(reposDir).find((n) => isDirForKey(n, uid));
    if (!match) continue;
    const file = path.join(reposDir, match, "decisions.yaml");
    if (!fs.existsSync(file)) continue;
    // Two SDL roots CAN share a basename (a company storage and a personal one both cloned as `repos`, say).
    // The leg key is a cursor component, so it has to be unique within the scope or a resume would restart
    // the wrong leg.
    let key = path.basename(root);
    for (let i = 2; used.has(key); i += 1) key = `${path.basename(root)}#${i}`;
    used.add(key);
    legs.push({ key, file });
  }
  return legs;
}

export function decisionScopes(): BackfillScope[] {
  const roots = sdlRoots();
  const scopes: BackfillScope[] = [];
  for (const folder of listDirs(pinReposRoot())) {
    const configFile = path.join(pinReposRoot(), folder, "config.yaml");
    let absPath: string;
    try {
      const cfg = readRawYaml(configFile, RepoUnitConfigSchema);
      if (!cfg.repo.path.trim()) continue; // area 2 already rejected this one by name
      absPath = path.resolve(expandHome(cfg.repo.path));
    } catch {
      continue; // unreadable pin config — area 2 owns that reject; a second copy of it would be noise
    }
    const trackingDir = trackingDirFor(repoKeyFor(absPath));
    if (!trackingDir) continue; // no Local-Storage tracking dir → no ledger to migrate
    const legs = legsFor(trackingDir, roots);
    if (legs.length === 0) continue; // a repo nobody has decided anything in yet
    scopes.push({
      key: `r/${folder}`,
      // EVERY leg is part of the watermark: a mirror refreshed by a `git pull` must re-do this repo, and
      // only this repo. That is mechanic (a) doing the work the wire leg exists for.
      sources: legs.map((l) => l.file),
      data: { folder, absPath, legs } satisfies DecisionScopeData,
    });
  }
  return scopes;
}

/** `<leg>:<events consumed>` — the resume cursor. Legs run in `data.legs` order, always. */
export function parseCursor(cursor: string | null): { leg: string; offset: number } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf(":");
  if (at < 0) return null;
  const offset = Number(cursor.slice(at + 1));
  return Number.isFinite(offset) && offset >= 0 ? { leg: cursor.slice(0, at), offset } : null;
}

/**
 * One ledger event → one `decision_event` row. Exported because rule 1 in this file's header — `rel_path` is
 * BYTE-EXACT — is a single expression whose wrong version is silent: a normalized path is a DIFFERENT event
 * under `decision_event_identity`, so it would insert beside the original on every single run forever.
 */
export function toInsert(e: DecisionEvent, unitId: number, origin: "local" | "wire") {
  return {
    unitId,
    sid: e.sid,
    relPath: e.path, // BYTE-EXACT — rule 1 in the header
    fingerprint: e.fingerprint,
    asked: e.asked,
    ipfs: e.ipfs,
    gitignore: e.gitignore,
    decidedBy: e.decided_by,
    decidedAt: e.decided_at,
    origin,
  };
}

async function runDecisionScope(data: DecisionScopeData, ctx: BackfillContext): Promise<number> {
  const unitId = await unitIdForAbsPath(data.absPath);
  if (unitId === null) {
    // `decision_event.unit_id` is NOT NULL and REFERENCES `unit` — there is nowhere to put these events.
    // A reject rather than a throw: one un-adopted repo must not fail the other 104 (mechanic (c)).
    ctx.reject(data.legs[0]!.file, `no lfb.unit row for ${data.absPath} — run the adopt_units backfill first`);
    return 0;
  }

  const resume = parseCursor(ctx.resumeFrom);
  const startLeg = resume ? data.legs.findIndex((l) => l.key === resume.leg) : 0;
  let rows = ctx.rowsBefore;

  for (let li = startLeg < 0 ? 0 : startLeg; li < data.legs.length; li += 1) {
    const leg = data.legs[li]!;
    // Only the leg the cursor names starts part-way in; every later leg starts at zero.
    const from = resume && li === startLeg && leg.key === resume.leg ? resume.offset : 0;

    let events: DecisionEvent[];
    try {
      // `readRawYaml`, never `readYaml()` (R6 / §4.2): 4.97 MB of ledger through yaml-store's 4,096-entry
      // FIFO `rawCache` would evict the hot unit configs this workstream exists to keep warm.
      events = readRawYaml(leg.file, DecisionsLedgerSchema).events;
    } catch (e) {
      // A ledger that will not parse is recorded and skipped — the other legs and the other repos continue.
      ctx.reject(leg.file, `decision ledger unreadable: ${(e as Error).message}`);
      continue;
    }

    const origin = leg.key === LOCAL_LEG ? "local" : "wire";
    for (let i = from; i < events.length; i += BATCH) {
      const batch = events.slice(i, i + BATCH);
      rows += await insertDecisionEvents(batch.map((e) => toInsert(e, unitId, origin)));
      // The cursor is EXACT even though `rows` is only a count of what was actually inserted: a re-run from
      // the cursor re-reads the same slice boundary, and the UNIQUE makes re-inserting the tail harmless.
      ctx.checkpoint(`${leg.key}:${i + batch.length}`, rows);
    }
    // An empty leg still has to advance the cursor, or a resume would re-open it from zero forever.
    if (events.length === 0) ctx.checkpoint(`${leg.key}:0`, rows);
  }
  return rows;
}

// ── verification (database_migration.mdx §4.5) ──────────────────────────────────────────────────────────

/** One unit's gate result, for the report the CLI and the spec both print. */
export interface DecisionGateResult {
  absPath: string;
  unitId: number | null;
  yamlPaths: number;
  pgPaths: number;
  mismatches: string[];
}

function sameFold(a: FoldedDecision, b: FoldedDecision): boolean {
  return (
    a.sid === b.sid &&
    a.asked === b.asked &&
    a.ipfs === b.ipfs &&
    a.gitignore === b.gitignore &&
    (a.decidedBy ?? null) === (b.decidedBy ?? null) &&
    a.decidedAt === b.decidedAt
  );
}

/**
 * THE GATE, AND IT IS THE WHOLE JUSTIFICATION FOR THE READ CUTOVER.
 *
 * For every unit: `file_decision` must equal `foldLedger(readLedger(root))` computed by the TypeScript
 * function that owns the rule. Not a row count — the full tuple, per path, including `sid`, both axes,
 * `decided_by` and the `decided_at` spelling.
 *
 * This is a direct, executable equality against the code the cutover replaces (§4.5), and it is what makes
 * the SQL fold trustworthy: the fold is implemented in plpgsql (`lfb.fold_decision`) and its tie-break is a
 * row comparison with plain `>`, deliberately not `localeCompare`, so two computers cannot disagree because
 * of collation. That is a DIFFERENT expression of `foldLedger`'s rule, and the only honest way to claim they
 * agree is to run both over the real corpus and compare.
 */
export async function gateEveryUnit(limitPerUnit = 6): Promise<DecisionGateResult[]> {
  const out: DecisionGateResult[] = [];
  for (const scope of decisionScopes()) {
    const data = scope.data as DecisionScopeData;
    const unitId = await unitIdForAbsPath(data.absPath);
    const mismatches: string[] = [];
    let yaml: Map<string, FoldedDecision>;
    try {
      yaml = foldLedger(readLedger(data.absPath));
    } catch (e) {
      out.push({ absPath: data.absPath, unitId, yamlPaths: -1, pgPaths: -1, mismatches: [`oracle failed: ${(e as Error).message}`] });
      continue;
    }
    if (unitId === null) {
      // No unit row means the read cutover falls back to the ledger for this repo anyway, so it is not a
      // gate failure — but it IS worth reporting, because it means `adopt_units` has not seen this repo.
      out.push({ absPath: data.absPath, unitId, yamlPaths: yaml.size, pgPaths: 0, mismatches: [] });
      continue;
    }
    const pg = await foldedDecisionsForUnit(unitId);
    for (const [key, want] of yaml) {
      const got = pg.get(key);
      if (!got) {
        if (mismatches.length < limitPerUnit) mismatches.push(`missing in file_decision: ${key}`);
        continue;
      }
      if (!sameFold(want, got) && mismatches.length < limitPerUnit) {
        mismatches.push(
          `differs at ${key}: yaml=${JSON.stringify(want)} pg=${JSON.stringify(got)}`,
        );
      }
    }
    for (const key of pg.keys()) {
      if (!yaml.has(key) && mismatches.length < limitPerUnit) mismatches.push(`extra in file_decision: ${key}`);
    }
    out.push({ absPath: data.absPath, unitId, yamlPaths: yaml.size, pgPaths: pg.size, mismatches });
  }
  return out;
}

/**
 * The plan's cross-check: the frozen `pin/r/<folder>/config.yaml → decisions:` enum map against the folded
 * IPFS axis. LOGGED, NEVER RECONCILED — the two are supposed to agree, and any drift is PRE-EXISTING
 * corruption worth surfacing rather than a migration picking a winner (§4.3 area 4).
 *
 * `undecided` enum entries are skipped: the enum spells "undecided" where the fold spells "no row", so they
 * are the same statement and comparing them would manufacture disagreements.
 */
async function crossCheckFrozenEnum(): Promise<{ compared: number; disagreements: number }> {
  let compared = 0;
  let disagreements = 0;
  for (const scope of decisionScopes()) {
    const data = scope.data as DecisionScopeData;
    const unitId = await unitIdForAbsPath(data.absPath);
    if (unitId === null) continue;
    let cfg;
    try {
      cfg = readRawYaml(path.join(pinReposRoot(), data.folder, "config.yaml"), RepoUnitConfigSchema);
    } catch {
      continue;
    }
    const pg = await foldedDecisionsForUnit(unitId);
    for (const [rawPath, value] of Object.entries(cfg.decisions)) {
      if (value === "undecided") continue;
      // The enum map is POSIX-healed at the fold, so compare the healed key — a Windows-era `\` entry is the
      // same statement about the same file, not a disagreement (repo__list_syns.mdx §6.1).
      const key = rawPath.includes("\\") ? rawPath.replace(/\\/g, "/") : rawPath;
      compared += 1;
      const row = pg.get(key);
      const expected = value === "sync";
      if (!row || !row.asked || row.ipfs !== expected) {
        disagreements += 1;
        if (disagreements <= 20) {
          log.warn(
            "migrate",
            `backfill_decisions: frozen enum disagrees with the fold — ${data.folder}:${key} ` +
              `enum=${value} fold=${row ? (row.asked ? (row.ipfs ? "sync" : "ignore") : "undecided(tombstone)") : "no-row"}`,
          );
        }
      }
    }
  }
  return { compared, disagreements };
}

export const BACKFILL_DECISIONS: BackfillArea = {
  name: "backfill_decisions",
  version: 1,
  kind: "backfill",
  sources: () => decisionScopes().flatMap((s) => s.sources),
  scopes: () => decisionScopes(),

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    return { rows: await runDecisionScope(scope.data as DecisionScopeData, ctx) };
  },

  async verify(): Promise<BackfillVerification> {
    const mismatches: string[] = [];

    // §4.5's row assertion: count(decision_event WHERE origin='local') = the events on disk.
    let yamlRows = 0;
    for (const scope of decisionScopes()) {
      const data = scope.data as DecisionScopeData;
      const local = data.legs.find((l) => l.key === LOCAL_LEG);
      if (!local) continue;
      try {
        yamlRows += readRawYaml(local.file, DecisionsLedgerSchema).events.length;
      } catch {
        // Already in the reject table with the parser's own message; it must not also inflate the expected
        // count, or the assertion below would fail for a file we deliberately skipped.
      }
    }
    const pgLocal = await countDecisionEvents("local");
    if (pgLocal !== yamlRows) mismatches.push(`decision_event origin='local' is ${pgLocal}, ledgers hold ${yamlRows}`);

    // THE GATE. Any per-unit disagreement fails the area and blocks the read cutover (§4.5).
    const gate = await gateEveryUnit();
    for (const g of gate) {
      if (g.mismatches.length) mismatches.push(`${g.absPath}: ${g.mismatches.join(" | ")}`);
      else if (g.unitId !== null && g.yamlPaths !== g.pgPaths) {
        mismatches.push(`${g.absPath}: fold size ${g.pgPaths} != ${g.yamlPaths}`);
      }
    }

    const cross = await crossCheckFrozenEnum();
    log.info(
      "migrate",
      `backfill_decisions: frozen-enum cross-check compared ${cross.compared} entr(ies), ` +
        `${cross.disagreements} disagreement(s) — logged only, never reconciled`,
    );

    return { yamlRows, pgRows: await countDecisionEvents(), mismatches };
  },
};

/** The maintained fold's fleet-wide size, for the CLI report. */
export async function foldedRowCount(): Promise<number> {
  return countFileDecisions();
}

/**
 * Register area 4. Explicit, not a module-load side effect — the specs import `gateEveryUnit` on its own and
 * must not silently mutate the global registry by doing so (the same reason `registerUnitBackfills` is a
 * function).
 */
export function registerDecisionBackfills(): void {
  registerBackfill(BACKFILL_DECISIONS);
}
