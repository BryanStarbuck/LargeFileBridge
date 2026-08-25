// THE PIN PLANE'S DATA-ACCESS LAYER — `lfb.manifest_entry`, `lfb.pin_claim`, `lfb.cid` and
// `lfb.cid_alias` (database.mdx §4.1, migration 0007).
//
// Like `store-model/unit.repo.ts`, every function here is Postgres-only and every one is safe to call with
// no database: they go through `shared/persistence/db.ts`, whose `q`/`exec`/`copyRows` answer emptily when
// there is no pool. None of them is a fallback — deciding what to do when Postgres is absent belongs to the
// caller, which is the only layer that knows what the YAML answer would have been (R2 / database.mdx §7).
//
// ── THE THREE THINGS THIS FILE EXISTS TO GET RIGHT ─────────────────────────────────────────────────────
//
// 1. `stage` IS A PARAMETER, NEVER A DEFAULT. `pin/r/<folder>/manifest.yaml` (stage='unit') and
//    `repos/<key>/manifest.yaml` (stage='tracking') are NOT twins to be collapsed — they are two stages of
//    one pipeline. `pin.service.ts:768-770` deliberately keeps the unit copy off the wire so
//    `mergeManifests` has two distinct operands, and `pin.service.ts:793` gates the tracking write behind
//    `publish_manifest`. A helper that defaulted the stage, or a schema that folded the two, would start
//    publishing manifests for repos the user OPTED OUT of — a data-escape bug, not a perf regression
//    (database.mdx §4.1).
//
// 2. A MANIFEST WRITE IS A REPLACE, NOT A UNION. `pinned_by` is not append-only: the pin pass DROPS our own
//    claim when the bytes are no longer pinned here, and `mergeManifests` (manifest-merge.ts:123-128) is
//    built so a peer's WITHDRAWAL travels too. A projection that only ever upserted would resurrect a claim
//    this computer withdrew — the exact defect that produced 77% of one day's commits (0007's header). So
//    every write sweeps the rows the incoming document no longer carries, inside the same transaction.
//
// 3. `origin` IS A RATCHET, AND THE TRIGGER IS THE FLOOR. `lfb_pin_claim_guard` refuses any claim naming
//    THIS computer with origin='wire'. The upsert below can only ever move a claim wire → local, never the
//    reverse, so the writer and the guard agree by construction rather than by discipline.
import path from "node:path";
import type { Manifest } from "@lfb/shared";
import { copyRows, dbEnabled, q, q1, tryDb, tx } from "../../shared/persistence/db.js";
import { DB_SCHEMA as S } from "../../shared/persistence/pool.js";
import { repoFolderKey } from "../../shared/store/sanitize.js";
import { log } from "../../shared/logging.js";

export type ManifestStage = "unit" | "tracking";
export type ClaimOrigin = "local" | "wire";

/** One `pinned_by` label, resolved to a device and classified. */
export interface ManifestClaim {
  deviceId: number;
  origin: ClaimOrigin;
  /** The entry's CID at the moment of the claim — what the device says it holds. */
  cidCanon: string | null;
}

export interface ManifestEntryInput {
  /** VERBATIM, as the document spells it. `rel_posix` is a GENERATED column and computes itself. */
  relPath: string;
  /** Verbatim, never locally rewritten (0002's header, cid-equivalence.service.ts). */
  cidText: string | null;
  /** `canonicalCid(cidText)` — computed in TypeScript and inserted as a literal (R7). */
  cidCanon: string | null;
  sizeBytes: number;
  sha256: string | null;
  modifiedAt: Date | null;
  claims: ManifestClaim[];
}

export interface ManifestWriteResult {
  entries: number;
  claims: number;
  entriesSwept: number;
  claimsSwept: number;
}

/**
 * The TypeScript twin of `manifest_entry.rel_posix`'s generation expression,
 * `replace(rel_path, '\', '/')` (0007).
 *
 * It exists because the SWEEP predicates below have to name rows by the key the PK actually uses, and the
 * generated value is not known to us until after the insert. Keeping the two spellings identical is the
 * whole job — if they drifted, the sweep would delete rows it had just written.
 */
