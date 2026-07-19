// Foreign Pin Discovery (pm/foreign_pin_discovery.mdx): find files whose bytes are ALREADY pinned on this
// node but pinned OUTSIDE Large File Bridge — a bare `ipfs add`, IPFS Desktop, a Pinata/web3.storage helper,
// a script — so the pin wears a CID our app never computes and a naive check reports the file "not pinned."
//
// The whole subsystem is built around one rule (knowledge/ipfs.mdx §5.1 honest boundary): re-hashing is
// EXPENSIVE, so it runs ONLY in the background scan/pin pass, is SIZE-PRUNED hard (hash only files whose size
// matches a mystery pin), and is FINGERPRINT-CACHED (an unchanged file is never re-hashed). The read paths
// (repo row, IPFS page) only ever read the RECORDED result — a flag, never a hash.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir, ensureDir } from "../../config/state-dir.js";
import { canonicalCid, keptCidSet, keptSizeIndex, contentPinnedCidDetailed } from "./ipfs.service.js";
import { log } from "../../shared/logging.js";

// ── on-disk stores under the state root (tier-1 local persistence — foreign_pin_discovery §5) ─────────
// The fingerprint CACHE: a file's (size, mtime) → the CID it is pinned under, or null (a NEGATIVE cache so we
// don't re-hash the same non-match every 15 minutes). Keyed by abs path + fingerprint so a changed file
// (new size/mtime) misses the cache and is re-discovered.
const CACHE_FILE = () => path.join(resolveStateDir(), "foreign-pin-cache.json");
// The global INDEX the UI reads: one entry per discovered pin, mapping the file to the CID it is really
// pinned under. Rebuildable/derived — the durable, travelling record is the per-file .lfbridge sidecar
// (tiers 2/3), written by the scan's reconcileExternalState.
const INDEX_FILE = () => path.join(resolveStateDir(), "foreign-pins.json");

