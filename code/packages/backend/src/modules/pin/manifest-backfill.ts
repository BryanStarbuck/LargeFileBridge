// BACKFILL AREAS 5 AND 10 — manifests + pin claims, and the two machine-local CID alias maps
// (database_migration.mdx §4.3, migration 0007).
//
// ── AREA 5, AND THE ONE THING IT MUST NOT DO ───────────────────────────────────────────────────────────
//
// Measured on this machine: 105 × `repos/<slug>-<key>/manifest.yaml` (1,682,380 B, stage='tracking') and
// 105 × `pin/r/<folder>/manifest.yaml` (1,700,088 B, stage='unit'). 4,184 entries EACH, 3,691 distinct raw
// CIDs across both, and 22,221 `pinned_by` claims on the tracking side against 22,844 on the unit side.
//
// THAT 623-CLAIM DIFFERENCE IS THE WHOLE REASON THE TWO STAGES STAY SEPARATE. The two documents are not a
// redundant twin to be collapsed — they are two stages of one pipeline. `pin.service.ts:768-770` keeps the
// unit copy off the wire precisely so `mergeManifests` has two DISTINCT operands, and `pin.service.ts:793`
// gates the tracking write behind `publish_manifest`. Folding them into one table would start publishing
// manifests for repos the user OPTED OUT of — a data-escape bug, not a perf regression (database.mdx §4.1).
//
// The claims explode into `lfb.pin_claim` with an `origin` discriminator: 'local' for THIS computer's
// label, 'wire' for every other. `lfb_pin_claim_guard` REJECTS a self-claim written as 'wire', and that
// rejection is the point — it is `manifest-merge.ts:123-128`'s asymmetry restated as a database invariant,
// so the SQL path and the YAML path cannot drift on the question this product keeps reopening: "pinned"
// means pinned on THIS computer by ANY local software; a peer's claim is never pinned-here (ipfs.mdx §1.1).
//
// ── AREA 10 ────────────────────────────────────────────────────────────────────────────────────────────
//
// `cid_equivalence.yaml` (58 pairs) and `superseded_cids.yaml` (16) into `lfb.cid_alias`. BOTH STAY
// MACHINE-LOCAL BY EXPLICIT DESIGN (`scopes.ts:12-20`: putting them in the SDL "is what made two machines
// rewrite each other's manifest forever"), and `superseded_cids` keeps BOTH of its wire legs unchanged —
// the export into `<sdl>/devices/<self>.yaml` (`devices.service.ts:174`) and the adopt from a peer (`:250`).
// Postgres holds the local index only, and no reader has cut over to it (R3).
//
// Both areas read through `readRawYaml`, never `readYaml()` (R6), write only their own tables (R5), and
// compute every CID canonical form in TypeScript before it reaches SQL (R7).
import fs from "node:fs";
import path from "node:path";
import { CidEquivalenceSchema, ManifestSchema, RepoUnitConfigSchema, SupersededCidsSchema } from "@lfb/shared";
import {
  registerBackfill,
  type BackfillArea,
  type BackfillContext,
  type BackfillScope,
} from "../../shared/persistence/backfill.js";
import { readRawYaml, readRawYamlIfPresent } from "../../shared/persistence/raw-yaml.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { expandHome } from "../../shared/home-path.js";
import { log } from "../../shared/logging.js";
import { repoKeyFor } from "../storage/tracking-root.service.js";
import { canonicalCid } from "../ipfs/ipfs.service.js";
import { listDirs, pinReposRoot, trackingDirFor } from "../store-model/unit-backfill.js";
import { unitIdsByAbsPath } from "../store-model/unit.repo.js";
import {
  countCidAliases,
  countManifestCids,
  countManifestEntries,
  countPinClaims,
  countSelfClaimsNotLocal,
  deviceIdForLabel,
  manifestEntryCountsByUnit,
  manifestToEntries,
  readDeviceIndex,
  replaceManifestStage,
  upsertCidAliases,
  type CidAliasRow,
  type DeviceIndex,
  type ManifestStage,
} from "./manifest.repo.js";

const stateRoot = (): string => resolveStateDir();

/**
 * STAGE ORDER IS ALSO THE RESUME ORDER, and the plan's cursor for this area is literally `(unit, stage)`.
 * 'unit' first because it is the LOCAL document — if a run is interrupted halfway through a repo, the half
 * that landed is the one that never travels, which is the safer half to have written.
 */
