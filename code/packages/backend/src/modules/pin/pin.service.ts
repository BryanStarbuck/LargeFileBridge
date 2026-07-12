// The pin process (pin_process.mdx). A pin pass is ALWAYS a full pass over every
// known unit — every repo PLUS the computer unit (storage.mdx §5/§8). Per unit the byte work is:
// read pinset -> add -> CID -> pin -> update manifest -> fetch missing -> reconcile pin cache ->
// publish manifest. The local IPFS pinset (`ipfs pin ls`) is the source of truth for pin state; the
// manifest `pinned_by` is a stale cache we verify and refresh against it here (storage.mdx §9.5).
//
// Parallelism (pin_process.mdx §4): the pass fans out across units, and WITHIN a unit the independent
// per-file add/pin and fetch operations fan out too — all heavy IPFS work is drawn through ONE global
// limiter (`ipfsLimiter`, size `cores − 2`) so total in-flight operations stay bounded no matter how
// units × files multiply. Concurrent state writes are safe because the store layer serializes per file
// with atomic temp-then-rename (storage.mdx §15).
import fs from "node:fs";
import path from "node:path";
import { ManifestSchema, UnitStatusSchema, mediaKindForName, type Manifest, type ManifestFile, type UnitStatus, type Decision, type PinCounts, type MissingPinnedFile } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import {
  listRepoFolders,
  getRepoConfig,
  updateRepoConfig,
  getRepoManifest,
  getRepoStatus,
  writeRepoManifest,
  writeRepoStatus,
  getComputerConfig,
  getComputerManifest,
  getComputerStatus,
  writeComputerManifest,
  writeComputerStatus,
  isGitWorkingTree,
} from "../store-model/units.service.js";
import { writeCommittedManifest, readCommittedManifest } from "./manifest.service.js";
import { listStorageIds, ensureBackingLocations, getStorageRow } from "../storage/storage.service.js";
import { readStorageIndex } from "../storage/tracking.service.js";
import { writeSelfDevice, resolveGraftedPath } from "../storage/devices.service.js";
import { getStoragePinned, readMappedDirsForRoot, getGitBackboneRemote } from "../storage/storage-settings.service.js";
import { GitBackbone, type GitCycleResult } from "../git/git.service.js";
import { appendFileEvent, readSidecar } from "../storage/file-sidecar.service.js";
import { appendHistory } from "../storage/history-log.service.js";
import { enqueue } from "../jobqueue/jobqueue.service.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { responsiveBudget } from "../../shared/concurrency.js";
import { log } from "../../shared/logging.js";

function computerLabel(): string {
  return getAppConfig().computer.label || "this-computer";
}

// One global concurrency budget for ALL heavy IPFS work in a pass — the canonical RESPONSIVE budget
// (`cores − 2`, parallelization.mdx §1) so a 20–30-core machine stays busy while 2 cores keep the web app
// + IPFS node responsive (pin_process.mdx §4). Drawn from the ONE shared helper so there is no second
// core-count definition. Every add/pin/fetch runs through `ipfsLimiter.run(...)`, so unit-level and
// file-level fan-out share the same ceiling and never oversubscribe the box.
const PIN_CONCURRENCY = responsiveBudget();

class Limiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
const ipfsLimiter = new Limiter(PIN_CONCURRENCY);

let passInFlight = false;

/** A fresh, all-zero pin tally — the honest baseline for a no-op run (pin_process.mdx §6). */
function zeroCounts(): PinCounts {
  return { eligible: 0, added: 0, pinned: 0, fetched: 0, skipped: 0, failed: 0 };
}

