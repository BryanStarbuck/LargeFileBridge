// THE DECISION DATA-ACCESS LAYER — `lfb.decision_event` (the append-only ledger) and `lfb.file_decision`
// (THE MAINTAINED FOLD), database.mdx §9 slice 6 / migration 0006.
//
// WHY THIS TABLE PAIR IS THE HEADLINE OF THE WHOLE WORKSTREAM. `foldLedger(readLedger(root))` is a
// DISTINCT-ON-by-hand over an append log that has 5.2× write amplification: the largest ledger on this
// machine is 3,110,794 B / 11,423 events folding to 2,189 distinct paths, and it is re-parsed and re-folded
// on EVERY composition of the One-Repo table. 0006's header records the measurement that decided the shape
// — the raw fold at 96.0 ms, the same thing forced through a covering index at 40.2 ms, and the maintained
// table at 0.23 ms. So the fold is STORED, and it is stored by a TRIGGER (`lfb.fold_decision`) rather than
// by anything in this file: two computers must not be able to fold differently, and the only way to
// guarantee that is to have exactly one implementation of the rule.
//
// WHICH MEANS: NOTHING HERE EVER WRITES `file_decision`. Callers insert events; the trigger folds. A
// hand-written upsert into `file_decision` would be a second implementation of `foldLedger`'s tie-break,
// living one file away from the one in SQL — and the two would disagree the first time either changed.
//
// Every function is Postgres-only and safe with no database (`shared/persistence/db.ts` answers empty), and
// none of them is a fallback: the caller owns the YAML path, because only the caller knows what the YAML
// answer would have been (R2 / database.mdx §7).
import { copyRows, q, q1 } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";
import type { FoldedDecision } from "./decisions.service.js";

/**
 * THE ONE SPELLING OF `decided_at` ON THE WAY OUT.
 *
 * `foldLedger` returns `decidedAt` as the ISO-8601 string that was in the YAML, and every consumer treats it
 * as that string (the One-Repo row's `decidedAt`, the provenance tooltip, the equality gate in the specs).
 * `timestamptz` has no spelling of its own, and the pg driver would hand back a JS `Date` whose rendering
 * depends on the driver's parser and this process's timezone — so the format is pinned HERE, in SQL, to
 * exactly what `Date.prototype.toISOString()` produces: UTC, three fractional digits, `Z`.
 *
 * Measured on the live corpus: all 18,234 events on disk carry exactly that shape
 * (`2026-07-20T19:08:27.841Z`, `grep -o 'decided_at: .*' | sed 's/[0-9]/N/g' | sort -u` → one row), which is
 * unsurprising — the only writer is `new Date().toISOString()` in `recordDecision`. Sub-millisecond
 * precision cannot enter this column from our own writer, and if it ever did through a peer, this render
 * would truncate it rather than disagree in format.
 */
const decidedAtIso = (col: string): string =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ── decision_event (the append-only ledger) ─────────────────────────────────────────────────────────────

export interface DecisionEventInsert {
  unitId: number;
  sid: string;
  /**
   * BYTE-EXACT, never normalized. `rel_posix` is a GENERATED column (`replace(rel_path, '\', '/')`) and is
   * what the fold and every read key on; `rel_path` keeps the spelling the event was recorded with because
   * EVENT IDENTITY must stay byte-exact (`ledger-merge.ts:24-26` — the union key includes the raw path, so a
   * normalized copy would be a DIFFERENT event and would re-insert forever beside the original).
   */
  relPath: string;
  fingerprint: string | null;
  asked: boolean;
  ipfs: boolean;
  gitignore: boolean;
  decidedBy: string | null;
  /** The ISO-8601 string exactly as the ledger carries it. Postgres parses it into the timestamptz. */
  decidedAt: string;
  origin: "local" | "wire";
}

const EVENT_COLUMNS = [
  "unit_id",
  "sid",
  "rel_path",
  "fingerprint",
  "asked",
  "ipfs",
  "gitignore",
  "decided_by",
  "decided_at",
  "origin",
];

/**
 * Append events. Returns how many were ACTUALLY inserted — duplicates are not an error and not a row.
 *
 * `ON CONFLICT ON CONSTRAINT decision_event_identity DO NOTHING` is the whole idempotency story for this
 * area, and the constraint it names is declared `UNIQUE NULLS NOT DISTINCT` for a reason worth restating at
 * the call site: `fingerprint` and `decided_by` are `.nullable().default(null)` (schemas.ts:607/611), and
 * under Postgres's default NULLS DISTINCT two byte-identical events carrying a NULL in either column would
 * never collide — so every backfill pass, every mirror-in and every re-run would insert them again, forever
 * (database_migration.mdx §4.1(b)).
 *
 * DO NOTHING rather than DO UPDATE because an event is IMMUTABLE: its identity is every field it has, so
 * there is nothing left to update. In particular a wire copy of an event we already hold locally must NOT
 * overwrite `origin` — the local claim is the stronger one and the wire copy carries no new information.
 */
