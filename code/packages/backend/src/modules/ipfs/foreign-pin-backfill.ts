// BACKFILL AREA 9 — FOREIGN PINS AND THE PROBE CACHE (database_migration.mdx §4.1 area 9).
//
// The largest byte win of the whole workstream and the one that is fully independent of every other area:
// `foreign-pins.json` (1,284,193 B / 2,825 records) becomes `lfb.foreign_pin`, and `foreign-pin-cache.json`
// (7,198,446 B / 36,103 entries, 33,157 of them NEGATIVE) becomes `lfb.fingerprint_probe`.
//
// THREE THINGS THIS AREA GETS RIGHT OR GETS WRONG, and they are the three the plan calls out.
//
//   1. THE NEGATIVES MIGRATE. `cid: null` is not an empty record; it is "I hashed this file and it is not
//      pinned", and it is 91.8% of the cache. Dropping them would look like a smaller migration and would
//      cost 33,157 re-hashes of large files on the next background pass.
//
//   2. THE KEY IS SPLIT FROM THE RIGHT. `fpKey` is `${absPath}::${size}:${mtimeMs}`
//      (foreign-pin.service.ts:55) and macOS permits `:` inside a filename, so `split("::")` is a guess.
//      `parseFpKey` works in from the end, where the two integers are unambiguous.
//
//   3. THE 7 MB FILE IS STREAMED. `JSON.parse` of it is ~40 MB of live object graph, which is the exact
//      allocation shape that produced the 4 GB RSS incident this slice exists to retire (memory.mdx). See
//      `shared/persistence/raw-json.ts`.
//
// It is a pure ADD behind stores that are unchanged and still running on a machine with no database (R1/R2),
// it writes only its own tables (R5 — and `lfb.cid` gets `DO NOTHING`), and every canonical CID is computed
// by the app's own `canonicalCid()` and inserted as a literal (R7).
import fs from "node:fs";
import path from "node:path";
import { registerBackfill, type BackfillArea, type BackfillContext, type BackfillScope } from "../../shared/persistence/backfill.js";
import { streamJsonMembers } from "../../shared/persistence/raw-json.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";
import { log } from "../../shared/logging.js";
import { unitIdsByAbsPath } from "../store-model/unit.repo.js";
import { canonicalCid } from "./ipfs.service.js";
import { foreignPinStoreFiles, parseFpKey } from "./foreign-pin.service.js";
import {
  countForeignPins,
  countForeignPinsWithoutCid,
  countNegativeProbes,
  countProbes,
  ensureCids,
  upsertForeignPins,
  upsertProbes,
  type ForeignPinUpsert,
  type ProbeUpsert,
} from "./foreign-pin.repo.js";

/**
 * Rows held before a write. 2,000 is a compromise the harness's own checkpoint policy sets the shape of:
 * it flushes the ledger every 2,000 rows or 5 seconds, so a smaller batch would checkpoint more often than
 * it inserts, and a much larger one would put more work than that at risk on an interruption.
 */
const BATCH_ROWS = 2_000;

// ── scope 1: foreign-pins.json → lfb.foreign_pin ───────────────────────────────────────────────────────

interface RawPin {
  cid?: unknown;
  profile?: unknown;
  absPath?: unknown;
  size?: unknown;
  repoRoot?: unknown;
  canonicalCid?: unknown;
  at?: unknown;
}

/**
 * `abs_path` → `unit_id`, resolved the way the plan asks: attach a unit where the path falls under a known
 * unit root, leave NULL otherwise, "a foreign pin can be discovered outside every unit".
 *
 * LONGEST ROOT WINS. Two of the 105 tracked repos on this machine are themselves inside other tracked
 * trees, so a first-match-wins prefix test would file a nested repo's pins under its parent — and
 * `foreignPinPathSetFor` would then hand the parent repo rows that are not its own. The record's OWN
 * `repoRoot` is preferred over any prefix search, because that is what the scan observed at discovery time.
 */
class UnitRootIndex {
  private readonly byPath: Map<string, number>;
  private readonly rootsLongestFirst: string[];

  constructor(units: Map<string, number>) {
    this.byPath = units;
    this.rootsLongestFirst = [...units.keys()].sort((a, b) => b.length - a.length);
  }

  resolve(absPath: string, repoRoot: string | null): number | null {
    if (repoRoot) {
      const exact = this.byPath.get(repoRoot);
      if (exact !== undefined) return exact;
    }
    for (const root of this.rootsLongestFirst) {
      if (absPath.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
        return this.byPath.get(root) ?? null;
      }
    }
    return null;
  }
}