/** Run `fn` over `items` with at most `limit` in flight at once. Each item's failure is contained. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ── The generic unit-pin core ───────────────────────────────────────────────
// A UnitTarget adapts either a repo unit or the computer unit onto the one pin algorithm below, so the
// full pass (pin_process.mdx §2) treats them identically. Repo files resolve under the working tree;
// computer files are already absolute (the scanner labels them absolute — storage.mdx §8). `publish`
// is git for a repo (storage.mdx §9.2) and (for now) a no-op for the computer unit whose IPNS transport
// (storage.mdx §9.3) is a separate follow-up.
interface UnitTarget {
  kind: "repo" | "computer" | "storage";
  name: string;
  label: string;
  decisions: Record<string, Decision>;
  fetchMissing: boolean;
  // Resolve a unit-relative path to THIS computer's absolute path, or null when the file is not placeable
  // here (a storage's mapped dir this device hasn't grafted — known-but-absent, devices.mdx §4). Repo and
  // computer units always return a string.
  resolveAbs: (rel: string) => string | null;
  manifest: Manifest;
  status: UnitStatus;
  writeManifest: (m: Manifest) => void;
  writeStatus: (s: UnitStatus) => void;
  publish?: (m: Manifest) => void;
  preflightError?: () => string | null;
}

async function runUnitPin(t: UnitTarget, onlyPaths?: Set<string>): Promise<PinCounts> {
  // Tally what this run actually does so the caller can report the truth, never a fixed "complete"
  // string (pin_process.mdx §6). Incremented inside the parallel closures below — safe because JS runs
  // each synchronous span between awaits atomically, so counter bumps never interleave.
  const counts = zeroCounts();
  const missing = t.preflightError?.();
  if (missing) {
    markUnitError(t, missing);
    return counts;
  }
  const health = await ipfs.health();
  if (health !== "ok") {
    markUnitError(t, "IPFS node unreachable");
    return counts;
  }
  await ipfs.enforceCompliance();

  const byPath = new Map(t.manifest.files.map((f) => [f.path, f]));

  // Learn from the filesystem which CIDs are REALLY pinned right now. The local IPFS pinset is the
  // source of truth; our manifest `pinned_by` is a stale cache we verify and refresh against it every
  // pin pass (storage.mdx §9.5). Read it once up front, and keep it current as we pin below.
  const pinset = new Set((await ipfs.listPins()).map((p) => p.cid));

  // Add + pin any new / changed / no-longer-pinned Add-to-IPFS-decided file — IN PARALLEL, bounded by the
  // global limiter (pin_process.mdx §4). Each task owns a distinct path key, so the shared `byPath` /
  // `pinset` mutations never collide (JS runs each synchronous span between awaits atomically).
  const toAdd = Object.entries(t.decisions).filter(
    ([rel, decision]) => decision === "sync" && (!onlyPaths || onlyPaths.has(rel)),
  );
  counts.eligible = toAdd.length;
  await Promise.all(
    toAdd.map(([rel]) =>
      ipfsLimiter.run(async () => {
        const abs = t.resolveAbs(rel);
        if (abs === null) return; // not placeable here (ungrafted mapped dir) — known-but-absent
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          return; // decided-but-absent — leave for a later fetch
        }
        const existing = byPath.get(rel);
        // "Unchanged" means same bytes AND still really pinned. A size match alone is NOT enough — if
        // the pin was lost (GC, or an `ipfs pin rm` outside the app) we must re-pin so reality matches
        // intent rather than trust the stale cache (storage.mdx §9.5).
        const unchanged = existing?.cid && existing.size === st.size && pinset.has(existing.cid);
        if (unchanged) {
          setPinClaim(existing!, t.label, true);
          counts.skipped++; // eligible but already up-to-date + still pinned (§6 truthful "nothing changed")
          return;
        }
        try {
          const cid = await ipfs.addFile(abs); // add streams the bytes and pins recursively (pin=true)
          pinset.add(cid);
          byPath.set(rel, {
            path: rel,
            cid,
            size: st.size,
            modified_at: st.mtime.toISOString(),
            sha256: null,
            pinned_by: [t.label],
          });
          counts.added++;
          counts.pinned++; // add pins recursively, so an add is also a pin
          log.info("pin", `Added+pinned ${rel} -> ${cid}`);
        } catch (e) {
          counts.failed++;
          log.error("pin", `add failed for ${rel}: ${(e as Error).message}`);
        }
      }),
    ),
  );

  // Drop manifest entries whose decision is no longer "sync".
  for (const rel of [...byPath.keys()]) {
    if (t.decisions[rel] !== "sync") byPath.delete(rel);
  }

  // Fetch missing: rehydrate any manifest file we don't have ON DISK here yet — pin its CID AND
  // materialize the bytes to the resolved local path (storage.mdx §9). Byte placement goes through the
  // unit's `resolveAbs`, so a repo file lands in its working tree, a computer file at its absolute path,
  // and a storage file at THIS device's grafted local path (devices.mdx §4). All IN PARALLEL, bounded by
  // the global limiter. A file already on disk needs nothing; a mapped dir not grafted here (abs === null)
  // is known-but-absent and skipped.
  if (t.fetchMissing) {
    await Promise.all(
      [...byPath.values()].map((entry) =>
        ipfsLimiter.run(async () => {
          if (!entry.cid) return;
          const abs = t.resolveAbs(entry.path);
          if (abs === null) return; // ungrafted mapped dir — known-but-absent on this computer
          if (fs.existsSync(abs)) return; // already on disk here — nothing to fetch
          try {
            if (!pinset.has(entry.cid)) {
              await ipfs.pinAdd(entry.cid); // hold a local copy first…
              pinset.add(entry.cid);
              counts.pinned++;
            }
            await ipfs.catToFile(entry.cid, abs); // …then write the bytes to the resolved local path
            counts.fetched++;
            log.info("pin", `Fetched ${entry.path} -> ${abs} (${entry.cid})`);
          } catch (e) {
            counts.failed++;
            log.warn("pin", `fetch failed for ${entry.path}: ${(e as Error).message}`);
          }
        }),
      ),
    );
  }

  // Refresh the pin cache against ground truth: this computer belongs in `pinned_by` for a CID iff the
  // local pinset actually holds it now (storage.mdx §9.5). Stale self-claims (a pin lost since the last
  // pin pass) are dropped here. Peer claims are left untouched — we can only verify our own.
  for (const entry of byPath.values()) {
    if (!entry.cid) continue;
    setPinClaim(entry, t.label, pinset.has(entry.cid));
  }

  const next: Manifest = ManifestSchema.parse({
    unit: t.kind,
    generated_at: new Date().toISOString(),
    files: [...byPath.values()],
  });
  t.writeManifest(next);

  if (t.publish) {
    try {
      t.publish(next);
    } catch (e) {
      log.warn("pin", `publish manifest failed for ${t.name}: ${(e as Error).message}`);
    }
  }

  t.writeStatus({ ...t.status, last_pin_at: new Date().toISOString(), last_error: null });
  log.info(
    "pin",
    `Pinned ${t.name}: ${next.files.length} file(s) — added ${counts.added}, fetched ${counts.fetched}, pinned ${counts.pinned}, skipped ${counts.skipped}, failed ${counts.failed}.`,
  );
  return counts;
}

/**
 * Pin one repo (used by Pin-now and the scheduled worker). onlyPaths optional = whole repo.
 *
 * `opts.manual` marks an explicit user "Pin now" (one_repo.mdx §3.1) vs. the background scheduler.
 * The per-repo `pinned` flag gates the BACKGROUND scheduler only (one_repo.mdx §3.2: "skips this repo
 * during background pin passes"). A manual Pin now is the repo's primary action and must move bytes even
 * when the flag is off — otherwise the button silently no-ops while the UI still reports success
 * (pin_process.mdx §6). Because clicking Pin now is the user explicitly opting this repo in, a manual
 * run on an off repo also flips `pinned=true` so the every-15-min background pin pass keeps it fresh.
 */