export function toRelPosix(relPath: string): string {
  return relPath.replaceAll("\\", "/");
}

/**
 * WHICH CLAIMS ARE OURS — the one classification the guard trigger also enforces.
 *
 * `manifest-merge.ts:123` tests our own claim with a plain `c !== selfLabel` on the RAW label, so the
 * primary rule here is that same equality: whatever the merge calls ours, we call `origin='local'`.
 *
 * Two additions, both of which only ever move a claim TOWARD 'local':
 *   * the `repoFolderKey` spelling, because the same computer appears sanitized in `history/<device>.txt`
 *     and unsanitized in `pinned_by` (unit-backfill.ts's device-registry transform) and a claim filed under
 *     the sanitized spelling is still ours;
 *   * `deviceId === selfDeviceId`, which is MANDATORY rather than defensive: that is precisely the
 *     predicate `lfb_pin_claim_guard` evaluates, so omitting it would let us hand the database a row it is
 *     obliged to reject and fail the whole transaction.
 */
export function claimOriginFor(
  label: string,
  selfLabel: string,
  deviceId: number,
  selfDeviceId: number | null,
): ClaimOrigin {
  if (selfDeviceId !== null && deviceId === selfDeviceId) return "local";
  const t = label.trim();
  const s = selfLabel.trim();
  if (!s) return "wire"; // no idea who we are → we cannot claim anything as ours
  if (t === s) return "local";
  return repoFolderKey(t) === repoFolderKey(s) ? "local" : "wire";
}

// ── unit lookup ─────────────────────────────────────────────────────────────────────────────────────────

// `pin/r/<folder>` → `unit_id` is NOT re-declared here: `store-model/file.repo.ts unitIdForPinFolder` is
// already that lookup on `unit_pin_folder_uq` (0003), and a second copy would be a second thing to keep in
// step with the index. `projectManifest` takes the resolver as a thunk precisely so each caller supplies
// whichever of the two keys it happens to hold.

/** A repo's working-tree root → `unit_id` via `unit_abs_path_unique` (0003). */
export async function unitIdForAbsPath(absPath: string): Promise<number | null> {
  const row = await q1<{ unit_id: string }>(`SELECT unit_id::text FROM ${S}.unit WHERE abs_path = $1`, [
    path.resolve(absPath),
  ]);
  return row ? Number(row.unit_id) : null;
}

// ── device resolution ───────────────────────────────────────────────────────────────────────────────────

/**
 * The label→device index, BOTH spellings, from one SELECT.
 *
 * `lfb.device` already stores both: `label` is the `pinned_by` spelling and `folder_key` is
 * `repoFolderKey(label)`, the `history/<device>.txt` spelling. Indexing both here means a manifest token in
 * either spelling resolves to the ONE row area 1 created for that computer — without this file re-reading
 * the SDL device registry off disk on every manifest write.
 */
export interface DeviceIndex {
  byLabel: Map<string, number>;
  byFolderKey: Map<string, number>;
  selfDeviceId: number | null;
  /** The CANONICAL spelling of this computer, as area 1 resolved it through the SDL device registry. */
  selfLabel: string | null;
}

export async function readDeviceIndex(): Promise<DeviceIndex> {
  const rows = await q<{ device_id: number; label: string; folder_key: string | null; is_self: boolean }>(
    `SELECT device_id, label, folder_key, is_self FROM ${S}.device`,
  );
  const byLabel = new Map<string, number>();
  const byFolderKey = new Map<string, number>();
  let selfDeviceId: number | null = null;
  let selfLabel: string | null = null;
  for (const r of rows) {
    byLabel.set(r.label, r.device_id);
    if (r.folder_key) byFolderKey.set(r.folder_key, r.device_id);
    if (r.is_self) {
      selfDeviceId = r.device_id;
      selfLabel = r.label;
    }
  }
  return { byLabel, byFolderKey, selfDeviceId, selfLabel };
}

export function deviceIdForLabel(index: DeviceIndex, label: string): number | null {
  const t = label.trim();
  if (!t) return null;
  return index.byLabel.get(t) ?? index.byFolderKey.get(repoFolderKey(t)) ?? null;
}

