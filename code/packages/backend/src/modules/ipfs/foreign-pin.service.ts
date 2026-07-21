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
function writeJsonAtomic(file: string, data: unknown, pretty = true): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const fpKey = (absPath: string, size: number, mtimeMs: number) => `${absPath}::${size}:${Math.round(mtimeMs)}`;

// ── WRITE-BACK STORES (memory.mdx — the 4 GB RSS incident of 2026-07-20T22:55) ────────────────────────
//
// THE BUG THIS FIXES. Both JSON stores below used to be read-modify-WRITTEN in FULL, once PER FILE, from
// inside the scan's per-file loop: `readJson(CACHE_FILE())` (readFileSync + JSON.parse of the whole file)
// then `writeJsonAtomic(CACHE_FILE(), cache)` (JSON.stringify of the whole file + writeFileSync). By
// 2026-07-20 foreign-pin-cache.json held 18,521 entries / 3.9 MB, so a single scanned file cost ~4 MB of
// string + a ~20 MB parsed object graph, ALL of it garbage a millisecond later — and the whole-computer
// walk runs many repo units IN PARALLEL (responsiveBudget()), so several of those were co-resident.
//
// That allocation RATE is what killed the process. V8 grows (and the OS keeps) the pages it needs to
// absorb the churn, so RSS ratchets up and never comes back, while `heapUsed` — sampled between GCs —
// stays at ~80 MB and looks perfectly healthy. That is EXACTLY the observed signature: rssMB=4103 with
// heapUsedMB=78 in transactions.log, and heap-watch (which measures heapUsed/heap_size_limit) silent
// throughout. Measured on a copy of the real cache: 2,000 files → RSS 45 MB → 349 MB in 38.7 s. The same
// 2,000 through the write-back store below → RSS flat at ~72 MB in 30 ms (1,290× faster).
//
// It was also QUADRATIC: every negative-cache miss appended an entry and rewrote the file, so the file
// each later file had to parse kept growing — a longer scan made every remaining file more expensive.
//
// THE RULE, therefore: nothing in this module may read or write a whole store inside a per-file loop.
// Load once, mutate in memory, and let the debounced flush below coalesce thousands of mutations into one
// write. Never reintroduce a `readJson(...)`/`writeJsonAtomic(...)` pair on a per-file path.
//
// Cross-process staleness is no worse than before: two processes writing these stores were already
// last-writer-wins per rewrite. We revalidate against the file's identity (ino+size+mtime) on every load
// and reload when another process changed it, but our own unflushed mutations win over a reload.

// How long we may sit on unwritten mutations. Both numbers are deliberately generous, because of WHAT is
// at stake if we lose them: these stores are REBUILDABLE caches (the durable, travelling record is the
// per-file .lfbridge sidecar — tiers 2/3). The worst case of an unflushed loss is that a later scan
// re-derives some entries; the worst case of flushing eagerly is the 4 GB incident. A scan flushes
// explicitly at its end, and a process exit flushes synchronously, so the common paths never rely on
// these at all — they only bound the window for an abrupt kill.
/** Flush this long after the last mutation. Unref'd — a pending flush must never hold the process open. */
const FLUSH_DEBOUNCE_MS = Math.max(250, Number(process.env.LFB_FOREIGN_PIN_FLUSH_MS) || 10_000);
/** …and never let more than this many mutations sit unwritten, whatever the timer is doing. */
const FLUSH_MAX_PENDING = 5000;
/** Hard ceiling on the fingerprint cache. Without one it grew forever (a changed file's old (size,mtime)
 *  key is never revisited, so every re-encode/edit leaves a permanent orphan). Over the cap we keep the
 *  most recently written entries — an evicted entry costs one re-hash, never correctness. */
const CACHE_MAX_ENTRIES = Math.max(1000, Number(process.env.LFB_FOREIGN_PIN_CACHE_MAX) || 40_000);

interface FileIdentity {
  ino: number;
  size: number;
  mtimeMs: number;
}