export async function pinRepoFolder(
  folder: string,
  onlyPaths?: Set<string>,
  opts: { manual?: boolean } = {},
): Promise<PinCounts> {
  const cfg = getRepoConfig(folder);
  if (!cfg.pinned) {
    if (!opts.manual) {
      log.info("pin", `Skip ${folder}: pinned=false.`);
      return zeroCounts(); // background scheduler respects the opt-in — an honest no-op tally
    }
    await updateRepoConfig(folder, (c) => ({ ...c, pinned: true }));
    cfg.pinned = true;
    log.info("pin", `${folder}: manual Pin now — enabling background pinning (pinned=true).`);
  }
  const repoPath = expandHome(cfg.repo.path);
  return runUnitPin(
    {
      kind: "repo",
      name: folder,
      label: computerLabel(),
      decisions: cfg.decisions,
      fetchMissing: cfg.pin.fetch_missing,
      resolveAbs: (rel) => path.join(repoPath, rel),
      manifest: getRepoManifest(folder),
      status: getRepoStatus(folder),
      writeManifest: (m) => writeRepoManifest(folder, m),
      writeStatus: (s) => writeRepoStatus(folder, s),
      // Publish the committed in-repo manifest so git carries the list (storage.mdx §9.2).
      publish: cfg.pin.publish_manifest ? (m) => writeCommittedManifest(repoPath, m) : undefined,
      preflightError: () => (isGitWorkingTree(repoPath) ? null : "repo missing"),
    },
    onlyPaths,
  );
}

/**
 * Pin the computer unit — everything large OUTSIDE any repo (storage.mdx §8). Part of every full pass
 * (pin_process.mdx §2). Its files are stored with absolute paths, so `resolveAbs` is (home-expanded)
 * identity. It has no git to carry its manifest; the IPNS transport (storage.mdx §9.3) is a follow-up,
 * so `publish` is omitted for now — the local manifest + pins are still written and reconciled.
 */