/** Validate one record from the index file. Returns the reason it is unusable, or the row. */
function pinRowFrom(
  raw: RawPin,
  units: UnitRootIndex,
): { row: ForeignPinUpsert; canon: string; text: string } | { reason: string } {
  const absPath = typeof raw.absPath === "string" ? raw.absPath : "";
  const cid = typeof raw.cid === "string" ? raw.cid : "";
  if (!absPath) return { reason: "record has no absPath" };
  if (!cid) return { reason: "record has no cid" };
  // RECOMPUTED, NOT TRUSTED (R7). `canonicalCid` is the app's own TypeScript function and it is what every
  // membership test in the product uses; a record whose stored `canonicalCid` was written by an older
  // spelling of it must migrate as the CURRENT function sees it, or the row would never match a kept-set
  // test again. The stored value is the fallback only when the CID itself will not canonicalize.
  let canon: string;
  try {
    canon = canonicalCid(cid);
  } catch {
    canon = typeof raw.canonicalCid === "string" ? raw.canonicalCid : "";
  }
  if (!canon) return { reason: `cid ${cid} does not canonicalize` };
  const repoRoot = typeof raw.repoRoot === "string" && raw.repoRoot ? raw.repoRoot : null;
  const size = typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0 ? Math.floor(raw.size) : 0;
  const at = typeof raw.at === "string" ? new Date(raw.at) : new Date();
  return {
    row: {
      absPath,
      cidText: cid,
      cidCanon: canon,
      profile: typeof raw.profile === "string" ? raw.profile : "",
      sizeBytes: size,
      unitId: units.resolve(absPath, repoRoot),
      observedAt: Number.isNaN(at.getTime()) ? new Date() : at,
    },
    canon,
    text: cid,
  };
}

async function runPinScope(file: string, ctx: BackfillContext): Promise<number> {
  // A machine that has never completed a scan with a reachable IPFS node has no store to migrate. That is
  // an empty area, not a failed scope — and letting `openSync` throw ENOENT here would mark it failed and
  // block the ledger's clean-pass fingerprint forever.
  if (!fs.existsSync(file)) return ctx.rowsBefore;
  const units = new UnitRootIndex(await unitIdsByAbsPath());
  let rows = ctx.rowsBefore;
  // RESUME (mechanic (a)): the cursor is the last abs path inserted, in the file's own order. We stream from
  // the top either way — a byte offset is meaningless once the source has been rewritten — and simply skip
  // until we have seen it again.
  let skipping = ctx.resumeFrom !== null;
  let pending: ForeignPinUpsert[] = [];
  let cids: Array<{ canon: string; text: string }> = [];
  let lastKey: string | null = ctx.resumeFrom;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    // `lfb.cid` FIRST — `foreign_pin.cid_canon` has a FK onto it (0008) and a batch that writes the pins
    // first aborts entirely on the first unseen CID.
    await ensureCids(cids);
    await upsertForeignPins(pending);
    rows += pending.length;
    pending = [];
    cids = [];
    ctx.checkpoint(lastKey, rows);
  };

  for (const member of streamJsonMembers(file)) {
    const raw = member.value as RawPin;
    const absPath = typeof raw?.absPath === "string" ? raw.absPath : null;
    if (skipping) {
      if (absPath === ctx.resumeFrom) skipping = false;
      continue;
    }
    const parsed = pinRowFrom(raw ?? {}, units);
    if ("reason" in parsed) {
      ctx.reject(absPath ?? `${file}#${rows}`, parsed.reason);
      continue;
    }
    pending.push(parsed.row);
    cids.push({ canon: parsed.canon, text: parsed.text });
    lastKey = parsed.row.absPath;
    if (pending.length >= BATCH_ROWS) await flush();
  }
  await flush();
  return rows;
}

// ── scope 2: foreign-pin-cache.json → lfb.fingerprint_probe ────────────────────────────────────────────

interface RawProbe {
  cid?: unknown;
  profile?: unknown;
  at?: unknown;
}

async function runProbeScope(file: string, ctx: BackfillContext): Promise<number> {
  if (!fs.existsSync(file)) return ctx.rowsBefore; // see runPinScope — an absent store is an empty area
  let rows = ctx.rowsBefore;
  let skipping = ctx.resumeFrom !== null;
  let pending: ProbeUpsert[] = [];
  let lastKey: string | null = ctx.resumeFrom;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await upsertProbes(pending);
    rows += pending.length;
    pending = [];
    ctx.checkpoint(lastKey, rows);
  };

  for (const member of streamJsonMembers(file)) {
    const key = member.key;
    if (key === null) {
      ctx.reject(file, "the fingerprint cache is not a JSON object");
      break;
    }
    if (skipping) {
      if (key === ctx.resumeFrom) skipping = false;
      continue;
    }
    const parts = parseFpKey(key);
    if (!parts) {
      // Mechanic (c): one unparseable cache key is one lost negative-cache entry — a single re-hash on some
      // later scan — never a reason to abandon the other 36,102.
      ctx.reject(key, "cache key does not split into (absPath, size, mtimeMs)");
      continue;
    }
    const raw = (member.value ?? {}) as RawProbe;
    const at = typeof raw.at === "string" ? new Date(raw.at) : new Date();
    pending.push({
      absPath: parts.absPath,
      sizeBytes: parts.size,
      mtimeMs: parts.mtimeMs,
      // THE NEGATIVE CACHE, MIGRATED AS-IS. `cid: null` in the JSON becomes `cid_text NULL`, which is what
      // `discoverForeignPin` reads as "already hashed, not pinned" and returns without touching the file.
      cidText: typeof raw.cid === "string" && raw.cid ? raw.cid : null,
      profile: typeof raw.profile === "string" ? raw.profile : null,
      probedAt: Number.isNaN(at.getTime()) ? new Date() : at,
    });
    lastKey = key;
    if (pending.length >= BATCH_ROWS) await flush();
  }
  await flush();
  return rows;
}

