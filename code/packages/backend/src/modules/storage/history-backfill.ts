// BACKFILL AREA 8 — `repos/<slug>-<key>/history/<device>.txt` → `lfb.history_entry`
// (database_migration.mdx §4.1 AREA 8, migration 0010; state-file key `backfill_history`).
//
// ── SAY IT PLAINLY: NOTHING IN THE BACKEND READS THIS FILE TODAY ────────────────────────────────────────
// `history-log.service.ts` writes `history/<device>.txt` and no code path anywhere reads it back. Its only
// consumer is the SDL mirror's per-entry union — `copyTreeGen` carries each device's file across to the
// other computers, and because a computer appends ONLY to its own file the merge is a pure union with no
// conflict (history-log.service.ts:2-4).
//
// SO THIS AREA IS NOT A BOTTLENECK AND IS NOT MIGRATED AS ONE. It is migrated because the parser is the
// only expensive part, the index is nearly free once the parser exists, and it turns 2.4 MB of write-only
// text into a queryable provenance trail — "what did pc-4 do to this repo in August", which today is a grep
// with no structure behind it. If the value never materialises, deleting this area costs one file.
//
// ── MEASURED SOURCE on this machine ─────────────────────────────────────────────────────────────────────
// 18 files across 3 repos, 2,466,833 bytes, 12,599 entry lines. Three files dominate at 412-477 KB each
// (charlie-kirk's pc-10-pc10-mint, pc-4-pc-4 and lenovo-laptop-ug0k96ca). The verbs present are PULL
// (12,583), CONVERT (15) and COMPRESS (1); the only field keys are `by`, `cid` and `size`; and ZERO lines
// carry an indented per-file block, so the `per_file` branch below is exercised only by its spec.
//
// ── WHY "INGEST FROM N+1" IS EXACT HERE AND NOWHERE ELSE ────────────────────────────────────────────────
// These files are APPEND-ONLY. `appendHistory` opens with `fs.appendFileSync` and never rewrites, so line
// N means the same thing forever. That is what makes `line_no` both the stored physical line number AND the
// resume cursor: a re-run reads from `max(line_no) + 1` and re-parses nothing. Every other area has to
// re-read its whole source to find where it stopped.
//
// The three harness mechanics are the harness's (shared/persistence/backfill.ts). What this file owns is
// the PARSER, and the parser's contract is the exact shape `appendHistory` builds:
//
//     <ISO-8601 UTC>␠␠<VERB>␠␠[by=<actor>␠␠][k=v␠␠…]<summary>
//     ␠×24<axis>=<value>␠␠<repo-relative path>        (zero or more, indented, belonging to the line above)
//
// Segments are joined with TWO spaces, the summary is last and is the first segment that is not `k=v`.
// Comment lines (`# …`, the two-line header) and blank lines are skipped but STILL CONSUME A LINE NUMBER,
// because `line_no` is the PHYSICAL line and the whole resume scheme depends on that being literally true.
import fs from "node:fs";
import path from "node:path";
import {
  registerBackfill,
  type BackfillArea,
  type BackfillContext,
  type BackfillScope,
} from "../../shared/persistence/backfill.js";
import { copyRows, q, q1 } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";
import { isDirForKey } from "../../shared/store/keyed-dir.js";
import { repoFolderKey } from "../../shared/store/sanitize.js";
import {
  listDirs,
  sdlRoots,
  trackingReposRoot,
  canonicalDeviceLabel,
  indexDeviceRegistry,
  type DeviceRegistry,
  type DeviceRegistryEntry,
} from "../store-model/unit-backfill.js";
import { readRawYaml } from "../../shared/persistence/raw-yaml.js";
import { DeviceFileSchema } from "@lfb/shared";

// ── the parser ──────────────────────────────────────────────────────────────────────────────────────────

/** The indent `appendHistory` writes before a per-file line — 24 spaces, aligning under the summary. */
const PERFILE_INDENT = " ".repeat(24);

/** A `k=v` segment. The key shape is deliberately narrow so a summary that merely CONTAINS an `=` — "kept
 *  the original — the best candidate was only -47.0% smaller" — is never mistaken for a field. */
const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/s;

export interface HistoryRow {
  lineNo: number;
  at: Date;
  verb: string;
  actor: string | null;
  fields: Record<string, string>;
  summary: string;
  perFile: Array<{ axis: string; value: string; path: string }> | null;
}

/**
 * Parse one device's history file into rows, from `fromLine + 1` onward.
 *
 * Exported for the spec: the per-file branch and the malformed-line branch cannot be exercised by this
 * machine's corpus (zero indented lines, zero unparseable timestamps), and a branch no test reaches is a
 * branch that is not known to work.
 *
 * A line that does not parse is REPORTED and SKIPPED, never fatal — mechanic (c) at line granularity. The
 * alternative is one malformed line costing a whole device's history, and this is an advisory index.
 */