export async function pinComputerUnit(): Promise<void> {
  const cfg = getComputerConfig();
  if (!cfg.pinned) {
    log.info("pin", "Skip computer unit: pinned=false.");
    return;
  }
  await runUnitPin({
    kind: "computer",
    name: "computer",
    label: computerLabel(),
    decisions: cfg.decisions,
    fetchMissing: cfg.pin.fetch_missing,
    resolveAbs: (rel) => expandHome(rel),
    manifest: getComputerManifest(),
    status: getComputerStatus(),
    writeManifest: (m) => writeComputerManifest(m),
    writeStatus: (s) => writeComputerStatus(s),
  });
}

async function pinRepoSafe(folder: string): Promise<void> {
  try {
    await pinRepoFolder(folder);
  } catch (e) {
    log.error("pin", `pin ${folder} failed: ${(e as Error).message}`);
  }
}

/**
 * Resolve a storage file's local absolute path through THIS computer's device GRAFT (devices.mdx §4).
 * A tracked file's machine-independent identity is a mapped-dir KEY + a relpath under it; the graft maps
 * that key onto this box's absolute path. The first path segment is treated as a mapped-dir key ONLY when
 * it is a real key in `mapped_dirs.yaml`:
 *   • known mapped key, grafted here      → the grafted absolute path;
 *   • known mapped key, NOT grafted here  → null (known-but-absent — don't add/fetch/place it here);
 *   • not a mapped key (pre-mapped-dir index shape, files under the SDL root) → storage-root-relative.
 * This is the pin-pass call site the graft resolver was built for (syncable_data_location.mdx §5).
 */
function resolveStorageAbs(root: string, rel: string, mappedKeys: Set<string>): string | null {
  const sep = rel.indexOf(path.sep) >= 0 ? path.sep : "/";
  const cut = rel.indexOf(sep);
  if (cut > 0) {
    const key = rel.slice(0, cut);
    if (mappedKeys.has(key)) {
      // A mapped hierarchy: the graft decides where (or whether) it lives here.
      return resolveGraftedPath(root, key, rel.slice(cut + 1));
    }
  }
  return path.join(root, rel); // pre-mapped-dir model: the file lives under the SDL root
}

// Serialize all Git-cycle work PER STORAGE. The every-10-min device worker and the every-15-min pin pass
// (plus a manual Pin now) all hit THIS one backend process over loopback, and their cadences coincide —
// two of them running git add/commit/push in the SAME working copy at once corrupts the index. This keyed
// chain guarantees at most one pass touches a given storage's repo at a time; different storages still run
// concurrently. In-process is sufficient because every trigger routes through this single process.
const storageGitChain = new Map<string, Promise<unknown>>();
function withStorageGitLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = storageGitChain.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after the previous holder settles, success or failure
  storageGitChain.set(
    id,
    run.then(
      () => {},
      () => {},
    ), // keep the chain alive; swallow errors so one failure never poisons the next waiter
  );
  return run;
}

/**
 * Pin one directory-based storage (personal / company / community) as a unit, placing each file through
 * this computer's device graft (`resolveStorageAbs` → devices.mdx §4). Repos pin as their own repo
 * units and the settings-only "local" storage has no bytes, so both are skipped. Byte work is gated by
 * the per-storage `pinned` opt-in (default OFF — charter), mirroring the repo/computer-unit gate
 * (pin_process.mdx §1): a not-opted-in storage is still known and visited, but nothing is added/pinned/
 * fetched. Its file list is the tracking index; its manifest is the SDL's `.lfbridge/manifest.yaml`.
 * The whole unit runs under the per-storage Git lock so it never races the device worker on the same repo.
 */
export function pinStorageUnit(id: string): Promise<void> {
  return withStorageGitLock(id, () => pinStorageUnitInner(id));
}