const STAGES: ManifestStage[] = ["unit", "tracking"];

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// AREA 5 — backfill_manifests
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

interface ManifestScopeData {
  folder: string;
  /** The repo's working-tree root — the natural key `lfb.unit` is keyed on (`unit_abs_path_unique`). */
  absPath: string | null;
  configFile: string;
  files: Record<ManifestStage, string | null>;
}

function manifestScopes(): BackfillScope[] {
  const scopes: BackfillScope[] = [];
  for (const folder of listDirs(pinReposRoot())) {
    const configFile = path.join(pinReposRoot(), folder, "config.yaml");
    const unitFile = path.join(pinReposRoot(), folder, "manifest.yaml");
    let absPath: string | null = null;
    let trackingFile: string | null = null;
    try {
      const cfg = readRawYaml(configFile, RepoUnitConfigSchema);
      if (cfg.repo.path.trim()) {
        absPath = path.resolve(expandHome(cfg.repo.path));
        // The tracking copy lives under `repos/<slug>-<repoKey>/`, resolved BY SUFFIX (`keyed-dir.ts`) so a
        // directory written before the `<slug>-<key>` rename still matches. `trackingDirFor` is the
        // read-only resolver — `repoStateDir()` would MKDIR, and a migration must not plant directories for
        // repos it is only looking at.
        const dir = trackingDirFor(repoKeyFor(absPath));
        if (dir) trackingFile = path.join(dir, "manifest.yaml");
      }
    } catch {
      // Unreadable here is unreadable in run() too, where it becomes a reject carrying the parser's message.
    }
    const sources = [configFile, unitFile, ...(trackingFile ? [trackingFile] : [])].filter((f) => fs.existsSync(f));
    scopes.push({
      key: `r/${folder}`,
      sources,
      data: {
        folder,
        absPath,
        configFile,
        files: { unit: fs.existsSync(unitFile) ? unitFile : null, tracking: trackingFile },
      } satisfies ManifestScopeData,
    });
  }
  return scopes;
}

/** Per-run caches. Reset in `scopes()`, which the harness calls exactly once per run. */
let unitIdCache: Map<string, number> | null = null;
let deviceIndexCache: DeviceIndex | null = null;

async function unitIdFor(absPath: string): Promise<number | null> {
  unitIdCache ??= await unitIdsByAbsPath();
  return unitIdCache.get(absPath) ?? null;
}

async function deviceIndex(): Promise<DeviceIndex> {
  deviceIndexCache ??= await readDeviceIndex();
  return deviceIndexCache;
}

/**
 * Where an interrupted run left this scope: the last stage that finished, or null for "nothing yet".
 *
 * The harness hands back the cursor string the previous run checkpointed; parsing it here rather than
 * storing an index keeps the ledger readable — `migration_state.yaml` says `r/charlie-kirk:unit`, which is
 * a sentence, not a number whose meaning lives in this file.
 */
export function stagesToRun(scopeKey: string, resumeFrom: string | null): ManifestStage[] {
  if (!resumeFrom || !resumeFrom.startsWith(`${scopeKey}:`)) return STAGES;
  const done = resumeFrom.slice(scopeKey.length + 1) as ManifestStage;
  const idx = STAGES.indexOf(done);
  return idx < 0 ? STAGES : STAGES.slice(idx + 1);
}