export function parseHistory(
  text: string,
  fromLine: number,
  onBadLine: (lineNo: number, reason: string) => void,
): HistoryRow[] {
  const lines = text.split("\n");
  const rows: HistoryRow[] = [];
  let current: HistoryRow | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1; // PHYSICAL line number, 1-based — the cursor and the stored value
    const raw = lines[i]!;
    // `split("\n")` on a trailing newline yields a final empty element that is not a line at all.
    if (i === lines.length - 1 && raw === "") break;

    if (raw.startsWith(PERFILE_INDENT)) {
      // An indented block belongs to the entry above it. It is attached even when that entry is BELOW the
      // resume point and this one is above — impossible for an append-only file, but the guard costs a
      // branch and its absence would be a silent orphan.
      if (!current) continue;
      const body = raw.slice(PERFILE_INDENT.length);
      const [head, ...rest] = body.split("  ");
      const m = FIELD_RE.exec(head ?? "");
      if (!m) {
        onBadLine(lineNo, "indented per-file line is not `<axis>=<value>  <path>`");
        continue;
      }
      (current.perFile ??= []).push({ axis: m[1]!, value: m[2]!, path: rest.join("  ").trim() });
      continue;
    }

    current = null;
    if (lineNo <= fromLine) continue; // already ingested — this is the whole point of an append-only source
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#")) continue; // header + blanks consume a line number and nothing else

    const segments = line.split("  ");
    const stamp = segments[0]?.trim() ?? "";
    const ms = Date.parse(stamp);
    if (segments.length < 2 || !Number.isFinite(ms)) {
      onBadLine(lineNo, `not a history entry (expected '<UTC>  <VERB>  …', got ${JSON.stringify(line.slice(0, 60))})`);
      continue;
    }

    const fields: Record<string, string> = {};
    let actor: string | null = null;
    let rest = segments.slice(2);
    // Fields run until the first segment that is not `k=v`; everything from there on is the summary,
    // rejoined with the two spaces that separated it. `appendHistory` puts the summary last, always.
    let cut = 0;
    while (cut < rest.length) {
      const m = FIELD_RE.exec(rest[cut]!);
      if (!m) break;
      if (m[1] === "by") actor = m[2]!;
      else fields[m[1]!] = m[2]!;
      cut += 1;
    }
    rest = rest.slice(cut);

    current = {
      lineNo,
      at: new Date(ms),
      verb: segments[1]!.trim(),
      actor,
      fields,
      summary: rest.join("  ").trim(),
      perFile: null,
    };
    rows.push(current);
  }
  return rows;
}

// ── scopes: one per (repo tracking dir, device file) ────────────────────────────────────────────────────

interface HistoryScopeData {
  repoDir: string; // the `<slug>-<repoKey>` directory name under repos/
  deviceStem: string; // the history filename without `.txt` — a repoFolderKey-sanitized device name
  file: string;
}

function historyScopes(): BackfillScope[] {
  const scopes: BackfillScope[] = [];
  for (const repoDir of listDirs(trackingReposRoot())) {
    const dir = path.join(trackingReposRoot(), repoDir, "history");
    let names: string[];
    try {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".txt"))
        .map((d) => d.name)
        .sort();
    } catch {
      continue; // a repo nobody has acted on yet has no history dir — normal, not an error
    }
    for (const name of names) {
      const file = path.join(dir, name);
      scopes.push({
        key: `${repoDir}/${name.slice(0, -".txt".length)}`,
        sources: [file],
        data: { repoDir, deviceStem: name.slice(0, -".txt".length), file } satisfies HistoryScopeData,
      });
    }
  }
  return scopes;
}

// ── the two id resolutions this area needs ──────────────────────────────────────────────────────────────

/**
 * `repos/<slug>-<repoKey>/` → `unit_id`, matched by KEY SUFFIX and never by exact directory name.
 *
 * The same rule area 2 uses (`keyed-dir.ts isDirForKey`): a subtree written before the `<slug>-<key>`
 * rename is a bare 12-hex directory, and matching on the whole name would leave every one of them
 * unmatched. Built once per run — 105 units × 105 directories is nothing, and this area has 18 scopes.
 */
async function unitIdsByTrackingDir(): Promise<Map<string, number>> {
  const rows = await q<{ unit_id: string; repo_key: string }>(
    `SELECT unit_id::text AS unit_id, repo_key FROM ${S}.unit WHERE repo_key IS NOT NULL`,
  );
  const out = new Map<string, number>();
  for (const dir of listDirs(trackingReposRoot())) {
    const hit = rows.find((r) => isDirForKey(dir, r.repo_key));
    if (hit) out.set(dir, Number(hit.unit_id));
  }
  return out;
}