/**
 * Make sure a `pinned_by` label has a `device` row — INSERT-ONLY, deliberately.
 *
 * `unit.repo.ts upsertDevices` is area 1's writer and it sets `is_self = EXCLUDED.is_self`; calling it from
 * here with `isSelf: false` would STAND DOWN this computer's own row the first time a manifest happened to
 * name us. `ON CONFLICT DO NOTHING` cannot do that, cannot create a second `is_self` row, and cannot
 * overwrite the peer id area 1 read out of the SDL registry — so a teammate's new computer becomes visible
 * in the pin plane on the next manifest write instead of waiting for a backfill, at no risk to area 1's
 * columns (R5).
 */
export async function ensureDeviceLabels(labels: string[]): Promise<number> {
  const wanted = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
  if (wanted.length === 0) return 0;
  return copyRows(
    `${S}.device`,
    ["label", "folder_key", "is_self", "last_seen_at"],
    wanted.map((l) => [l, repoFolderKey(l), false, new Date()]),
    { onConflict: "ON CONFLICT (label) DO NOTHING" },
  );
}

// ── lfb.cid ─────────────────────────────────────────────────────────────────────────────────────────────

export interface CidRow {
  cidCanon: string;
  /** The verbatim first-seen spelling. NEVER a locally rewritten one (0002, R7). */
  cidText: string;
}

/**
 * Adopt CIDs, `ON CONFLICT DO NOTHING` — the clause R5 names for this table specifically.
 *
 * `lfb.cid` is a shared dimension with several writers (manifests, foreign pins, the compression records).
 * `cid_text` is "the verbatim FIRST-SEEN spelling", so first writer wins by definition and an upsert that
 * overwrote it would let the last pass to run decide what the fleet had recorded.
 */
export async function upsertCids(rows: CidRow[]): Promise<number> {
  const deduped = new Map<string, string>();
  for (const r of rows) if (r.cidCanon && !deduped.has(r.cidCanon)) deduped.set(r.cidCanon, r.cidText);
  if (deduped.size === 0) return 0;
  return copyRows(
    `${S}.cid`,
    ["cid_canon", "cid_text"],
    [...deduped].map(([canon, text]) => [canon, text]),
    { onConflict: "ON CONFLICT (cid_canon) DO NOTHING" },
  );
}

// ── the manifest replace ────────────────────────────────────────────────────────────────────────────────

const ENTRY_COLUMNS = ["unit_id", "stage", "rel_path", "cid_text", "cid_canon", "size_bytes", "sha256", "modified_at"];
const CLAIM_COLUMNS = ["unit_id", "stage", "rel_posix", "device_id", "origin", "cid_canon"];

/**
 * Collapse a document onto the PK the table actually uses, BEFORE it reaches Postgres.
 *
 * The PK is `(unit_id, stage, rel_posix)`, so `a\b.mp4` and `a/b.mp4` are ONE row (0007). A multi-row
 * `INSERT … ON CONFLICT DO UPDATE` that carried both spellings dies with "ON CONFLICT DO UPDATE command
 * cannot affect row a second time" and takes the whole repo's manifest with it. `normalizeManifestPaths`
 * heals the documents on this machine so the case is currently absent — which is exactly why it has to be
 * handled here rather than assumed away.
 *
 * Later wins, matching `foldManifestFiles`' last-wins fold of a `merge=union` duplicate, and the claims of
 * both spellings are unioned so a peer's claim on the losing twin is not silently dropped.
 */
export function dedupeEntries(entries: ManifestEntryInput[]): Array<ManifestEntryInput & { relPosix: string }> {
  const byPosix = new Map<string, ManifestEntryInput & { relPosix: string }>();
  for (const e of entries) {
    const relPosix = toRelPosix(e.relPath);
    const prior = byPosix.get(relPosix);
    const claims = new Map<number, ManifestClaim>();
    for (const c of prior?.claims ?? []) claims.set(c.deviceId, c);
    // A later claim for the same device supersedes the earlier one, and `origin='local'` never loses to a
    // 'wire' twin — the same ratchet the SQL upsert applies, so the in-memory fold cannot disagree with it.
    for (const c of e.claims) {
      const had = claims.get(c.deviceId);
      claims.set(c.deviceId, had?.origin === "local" ? { ...c, origin: "local" } : c);
    }
    byPosix.set(relPosix, { ...e, relPosix, claims: [...claims.values()] });
  }
  return [...byPosix.values()];
}