async function runManifestScope(scope: BackfillScope, ctx: BackfillContext): Promise<number> {
  const data = scope.data as ManifestScopeData;
  if (!data.absPath) {
    ctx.reject(data.configFile, "pin unit config has no repo.path — its manifests cannot be attached to a unit");
    return 0;
  }
  const unitId = await unitIdFor(data.absPath);
  if (unitId === null) {
    // `manifest_entry.unit_id` is a NOT NULL FK into `lfb.unit`. A repo area 2 has not adopted has nowhere
    // to put its entries; recording it is the honest outcome, and the next run picks it up once area 2 has.
    ctx.reject(data.configFile, `no lfb.unit row for ${data.absPath} — run adopt_units first`);
    return 0;
  }

  const index = await deviceIndex();
  let rows = ctx.rowsBefore;
  for (const stage of stagesToRun(scope.key, ctx.resumeFrom)) {
    const file = data.files[stage];
    if (!file) continue;
    let doc;
    try {
      doc = readRawYaml(file, ManifestSchema);
    } catch (e) {
      // Mechanic (c): a manifest we cannot parse costs us that stage, not the run and not the other stage.
      ctx.reject(file, `manifest unreadable: ${(e as Error).message}`);
      continue;
    }
    const unknown = new Set<string>();
    const entries = manifestToEntries(doc, {
      canonicalCid,
      // The CANONICAL self spelling, taken from the row area 1 marked `is_self` rather than re-read off
      // disk, so area 5 cannot decide this computer is a different computer than area 1 decided it was.
      selfLabel: index.selfLabel ?? "",
      index,
      onUnknownLabel: (l) => unknown.add(l),
    });
    for (const label of unknown) {
      // NOT an `upsertDevices` from here: `lfb.device` is area 1's table and its writer sets `is_self`
      // (R5). A label with no row costs its claims and is recorded by name so the gap is visible.
      ctx.reject(file, `pinned_by label '${label}' has no lfb.device row — run adopt_devices first`);
    }
    await replaceManifestStage(unitId, stage, entries);
    rows += entries.length + entries.reduce((n, e) => n + e.claims.length, 0);
    ctx.checkpoint(`${scope.key}:${stage}`, rows);
  }
  return rows;
}

/** What the documents on disk hold, counted the way the tables count it: entries + claims, per stage. */
interface YamlCensus {
  entries: Record<ManifestStage, number>;
  claims: Record<ManifestStage, number>;
  /** Distinct RAW (verbatim) CIDs, before `canonicalCid` folds base encodings together. */
  rawCids: number;
  perUnitEntries: Record<ManifestStage, Map<number, number>>;
}

async function censusFromYaml(): Promise<YamlCensus> {
  const out: YamlCensus = {
    entries: { unit: 0, tracking: 0 },
    claims: { unit: 0, tracking: 0 },
    rawCids: 0,
    perUnitEntries: { unit: new Map(), tracking: new Map() },
  };
  const raw = new Set<string>();
  const index = await deviceIndex();
  for (const scope of manifestScopes()) {
    const data = scope.data as ManifestScopeData;
    if (!data.absPath) continue;
    const unitId = await unitIdFor(data.absPath);
    for (const stage of STAGES) {
      const file = data.files[stage];
      if (!file) continue;
      let doc;
      try {
        doc = readRawYaml(file, ManifestSchema);
      } catch {
        continue; // already in the reject table with the parser's own message
      }
      // Deduped by `rel_posix`, because that is what the PK collapses to — counting raw list length would
      // report a `merge=union` duplicate as a missing row and block the cutover over a correct result.
      const byPosix = new Map<string, Set<number>>();
      for (const f of doc.files) {
        const key = f.path.replaceAll("\\", "/");
        const devices = byPosix.get(key) ?? new Set<number>();
        byPosix.set(key, devices);
        if (f.cid) raw.add(f.cid);
        for (const label of f.pinned_by ?? []) {
          const id = deviceIdForLabel(index, label);
          if (id !== null) devices.add(id);
        }
      }
      out.entries[stage] += byPosix.size;
      for (const d of byPosix.values()) out.claims[stage] += d.size;
      if (unitId !== null) out.perUnitEntries[stage].set(unitId, byPosix.size);
    }
  }
  out.rawCids = raw.size;
  return out;
}

