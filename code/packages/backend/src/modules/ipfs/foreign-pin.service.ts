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
import { statOrNull } from "../../shared/fs-probe.js";
import { dbEnabled, tryDb } from "../../shared/persistence/db.js";
import {
  countProbes,
  deleteForeignPinsNotKept,
  ensureCids,
  foreignPinByPath,
  foreignPinPathsUnder,
  foreignPinsByCanon,
  foreignPinsUnder,
  probeForKey,
  probesForPaths,
  pruneProbes,
  readAllForeignPins,
  upsertForeignPins,
  unitIdsForRoots,
  upsertProbes,
  type ForeignPinRow,
  type ForeignPinUpsert,
  type ProbeUpsert,
} from "./foreign-pin.repo.js";

// ── on-disk stores under the state root (tier-1 local persistence — foreign_pin_discovery §5) ─────────
// The fingerprint CACHE: a file's (size, mtime) → the CID it is pinned under, or null (a NEGATIVE cache so we
// don't re-hash the same non-match every 15 minutes). Keyed by abs path + fingerprint so a changed file
// (new size/mtime) misses the cache and is re-discovered.
const CACHE_FILE = () => path.join(resolveStateDir(), "foreign-pin-cache.json");
// The global INDEX the UI reads: one entry per discovered pin, mapping the file to the CID it is really
// pinned under. Rebuildable/derived — the durable, travelling record is the per-file .lfbridge sidecar
// (tiers 2/3), written by the scan's reconcileExternalState.
const INDEX_FILE = () => path.join(resolveStateDir(), "foreign-pins.json");

/**
 * The two JSON stores' absolute paths — the SOURCES backfill area 9 reads and fingerprints.
 *
 * Exported rather than duplicated in the backfill because the paths are resolved at CALL time from
 * `LFB_STATE_DIR`; a second copy of these two `path.join`s would be a second thing to keep in step with the
 * state root, and a backfill fingerprinting the wrong file is a watermark that never invalidates.
 */
export function foreignPinStoreFiles(): { index: string; cache: string } {
  return { index: INDEX_FILE(), cache: CACHE_FILE() };
}

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

/**
 * {@link fpKey} run backwards — the split backfill area 9 needs to turn 36,103 JSON keys into
 * `(abs_path, size_bytes, mtime_ms)` rows (database_migration.mdx §4.1 area 9).
 *
 * PARSED FROM THE RIGHT, NOT THE LEFT, and that is the whole subtlety. The naive `key.split("::")` is wrong
 * for any absolute path that itself contains a colon — macOS permits `:` in a filename, and this machine's
 * corpus is full of downloaded media whose names carry timestamps. Sizes and mtimes are decimal digits and
 * cannot contain a separator, so working in from the end is unambiguous where working in from the front is
 * a guess: the LAST `:` ends the mtime, and the LAST `::` before it ends the path.
 *
 * Returns null when the tail is not two integers — the caller records that in the reject table and carries
 * on (mechanic (c)); a malformed cache key is one lost negative-cache entry, never a reason to abort.
 */