async function pinStorageUnitInner(id: string): Promise<void> {
  const row = getStorageRow(id);
  if (!row || row.type === "local" || row.type === "repo") return;
  const root = expandHome(row.root);

  // Git backbone (git_backbone.mdx §6): if this storage's dedicated Git repo is ON, FETCH + auto-MERGE the
  // user's other computers' SDL edits BEFORE we touch anything, so the incoming devices/manifest/analysis
  // are merged in first. This pull happens EVERY pass even when we have nothing to change (devices.mdx
  // §12), so edits made on another computer land here. A merge conflict or auth failure is surfaced and we
  // continue over IPFS. The commit + push of THIS device's own changes happens AFTER the reconcile below.
  const gitRemote = getGitBackboneRemote(id);
  const gitBackbone = gitRemote ? await GitBackbone.resolve(id, gitRemote.remote) : null;
  const gitResult: GitCycleResult = { ran: gitBackbone !== null };
  if (gitBackbone) {
    await gitBackbone.pull(gitResult).catch((e) => {
      gitResult.problem = `Git pull failed: ${(e as Error).message}`;
    });
    if (gitResult.problem) log.warn("pin", `storage ${id} git: ${gitResult.problem}`);
  }

  // DEVICE WRITE-BACK (devices.mdx §12) — write this computer's own device file REGARDLESS of the IPFS
  // `pinned` opt-in. Writing your own identity text to your own configured repo has no outward footprint
  // (pin_process.mdx §1), so it is never gated the way byte work is. This also gives path resolution the
  // graft to read below. Committed + pushed by the Git cycle at the end of this function.
  try {
    writeSelfDevice(root);
  } catch (e) {
    log.warn("pin", `writeSelfDevice for storage ${id} failed: ${(e as Error).message}`);
  }

  // BYTE WORK is the ONLY thing gated by the per-storage `pinned` opt-in (charter, pin_process.mdx §1/§5):
  // a not-opted-in storage is still visited, its device info written & pushed, but no bytes are added/
  // pinned/fetched. When opted in, reconcile every indexed large file through this computer's graft.
  if (getStoragePinned(id)) {
    const decisions: Record<string, Decision> = {};
    for (const f of readStorageIndex(root)) decisions[f.path] = "sync";

    // The set of real mapped-dir keys (read once) tells resolveStorageAbs whether a path's first segment is
    // a grafted hierarchy vs. a plain SDL-relative path.
    const mappedKeys = new Set(readMappedDirsForRoot(root).mapped.map((m) => m.key));

    await runUnitPin({
      kind: "storage",
      name: `storage:${id}`,
      label: computerLabel(),
      decisions,
      fetchMissing: true,
      resolveAbs: (rel) => resolveStorageAbs(root, rel, mappedKeys),
      manifest: readCommittedManifest(root), // <root>/.lfbridge/manifest.yaml (same path convention as a repo)
      status: UnitStatusSchema.parse({}),
      writeManifest: (m) => writeCommittedManifest(root, m),
      // Storage units have no status.yaml store yet — status is a no-op (the manifest + pins are still
      // written and reconciled). A persisted per-storage status is a later follow-up.
      writeStatus: () => {},
    });
  } else {
    log.info("pin", `Storage ${id}: pinned=false — device info kept current, no byte work.`);
  }

  // Git backbone (git_backbone.mdx §6 steps 5–6): after the reconcile has refreshed this device's own files
  // (device file, manifest, analysis), STAGE the self-owned SDL text, COMMIT, and PUSH — with a
  // fetch-merge-push retry on a non-fast-forward reject. Big bytes are git-ignored, so only the small
  // text is ever committed. A push/auth problem is surfaced (logged) and never blocks the IPFS work.
  if (gitBackbone) {
    await gitBackbone.commitAndPush(gitResult).catch((e) => {
      gitResult.problem = `Git push failed: ${(e as Error).message}`;
    });
    if (gitResult.problem) log.warn("pin", `storage ${id} git: ${gitResult.problem}`);
    else if (gitResult.pushed) log.info("pin", `storage ${id} git: pushed device state to remote`);
  }
}

/**
 * Ensure THIS device's registration is written & pushed to ONE storage's Git backbone (devices.mdx §12) —
 * the unit of work the every-10-minute device worker runs for each Git-backed storage. It is the storage
 * pin pass narrowed to just the device write-back, DECOUPLED from the IPFS `pinned` opt-in: writing your own
 * identity text to your OWN configured repo has no outward footprint (pin_process.mdx §1).
 *
 * Strict order (git_backbone.mdx §6), matching the user's requirement — before it ever modifies the repo it
 * pulls, and it always pushes after:
 *   1. resolve the working copy → git fetch → auto-merge  (ALWAYS, even with nothing to change, so another
 *      computer's edits are pulled down);
 *   2. writeSelfDevice — write/update this device's own devices/<self>.yaml;
 *   3. git add (self-owned) → commit → push, with the non-fast-forward retry.
 *
 * A storage with no Git backbone still gets its local device file refreshed (it travels once a backbone is
 * turned on). Returns the Git cycle result so the caller can surface a problem; never throws for a per-
 * storage fault (the pass contains it). Runs under the per-storage Git lock so it never races the pin pass
 * on the same repo.
 */
export function ensureDeviceRegistered(id: string): Promise<GitCycleResult> {
  return withStorageGitLock(id, () => ensureDeviceRegisteredInner(id));
}