/**
 * Write ONE stage of ONE unit's manifest: upsert every entry and claim the document carries, then sweep
 * whatever it no longer carries. All of it in one transaction, so a reader never sees a half-replaced
 * manifest and a failure leaves the previous one intact.
 */
export async function replaceManifestStage(
  unitId: number,
  stage: ManifestStage,
  entries: ManifestEntryInput[],
): Promise<ManifestWriteResult> {
  const rows = dedupeEntries(entries);
  const keepPaths = rows.map((r) => r.relPosix);
  const claimPaths: string[] = [];
  const claimDevices: number[] = [];
  for (const r of rows) {
    for (const c of r.claims) {
      claimPaths.push(r.relPosix);
      claimDevices.push(c.deviceId);
    }
  }

  return tx(async (client) => {
    const cids: CidRow[] = [];
    for (const r of rows) {
      if (r.cidCanon) cids.push({ cidCanon: r.cidCanon, cidText: r.cidText ?? r.cidCanon });
      for (const c of r.claims) if (c.cidCanon) cids.push({ cidCanon: c.cidCanon, cidText: r.cidText ?? c.cidCanon });
    }
    // The FK on `manifest_entry.cid_canon` is ON DELETE SET NULL, so an unadopted CID would silently null
    // the column rather than fail — a manifest that quietly lost its CIDs. Adopt first.
    const dedupedCids = new Map<string, string>();
    for (const c of cids) if (!dedupedCids.has(c.cidCanon)) dedupedCids.set(c.cidCanon, c.cidText);
    if (dedupedCids.size) {
      await copyRows(
        `${S}.cid`,
        ["cid_canon", "cid_text"],
        [...dedupedCids].map(([canon, text]) => [canon, text]),
        { onConflict: "ON CONFLICT (cid_canon) DO NOTHING", client },
      );
    }

    let entriesWritten = 0;
    if (rows.length) {
      entriesWritten = await copyRows(
        `${S}.manifest_entry`,
        ENTRY_COLUMNS,
        rows.map((r) => [
          unitId,
          stage,
          r.relPath,
          r.cidText,
          r.cidCanon,
          // The CHECK is `size_bytes >= 0` and the column is bigint. A manifest `size` is a JSON number that
          // has been through YAML; clamping and rounding here means a malformed document costs one wrong
          // size rather than aborting the repo's whole projection.
          Math.max(0, Math.round(r.sizeBytes || 0)),
          r.sha256,
          r.modifiedAt,
        ]),
        {
          // This table has ONE writer (this function), so a whole-row DO UPDATE is honest here — unlike
          // `lfb.file`, which R5 is written about.
          onConflict:
            "ON CONFLICT (unit_id, stage, rel_posix) DO UPDATE SET " +
            ["rel_path", "cid_text", "cid_canon", "size_bytes", "sha256", "modified_at"]
              .map((c) => `${c} = EXCLUDED.${c}`)
              .join(", "),
          client,
        },
      );
    }

    // MECHANIC 2 (see the file header): the document is the truth about this stage, so an entry it no longer
    // carries is gone. `<> ALL('{}')` is TRUE for every row, which correctly empties the stage when the
    // manifest itself is empty.
    const sweptEntries = await client.query(
      `DELETE FROM ${S}.manifest_entry WHERE unit_id = $1 AND stage = $2 AND rel_posix <> ALL($3::text[])`,
      [unitId, stage, keepPaths],
    );

    let claimsWritten = 0;
    if (claimPaths.length) {
      claimsWritten = await copyRows(
        `${S}.pin_claim`,
        CLAIM_COLUMNS,
        rows.flatMap((r) => r.claims.map((c) => [unitId, stage, r.relPosix, c.deviceId, c.origin, c.cidCanon])),
        {
          // THE RATCHET. A wire claim may be superseded by a local one; a local claim is never demoted to
          // wire. That is not a preference — `lfb_pin_claim_guard` REJECTS a self-claim with origin='wire',
          // so a symmetric `origin = EXCLUDED.origin` would be a statement the database is entitled to
          // refuse. `claimed_at` is deliberately untouched: it records when the claim was FIRST seen.
          onConflict:
            "ON CONFLICT (unit_id, stage, rel_posix, device_id) DO UPDATE SET " +
            `origin = CASE WHEN EXCLUDED.origin = 'local' THEN 'local'::${S}.claim_origin ` +
            `ELSE ${S}.pin_claim.origin END, cid_canon = EXCLUDED.cid_canon`,
          client,
        },
      );
    }

    // THE WITHDRAWAL. A claim the document no longer carries is a claim that was DROPPED — by our own pin
    // pass when the bytes stopped being pinned here, or by a peer's mirror. Two parallel arrays rather than
    // a tuple list so the statement takes 4 bind parameters instead of 2×22,000.
    const sweptClaims = await client.query(
      `DELETE FROM ${S}.pin_claim c
        WHERE c.unit_id = $1 AND c.stage = $2
          AND NOT EXISTS (
            SELECT 1 FROM unnest($3::text[], $4::int[]) AS k(rel, dev)
             WHERE k.rel = c.rel_posix AND k.dev = c.device_id)`,
      [unitId, stage, claimPaths, claimDevices],
    );

    return {
      entries: entriesWritten,
      claims: claimsWritten,
      entriesSwept: sweptEntries.rowCount ?? 0,
      claimsSwept: sweptClaims.rowCount ?? 0,
    };
  });
}