export const BACKFILL_MANIFESTS: BackfillArea = {
  name: "backfill_manifests",
  version: 1,
  kind: "backfill",
  sources: () => manifestScopes().flatMap((s) => s.sources),
  scopes: () => {
    unitIdCache = null;
    deviceIndexCache = null;
    return manifestScopes();
  },

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    return { rows: await runManifestScope(scope, ctx) };
  },

  async verify() {
    const mismatches: string[] = [];
    const yaml = await censusFromYaml();
    const pg = {
      entries: { unit: await countManifestEntries("unit"), tracking: await countManifestEntries("tracking") },
      claims: { unit: await countPinClaims("unit"), tracking: await countPinClaims("tracking") },
    };
    for (const stage of STAGES) {
      if (pg.entries[stage] !== yaml.entries[stage]) {
        mismatches.push(`stage='${stage}': ${pg.entries[stage]} manifest_entry rows for ${yaml.entries[stage]} entries`);
      }
      if (pg.claims[stage] !== yaml.claims[stage]) {
        mismatches.push(`stage='${stage}': ${pg.claims[stage]} pin_claim rows for ${yaml.claims[stage]} claims`);
      }
      // Per unit as well as in total: two repos whose errors cancel would pass the aggregate.
      const perUnit = await manifestEntryCountsByUnit(stage);
      for (const [unitId, n] of yaml.perUnitEntries[stage]) {
        const got = perUnit.get(unitId) ?? 0;
        if (got !== n) mismatches.push(`unit ${unitId} stage='${stage}': ${got} rows for ${n} entries`);
      }
    }

    // THE INVARIANT, STATED RATHER THAN ASSUMED. `lfb_pin_claim_guard` makes a non-zero answer impossible
    // today; asserting it here means a future change that drops the trigger fails a check instead of
    // quietly changing what "pinned" means (MEMORY.md, "foreign pin: recorded must render").
    const selfNotLocal = await countSelfClaimsNotLocal();
    if (selfNotLocal !== 0) {
      mismatches.push(`${selfNotLocal} claim(s) name this computer with origin <> 'local' — the guard is not holding`);
    }

    // REPORTED, NEVER ASSERTED. `canonicalCid` re-encodes a CIDv0 `Qm…` as its CIDv1 base32 twin, so two
    // spellings of one multihash become ONE `cid_canon`. Fewer canonical CIDs than verbatim ones is the
    // correct outcome and the difference is a fact about this fleet's mix of `ipfs add` profiles, not a
    // shortfall to fix (database_migration.mdx §4.3 area 5).
    const canon = await countManifestCids();
    log.info(
      "migrate",
      `backfill_manifests: ${canon} distinct cid_canon for ${yaml.rawCids} distinct verbatim CIDs ` +
        `(${yaml.rawCids - canon} collapsed by canonicalCid — CIDv0/CIDv1 spellings of one multihash)`,
    );
    if (canon > yaml.rawCids) {
      mismatches.push(`${canon} canonical CIDs from ${yaml.rawCids} verbatim ones — canonicalCid cannot ADD CIDs`);
    }

    const yamlRows = STAGES.reduce((n, s) => n + yaml.entries[s] + yaml.claims[s], 0);
    const pgRows = STAGES.reduce((n, s) => n + pg.entries[s] + pg.claims[s], 0);
    return { yamlRows, pgRows, mismatches };
  },
};

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// AREA 10 — backfill_cid_aliases
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

const cidEquivalenceFile = (): string => path.join(stateRoot(), "cid_equivalence.yaml");
const supersededFile = (): string => path.join(stateRoot(), "superseded_cids.yaml");

/**
 * Turn one `pairs:` map into alias rows.
 *
 * `proof` records HOW the pair was established, and the two maps have genuinely different standards:
 *   * `cid_equivalence.yaml` pairs come from foreign-profile adoption — the pin pass RE-HASHED the bytes and
 *     found the local pin (`cid-equivalence.service.ts`), so `'rehash'`.
 *   * `superseded_cids.yaml` pairs are only ever written from a walk that ACTUALLY RESOLVED
 *     (`noteSupersededCid`: "only ever from a walk that actually resolved (resolveFileCid), never from a
 *     guess"), so `'resolveFileCid'` — EXCEPT for pairs `adoptSupersededCids` took from a peer's device
 *     file, which the YAML does not distinguish. Recording those as `'peer'` is not possible from this
 *     source, and recording a prover we cannot name would be worse, so `proved_by` stays NULL throughout.
 */
export function aliasRowsFrom(
  pairs: Record<string, string>,
  kind: CidAliasRow["kind"],
  proof: string,
  reject: (key: string, reason: string) => void,
): CidAliasRow[] {
  const out: CidAliasRow[] = [];
  for (const [alias, target] of Object.entries(pairs ?? {})) {
    const aliasCanon = canonicalCid(String(alias).trim());
    const targetCanon = canonicalCid(String(target ?? "").trim());
    if (!aliasCanon || !targetCanon) {
      reject(alias, `${kind} pair has a blank half`);
      continue;
    }
    if (aliasCanon === targetCanon) {
      // `cid_alias_not_self` would refuse the row and take the whole statement with it. Both writers already
      // skip `key === val`, so a self-pair on disk means the file was hand-edited or predates that check.
      reject(alias, `${kind} pair maps a CID to itself after canonicalisation (cid_alias_not_self)`);
      continue;
    }
    out.push({ aliasCanon, targetCanon, kind, proof });
  }
  return out;
}