async function ensureDeviceRegisteredInner(id: string): Promise<GitCycleResult> {
  const result: GitCycleResult = { ran: false };
  const row = getStorageRow(id);
  if (!row || row.type === "local" || row.type === "repo") return result;
  const root = expandHome(row.root);

  const gitRemote = getGitBackboneRemote(id);
  const gitBackbone = gitRemote ? await GitBackbone.resolve(id, gitRemote.remote) : null;
  result.ran = gitBackbone !== null;

  // 1. PULL first — fetch + auto-merge before we modify anything (never on a storage without a backbone).
  if (gitBackbone) {
    await gitBackbone.pull(result).catch((e) => {
      result.problem = `Git pull failed: ${(e as Error).message}`;
    });
    if (result.problem) log.warn("pin", `device-reg storage ${id} git: ${result.problem}`);
  }

  // 2. WRITE/UPDATE this device's own file (self-owned). Runs even without a backbone so the local file
  //    stays current and is ready to travel the moment the user turns Git on.
  try {
    writeSelfDevice(root);
  } catch (e) {
    log.warn("pin", `device-reg writeSelfDevice for storage ${id} failed: ${(e as Error).message}`);
  }

  // 3. COMMIT + PUSH this device's own SDL text (skips an empty commit; non-fast-forward retry inside).
  if (gitBackbone) {
    await gitBackbone.commitAndPush(result).catch((e) => {
      result.problem = `Git push failed: ${(e as Error).message}`;
    });
    if (result.problem) log.warn("pin", `device-reg storage ${id} git: ${result.problem}`);
    else if (result.pushed) log.info("pin", `device-reg storage ${id} git: pushed device info to remote`);
  }
  return result;
}

/**
 * The DEVICE-REGISTRATION background pass (devices.mdx §12) — what the dedicated every-10-minute `device`
 * worker runs. For EVERY directory-based storage, make sure this computer's device info is present and
 * current in the repo, pulling first so another computer's edits land here even when we have nothing to
 * write. Decoupled from the IPFS opt-in and bounded by the same limiter; a per-storage fault is contained.
 */
export async function pushDeviceBackbone(): Promise<void> {
  const ids = safeStorageIds();
  await runPool(ids, PIN_CONCURRENCY, async (id) => {
    try {
      await ensureDeviceRegistered(id);
    } catch (e) {
      log.error("pin", `device registration for storage ${id} failed: ${(e as Error).message}`);
    }
  });
}

/** Pin one storage without letting a per-storage fault throw the pass. */
function pinStorageSafe(id: string): Promise<void> {
  return pinStorageUnit(id).catch((e) =>
    log.error("pin", `pin storage ${id} failed: ${(e as Error).message}`),
  );
}

/** Discover storage ids without letting a discovery fault throw the pass. */
function safeStorageIds(): string[] {
  try {
    return listStorageIds();
  } catch (e) {
    log.error("pin", `list storages failed: ${(e as Error).message}`);
    return [];
  }
}

/** Ensure one storage's enabled backing locations; contain any per-storage failure. */
async function ensureBackingSafe(id: string): Promise<void> {
  try {
    ensureBackingLocations(id);
  } catch (e) {
    log.error("pin", `ensure backing for storage ${id} failed: ${(e as Error).message}`);
  }
}

/**
 * The full pin pass over every known unit — every repo PLUS the computer unit — with bounded
 * concurrency (pin_process.mdx §2/§4). `opts.priorityDone` names a unit a caller already pinned first
 * (a manual Pin now) so we do not pin it twice; the pass then covers the remaining units. Overlapping
 * passes are collapsed by the in-flight guard; the priority unit itself is always pinned by its caller,
 * never gated by the guard.
 */
export async function pinAll(opts: { priorityDone?: string } = {}): Promise<void> {
  if (passInFlight) {
    log.info("pin", "Full pin pass already running — skipping duplicate.");
    return;
  }
  passInFlight = true;
  try {
    const repos = listRepoFolders().filter((f) => f !== opts.priorityDone);
    await runPool(repos, PIN_CONCURRENCY, pinRepoSafe);
    // The computer unit is part of the full pass too (storage.mdx §8).
    await pinComputerUnit().catch((e) =>
      log.error("pin", `pin computer unit failed: ${(e as Error).message}`),
    );
    // Directory-based storages (personal/company/community) are units too: pin each through this
    // computer's device graft (devices.mdx §4) so its mapped-dir files resolve to the right local paths.
    // Bounded by the same limiter; per-storage failure is contained.
    const storageIds = safeStorageIds();
    await runPool(storageIds, PIN_CONCURRENCY, pinStorageSafe);
    // Materialize each storage's ENABLED backing locations (storage_settings.mdx §6) — create-if-missing
    // + ensure .lfbridge/. Bounded by the same limiter as units; per-storage failure is contained so it
    // never throws the pass.
    await runPool(storageIds, PIN_CONCURRENCY, ensureBackingSafe);
  } finally {
    passInFlight = false;
  }
}