// ── the live projection (R1 dual-write) ─────────────────────────────────────────────────────────────────

/**
 * TRANSLATE a `Manifest` document into the row shape above.
 *
 * `canonicalCid` is injected rather than imported so this module stays free of `ipfs.service.ts` (which
 * pulls the RPC client, the daemon lifecycle and the whole IPFS module graph in behind it). Every caller
 * passes the same function, which is what keeps R7 true: the canonical form is computed in TypeScript, once,
 * by the code that already owns the rule.
 */
export function manifestToEntries(
  manifest: Manifest,
  opts: {
    canonicalCid: (cid: string) => string;
    selfLabel: string;
    index: DeviceIndex;
    onUnknownLabel?: (label: string) => void;
  },
): ManifestEntryInput[] {
  const out: ManifestEntryInput[] = [];
  for (const f of manifest.files) {
    const cidText = f.cid ?? null;
    const cidCanon = cidText ? opts.canonicalCid(cidText) : null;
    const claims: ManifestClaim[] = [];
    for (const label of f.pinned_by ?? []) {
      const deviceId = deviceIdForLabel(opts.index, label);
      if (deviceId === null) {
        opts.onUnknownLabel?.(label);
        continue;
      }
      claims.push({
        deviceId,
        origin: claimOriginFor(label, opts.selfLabel, deviceId, opts.index.selfDeviceId),
        cidCanon,
      });
    }
    const modified = f.modified_at ? new Date(f.modified_at) : null;
    out.push({
      relPath: f.path,
      cidText,
      cidCanon,
      sizeBytes: f.size ?? 0,
      sha256: f.sha256 ?? null,
      modifiedAt: modified && !Number.isNaN(modified.getTime()) ? modified : null,
      claims,
    });
  }
  return out;
}

/**
 * ONE PROJECTION AT A TIME PER (unit, stage).
 *
 * The four YAML writers this rides behind are SYNCHRONOUS (`writeRepoManifest`, `writeRepoTrackingManifest`
 * and their callers are sync callbacks handed to `runUnitPin`), so the Postgres half cannot be awaited
 * without changing every call site up the chain — including `pin.service.ts:789/793`, which are lambdas
 * inside a spec object. It is therefore fire-and-forget, which makes overlap possible: the reconcile fold
 * and the pin pass can both write the same repo's manifest within a second of each other.
 *
 * Overlap matters here because the projection is a REPLACE. Two interleaved replaces could have one's sweep
 * delete rows the other's insert had just written; the next write would repair it, but the window would be
 * a manifest that reads short. A per-key promise chain removes the window entirely and costs one Map entry.
 */