function fileIdentity(file: string): FileIdentity | null {
  try {
    const st = fs.statSync(file);
    return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

const sameIdentity = (a: FileIdentity | null, b: FileIdentity | null): boolean =>
  a != null && b != null && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * One write-back store over a JSON file: load-once, mutate-in-memory, debounced atomic flush.
 * `file` is resolved on every access because the state root is env-driven (LFB_STATE_DIR) and the tests
 * repoint it per test — a changed path always forces a fresh load.
 */
class WriteBackStore<T> {
  private loadedFrom: string | null = null;
  private identity: FileIdentity | null = null;
  private data: T | null = null;
  private dirty = false;
  private pending = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly resolveFile: () => string,
    private readonly empty: () => T,
    private readonly pretty: boolean,
    /** Applied just before a flush — the place to bound growth. Returns what should be persisted. */
    private readonly compact: (data: T) => T = (d) => d,
  ) {}

  /** The live in-memory value. Reloads from disk when the file is new to us or another process wrote it. */
  get(): T {
    const file = this.resolveFile();
    const id = fileIdentity(file);
    if (this.data !== null && this.loadedFrom === file && (this.dirty || sameIdentity(id, this.identity))) {
      return this.data;
    }
    this.data = readJson<T>(file, this.empty());
    this.loadedFrom = file;
    this.identity = id;
    this.dirty = false;
    this.pending = 0;
    return this.data;
  }

  /** Replace the whole value (verifyForeignPins' prune). Marks dirty like any other mutation. */
  set(next: T): void {
    this.get(); // establishes loadedFrom for the current state dir
    this.data = next;
    this.touch();
  }

  /** Record that the in-memory value changed; schedule (or force) the write. */
  touch(): void {
    this.dirty = true;
    this.pending += 1;
    if (this.pending >= FLUSH_MAX_PENDING) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Write now if there is anything to write. Safe to call any time, including from a process exit hook. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || this.data === null || this.loadedFrom === null) return;
    const file = this.loadedFrom;
    try {
      this.data = this.compact(this.data);
      writeJsonAtomic(file, this.data, this.pretty);
      this.identity = fileIdentity(file);
      this.dirty = false;
      this.pending = 0;
    } catch (e) {
      // A failed flush keeps the data dirty so the next touch retries; losing a rebuildable cache is
      // never worth throwing out of a scan.
      log.debug("ipfs", `foreign-pin store flush failed for ${file}: ${(e as Error).message}`);
    }
  }
}

const cacheStore = new WriteBackStore<Record<string, CacheEntry>>(
  CACHE_FILE,
  () => ({}),
  false, // not pretty: this file is machine-only and indentation was ~40% of its 3.9 MB
  (data) => {
    const keys = Object.keys(data);
    if (keys.length <= CACHE_MAX_ENTRIES) return data;
    // Keep the newest by discovery time; an evicted entry simply gets re-derived on a later scan.
    keys.sort((a, b) => (data[b]?.at ?? "").localeCompare(data[a]?.at ?? ""));
    const kept: Record<string, CacheEntry> = {};
    for (const k of keys.slice(0, CACHE_MAX_ENTRIES)) kept[k] = data[k]!;
    log.debug("ipfs", `foreign-pin cache pruned ${keys.length - CACHE_MAX_ENTRIES} oldest entr(ies)`);
    return kept;
  },
);

const indexStore = new WriteBackStore<ForeignPinRecord[]>(INDEX_FILE, () => [], true);

/** Persist any pending foreign-pin store writes NOW (scan end, shutdown). Idempotent and never throws. */
export function flushForeignPinStores(): void {
  cacheStore.flush();
  indexStore.flush();
}

// A crash/exit must not lose a whole scan's worth of discovery work. writeFileSync is legal in "exit".
process.once("exit", () => flushForeignPinStores());

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
  // In-memory (see WriteBackStore): NEVER re-read/re-write the whole cache file per scanned file.
  const cache = cacheStore.get();
  const key = fpKey(absPath, size, mtimeMs);
  const cached = cache[key];
  if (cached) return cached.cid ? { cid: cached.cid, profile: cached.profile ?? "cached" } : null;

  // Size-prune: no kept pin near this size ⇒ this file cannot be any of them. Negative-cache and return.
  if (!sizeMatches(ctx.keptSizes, size)) {
    cache[key] = { cid: null, at: new Date().toISOString() };
    cacheStore.touch();
    return null;
  }

  const hit = await contentPinnedCidDetailed(absPath, ctx.keptSet);
  cache[key] = { cid: hit?.cid ?? null, profile: hit?.profile, at: new Date().toISOString() };
  cacheStore.touch();
  return hit;
}

// ── the global index the UI reads (tier-1 fast lookup — rebuildable) ──────────────────────────────────

/** All discovered foreign pins. Served from the write-back store, which reloads only when another
 *  process changed the file — so the hot read paths never re-parse it, and a discovery recorded a
 *  millisecond ago is visible before its flush lands. */
export function readForeignPins(): ForeignPinRecord[] {
  return indexStore.get();
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
  const rows = indexStore.get();
  const canon = canonicalCid(rec.cid);
  const next: ForeignPinRecord = {
    ...rec,
    canonicalCid: canon,
    at: rec.at ?? new Date().toISOString(),
  };
  const i = rows.findIndex((r) => r.absPath === rec.absPath);
  if (i >= 0) rows[i] = next;
  else rows.push(next);
  indexStore.touch(); // debounced flush — this runs inside the scan's per-file loop
}

/** Compatibility (§5.1): drop any discovered pin whose CID the kept-set no longer holds — another tool
 *  unpinned it, so we must stop claiming it. Called once per scan with the freshly-built kept-set. */
export function verifyForeignPins(keptSet: Set<string>): void {
  const rows = indexStore.get();
  const kept = rows.filter((r) => keptSet.has(r.canonicalCid));
  if (kept.length !== rows.length) {
    indexStore.set(kept);
    indexStore.flush(); // once per scan, not per file — write it through immediately
    log.debug("ipfs", `verifyForeignPins dropped ${rows.length - kept.length} unpinned discoveries`);
  }
}