/**
 * Set whether THIS computer claims to pin `entry.cid`, matching the real pinset (storage.mdx §9.5).
 * Only ever touches this computer's own label — peer claims are not ours to verify or edit.
 */
function setPinClaim(entry: ManifestFile, label: string, pinned: boolean): void {
  const has = entry.pinned_by.includes(label);
  if (pinned && !has) entry.pinned_by.push(label);
  else if (!pinned && has) entry.pinned_by = entry.pinned_by.filter((c) => c !== label);
}

function markUnitError(t: UnitTarget, msg: string): void {
  t.writeStatus({ ...t.status, last_error: msg });
  log.warn("pin", `${t.name}: ${msg}`);
}

// ── "A computer of yours pinned files this one doesn't have — pull them down" (warnings.mdx §10.8.12) ──
// The user-facing surface for the background reconcile (pin_process.mdx §5): a repo that arrived via the git
// backbone carries a committed manifest listing every large file → CID, but the BYTES for some of those files
// are pinned only on ANOTHER of the user's computers and are not here yet. These two functions detect that gap
// and pull the bytes down over IPFS on demand.

/** The local pinset as a CID set — best-effort. IPFS down / unreachable → EMPTY set (never throws), which
 *  makes every manifest CID read as "not pinned here" so nothing is silently hidden from the pull prompt. */
async function pinnedCidSet(): Promise<Set<string>> {
  try {
    return new Set((await ipfs.listPins()).map((p) => p.cid));
  } catch (e) {
    log.warn("pin", `listPins failed (treating pinset as empty): ${(e as Error).message}`);
    return new Set();
  }
}

/**
 * Resolve the peer device that added/pinned a file we don't have yet — for the "added by {device}" row copy.
 * The manifest's `pinned_by` records which devices claim the CID; since the bytes are absent HERE, this
 * computer is (almost) never in that list, so the first entry that isn't us is the peer. Falls back to the
 * peer's per-file sidecar `first_seen.on_device` when the manifest carries no claim, else null (§10.8.12 B).
 */
function resolveAddedBy(repoRoot: string, entry: ManifestFile, selfLabel: string): string | null {
  const peer = entry.pinned_by.find((d) => d && d !== selfLabel);
  if (peer) return peer;
  try {
    const sc = readSidecar(repoRoot, entry.path);
    const dev = sc?.file.first_seen?.on_device;
    if (dev && dev.trim() && dev !== selfLabel) return dev;
  } catch {
    /* sidecar absent/unreadable — fall through to null */
  }
  return null;
}

/**
 * List the files a PEER computer of the user's pinned that THIS computer is missing (warnings.mdx §10.8.12 A).
 * Joins the COMMITTED manifest (arrived via the git backbone) against the local working tree (`fs.existsSync`)
 * and the running IPFS node's pinset. A file QUALIFIES when it is missing on disk here AND its manifest CID is
 * NOT pinned on this node — i.e. a peer pinned it, its identity travelled in the manifest, but its bytes are
 * not here yet. A manifest entry with NO cid is not a candidate (nothing to pull); a stray media file that is
 * not in the manifest is likewise not one (it was never a shared large file). Best-effort and NON-throwing:
 * a corrupt/half-merged manifest or a down IPFS node yields [] (or an empty pinset), never an exception.
 */
export async function missingPinnedFromPeers(repoRoot: string): Promise<MissingPinnedFile[]> {
  let manifest: Manifest;
  try {
    manifest = readCommittedManifest(repoRoot); // throws on a merge-conflicted/corrupt committed list
  } catch (e) {
    log.warn("pin", `missingPinnedFromPeers: cannot read committed manifest for ${repoRoot}: ${(e as Error).message}`);
    return [];
  }
  const pinset = await pinnedCidSet();
  const selfLabel = computerLabel();
  const out: MissingPinnedFile[] = [];
  for (const entry of manifest.files) {
    if (!entry.cid) continue; // no CID → nothing to pull
    const abs = path.join(repoRoot, entry.path);
    if (fs.existsSync(abs)) continue; // already on disk here → not missing
    if (pinset.has(entry.cid)) continue; // already pinned on this node → bytes are here
    out.push({
      path: entry.path,
      name: path.basename(entry.path),
      sizeBytes: entry.size,
      cid: entry.cid,
      addedByDevice: resolveAddedBy(repoRoot, entry, selfLabel),
    });
  }
  return out;
}