/**
 * The history FILENAME → `device_id`.
 *
 * Filenames are `repoFolderKey`-sanitized; `device.label` is not (database_migration.mdx §4.4). Area 1
 * already resolved both spellings through the SDL device registry and stored the canonical label plus its
 * `folder_key`, so this looks the stem up THREE ways in decreasing order of confidence — the stored
 * `folder_key`, the canonical label the registry gives the stem, and the raw stem — rather than guessing.
 * A stem that resolves to nothing is a REJECT, not a row: `history_entry.device_id` is NOT NULL, and
 * inventing a device is how one computer becomes two rows and `pinned_here` goes wrong for it forever.
 */
async function deviceResolver(): Promise<(stem: string) => number | null> {
  const rows = await q<{ device_id: number; label: string; folder_key: string }>(
    `SELECT device_id, label, folder_key FROM ${S}.device`,
  );
  const byFolderKey = new Map(rows.map((r) => [r.folder_key, r.device_id]));
  const byLabel = new Map(rows.map((r) => [r.label.toLowerCase(), r.device_id]));
  const reg = readDeviceRegistryForHistory();
  return (stem: string): number | null => {
    const direct = byFolderKey.get(stem);
    if (direct !== undefined) return direct;
    const canon = canonicalDeviceLabel(stem, reg);
    return byLabel.get(canon.label.toLowerCase()) ?? byFolderKey.get(repoFolderKey(canon.label)) ?? null;
  };
}

/** The SDL device registries, read the same two places area 1 reads them. Silent on failure: a registry we
 *  cannot read costs us a spelling, and the `folder_key` lookup above still resolves the common case. */
function readDeviceRegistryForHistory(): DeviceRegistry {
  const entries: DeviceRegistryEntry[] = [];
  for (const root of sdlRoots()) {
    for (const dir of [path.join(root, "devices"), path.join(root, ".lfbridge", "devices")]) {
      let names: string[];
      try {
        names = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith(".yaml"))
          .map((d) => d.name);
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          const doc = readRawYaml(path.join(dir, name), DeviceFileSchema);
          entries.push({
            fileStem: name.slice(0, -".yaml".length),
            name: doc.device.name.trim(),
            peerId: doc.device.ipfs_peer_id?.trim() || null,
          });
        } catch {
          // Area 1 already rejected this file by name with the parser's own message; re-recording it here
          // would file the same fault under a second area.
        }
      }
    }
  }
  return indexDeviceRegistry(entries);
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────────────

/** Rows per statement. 8 columns, so even 2,000 rows is 16,000 binds — well inside `copyRows`'s ceiling. */
const BATCH_ROWS = 1_000;

const HISTORY_COLUMNS = ["unit_id", "device_id", "at", "verb", "actor", "fields", "summary", "per_file", "line_no"];

/**
 * `history_union UNIQUE NULLS NOT DISTINCT (unit_id, device_id, at, verb, summary)`.
 *
 * DO NOTHING, not DO UPDATE, and the difference matters: a duplicate here is the SAME LINE seen twice (a
 * re-run, or the same file reached through both the local tree and an SDL mirror), and the row already
 * stored carries the line number it was FIRST seen at. Overwriting it with a later `line_no` would corrupt
 * the resume cursor, which is the one thing this area's idempotency rests on.
 *
 * Measured on this corpus: no device file contains two entries with the same (at, verb, summary), so the
 * constraint fires only on a genuine re-run.
 */
const HISTORY_ON_CONFLICT = "ON CONFLICT ON CONSTRAINT history_union DO NOTHING";

/** The highest physical line already ingested for this (unit, device) — the resume cursor, read from the
 *  index `history_resume` (0010) rather than trusted from the ledger, so a database restored from a backup
 *  resumes from what it actually holds. */
async function highestLine(unitId: number, deviceId: number): Promise<number> {
  const row = await q1<{ n: number | null }>(
    `SELECT max(line_no) AS n FROM ${S}.history_entry WHERE unit_id = $1 AND device_id = $2`,
    [unitId, deviceId],
  );
  return row?.n ?? 0;
}