const chains = new Map<string, Promise<void>>();

function enqueue(key: string, fn: () => Promise<void>): void {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next);
  void next.then(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
}

/** Await every in-flight projection. For tests and for a CLI that wants a settled database before it exits. */
export async function drainManifestProjections(): Promise<void> {
  while (chains.size) await Promise.all([...chains.values()]);
}

export interface ProjectManifestTarget {
  stage: ManifestStage;
  /** Resolves the unit, lazily — a lookup we must not pay when there is no database. */
  unitId: () => Promise<number | null>;
  /** For the log line when something degrades. */
  label: string;
}

/**
 * THE DUAL-WRITE (R1). The YAML write above it has already happened and is untouched; this is a pure ADD
 * behind it, and it can only ever fail into a log line.
 */
export function projectManifest(
  target: ProjectManifestTarget,
  manifest: Manifest,
  opts: { canonicalCid: (cid: string) => string; selfLabel: string },
): void {
  // Ask before queueing: `dbEnabled()` is the documented `auto` posture and answering it here means a
  // machine with no Postgres — every machine today — pays nothing at all for this call.
  if (!dbEnabled()) return;
  enqueue(`${target.label}#${target.stage}`, async () => {
    await tryDb(
      async () => {
        const unitId = await target.unitId();
        if (unitId === null) {
          // No unit row yet (the backfill has not run, or this repo was registered since). Not an error and
          // not a fallback — the backfill will pick the whole document up, so silence is correct here.
          return;
        }
        const labels = new Set<string>();
        for (const f of manifest.files) for (const l of f.pinned_by ?? []) if (l.trim()) labels.add(l.trim());
        let index = await readDeviceIndex();
        const missing = [...labels].filter((l) => deviceIdForLabel(index, l) === null);
        if (missing.length) {
          await ensureDeviceLabels(missing);
          index = await readDeviceIndex();
        }
        const entries = manifestToEntries(manifest, {
          canonicalCid: opts.canonicalCid,
          selfLabel: opts.selfLabel,
          index,
          onUnknownLabel: (l) => log.warn("manifest", `${target.label}: no device row for pinned_by '${l}'`),
        });
        await replaceManifestStage(unitId, target.stage, entries);
      },
      undefined,
      `manifest.project.${target.stage}`,
    );
  });
}

// ── cid_alias (area 10 + the two local maps' dual-write) ────────────────────────────────────────────────

export type AliasKind = "equivalent" | "superseded";

export interface CidAliasRow {
  aliasCanon: string;
  targetCanon: string;
  kind: AliasKind;
  /** 'resolveFileCid' | 'rehash' | 'peer' — how the pair was established. */
  proof: string;
}

/**
 * Upsert alias pairs.
 *
 * `target_canon` is an FK into `lfb.cid`, so its row is adopted first. `alias_canon` deliberately is NOT
 * adopted: it is a PK column with no FK, and writing a `lfb.cid` row for it would record the CANONICAL
 * spelling as `cid_text` — "the verbatim first-seen spelling" — for a CID whose verbatim form the fleet may
 * have recorded differently. That is a small lie the schema does not require us to tell.
 *
 * `proved_by` is left NULL on purpose. `superseded_cids.yaml` mixes pairs THIS computer proved by a walk
 * with pairs it ADOPTED from a peer's device file (`adoptSupersededCids`), and the file records no
 * provenance — so naming a prover would be a guess. NULL is the honest answer to a question the source
 * cannot answer.
 */