// ── counting the source, for verification ──────────────────────────────────────────────────────────────

/** How many members of `file` this area considers migratable — the `yamlRows` side of the comparison. */
function countSourceMembers(file: string, validate: (m: { key: string | null; value: unknown }) => boolean): number {
  let n = 0;
  if (!fs.existsSync(file)) return 0;
  try {
    for (const member of streamJsonMembers(file)) if (validate(member)) n += 1;
  } catch (e) {
    log.debug("migrate", `backfill_foreign_pins: counting ${file} failed: ${(e as Error).message}`);
    return -1; // "could not count" — never silently reported as zero, which would read as a clean match
  }
  return n;
}

// ── the area ───────────────────────────────────────────────────────────────────────────────────────────

interface ScopeData {
  kind: "pins" | "probes";
  file: string;
}

function foreignPinScopes(): BackfillScope[] {
  const files = foreignPinStoreFiles();
  return [
    { key: "foreign_pins", sources: [files.index], data: { kind: "pins", file: files.index } satisfies ScopeData },
    {
      key: "fingerprint_probes",
      sources: [files.cache],
      data: { kind: "probes", file: files.cache } satisfies ScopeData,
    },
  ];
}

export const ADOPT_FOREIGN_PINS: BackfillArea = {
  name: "backfill_foreign_pins",
  version: 1,
  kind: "backfill",
  sources: () => foreignPinScopes().flatMap((s) => s.sources),
  scopes: () => foreignPinScopes(),

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    const data = scope.data as ScopeData;
    const rows = data.kind === "pins" ? await runPinScope(data.file, ctx) : await runProbeScope(data.file, ctx);
    ctx.checkpoint(null, rows); // scope complete — the harness stamps `done` from here
    return { rows };
  },

  async verify() {
    const mismatches: string[] = [];
    const files = foreignPinStoreFiles();

    // A source file that is absent is not a mismatch: a machine that has never run a scan with a reachable
    // IPFS node has no discoveries and no probes, and 0 == 0 is the correct answer there.
    const pinSource = countSourceMembers(files.index, (m) => typeof (m.value as RawPin)?.absPath === "string");
    const probeSource = countSourceMembers(files.cache, (m) => m.key !== null && parseFpKey(m.key) !== null);

    const pgPins = await countForeignPins();
    const pgProbes = await countProbes();
    const negatives = await countNegativeProbes();

    if (pinSource >= 0 && pgPins < pinSource) {
      mismatches.push(`foreign_pin has ${pgPins} row(s) for ${pinSource} record(s) in ${path.basename(files.index)}`);
    }
    if (probeSource >= 0 && pgProbes < probeSource) {
      mismatches.push(
        `fingerprint_probe has ${pgProbes} row(s) for ${probeSource} entr(ies) in ${path.basename(files.cache)}`,
      );
    }
    // THE ONE THAT WOULD BE INVISIBLE OTHERWISE. If the negatives did not survive, the row COUNT above would
    // still look plausible on a partially-migrated table, and the only symptom in production would be a scan
    // that got slower. So it is asserted directly.
    if (probeSource > 0 && negatives === 0) {
      mismatches.push("fingerprint_probe holds no NEGATIVE probes — the negative cache did not migrate");
    }
    const orphans = await countForeignPinsWithoutCid();
    if (orphans > 0) mismatches.push(`${orphans} foreign_pin row(s) have no ${S}.cid row`);

    return {
      yamlRows: Math.max(pinSource, 0) + Math.max(probeSource, 0),
      pgRows: pgPins + pgProbes,
      mismatches,
    };
  },
};

/**
 * Register area 9.
 *
 * Order does not matter for this one — unlike areas 3-8 it has no FK onto anything a later area produces,
 * and `unit_id` is nullable by design. It is registered AFTER the unit areas only so that a first run on a
 * fresh database finds `lfb.unit` populated and can attach the unit ids rather than leaving them NULL.
 */
export function registerForeignPinBackfill(): void {
  registerBackfill(ADOPT_FOREIGN_PINS);
}