export const BACKFILL_CID_ALIASES: BackfillArea = {
  name: "backfill_cid_aliases",
  version: 1,
  kind: "backfill",
  sources: () => [cidEquivalenceFile(), supersededFile()].filter((f) => fs.existsSync(f)),
  // 74 pairs in two small files. One scope, one pass, no cursor worth keeping.
  scopes: () => [{ key: "local", sources: [cidEquivalenceFile(), supersededFile()] }],

  async run(_scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    const rows: CidAliasRow[] = [];
    try {
      const doc = readRawYamlIfPresent(cidEquivalenceFile(), CidEquivalenceSchema);
      if (doc) rows.push(...aliasRowsFrom(doc.pairs, "equivalent", "rehash", (k, r) => ctx.reject(`${cidEquivalenceFile()}#${k}`, r)));
    } catch (e) {
      ctx.reject(cidEquivalenceFile(), `cid equivalence map unreadable: ${(e as Error).message}`);
    }
    try {
      const doc = readRawYamlIfPresent(supersededFile(), SupersededCidsSchema);
      if (doc) rows.push(...aliasRowsFrom(doc.pairs, "superseded", "resolveFileCid", (k, r) => ctx.reject(`${supersededFile()}#${k}`, r)));
    } catch (e) {
      ctx.reject(supersededFile(), `superseded cid map unreadable: ${(e as Error).message}`);
    }

    // SUPERSEDED LAST, ON PURPOSE. `cid_alias` is keyed on `alias_canon` alone, so a CID that appears in
    // BOTH maps gets one row and the later write wins. 'superseded' is the stronger claim — an equivalence
    // says "two spellings of the same bytes", a supersession says "this CID is not the file at all and no
    // computer can ever `cat` it" (superseded-cids.service.ts) — so it must be the one that stands.
    await upsertCidAliases(rows);
    ctx.checkpoint("local", rows.length);
    return { rows: rows.length };
  },

  async verify() {
    const mismatches: string[] = [];
    const eq = readRawYamlIfPresent(cidEquivalenceFile(), CidEquivalenceSchema);
    const sup = readRawYamlIfPresent(supersededFile(), SupersededCidsSchema);
    const eqPairs = Object.keys(eq?.pairs ?? {}).length;
    const supPairs = Object.keys(sup?.pairs ?? {}).length;
    const total = await countCidAliases();
    const supRows = await countCidAliases("superseded");
    // Not an equality on the equivalent count: a CID present in BOTH maps legitimately lands as ONE row of
    // kind='superseded', so `equivalent + superseded <= eqPairs + supPairs` and the shortfall is the overlap.
    if (supRows !== supPairs) mismatches.push(`${supRows} superseded aliases for ${supPairs} pairs on disk`);
    if (total > eqPairs + supPairs) mismatches.push(`${total} alias rows for ${eqPairs + supPairs} pairs on disk`);
    return { yamlRows: eqPairs + supPairs, pgRows: total, mismatches };
  },
};

/**
 * Register areas 5 and 10.
 *
 * Order matters and it is not alphabetical: `manifest_entry.unit_id` and `pin_claim.device_id` are FKs into
 * the rows areas 1 and 2 produce, so `registerUnitBackfills()` must have run before this — registration
 * order IS the run order (`runAllBackfills`). Area 10 has no FK into a unit and could go anywhere; it sits
 * beside area 5 because `cid_alias.target_canon` shares `lfb.cid` with the manifests.
 *
 * Explicit rather than a module-load side effect, so importing this file for one exported helper (the specs
 * import `stagesToRun` and `aliasRowsFrom`) does not silently mutate the global registry.
 */
export function registerManifestBackfills(): void {
  registerBackfill(BACKFILL_MANIFESTS);
  registerBackfill(BACKFILL_CID_ALIASES);
}