export async function upsertCidAliases(rows: CidAliasRow[]): Promise<number> {
  const clean = rows.filter((r) => r.aliasCanon && r.targetCanon && r.aliasCanon !== r.targetCanon);
  if (clean.length === 0) return 0;
  const deduped = new Map<string, CidAliasRow>();
  for (const r of clean) deduped.set(r.aliasCanon, r); // later wins — see the caller's ordering note
  const list = [...deduped.values()];
  await upsertCids(list.map((r) => ({ cidCanon: r.targetCanon, cidText: r.targetCanon })));
  return copyRows(
    `${S}.cid_alias`,
    ["alias_canon", "target_canon", "kind", "proof", "proved_by", "proved_at"],
    list.map((r) => [r.aliasCanon, r.targetCanon, r.kind, r.proof, null, new Date()]),
    {
      onConflict:
        "ON CONFLICT (alias_canon) DO UPDATE SET target_canon = EXCLUDED.target_canon, " +
        "kind = EXCLUDED.kind, proof = EXCLUDED.proof, proved_at = EXCLUDED.proved_at",
    },
  );
}

/** Drop one alias — the mirror of `dropCidEquivalence`, which is the only caller that removes a pair. */
export async function deleteCidAlias(aliasCanon: string): Promise<number> {
  const rows = await q<{ alias_canon: string }>(
    `DELETE FROM ${S}.cid_alias WHERE alias_canon = $1 RETURNING alias_canon`,
    [aliasCanon],
  );
  return rows.length;
}

/** Fire-and-forget alias write, for the two machine-local maps' dual-write. Never throws (R2). */
export function projectCidAlias(row: CidAliasRow): void {
  if (!dbEnabled()) return;
  enqueue("cid_alias", async () => {
    await tryDb(() => upsertCidAliases([row]), 0, "manifest.projectCidAlias");
  });
}

/** Fire-and-forget alias removal. Never throws (R2). */
export function projectCidAliasRemoval(aliasCanon: string): void {
  if (!dbEnabled()) return;
  enqueue("cid_alias", async () => {
    await tryDb(() => deleteCidAlias(aliasCanon), 0, "manifest.projectCidAliasRemoval");
  });
}

// ── verification reads ──────────────────────────────────────────────────────────────────────────────────

export async function countManifestEntries(stage?: ManifestStage): Promise<number> {
  const r = stage
    ? await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.manifest_entry WHERE stage = $1`, [stage])
    : await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.manifest_entry`);
  return Number(r?.n ?? 0);
}

export async function countPinClaims(stage?: ManifestStage): Promise<number> {
  const r = stage
    ? await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.pin_claim WHERE stage = $1`, [stage])
    : await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.pin_claim`);
  return Number(r?.n ?? 0);
}

/** Distinct CANONICAL CIDs across both manifest stages — fewer than the raw count, by design (R7). */
export async function countManifestCids(): Promise<number> {
  const r = await q1<{ n: string }>(
    `SELECT count(DISTINCT cid_canon)::text AS n FROM ${S}.manifest_entry WHERE cid_canon IS NOT NULL`,
  );
  return Number(r?.n ?? 0);
}

/**
 * Claims that name THIS computer but did not originate locally.
 *
 * `lfb_pin_claim_guard` makes this unanswerable-by-construction — it is here so the backfill's `verify()`
 * states the invariant rather than assuming it, and so a future change that drops the trigger fails a check
 * instead of quietly changing what "pinned" means (MEMORY.md, "foreign pin: recorded must render").
 */
export async function countSelfClaimsNotLocal(): Promise<number> {
  const r = await q1<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${S}.pin_claim c
       JOIN ${S}.device d ON d.device_id = c.device_id
      WHERE d.is_self AND c.origin <> 'local'`,
  );
  return Number(r?.n ?? 0);
}

export async function countCidAliases(kind?: AliasKind): Promise<number> {
  const r = kind
    ? await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.cid_alias WHERE kind = $1`, [kind])
    : await q1<{ n: string }>(`SELECT count(*)::text AS n FROM ${S}.cid_alias`);
  return Number(r?.n ?? 0);
}

/** Per-(unit, stage) entry counts, for the backfill's per-repo equality check against the YAML. */
export async function manifestEntryCountsByUnit(
  stage: ManifestStage,
): Promise<Map<number, number>> {
  const rows = await q<{ unit_id: string; n: string }>(
    `SELECT unit_id::text, count(*)::text AS n FROM ${S}.manifest_entry WHERE stage = $1 GROUP BY unit_id`,
    [stage],
  );
  return new Map(rows.map((r) => [Number(r.unit_id), Number(r.n)]));
}