export async function insertDecisionEvents(rows: DecisionEventInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  return copyRows(
    `${S}.decision_event`,
    EVENT_COLUMNS,
    rows.map((r) => [
      r.unitId,
      r.sid,
      r.relPath,
      r.fingerprint,
      r.asked,
      r.ipfs,
      r.gitignore,
      r.decidedBy,
      r.decidedAt,
      r.origin,
    ]),
    { onConflict: "ON CONFLICT ON CONSTRAINT decision_event_identity DO NOTHING" },
  );
}

export async function countDecisionEvents(origin?: "local" | "wire"): Promise<number> {
  const r = origin
    ? await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.decision_event WHERE origin = $1`, [origin])
    : await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.decision_event`);
  return Number(r?.n ?? 0);
}

// ── unit lookup (the join every decision read starts from) ──────────────────────────────────────────────

/**
 * `abs_path` → `unit_id`, or null when this directory is not (yet) a unit row.
 *
 * NULL IS A REAL ANSWER AND CALLERS MUST HONOR IT. A repo enlisted since the last `adopt_units` pass has a
 * `decisions.yaml` and no unit row, so its decisions cannot be written or read here at all — the caller
 * falls back to the ledger, which is still the authority (R1: the YAML writer never stopped).
 */
export async function unitIdForAbsPath(absPath: string): Promise<number | null> {
  const row = await q1<{ unit_id: string }>(`SELECT unit_id::text AS unit_id FROM ${S}.unit WHERE abs_path = $1`, [
    absPath,
  ]);
  return row ? Number(row.unit_id) : null;
}

// ── file_decision (the maintained fold) ─────────────────────────────────────────────────────────────────

interface FoldRow {
  rel_posix: string;
  sid: string;
  asked: boolean;
  ipfs: boolean;
  gitignore: boolean;
  decided_by: string | null;
  decided_at: string;
}

function toFolded(rows: FoldRow[]): Map<string, FoldedDecision> {
  const out = new Map<string, FoldedDecision>();
  for (const r of rows) {
    out.set(r.rel_posix, {
      sid: r.sid,
      path: r.rel_posix,
      asked: r.asked,
      ipfs: r.ipfs,
      gitignore: r.gitignore,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
    });
  }
  return out;
}

/**
 * THE READ THIS SLICE CUTS OVER (R3) — the replacement for `foldLedger(readLedger(root))`.
 *
 * One join on `unit_abs_path_unique` plus a PK range scan of `file_decision (unit_id, rel_posix)`. There is
 * no DISTINCT ON, no sort and no GROUP BY on this path, which is the entire point of the maintained table:
 * the equivalent computed over the raw log measured 96.0 ms for the largest unit (0006's header).
 *
 * `null` — not an empty map — when the unit is unknown or holds no folded rows, so the caller can tell
 * "Postgres does not know about this repo" from "this repo has no decisions". Handing back an empty map for
 * the first case would silently strip provenance from every row of a repo enlisted after the last backfill.
 */
export async function foldedDecisionsForUnitPath(absPath: string): Promise<Map<string, FoldedDecision> | null> {
  const rows = await q<FoldRow>(
    `SELECT d.rel_posix, d.sid, d.asked, d.ipfs, d.gitignore, d.decided_by,
            ${decidedAtIso("d.decided_at")} AS decided_at
       FROM ${S}.file_decision d
       JOIN ${S}.unit u ON u.unit_id = d.unit_id
      WHERE u.abs_path = $1`,
    [absPath],
  );
  return rows.length ? toFolded(rows) : null;
}

/** The same fold, addressed by `unit_id` — what the verification gate iterates with. */
export async function foldedDecisionsForUnit(unitId: number): Promise<Map<string, FoldedDecision>> {
  const rows = await q<FoldRow>(
    `SELECT rel_posix, sid, asked, ipfs, gitignore, decided_by, ${decidedAtIso("decided_at")} AS decided_at
       FROM ${S}.file_decision WHERE unit_id = $1`,
    [unitId],
  );
  return toFolded(rows);
}

/** Folded-row counts per unit, for a cheap whole-fleet shape check before the per-unit gate runs. */
export async function fileDecisionCountsByUnit(): Promise<Map<number, number>> {
  const rows = await q<{ unit_id: string; n: string }>(
    `SELECT unit_id::text AS unit_id, count(*)::text AS n FROM ${S}.file_decision GROUP BY unit_id`,
  );
  return new Map(rows.map((r) => [Number(r.unit_id), Number(r.n)]));
}

/** The whole fleet's folded decisions in one statement — the aggregate 0006 measured at 0.37 ms. */
export async function countFileDecisions(): Promise<number> {
  const r = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.file_decision`);
  return Number(r?.n ?? 0);
}