export function parseFpKey(key: string): { absPath: string; size: number; mtimeMs: number } | null {
  const lastColon = key.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const mtimeText = key.slice(lastColon + 1);
  const head = key.slice(0, lastColon); // `${absPath}::${size}`
  const sep = head.lastIndexOf("::");
  if (sep <= 0) return null;
  const absPath = head.slice(0, sep);
  const sizeText = head.slice(sep + 2);
  if (!absPath || !/^\d+$/.test(sizeText) || !/^-?\d+$/.test(mtimeText)) return null;
  const size = Number(sizeText);
  const mtimeMs = Number(mtimeText);
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(mtimeMs)) return null;
  return { absPath, size, mtimeMs };
}

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
  const st = statOrNull(file); // shared/fs-probe — non-throwing
  return st && { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
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
//
// Guarded on `process` rather than by a module-local flag: this runs at IMPORT time, and a module can be
// instantiated more than once (vitest gives each test file its own registry; an ESM/CJS dual-load does the
// same) while `process` is shared — so an unguarded registration stacks a listener per instantiation and
// trips Node's "MaxListenersExceededWarning: 11 exit listeners added to [process]". See the same pattern
// and the fuller note in shared/logging.ts.
const EXIT_FLUSH_WIRED = Symbol.for("lfb.foreignPin.exitFlushWired");
if (!(process as typeof process & { [EXIT_FLUSH_WIRED]?: boolean })[EXIT_FLUSH_WIRED]) {
  Object.defineProperty(process, EXIT_FLUSH_WIRED, { value: true, configurable: true });
  process.once("exit", () => flushForeignPinStores());
}

// ── the discovery context: the kept-set + the size-prune index, built ONCE per scan ───────────────────
export interface DiscoveryCtx {
  keptSet: Set<string>; // canonical kept CIDs (pins ∪ MFS roots) — passed to the re-hash membership test
  keptSizes: number[]; // sorted kept cumulative sizes — the size-prune band lookup
}

/** Build the discovery context once per scan (foreign_pin_discovery §3 step 1). Two metadata-only node
 *  passes (kept-set + per-CID sizes); returns an empty ctx when the node is unreachable so discovery no-ops. */
export async function buildDiscoveryCtx(): Promise<DiscoveryCtx> {
  try {
    // ONE kept-set, reused for the size index. Asking for both in parallel made `keptSizeIndex()` build a
    // second one internally — two full `pin/ls` enumerations + two MFS listings per scan, for one answer.
    const keptSet = await keptCidSet();
    const sizeIdx = await keptSizeIndex(keptSet);
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

// ── WHERE THE TWO STORES ACTUALLY LIVE NOW (database.mdx §9 slice 8, migration 0008) ──────────────────
//
// Everything above this line — the write-back stores, the debounce, the exit flush — is the NO-DATABASE
// path, and it is unchanged and still correct. Below, each read and write asks `dbEnabled()` first and uses
// `lfb.fingerprint_probe` / `lfb.foreign_pin` when there is a database (R2: `LFB_DB_MODE=auto` is the
// default and a machine with no Postgres must behave exactly as it did).
//
// THIS IS A REPLACEMENT, NOT A DUAL WRITE, and the distinction matters enough to spell out. R1's dual-write
// rule protects YAML WRITERS — the Syncable Data Locations that ARE the sync protocol (R4, database.mdx
// §2.2). These two files are neither: they are machine-local, rebuildable JSON caches whose durable,
// travelling record is the per-file `.lfbridge` sidecar (foreign_pin_discovery.mdx §5, tiers 2/3). Writing
// both would keep all 8.47 MB resident and hold on to the whole-file rewrite this slice exists to retire,
// which would leave the 2026-07-20 failure mode in place while claiming to have fixed it. So on a machine
// with a database the JSON files are neither loaded nor written; on a machine without one they are the only
// store, exactly as before. If a database that WAS present goes away, the JSON files are stale — and the
// cost of that is one re-derivation by the next background scan, which is the defined cost of losing a
// rebuildable cache.
//
// PIN TRUTH IS NOT NEGOTIABLE THROUGH ANY OF THIS (MEMORY.md "foreign pin: recorded must render",
// ipfs.mdx §1.1). "Pinned" means pinned on THIS computer by ANY local software, so a recorded discovery has
// to keep rendering as `pinnedForeign` on every surface. Every read below therefore falls back to the JSON
// store on a query error rather than answering "no" — an answer of "no" here is not a degraded answer, it
// is a WRONG one that shows the user an unpinned badge for a file their node is holding.

/** The eviction cap for `lfb.fingerprint_probe`. Five times `CACHE_MAX_ENTRIES` on purpose — see 0008. */
const PROBE_MAX_ROWS = Math.max(1000, Number(process.env.LFB_FOREIGN_PIN_PROBE_MAX) || 200_000);

interface ProbeVerdict {
  cid: string | null;
  profile?: string;
}

/**
 * THE PER-UNIT BATCH — why slice 8 is not a straight swap of a Map for a query.
 *
 * `discoverForeignPin` is called once per candidate from inside the scan's per-file loop
 * (scanner.service.ts `reconcileExternalState`). An in-process `Map` hit costs ~0.05 ms; a loopback
 * round trip costs ~0.15-0.3 ms. On this machine's largest repo (2,188 candidates) turning each Map hit
 * into a query makes the scan SLOWER by roughly half a second per repo, and the whole point of the
 * fingerprint cache is that it is cheaper than the work it avoids. So the scan opens ONE batch per unit:
 * one SELECT preloads every probe row those candidates could hit, the loop reads it in memory exactly as
 * it read the JSON object, and one flush at the end writes the new verdicts and the new discoveries.
 *
 * The batch is also the write coalescer the debounced flush used to be: `pendingProbes` and `pendingPins`
 * are keyed maps, so a file seen twice in one unit produces one row, not two.
 */
export class ForeignPinBatch {
  /** Probe rows preloaded for this unit, keyed by `fpKey`. */
  private readonly loaded = new Map<string, ProbeVerdict>();
  private readonly pendingProbes = new Map<string, ProbeUpsert>();
  private readonly pendingPins = new Map<string, ForeignPinRecord>();

  private constructor(readonly enabled: boolean) {}

  /**
   * Open a batch for one unit. `files` is what the unit is about to scan; when there is no database the
   * batch is INERT (`enabled === false`) and every caller falls through to the write-back stores.
   */
  static async open(files: ReadonlyArray<{ absPath: string; size: number; mtimeMs: number }>): Promise<ForeignPinBatch> {
    const batch = new ForeignPinBatch(dbEnabled());
    if (!batch.enabled || files.length === 0) return batch;
    const paths = [...new Set(files.map((f) => f.absPath))];
    const rows = await tryDb(() => probesForPaths(paths), [], "foreignPin.batch.preload");
    for (const r of rows) {
      batch.loaded.set(fpKey(r.abs_path, Number(r.size_bytes), Number(r.mtime_ms)), {
        cid: r.cid_text,
        profile: r.profile ?? undefined,
      });
    }
    return batch;
  }

  /** `undefined` = never probed at this fingerprint. `{cid:null}` = probed and NOT pinned (the negative). */
  lookup(key: string): ProbeVerdict | undefined {
    const pending = this.pendingProbes.get(key);
    if (pending) return { cid: pending.cidText, profile: pending.profile ?? undefined };
    return this.loaded.get(key);
  }

  noteProbe(absPath: string, size: number, mtimeMs: number, cid: string | null, profile?: string): void {
    this.pendingProbes.set(fpKey(absPath, size, mtimeMs), {
      absPath,
      sizeBytes: size,
      mtimeMs: Math.round(mtimeMs),
      cidText: cid,
      profile: profile ?? null,
      probedAt: new Date(),
    });
  }

  notePin(rec: ForeignPinRecord): void {
    this.pendingPins.set(rec.absPath, rec);
  }

  /** True while the batch is holding writes — lets `readForeignPins` see this unit's own discoveries. */
  pendingPin(absPath: string): ForeignPinRecord | undefined {
    return this.pendingPins.get(absPath);
  }

  /** Write everything this unit accumulated. Never throws: a failed flush costs a re-derivation, not a scan. */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    const probes = [...this.pendingProbes.values()];
    const pins = [...this.pendingPins.values()];
    this.pendingProbes.clear();
    this.pendingPins.clear();
    if (probes.length) {
      await tryDb(() => upsertProbes(probes), 0, "foreignPin.batch.probes");
    }
    if (pins.length) {
      await tryDb(() => writeForeignPinRows(pins), 0, "foreignPin.batch.pins");
    }
  }
}

/**
 * Insert/refresh foreign-pin rows, `lfb.cid` first.
 *
 * The order is a hard requirement, not a preference: `foreign_pin.cid_canon` has a FK onto `lfb.cid`
 * (0008), so a batch that writes the pins first aborts entirely on the first unseen CID — and would take
 * the whole unit's discoveries down with it.
 */
async function writeForeignPinRows(recs: ReadonlyArray<ForeignPinRecord>): Promise<number> {
  await ensureCids(recs.map((r) => ({ canon: r.canonicalCid, text: r.cid })));
  const roots = [...new Set(recs.map((r) => r.repoRoot).filter((r): r is string => !!r))];
  const unitIds = await unitIdsForRoots(roots);
  const rows: ForeignPinUpsert[] = recs.map((r) => ({
    absPath: r.absPath,
    cidText: r.cid,
    cidCanon: r.canonicalCid,
    profile: r.profile ?? "",
    sizeBytes: r.size,
    // NULL is honest here: a foreign pin can be discovered outside every unit (0008's header), and the
    // upsert COALESCEs so an unknown never overwrites a known.
    unitId: (r.repoRoot ? unitIds.get(r.repoRoot) : undefined) ?? null,
    observedAt: r.at ? new Date(r.at) : new Date(),
  }));
  return upsertForeignPins(rows);
}

/** A `lfb.foreign_pin` row rendered back into the shape every existing caller already reads. */
function rowToRecord(r: ForeignPinRow): ForeignPinRecord {
  return {
    canonicalCid: r.cid_canon,
    cid: r.cid_text,
    profile: r.profile,
    absPath: r.abs_path,
    size: Number(r.size_bytes),
    // 0008 stores the owning unit as `unit_id`, not as a second copy of its path, so the read joins
    // `lfb.unit` back to reproduce the `repoRoot` the JSON index carried. The IPFS page renders it (a row's
    // unit name and repo id — foreign_pin_discovery.mdx §4), so dropping it would turn a NAMED foreign pin
    // back into an anonymous CID, which is the regression that reverse resolution exists to prevent.
    repoRoot: r.unit_abs_path,
    at: r.observed_at.toISOString(),
  };
}

/**
 * Discover whether THIS file's bytes are already pinned under some (possibly foreign) CID — the bounded,
 * cached core (foreign_pin_discovery §3). Returns the discovered CID + profile, or null. Order:
 *   1. cache hit on (path,size,mtime) → return the cached verdict (incl. the negative cache), no hash.
 *   2. SIZE-PRUNE against the kept-size band → miss ⇒ record null in cache, return null (no hash).
 *   3. re-hash under ADD_PROFILES and test against the kept-set → cache + return the verdict.
 * EXPENSIVE only in case 3, and case 2 eliminates the vast majority of files with a single lookup.
 *
 * `batch` is the per-unit {@link ForeignPinBatch} the scan opened. Without one (a CLI, a test, a one-off)
 * the Postgres path still works — it just pays a round trip per call instead of one per unit.
 */
export async function discoverForeignPin(
  absPath: string,
  size: number,
  mtimeMs: number,
  ctx: DiscoveryCtx,
  batch?: ForeignPinBatch,
): Promise<{ cid: string; profile: string } | null> {
  const key = fpKey(absPath, size, mtimeMs);
  const pg = batch?.enabled ?? dbEnabled();

  // 1. THE CACHE, INCLUDING THE NEGATIVES. `{cid: null}` is a real answer — "already hashed, not pinned" —
  //    and returning null for it is what stops the re-hash. Only `undefined` means "never probed".
  const cached = pg
    ? batch
      ? batch.lookup(key)
      : await tryDb(
          async () => {
            const r = await probeForKey(absPath, size, Math.round(mtimeMs));
            return r ? { cid: r.cid_text, profile: r.profile ?? undefined } : undefined;
          },
          () => jsonProbe(key),
          "foreignPin.probe",
        )
    : jsonProbe(key);
  if (cached) return cached.cid ? { cid: cached.cid, profile: cached.profile ?? "cached" } : null;

  const record = async (cid: string | null, profile?: string): Promise<void> => {
    if (!pg) {
      // In-memory (see WriteBackStore): NEVER re-read/re-write the whole cache file per scanned file.
      cacheStore.get()[key] = { cid, profile, at: new Date().toISOString() };
      cacheStore.touch();
      return;
    }
    if (batch) {
      batch.noteProbe(absPath, size, mtimeMs, cid, profile);
      return;
    }
    await tryDb(
      () =>
        upsertProbes([
          {
            absPath,
            sizeBytes: size,
            mtimeMs: Math.round(mtimeMs),
            cidText: cid,
            profile: profile ?? null,
            probedAt: new Date(),
          },
        ]),
      0,
      "foreignPin.probe.write",
    );
  };

  // Size-prune: no kept pin near this size ⇒ this file cannot be any of them. Negative-cache and return.
  if (!sizeMatches(ctx.keptSizes, size)) {
    await record(null);
    return null;
  }

  const hit = await contentPinnedCidDetailed(absPath, ctx.keptSet);
  await record(hit?.cid ?? null, hit?.profile);
  return hit;
}

/** The write-back store's answer for one fingerprint — the no-database path and the fallback on a pg error. */
function jsonProbe(key: string): ProbeVerdict | undefined {
  const e = cacheStore.get()[key];
  return e ? { cid: e.cid, profile: e.profile } : undefined;
}

// ── the global index the UI reads (tier-1 fast lookup — rebuildable) ──────────────────────────────────

/**
 * All discovered foreign pins, from wherever they live.
 *
 * NOT A REQUEST PATH. On the Postgres side this is an unbounded table scan and on the JSON side it parses
 * a 1.28 MB file; the per-surface reads below (`foreignPinByAbsPath`, `foreignPinPathSetFor`,
 * `foreignPinsByCanonicalCids`) are what the UI actually calls.
 */
export async function readForeignPins(): Promise<ForeignPinRecord[]> {
  if (!dbEnabled()) return readForeignPinsFromJson();
  return tryDb(
    async () => (await readAllForeignPins()).map(rowToRecord),
    () => readForeignPinsFromJson(),
    "foreignPin.readAll",
  );
}

/**
 * The JSON write-back store's view — the no-database path, the fallback on any query error, and (R3) the
 * VERIFICATION ORACLE the cut-over reads are checked against. It stays exactly as it was.
 */
export function readForeignPinsFromJson(): ForeignPinRecord[] {
  return indexStore.get();
}

/** Discovered foreign pin for a given absolute file path (repo row surfacing — foreign_pin_discovery §6). */
export async function foreignPinByAbsPath(absPath: string): Promise<ForeignPinRecord | undefined> {
  if (!dbEnabled()) return readForeignPinsFromJson().find((r) => r.absPath === absPath);
  return tryDb(
    async () => {
      const row = await foreignPinByPath(absPath);
      return row ? rowToRecord(row) : undefined;
    },
    () => readForeignPinsFromJson().find((r) => r.absPath === absPath),
    "foreignPin.byAbsPath",
  );
}

/**
 * The discovered paths under one unit root, as a SET, for callers that ask about many files in a row.
 *
 * {@link foreignPinByAbsPath} is one lookup, and the two composition walks in units.service ask it once PER
 * CANDIDATE — so on this machine's `all` repo that was 2,188 candidates against the whole global index, per
 * repo, on the Repos-list hot path the whole cheap-counting design exists to protect. Build this once per
 * repo and test membership instead. Callers must not hold it across a scan (a discovery recorded meanwhile
 * would be missing); one composition pass is the intended lifetime.
 *
 * `rootAbs` narrows the query to one unit (`foreign-pin.repo.ts foreignPinPathsUnder`). With no database the
 * whole-index set is returned unchanged, which is a SUPERSET of what the caller asks about — both call sites
 * only ever test paths they built with `joinRel(repoRootAbs, …)` — so the two paths agree.
 */
export async function foreignPinPathSetFor(rootAbs: string | null): Promise<Set<string>> {
  if (!rootAbs || !dbEnabled()) return foreignPinPathSetFromJson();
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  return tryDb(
    async () => new Set(await foreignPinPathsUnder(prefix)),
    () => foreignPinPathSetFromJson(),
    "foreignPin.pathSet",
  );
}

/**
 * The discovered pins under one unit root, as full records — what the pin pass publishes as identity-only
 * manifest entries for files pinned here that nobody decided to sync (foreign_pin_discovery.mdx §6.1).
 *
 * Unlike {@link foreignPinPathSetFor}, the JSON path FILTERS to the root: the caller turns every record it
 * gets into a manifest key relative to that root, so a superset would only be work it has to throw away.
 * One read per unit per pass — never per file.
 */
export async function foreignPinRecordsFor(rootAbs: string): Promise<ForeignPinRecord[]> {
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  const fromJson = (): ForeignPinRecord[] => readForeignPinsFromJson().filter((r) => r.absPath.startsWith(prefix));
  if (!dbEnabled()) return fromJson();
  return tryDb(async () => (await foreignPinsUnder(prefix)).map(rowToRecord), fromJson, "foreignPin.recordsUnder");
}

/** The whole-index set — the no-database path and (R3) the oracle `foreignPinPathSetFor` is checked against. */
export function foreignPinPathSetFromJson(): Set<string> {
  return new Set(readForeignPinsFromJson().map((r) => r.absPath));
}

/** Discovered foreign pin for a CANONICAL cid (IPFS-page reverse resolution — §4). */
export async function foreignPinByCanonicalCid(cid: string): Promise<ForeignPinRecord | undefined> {
  return (await foreignPinsByCanonicalCids([cid])).get(canonicalCid(cid));
}

/**
 * Reverse resolution for MANY cids at once, keyed by canonical form.
 *
 * The IPFS page resolves every untracked pin this way inside one synchronous `pins.map()`; asking per pin
 * would be one round trip each, and the JSON form was a linear scan of 2,825 records each. One query, one
 * Map, and the map callback stays synchronous.
 */
export async function foreignPinsByCanonicalCids(cids: readonly string[]): Promise<Map<string, ForeignPinRecord>> {
  const canons = [...new Set(cids.map((c) => canonicalCid(c)))];
  if (canons.length === 0) return new Map();
  const fromJson = (): Map<string, ForeignPinRecord> => {
    const want = new Set(canons);
    const out = new Map<string, ForeignPinRecord>();
    for (const r of readForeignPinsFromJson()) {
      if (want.has(r.canonicalCid) && !out.has(r.canonicalCid)) out.set(r.canonicalCid, r);
    }
    return out;
  };
  if (!dbEnabled()) return fromJson();
  return tryDb(
    async () => {
      const out = new Map<string, ForeignPinRecord>();
      for (const row of await foreignPinsByCanon(canons)) {
        if (!out.has(row.cid_canon)) out.set(row.cid_canon, rowToRecord(row));
      }
      return out;
    },
    fromJson,
    "foreignPin.byCanonicalCid",
  );
}

/**
 * Upsert a discovered pin into the global index (keyed by absPath — one live record per file).
 *
 * ONE UPSERT, not the `findIndex` + splice over 2,825 records this used to do from inside the scan's
 * per-file loop. With a `batch` open it is a Map write and the round trip happens once for the whole unit.
 */
export async function recordForeignPin(
  rec: Omit<ForeignPinRecord, "canonicalCid" | "at"> & { at?: string },
  batch?: ForeignPinBatch,
): Promise<void> {
  const next: ForeignPinRecord = {
    ...rec,
    canonicalCid: canonicalCid(rec.cid),
    at: rec.at ?? new Date().toISOString(),
  };
  if (batch?.enabled) {
    batch.notePin(next);
    return;
  }
  if (!dbEnabled()) {
    const rows = indexStore.get();
    const i = rows.findIndex((r) => r.absPath === rec.absPath);
    if (i >= 0) rows[i] = next;
    else rows.push(next);
    indexStore.touch(); // debounced flush — this runs inside the scan's per-file loop
    return;
  }
  await tryDb(() => writeForeignPinRows([next]), 0, "foreignPin.record");
}

/** Compatibility (§5.1): drop any discovered pin whose CID the kept-set no longer holds — another tool
 *  unpinned it, so we must stop claiming it. Called once per scan with the freshly-built kept-set. */
export async function verifyForeignPins(keptSet: Set<string>): Promise<void> {
  if (dbEnabled()) {
    const dropped = await tryDb(() => deleteForeignPinsNotKept([...keptSet]), -1, "foreignPin.verify");
    if (dropped > 0) log.debug("ipfs", `verifyForeignPins dropped ${dropped} unpinned discoveries`);
    if (dropped >= 0) return; // -1 means the DELETE failed; fall through to the JSON store rather than skip
  }
  const rows = indexStore.get();
  const kept = rows.filter((r) => keptSet.has(r.canonicalCid));
  if (kept.length !== rows.length) {
    indexStore.set(kept);
    indexStore.flush(); // once per scan, not per file — write it through immediately
    log.debug("ipfs", `verifyForeignPins dropped ${rows.length - kept.length} unpinned discoveries`);
  }
}

/**
 * Bound the probe cache — the scan-end call that replaces `CACHE_MAX_ENTRIES`'s per-flush key sort.
 *
 * Once per scan, never per file. An evicted row costs one re-hash, never correctness, so this is
 * best-effort by construction.
 */
export async function pruneForeignPinProbes(): Promise<number> {
  if (!dbEnabled()) return 0; // the JSON path bounds itself inside `cacheStore`'s compact()
  const n = await tryDb(() => pruneProbes(PROBE_MAX_ROWS), 0, "foreignPin.prune");
  if (n > 0) log.debug("ipfs", `fingerprint probe cache pruned ${n} row(s) over the ${PROBE_MAX_ROWS} cap`);
  return n;
}

/** How many probe rows are on record — `just db-status`, the backfill's verification, and tests. */
export async function foreignPinProbeCount(): Promise<number> {
  if (!dbEnabled()) return Object.keys(cacheStore.get()).length;
  return tryDb(() => countProbes(), 0, "foreignPin.probeCount");
}