interface CacheEntry {
  cid: string | null; // the discovered CID, or null = hashed-and-not-pinned (negative cache)
  profile?: string;
  at: string;
}
export interface ForeignPinRecord {
  canonicalCid: string; // canonical (CIDv1 base32) — the UI/reconcile lookup key
  cid: string; // the ACTUAL CID the bytes are pinned under (e.g. QmTo4Htjkqv… — recorded verbatim)
  profile: string; // which ADD_PROFILES entry reproduced it
  absPath: string; // resolved local path of the file
  size: number;
  repoRoot: string | null; // owning repo root when known (null = loose / computer-unit)
  at: string; // ISO discovery time
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const fpKey = (absPath: string, size: number, mtimeMs: number) => `${absPath}::${size}:${Math.round(mtimeMs)}`;

// ── the discovery context: the kept-set + the size-prune index, built ONCE per scan ───────────────────
export interface DiscoveryCtx {
  keptSet: Set<string>; // canonical kept CIDs (pins ∪ MFS roots) — passed to the re-hash membership test
  keptSizes: number[]; // sorted kept cumulative sizes — the size-prune band lookup
}

/** Build the discovery context once per scan (foreign_pin_discovery §3 step 1). Two metadata-only node
 *  passes (kept-set + per-CID sizes); returns an empty ctx when the node is unreachable so discovery no-ops. */
export async function buildDiscoveryCtx(): Promise<DiscoveryCtx> {
  try {
    const [keptSet, sizeIdx] = await Promise.all([keptCidSet(), keptSizeIndex()]);
    return { keptSet, keptSizes: [...sizeIdx.keys()].sort((a, b) => a - b) };
  } catch (e) {
    log.debug("ipfs", `buildDiscoveryCtx skipped: ${(e as Error).message}`);
    return { keptSet: new Set(), keptSizes: [] };
  }
}

/** SIZE-PRUNE: is there a kept CID whose cumulative size sits in [size, size + tolerance]? A DAG's cumulative
 *  size is the file size + a little framing (~0.024% measured), so a real pin of this file has a size just at
 *  or above it. Tolerance = max(64 KiB, 3% of size) covers dag-pb framing on large multi-block files. */
function sizeMatches(keptSizes: number[], size: number): boolean {
  const hi = size + Math.max(65536, Math.floor(size * 0.03));
  // binary search for the first kept size >= `size`; a hit exists iff that value is <= hi.
  let lo = 0;
  let hiIdx = keptSizes.length;
  while (lo < hiIdx) {
    const mid = (lo + hiIdx) >> 1;
    if (keptSizes[mid]! < size) lo = mid + 1;
    else hiIdx = mid;
  }
  return lo < keptSizes.length && keptSizes[lo]! <= hi;
}

/**
 * Discover whether THIS file's bytes are already pinned under some (possibly foreign) CID — the bounded,
 * cached core (foreign_pin_discovery §3). Returns the discovered CID + profile, or null. Order:
 *   1. cache hit on (path,size,mtime) → return the cached verdict (incl. the negative cache), no hash.
 *   2. SIZE-PRUNE against the kept-size band → miss ⇒ record null in cache, return null (no hash).
 *   3. re-hash under ADD_PROFILES and test against the kept-set → cache + return the verdict.
 * EXPENSIVE only in case 3, and case 2 eliminates the vast majority of files with a single lookup.
 */
export async function discoverForeignPin(
  absPath: string,
  size: number,
  mtimeMs: number,
  ctx: DiscoveryCtx,
): Promise<{ cid: string; profile: string } | null> {
  const cache = readJson<Record<string, CacheEntry>>(CACHE_FILE(), {});
  const key = fpKey(absPath, size, mtimeMs);
  const cached = cache[key];
  if (cached) return cached.cid ? { cid: cached.cid, profile: cached.profile ?? "cached" } : null;

  // Size-prune: no kept pin near this size ⇒ this file cannot be any of them. Negative-cache and return.
  if (!sizeMatches(ctx.keptSizes, size)) {
    cache[key] = { cid: null, at: new Date().toISOString() };
    writeJsonAtomic(CACHE_FILE(), cache);
    return null;
  }

  const hit = await contentPinnedCidDetailed(absPath, ctx.keptSet);
  cache[key] = { cid: hit?.cid ?? null, profile: hit?.profile, at: new Date().toISOString() };
  writeJsonAtomic(CACHE_FILE(), cache);
  return hit;
}

// ── the global index the UI reads (tier-1 fast lookup — rebuildable) ──────────────────────────────────
let indexCache: { mtimeMs: number; rows: ForeignPinRecord[] } | null = null;

/** All discovered foreign pins (cached by the index file's mtime — cheap for the hot read paths). */
export function readForeignPins(): ForeignPinRecord[] {
  try {
    const st = fs.statSync(INDEX_FILE());
    if (indexCache && indexCache.mtimeMs === st.mtimeMs) return indexCache.rows;
    const rows = readJson<ForeignPinRecord[]>(INDEX_FILE(), []);
    indexCache = { mtimeMs: st.mtimeMs, rows };
    return rows;
  } catch {
    return [];
  }
}

/** Discovered foreign pin for a given absolute file path (repo row surfacing — foreign_pin_discovery §6). */
export function foreignPinByAbsPath(absPath: string): ForeignPinRecord | undefined {
  return readForeignPins().find((r) => r.absPath === absPath);
}

/** Discovered foreign pin for a CANONICAL cid (IPFS-page reverse resolution — §4). */
export function foreignPinByCanonicalCid(cid: string): ForeignPinRecord | undefined {
  const target = canonicalCid(cid);
  return readForeignPins().find((r) => r.canonicalCid === target);
}

/** Upsert a discovered pin into the global index (keyed by absPath — one live record per file). */
export function recordForeignPin(rec: Omit<ForeignPinRecord, "canonicalCid" | "at"> & { at?: string }): void {
  const rows = readJson<ForeignPinRecord[]>(INDEX_FILE(), []);
  const canon = canonicalCid(rec.cid);
  const next: ForeignPinRecord = {
    ...rec,
    canonicalCid: canon,
    at: rec.at ?? new Date().toISOString(),
  };
  const i = rows.findIndex((r) => r.absPath === rec.absPath);
  if (i >= 0) rows[i] = next;
  else rows.push(next);
  writeJsonAtomic(INDEX_FILE(), rows);
  indexCache = null; // force re-read on next surface
}

/** Compatibility (§5.1): drop any discovered pin whose CID the kept-set no longer holds — another tool
 *  unpinned it, so we must stop claiming it. Called once per scan with the freshly-built kept-set. */
export function verifyForeignPins(keptSet: Set<string>): void {
  const rows = readJson<ForeignPinRecord[]>(INDEX_FILE(), []);
  const kept = rows.filter((r) => keptSet.has(r.canonicalCid));
  if (kept.length !== rows.length) {
    writeJsonAtomic(INDEX_FILE(), kept);
    indexCache = null;
    log.debug("ipfs", `verifyForeignPins dropped ${rows.length - kept.length} unpinned discoveries`);
  }
}