/**
 * Pull the checked peer-pinned files down over IPFS (warnings.mdx §10.8.12 C). For each checked repo-relative
 * path we look up its manifest CID and PIN it on this node — pinning FETCHES the bytes over IPFS; we never
 * re-add the bytes (no new CID). We then materialize those already-pinned bytes to the repo working tree
 * (`ipfs.catToFile`, the same byte placement the regular pin pass's fetch-missing does) so the file is a real
 * on-disk copy here — which is also what lets the optional compress pass read it. When `opts.compress` is set,
 * each pulled file is handed to the background compress queue (jobqueue) AFTER its bytes land. Every pulled
 * file gets a `pull` + `ipfs_pin` event in its sidecar and a `PULL` line in this computer's history log
 * (repo_tracking_scheme.mdx §3.2/§4), guarded so a tracking write never fails the pull. NOT destructive — it
 * only ADDS local copies. Returns { pulled, failed } counts.
 */
export async function pullMissing(
  repoRoot: string,
  checkedPaths: string[],
  opts: { compress?: boolean; by?: string | null } = {},
): Promise<{ pulled: number; failed: number }> {
  let manifest: Manifest;
  try {
    manifest = readCommittedManifest(repoRoot);
  } catch (e) {
    log.warn("pin", `pullMissing: cannot read committed manifest for ${repoRoot}: ${(e as Error).message}`);
    return { pulled: 0, failed: checkedPaths.length };
  }
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const pinset = await pinnedCidSet();
  const by = opts.by ?? null;
  let pulled = 0;
  let failed = 0;

  // Bounded fan-out through the same global IPFS limiter the pin pass uses, so many pulls don't stampede
  // the daemon. Each file's failure is contained; one bad CID never fails the rest.
  await Promise.all(
    checkedPaths.map((rel) =>
      ipfsLimiter.run(async () => {
        const entry = byPath.get(rel);
        if (!entry || !entry.cid) {
          failed++;
          log.warn("pin", `pullMissing: no manifest CID for ${rel} in ${repoRoot} — skipping`);
          return;
        }
        const abs = path.join(repoRoot, entry.path);
        try {
          if (!pinset.has(entry.cid)) {
            await ipfs.pinAdd(entry.cid); // fetch + hold the bytes locally (does NOT re-add / mint a new CID)
            pinset.add(entry.cid);
          }
          if (!fs.existsSync(abs)) {
            await ipfs.catToFile(entry.cid, abs); // write the pinned bytes to the working tree (a real copy)
          }
          pulled++;
          log.info("pin", `Pulled ${rel} <- ${entry.cid} (added by ${entry.pinned_by.find((d) => d !== computerLabel()) ?? "a peer"})`);
        } catch (e) {
          failed++;
          log.warn("pin", `pullMissing: pull failed for ${rel} (${entry.cid}): ${(e as Error).message}`);
          return;
        }

        // Best-effort tracking writes (repo_tracking_scheme.mdx §3.2/§4) — never let a sidecar/history write
        // fail an otherwise-successful pull. on_device defaults to this computer inside appendFileEvent.
        try {
          appendFileEvent(repoRoot, rel, { kind: "pull", by });
          appendFileEvent(repoRoot, rel, { kind: "ipfs_pin", by, cid: entry.cid });
          appendHistory(repoRoot, {
            verb: "PULL",
            by,
            fields: { cid: entry.cid, size: entry.size },
            summary: `Pulled ${path.basename(rel)} down over IPFS`,
          });
        } catch (e) {
          log.warn("pin", `pullMissing: tracking write skipped for ${rel}: ${(e as Error).message}`);
        }

        // Optional compress axis (§10.8.12 B/C): now that the bytes are on disk, hand the file to the
        // background compress queue. Only images/videos compress; anything else is left as-is. Recoverable
        // "trash" disposition (compression.mdx §8 default) so an original is never hard-deleted here.
        if (opts.compress) {
          const kind = mediaKindForName(path.basename(rel));
          const mediaKind = kind === "image" ? "image" : kind === "video" ? "video" : null;
          if (mediaKind) {
            try {
              enqueue([{ op: "compress", path: abs, overwrite: false, compress: { deleteOriginal: "trash", mediaKind } }]);
            } catch (e) {
              log.warn("pin", `pullMissing: could not enqueue compress for ${rel}: ${(e as Error).message}`);
            }
          }
        }
      }),
    ),
  );

  log.info("pin", `pullMissing ${path.basename(repoRoot)}: pulled ${pulled}, failed ${failed} (compress=${Boolean(opts.compress)}).`);
  return { pulled, failed };
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || "~");
}