async function runHistoryScope(data: HistoryScopeData, ctx: BackfillContext, deps: HistoryDeps): Promise<number> {
  const unitId = deps.units.get(data.repoDir);
  if (unitId === undefined) {
    ctx.reject(data.file, `no lfb.unit row for tracking dir '${data.repoDir}' — run adopt_units first`);
    return 0;
  }
  const deviceId = deps.deviceFor(data.deviceStem);
  if (deviceId === null) {
    ctx.reject(data.file, `history filename '${data.deviceStem}' resolves to no lfb.device — run adopt_devices first`);
    return 0;
  }

  let text: string;
  try {
    text = fs.readFileSync(data.file, "utf8");
  } catch (e) {
    ctx.reject(data.file, `history log unreadable: ${(e as Error).message}`);
    return 0;
  }

  // The cursor is a LINE NUMBER, and it is read from the table rather than from `ctx.resumeFrom`, because
  // the two can legitimately disagree: the ledger records where the last run said it stopped, the table
  // records what is actually there. On an append-only source the table is always the safer of the two.
  const from = await highestLine(unitId, deviceId);
  const parsed = parseHistory(text, from, (lineNo, reason) => ctx.reject(`${data.file}:${lineNo}`, reason));

  let rows = ctx.rowsBefore;
  for (let i = 0; i < parsed.length; i += BATCH_ROWS) {
    const batch = parsed.slice(i, i + BATCH_ROWS);
    await copyRows(
      `${S}.history_entry`,
      HISTORY_COLUMNS,
      batch.map((r) => [
        unitId,
        deviceId,
        r.at,
        r.verb,
        r.actor,
        JSON.stringify(r.fields),
        r.summary,
        r.perFile ? JSON.stringify(r.perFile) : null,
        r.lineNo,
      ]),
      { onConflict: HISTORY_ON_CONFLICT },
    );
    rows += batch.length;
    ctx.checkpoint(String(batch[batch.length - 1]!.lineNo), rows);
  }
  ctx.checkpoint(null, rows);
  return rows;
}

interface HistoryDeps {
  units: Map<string, number>;
  deviceFor: (stem: string) => number | null;
}

let deps: HistoryDeps | null = null;

export const BACKFILL_HISTORY: BackfillArea = {
  name: "backfill_history",
  version: 1,
  kind: "backfill",
  sources: () => historyScopes().flatMap((s) => s.sources),
  async scopes() {
    // Resolved ONCE per run, here rather than per scope: two whole-table reads of 13 devices and 105 units
    // against 18 scopes. A later area that needs these at 30k-row scale must not copy this shape.
    deps = { units: await unitIdsByTrackingDir(), deviceFor: await deviceResolver() };
    return historyScopes();
  },

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    const d = deps ?? { units: await unitIdsByTrackingDir(), deviceFor: await deviceResolver() };
    return { rows: await runHistoryScope(scope.data as HistoryScopeData, ctx, d) };
  },

  /**
   * §4.5's named assertion for this area: PER (unit, device), `max(line_no)` = `wc -l` of the source file.
   *
   * That equality holds because every entry line is stored with its physical line number and the LAST line
   * of an append-only log is always an entry (`appendHistory` writes a trailing newline after each block,
   * so the file's final line is the last thing written). A file whose last line were a comment would break
   * the identity legitimately — hence the comparison is against the last NON-COMMENT, NON-BLANK line
   * number, and the raw `wc -l` is reported alongside so the two can be seen to agree.
   */
  async verify() {
    const mismatches: string[] = [];
    const units = await unitIdsByTrackingDir();
    const deviceFor = await deviceResolver();
    let yamlRows = 0;

    for (const scope of historyScopes()) {
      const data = scope.data as HistoryScopeData;
      const unitId = units.get(data.repoDir);
      const deviceId = deviceFor(data.deviceStem);
      let text: string;
      try {
        text = fs.readFileSync(data.file, "utf8");
      } catch {
        continue; // already in the reject table with the reader's own message
      }
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      let lastEntryLine = 0;
      let entries = 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (l === "" || l.startsWith("#") || l.startsWith(PERFILE_INDENT)) continue;
        lastEntryLine = i + 1;
        entries += 1;
      }
      yamlRows += entries;
      if (unitId === undefined || deviceId === null) {
        mismatches.push(`${scope.key}: no unit/device row (unit=${unitId ?? "?"} device=${deviceId ?? "?"})`);
        continue;
      }
      const got = await highestLine(unitId, deviceId);
      if (got !== lastEntryLine) {
        mismatches.push(
          `${scope.key}: max(line_no)=${got} in Postgres, last entry line ${lastEntryLine} of ${lines.length} in the file`,
        );
      }
    }

    const total = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.history_entry`);
    return { yamlRows, pgRows: Number(total?.n ?? 0), mismatches };
  },
};

/**
 * Register area 8.
 *
 * MUST run after areas 1 and 2: `history_entry.unit_id` and `.device_id` are both NOT NULL FKs into what
 * `adopt_units` and `adopt_devices` produce, and registration order IS run order
 * (backfill.ts `runAllBackfills`).
 */
export function registerHistoryBackfill(): void {
  registerBackfill(BACKFILL_HISTORY);
}
