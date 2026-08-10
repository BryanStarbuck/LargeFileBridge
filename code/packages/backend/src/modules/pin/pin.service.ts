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
import { execFileSync } from "node:child_process";
import { ManifestSchema, mediaKindForName, formatBytes, type Manifest, type ManifestFile, type UnitStatus, type Decision, type PinCounts, type MissingPinnedFile } from "@lfb/shared";
import { computerLabel } from "../store-model/config.service.js";
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
import {
  writeCommittedManifest,
  readCommittedManifest,
  writeRepoTrackingManifest,
  readRepoTrackingManifest,
} from "./manifest.service.js";
import { listStorageIds, ensureBackingLocations, getStorageRow } from "../storage/storage.service.js";
import { readStorageIndex } from "../storage/tracking.service.js";
import { writeSelfDevice, resolveGraftedPath } from "../storage/devices.service.js";
import {
  getStoragePinned,
  readMappedDirsForRoot,
  getGitBackboneRemote,
  getStorageUnitStatus,
  writeStorageUnitStatus,
} from "../storage/storage-settings.service.js";
import { GitBackbone, type GitCycleResult } from "../git/git.service.js";
import { stableGitBin } from "../git/git-bin.js";
import { withStorageGitLock, storageGitLockBusy } from "../git/git-lock.js";
// One pin pass at a time per repo unit — the equivalent of the per-storage git lock for the repo units,
// which had none (unit-lock.ts).
import { withUnitLock, unitLockBusy } from "./unit-lock.js";
// The sync-repo mirror: send (mirrorToSyncRepo, via writeRepoTrackingManifest), receive (reconcile), and the
// per-entry merge that keeps a peer's pin claim alive (storage_company.mdx §8.4.2/§8.4.3/§8.6).
import {
  ensureSyncRepoMarker,
  reconcileFromSyncRepo,
  reconcileMirroredRepos,
  mergeManifests,
} from "../storage/tracking-sync.service.js";
import { foldManifestFiles } from "../storage/manifest-merge.js";
import { recordDecision } from "../storage/decisions.service.js";
import { appendFileEvent, readSidecar } from "../storage/file-sidecar.service.js";
import { appendHistory } from "../storage/history-log.service.js";
import { enqueue } from "../jobqueue/jobqueue.service.js";
import { track } from "../progress/progress.registry.js";
// The dock's "what is happening right now" line (webapp.mdx §12a). A pin pass and a pull both fan out over
// the limiter, so the note is COMPOSED from a phase + the in-flight files rather than written by hand.
import { WorkNote, yieldToLoop } from "../progress/work-note.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { joinRelConfined, healWindowsPath } from "../../shared/rel-path.js";
import { noteCidEquivalence, pinsetHasContent } from "./cid-equivalence.service.js";
import { classifyAbsent, mergeOrphans } from "./orphans.service.js";
import { responsiveBudget } from "../../shared/concurrency.js";
import { bumpTopicThrottled, DEVICES_TOPIC } from "../events/state-events.service.js";
import { log } from "../../shared/logging.js";
import { whenOnline, hostFromRemote } from "../../shared/net-transient.js";
import { statOrNull } from "../../shared/fs-probe.js";
import { expandHome } from "../../shared/home-path.js";

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
    // RE-CHECK AFTER WAKING, in a loop. A woken waiter used to take the slot unconditionally, but its
    // `resolve()` only schedules a microtask — and any caller entering `run()` synchronously in the
    // meantime sees `active < max` and takes the slot first. Both then incremented, so the ceiling this
    // limiter exists to hold (`cores − 2`, shared by EVERY add/pin/fetch in a pass) was quietly exceeded
    // whenever units overlapped — which is the normal shape of a full pass, and of a pull running
    // alongside one.
    while (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
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
  return { eligible: 0, added: 0, pinned: 0, fetched: 0, skipped: 0, failed: 0, missing: 0, orphaned: 0, staled: 0 };
}

/**
 * How a tracked pin run reports what it is doing, so the dock shows real counts, not a bare spinner.
 * `note` is the phase line (ProgressJob.note) — the half of the answer counts alone cannot give.
 */
export type PinReport = (p: { done?: number; total?: number; unit?: string; note?: string }) => void;

/** "310 MB of 734 MB" — the per-file detail line. `approx` marks a reading derived from Kubo's node count. */
function bytesDetail(done: number, total: number | undefined, approx = false): string {
  const tilde = approx ? "≈" : "";
  if (!total || total <= 0) return `${tilde}${formatBytes(done)}`;
  const pct = Math.min(100, Math.round((done / total) * 100));
  return `${tilde}${formatBytes(done)} of ${formatBytes(total)} (${pct}%)`;
}

/**
 * How long a decided file's bytes may be absent from a computer that HELD them before the record is staled
 * (decisions.mdx §12: "marked stale after a grace period"). An unmounted external drive, a repo mid-checkout
 * or a file being rewritten in place must all survive; a genuine delete lands after one day.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

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
  // Return a decided file to Undecided once its grace period lapses (decisions.mdx §12). Only a repo unit
  // has a ledger to tombstone into; the computer/storage units leave this undefined and simply stop
  // re-fetching the orphan. Best-effort: a throw is logged and the rest of the pass continues.
  tombstone?: (rels: string[]) => Promise<void>;
}

async function runUnitPin(t: UnitTarget, onlyPaths?: Set<string>, report?: PinReport): Promise<PinCounts> {
  // Tally what this run actually does so the caller can report the truth, never a fixed "complete"
  // string (pin_process.mdx §6). Incremented inside the parallel closures below — safe because JS runs
  // each synchronous span between awaits atomically, so counter bumps never interleave.
  const counts = zeroCounts();
  // The phase line for this unit. Every long step below names itself here, so a pass that is between files
  // — or inside one big one — says what it is doing instead of rendering as a bare spinner.
  const note = new WorkNote(report);
  const missing = t.preflightError?.();
  if (missing) {
    markUnitError(t, missing);
    // The run never STARTED — say so. An all-zero tally alone renders as the benign "Nothing to pin —
    // no files marked Pin", which is the same sentence a healthy no-op prints: three completely
    // different situations wearing one face (pin_process.mdx §6).
    counts.error = missing;
    return counts;
  }
  note.phase("checking the IPFS node");
  const health = await ipfs.health();
  if (health !== "ok") {
    markUnitError(t, "IPFS node unreachable");
    counts.error = "IPFS node unreachable";
    return counts;
  }
  await ipfs.enforceCompliance();

  // FOLD, don't just key: a `merge=union` manifest legitimately carries the same path twice, and keying the
  // raw list is last-wins — the twin holding the CID or a peer's pin claim would vanish from the manifest
  // this pass rewrites wholesale below (§8.4.3: absence is never a delete).
  note.phase("reading this unit's file list");
  await yieldToLoop(); // the fold below is synchronous over the whole manifest — let the poll see the note
  const byPath = new Map(foldManifestFiles(t.manifest.files, t.kind).map((f) => [f.path, f]));

  // Learn from the filesystem which CIDs are REALLY pinned right now. The local IPFS pinset is the
  // source of truth; our manifest `pinned_by` is a stale cache we verify and refresh against it every
  // pin pass (storage.mdx §9.5). Read it once up front, and keep it current as we pin below.
  //
  // CANONICAL membership (knowledge/ipfs.mdx §5.1): the pinset is keyed by CANONICAL (CIDv1 base32) CIDs so a
  // block pinned as `Qm…` is not invisible to a `bafy…` manifest CID for the SAME block — `pin ls` is
  // base-sensitive, so a raw string Set silently missed those. Always test membership as
  // `pinset.has(ipfs.canonicalCid(cid))`.
  let pinset: Set<string>;
  try {
    // On a large pinset this single call runs for a long time and moves no files — the exact interval that
    // used to read as a hang. Name it.
    note.phase("reading this computer's pin list");
    pinset = new Set((await ipfs.listPins()).map((p) => ipfs.canonicalCid(p.cid)));
  } catch (e) {
    // A failed/timed-out `pin ls` must NEVER be read as "nothing is pinned" — an empty pinset here makes
    // every previously-pinned file look pin-lost and re-uploads the whole unit. Skip this pass instead;
    // the next scheduled pass retries with a healthy daemon.
    const msg = `pin ls failed — skipping pin pass: ${(e as Error).message}`;
    markUnitError(t, msg);
    counts.error = msg;
    return counts;
  }

  // Add + pin any new / changed / no-longer-pinned Add-to-IPFS-decided file — IN PARALLEL, bounded by the
  // global limiter (pin_process.mdx §4). Each task owns a distinct path key, so the shared `byPath` /
  // `pinset` mutations never collide (JS runs each synchronous span between awaits atomically).
  const toAdd = Object.entries(t.decisions).filter(
    ([rel, decision]) => decision === "sync" && (!onlyPaths || onlyPaths.has(rel)),
  );
  counts.eligible = toAdd.length;

  // Determinate progress for the dock (webapp.mdx §12): one tick per settled file. `total` grows when the
  // fetch phase's real target list is known below — a bare spinner with no counts is what made a long pin
  // pass indistinguishable from a hung one.
  let done = 0;
  let total = toAdd.length;
  const tick = (): void => report?.({ done: ++done, total, unit: "files" });
  report?.({ done: 0, total, unit: "files" });
  // The per-file fan-out carries its VERB in the item label ("checking x", "adding x"), not in the phase:
  // several files are in flight at once and they are not all at the same step, so one shared phase word
  // would be wrong for most of them.
  note.phase("");

  // Decided files with NO bytes here, gathered during the add phase and classified after it (below): either
  // never-here (a second computer's pull-down offer) or gone-from-a-computer-that-held-them (a delete).
  const absentHere: string[] = [];

  await Promise.all(
    toAdd.map(([rel]) =>
      ipfsLimiter.run(async () => {
        note.start(rel, `checking ${path.basename(rel)}`);
        const abs = t.resolveAbs(rel);
        if (abs === null) return; // not placeable here (ungrafted mapped dir) — known-but-absent
        // Non-throwing (shared/fs-probe): runs per pinned file, and decided-but-absent is a NORMAL
        // second-computer state, not an exceptional one.
        const st = statOrNull(abs);
        if (!st) {
          absentHere.push(rel); // no bytes here — classified after this phase, never silently dropped
          return;
        }
        const existing = byPath.get(rel);
        // "Unchanged" means same bytes AND still really pinned. A size match alone is NOT enough — if
        // the pin was lost (GC, or an `ipfs pin rm` outside the app) we must re-pin so reality matches
        // intent rather than trust the stale cache (storage.mdx §9.5). Membership is CANONICAL so a
        // `Qm…`-encoded pin of a `bafy…` manifest CID (same block) still counts (knowledge/ipfs.mdx §5.1).
        // `pinsetHasContent` also accepts a CID we have previously established as content-identical to the
        // recorded one (cid-equivalence.service.ts) — the case where our IPFS add profile differs from the
        // computer that first recorded the file. Without it, this machine re-hashes those files EVERY pass.
        const unchanged = existing?.cid && existing.size === st.size && pinsetHasContent(pinset, existing.cid);
        if (unchanged) {
          setPinClaim(existing!, t.label, true);
          counts.skipped++; // eligible but already up-to-date + still pinned (§6 truthful "nothing changed")
          return;
        }
        // FOREIGN-PROFILE ADOPTION (knowledge/ipfs.mdx §5.1). A PREVIOUSLY-TRACKED file whose recorded CID
        // is no longer in the pinset may not be "pin lost" at all — its exact bytes can already be pinned
        // under a DIFFERENT add profile (a legacy CIDv0 `ipfs add`, or a non-raw-leaves build) whose CID we
        // never compute. canonicalCid can't bridge that (different multihash), so re-hash the bytes once and,
        // if they ARE already pinned, ADOPT that CID instead of re-adding a duplicate pin of identical bytes.
        // Bounded to already-tracked files that appear unpinned (never brand-new adds), so the extra read is
        // paid only where we were about to re-upload the file anyway.
        if (existing?.cid && existing.size === st.size) {
          // Hand it the pinset THIS pass already read. Without it, each probe rebuilt the kept-set from
          // scratch — a full `pin/ls` enumeration per candidate file, on top of the byte re-hash it is
          // already paying for.
          const already = await ipfs.contentPinnedCid(abs, pinset);
          if (already) {
            const canon = ipfs.canonicalCid(already);
            pinset.add(canon);
            // RECORD THE EQUIVALENCE LOCALLY — do NOT rewrite the manifest's CID. The manifest is SHARED and
            // committed, and the adopted CID is a fact about THIS computer's add profile, not about the file.
            // Writing it back made two computers with different profiles overwrite each other's entry on
            // every single pass: a real conflict on a real payload file, every cycle, forever, which is what
            // kept the company backbone in a permanent merge/retry loop (cid-equivalence.service.ts).
            noteCidEquivalence(existing.cid, already);
            setPinClaim(existing, t.label, true);
            counts.skipped++;
            log.info(
              "pin",
              `Adopted existing foreign-profile pin for ${rel} -> ${already} (no duplicate add; manifest CID ${existing.cid} left as recorded).`,
            );
            return;
          }
        }
        try {
          // `add` uploads the whole file into the blockstore, so a multi-GB video sits here for minutes.
          // Kubo's own byte count drives the card's detail — a true reading, not an estimate.
          note.start(rel, `adding ${path.basename(rel)}`);
          note.detail(rel, bytesDetail(0, st.size));
          const cid = await ipfs.addFile(abs, {
            onBytes: (b) => note.detailLazy(rel, () => bytesDetail(b, st.size)),
          }); // add streams the bytes and pins recursively (pin=true)
          pinset.add(ipfs.canonicalCid(cid));
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
      }).finally(() => {
        note.finish(rel); // the line must never keep naming a file that already settled
        tick(); // every exit path counts, so the bar reaches its total even on an all-no-op pass
      }),
    ),
  );

  // Drop manifest entries whose decision is no longer "sync" — EXCEPT the ones another of the user's
  // computers pins (storage_company.mdx §8.5). Those are "known here, owned elsewhere": their identity
  // arrived over the sync repo, this computer has made no decision about them, and they are the raw material
  // for the red remote-only row + the Pull down metric. Dropping them would delete the peer's claim on every
  // pin pass and silently re-empty the very list this feature exists to fill — the local decision axis is not
  // a licence to forget what a peer told us (§8.4.3: absence is never a delete).
  const knownFromPeers = new Set<string>();
  for (const rel of [...byPath.keys()]) {
    if (t.decisions[rel] === "sync") continue;
    const entry = byPath.get(rel)!;
    if (entry.cid && entry.pinned_by.some((d) => d && d !== t.label)) {
      knownFromPeers.add(rel);
      continue;
    }
    byPath.delete(rel);
  }

  // ── REALITY vs. RECORD for the decided files with no bytes here (decisions.mdx §12) ──────────────────
  // Never-here (a pull-down offer) vs. gone-from-here (a deletion), plus the grace period — the whole rule
  // lives in orphans.service.ts so it is testable without a daemon. What is done ABOUT each answer is here.
  note.phase("working out what is missing on this computer");
  const { missing: neverHere, orphans, stale } = classifyAbsent({
    absent: absentHere,
    entryFor: (rel) => byPath.get(rel),
    heldHere: (cid) => pinsetHasContent(pinset, cid),
    label: t.label,
    prior: t.status.orphans ?? {},
    nowMs: Date.now(),
    graceMs: ORPHAN_GRACE_MS,
  });
  counts.missing = neverHere.length;
  counts.orphaned = Object.keys(orphans).length;
  const orphanedNow = new Set(Object.keys(orphans));
  for (const rel of orphanedNow) {
    if (!t.status.orphans?.[rel]) {
      log.info(
        "pin",
        `${t.name}: ${rel} is decided and was pinned here but its bytes are gone — no longer fetching it back; the decision stales if it stays gone.`,
      );
    }
  }

  // Grace lapsed → STALE it: return the file to Undecided and drop this computer's pin so the blockstore
  // stops holding bytes for a file the user deleted. The manifest entry itself survives when a PEER still
  // claims it (§8.4.3 absence is never a delete) — it simply becomes a remote-only row again.
  for (const rel of stale) {
    const entry = byPath.get(rel);
    const cid = orphans[rel]?.cid ?? entry?.cid ?? null;
    if (cid) {
      try {
        await ipfs.pinRm(cid);
      } catch (e) {
        // A pin we no longer hold is the desired end state, so a failure here is informational only.
        log.info("pin", `${t.name}: unpin of staled ${rel} did not apply: ${(e as Error).message}`);
      }
    }
    if (entry) {
      setPinClaim(entry, t.label, false);
      if (!entry.pinned_by.some((d) => d && d !== t.label)) byPath.delete(rel); // nobody holds it anywhere
    }
    delete orphans[rel];
    orphanedNow.delete(rel);
    delete t.decisions[rel]; // this pass must stop treating it as eligible
  }
  counts.staled = stale.length;
  if (stale.length > 0) {
    if (t.tombstone) {
      try {
        await t.tombstone(stale);
      } catch (e) {
        log.warn("pin", `${t.name}: tombstoning ${stale.length} deleted file(s) failed: ${(e as Error).message}`);
      }
    }
    log.info("pin", `${t.name}: staled ${stale.length} deleted file(s) — decision returned to Undecided, local pin dropped.`);
  }

  // Fetch missing: rehydrate any manifest file we don't have ON DISK here yet — pin its CID AND
  // materialize the bytes to the resolved local path (storage.mdx §9). Byte placement goes through the
  // unit's `resolveAbs`, so a repo file lands in its working tree, a computer file at its absolute path,
  // and a storage file at THIS device's grafted local path (devices.mdx §4). All IN PARALLEL, bounded by
  // the global limiter. A file already on disk needs nothing; a mapped dir not grafted here (abs === null)
  // is known-but-absent and skipped.
  if (t.fetchMissing) {
    // Resolve the real target list FIRST, so the dock's total is the number of files that will actually be
    // fetched rather than every entry in the manifest.
    const fetchTargets = [...byPath.values()].filter((entry) => {
      if (!entry.cid) return false;
      // SCOPE APPLIES TO BOTH HALVES (pin_process.mdx §3). A paths-scoped run — the bulk "Pin now
      // (selected)", and the targeted pin every decision click fires — asked for THESE files. Without this
      // the add half honored the selection while the fetch half quietly pulled down every missing file in
      // the repo, and reported `fetched`/`failed` counts for files the user never selected.
      if (onlyPaths && !onlyPaths.has(entry.path)) return false;
      // A peer-known file this computer has NOT decided to sync is an OFFER, not an obligation
      // (storage_company.mdx §8.5). Fetching it here would silently download every big file the user's
      // other machines hold — the opposite of "we surface and offer, we never act on files on our own"
      // (the charter). It stays a red remote-only row until the user pulls it.
      if (knownFromPeers.has(entry.path)) return false;
      // An orphan inside its grace period is a file the user DELETED here. Re-fetching it is the "surprise
      // re-pinning" decisions.mdx §12 forbids, and it is precisely why deleting a synced file used to do
      // nothing at all — the next pass silently put it back.
      if (orphanedNow.has(entry.path)) return false;
      const abs = t.resolveAbs(entry.path);
      if (abs === null) return false; // ungrafted mapped dir — known-but-absent on this computer
      return !fs.existsSync(abs); // already on disk here — nothing to fetch
    });
    total += fetchTargets.length;
    report?.({ done, total, unit: "files" });
    note.phase("");
    await Promise.all(
      fetchTargets.map((entry) =>
        ipfsLimiter.run(async () => {
          if (!entry.cid) return;
          const abs = t.resolveAbs(entry.path);
          if (abs === null) return;
          note.start(entry.path, `fetching ${path.basename(entry.path)}`);
          try {
            // SELF-HEAL a wrapper-directory CID before we pin OR cat it. A manifest written before the
            // basename fix in `ipfs.addFile` can hold the CID of the WRAPPER DIRECTORY Kubo builds for a
            // slashed upload filename; `cat` on a directory node can never succeed, so the old code retried
            // the same failure every sync pass forever and the file NEVER synced. Resolving first also means
            // we pin the file itself rather than the wrapper tree.
            const fileCid = await ipfs.resolveFileCid(entry.cid, path.basename(entry.path));
            if (fileCid !== entry.cid) {
              log.info("pin", `Healed wrapper-directory CID for ${entry.path}: ${entry.cid} -> ${fileCid}`);
              entry.cid = fileCid; // persisted below by t.writeManifest — the bad CID stops being retried
            }
            if (!pinset.has(ipfs.canonicalCid(entry.cid))) {
              // Same fast availability probe as the interactive pull (warnings.mdx §10.8.12 C.1): when the
              // only holder is offline, fail this file in seconds instead of spending the full pin-add
              // stall budget on it EVERY 15-minute pass. Inconclusive (null) proceeds.
              note.detail(entry.path, "looking for a computer that has it");
              if ((await ipfs.hasProvider(entry.cid)) === false) {
                counts.failed++;
                log.warn("pin", `fetch skipped for ${entry.path}: no computer is currently providing it (holder offline?)`);
                return;
              }
              // hold a local copy first… — and say how far the transfer has got while it runs
              await ipfs.pinAdd(entry.cid, {
                onNodes: (n) =>
                  note.detailLazy(entry.path, () =>
                    bytesDetail(ipfs.approxFetchedBytes(n, entry.size), entry.size, true),
                  ),
              });
              pinset.add(ipfs.canonicalCid(entry.cid));
              counts.pinned++;
            }
            note.detail(entry.path, "writing it to disk");
            // `resolved: true` — `resolveFileCid` ran a few lines up; re-running it costs a `files/stat`
            // per file (more per wrapper level) to re-derive the CID we are already holding.
            await ipfs.catToFile(entry.cid, abs, {
              resolved: true,
              onBytes: (b) =>
                note.detailLazy(entry.path, () => `writing to disk · ${bytesDetail(b, entry.size)}`),
            }); // …then write the bytes locally
            counts.fetched++;
            log.info("pin", `Fetched ${entry.path} -> ${abs} (${entry.cid})`);
          } catch (e) {
            counts.failed++;
            log.warn("pin", `fetch failed for ${entry.path}: ${(e as Error).message}`);
          }
        }).finally(() => {
          note.finish(entry.path);
          tick();
        }),
      ),
    );
  }

  // Refresh the pin cache against ground truth: this computer belongs in `pinned_by` for a CID iff the
  // local pinset actually holds it now (storage.mdx §9.5). Stale self-claims (a pin lost since the last
  // pin pass) are dropped here. Peer claims are left untouched — we can only verify our own.
  for (const entry of byPath.values()) {
    if (!entry.cid) continue;
    // Content-aware: a file we hold under a different add profile IS pinned here, so the claim stands.
    // Testing the raw CID alone would drop our own claim every pass and re-churn the shared manifest.
    setPinClaim(entry, t.label, pinsetHasContent(pinset, entry.cid));
  }

  note.phase("saving this unit's file list");
  await yieldToLoop(); // the parse + write below are synchronous over every file in the unit
  const next: Manifest = ManifestSchema.parse({
    unit: t.kind,
    generated_at: new Date().toISOString(),
    files: [...byPath.values()],
  });
  t.writeManifest(next);

  if (t.publish) {
    try {
      note.phase("sharing the file list with your other computers");
      t.publish(next);
    } catch (e) {
      log.warn("pin", `publish manifest failed for ${t.name}: ${(e as Error).message}`);
    }
  }

  // A paths-scoped run only classified the paths it was given, so it must not write its map wholesale over
  // every OTHER file's grace record (mergeOrphans — the rule and why it exists live next to classifyAbsent).
  const orphansToWrite = mergeOrphans(t.status.orphans ?? {}, orphans, onlyPaths);
  t.writeStatus({ ...t.status, last_pin_at: new Date().toISOString(), last_error: null, orphans: orphansToWrite });
  log.info(
    "pin",
    `Pinned ${t.name}: ${next.files.length} file(s) — added ${counts.added}, fetched ${counts.fetched}, pinned ${counts.pinned}, ` +
      `skipped ${counts.skipped}, failed ${counts.failed}, not here ${counts.missing}, deleted here ${counts.orphaned} (${counts.staled} staled).`,
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
export function pinRepoFolder(
  folder: string,
  onlyPaths?: Set<string>,
  opts: { manual?: boolean; report?: PinReport } = {},
): Promise<PinCounts> {
  // ONE pass at a time for this repo (unit-lock.ts). The decision-triggered pin, a manual Pin now and the
  // background pass all land here for the same folder, and `runUnitPin` writes the unit manifest WHOLESALE
  // from a snapshot taken at entry — so two overlapping runs drop each other's newly-added CIDs and re-upload
  // those files on the next pass. Serialized rather than coalesced: a paths-scoped run carries the user's
  // selection and must not be swallowed by a queued run with a different scope.
  //
  // A QUEUED run is the most confusing state this pass has: the card is up, nothing is moving, and nothing
  // anywhere says why. Say it — the wait IS the honest answer, and the phase is overwritten the moment this
  // caller's turn actually starts.
  const key = `repo:${folder}`;
  if (unitLockBusy(key)) opts.report?.({ note: "waiting for the sync pass already running on this repo" });
  return withUnitLock(key, () => pinRepoFolderInner(folder, onlyPaths, opts));
}

async function pinRepoFolderInner(
  folder: string,
  onlyPaths?: Set<string>,
  opts: { manual?: boolean; report?: PinReport } = {},
): Promise<PinCounts> {
  const cfg = getRepoConfig(folder);
  if (!cfg.pinned) {
    if (!opts.manual) {
      // The SEND opt-in (`pinned`) must not gate the RECEIVE half (storage_company.mdx §8.4.3): a peer's
      // manifest that arrived in the sync repo still has to fold into Local Storage, or the Pull-down
      // metric reads 0 forever on any repo the user never pressed "Pin now" on — the exact break that
      // hid teammates' pinned files. Marker + reconcile only; no bytes move, no manifest is published.
      const repoPath = expandHome(cfg.repo.path);
      ensureSyncRepoMarker(repoPath, cfg.repo.remote ?? null, cfg.sync_repo?.enabled);
      reconcileFromSyncRepo(repoPath);
      log.info("pin", `Skip ${folder}: pinned=false (reconciled peer state only).`);
      return zeroCounts(); // background scheduler respects the opt-in — an honest no-op tally
    }
    await updateRepoConfig(folder, (c) => ({ ...c, pinned: true }));
    cfg.pinned = true;
    log.info("pin", `${folder}: manual Pin now — enabling background pinning (pinned=true).`);
  }
  const repoPath = expandHome(cfg.repo.path);
  // The mirror is ON by default (storage_company.mdx §8.4.2): make sure this repo's marker names the owning
  // storage's sync repo and this repo's shared `repoUid`, then fold in whatever a peer computer pushed
  // there. Both are best-effort — a repo that cannot mirror (no remote, no owning storage) simply pins
  // locally, exactly as before.
  //
  // THIS PRELUDE IS THE SLOW PART on a big repo and it moves no bytes at all: the reconcile re-parses and
  // rewrites the ledger, and the merge folds two whole manifests. Reported (and yielded to, so the poll is
  // actually served) because minutes of silence here is what made a working pass look wedged.
  opts.report?.({ note: "reading what your other computers changed" });
  await yieldToLoop();
  ensureSyncRepoMarker(repoPath, cfg.repo.remote ?? null, cfg.sync_repo?.enabled);
  reconcileFromSyncRepo(repoPath);
  // §8.6 — the two manifests must not disagree. The reconcile lands in Local Storage; the One-Repo file rows
  // read the UNIT manifest, so fold the peer's entries across before the pass rather than leaving a
  // Pull-down count that no row can explain.
  opts.report?.({ note: "merging the file lists" });
  await yieldToLoop();
  const unitManifest = mergeManifests(getRepoManifest(folder), readRepoTrackingManifest(repoPath));
  return runUnitPin(
    {
      kind: "repo",
      name: folder,
      label: computerLabel(),
      decisions: cfg.decisions,
      fetchMissing: cfg.pin.fetch_missing,
      // joinRelConfined, not path.join: a manifest key is POSIX (repo__list_syns.mdx §6.1), and this is the
      // function that decides WHERE a fetched file's bytes are written. `path.join(root, 'a\\b.mp4')` on
      // macOS/Linux writes one file literally named `a\b.mp4` at the repo root — the 2026-08-04 defect.
      // CONFINED because the key is not ours: it arrives through a git-merged manifest from another
      // computer (or a teammate), and null here reads as "not placeable on this computer", the same
      // known-but-absent answer an ungrafted mapped dir gives — so a bad key is skipped, never written.
      resolveAbs: (rel) => joinRelConfined(repoPath, rel),
      manifest: unitManifest,
      status: getRepoStatus(folder),
      writeManifest: (m) => writeRepoManifest(folder, m),
      writeStatus: (s) => writeRepoStatus(folder, s),
      // Publish the repo's manifest to LOCAL STORAGE (never the working repo → no merge conflict); it
      // travels via the company/Personal sync repo when configured (artifact_placement_policy.mdx §1.2).
      publish: cfg.pin.publish_manifest ? (m) => writeRepoTrackingManifest(repoPath, m) : undefined,
      preflightError: () => (isGitWorkingTree(repoPath) ? null : "repo missing"),
      // A repo has the shared ledger, so a staled orphan is returned to Undecided there — attributed to the
      // deletion itself, never to a person who did not make that choice (decisions.mdx §12).
      tombstone: (rels) => recordDecision(folder, rels, {}, "deleted", { asked: false }),
    },
    onlyPaths,
    opts.report,
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
  // Manifest keys are POSIX (repo__list_syns.mdx §6.1) — heal a `\` spelling from an older Windows writer
  // before splitting, or the whole path reads as ONE segment: no mapped-dir key ever matches, and the
  // fallback join materializes the bytes in a file literally named `dir\sub\clip.mp4` at the SDL root.
  const key = healWindowsPath(rel);
  const cut = key.indexOf("/");
  if (cut > 0 && mappedKeys.has(key.slice(0, cut))) {
    // A mapped hierarchy: the graft decides where (or whether) it lives here.
    return resolveGraftedPath(root, key.slice(0, cut), key.slice(cut + 1));
  }
  // CONFINED to the SDL root — the key came off a shared manifest, so `..` must resolve to "not placeable
  // here" rather than to a write outside the storage (joinRelConfined).
  return joinRelConfined(root, key); // pre-mapped-dir model: the file lives under the SDL root
}

// Serialize all Git-cycle work PER STORAGE. The every-10-min device worker, the every-15-min pin pass, a
// manual Pin now, and the artifact sync trigger (sync-trigger.service.ts) all hit THIS one backend process
// over loopback, and their cadences coincide — two of them running git add/commit/push in the SAME working
// copy at once corrupts the index. This guarantees at most one pass touches a given storage's repo at a
// time; different storages still run concurrently.
//
// COALESCING, not an unbounded FIFO (storage_personal.mdx §18.5.4 / AC-33 — CHANGED). The previous
// implementation chained EVERY caller: `prev.then(fn, fn)`. Under a long hold (a first-sync pin pass doing
// unbounded IPFS work) every 10-min tick appended another closure, nothing coalesced them, and when the lock
// finally freed they ALL ran back-to-back — each paying a full fetch + push. The watchdog, seeing the worker
// overdue, appended MORE every 5 minutes; its single-flight guards overlapping TICKS, not accumulating lock
// WAITERS. That is thrash, not dedup.
//
// A pass is a RECONCILIATION TO CURRENT STATE, not a work item: running it twice is never more correct than
// running it once. So we keep at most ONE running + ONE queued per storage, and any further request while one
// is already queued COLLAPSES into it and shares its promise.
/**
 * Pin one directory-based storage (personal / company / community) as a unit, placing each file through
 * this computer's device graft (`resolveStorageAbs` → devices.mdx §4). Repos pin as their own repo
 * units and the settings-only "local" storage has no bytes, so both are skipped. Byte work is gated by
 * the per-storage `pinned` opt-in (default OFF — charter), mirroring the repo/computer-unit gate
 * (pin_process.mdx §1): a not-opted-in storage is still known and visited, but nothing is added/pinned/
 * fetched. Its file list is the tracking index; its manifest is the SDL's root `manifest.yaml`.
 * The whole unit runs under the per-storage Git lock so it never races the device worker on the same repo.
 */
export function pinStorageUnit(id: string, onPhase?: PhaseNote): Promise<void> {
  if (storageGitLockBusy(id)) onPhase?.("waiting for the git cycle already running on this storage");
  return withStorageGitLock(id, () => pinStorageUnitInner(id, onPhase));
}

/** One line of "what step is this storage on" — fed to the pass card's per-unit detail (webapp.mdx §12a). */
export type PhaseNote = (text: string) => void;

/**
 * Report ONE git cycle's problem at the RIGHT severity, and never lose the cycle to a network blip (bug #15).
 *
 * A real remote/auth/merge problem stays a WARN — it is a fault, it belongs in `error.err`, and a human has
 * to do something about it. An OFFLINE cycle (`Could not resolve host`, `Resolving timed out` — a closed lid,
 * a wifi switch, a resolver that hadn't woken yet) is neither: it is logged at INFO so the durable fault
 * trail stays a list of real faults, NOTHING is marked failed, and the whole cycle is re-run the moment the
 * remote's host resolves again instead of waiting out the next 15-minute tick.
 */
function reportGitProblem(prefix: string, id: string, remote: string | null, r: GitCycleResult): void {
  if (!r.problem) return;
  if (r.offline) {
    log.info("pin", `${prefix}storage ${id} git: ${r.problem}`);
    whenOnline(`storage ${id}`, hostFromRemote(remote), () => {
      void syncStorageText(id).catch((e) =>
        log.warn("pin", `storage ${id}: retry after reconnect failed: ${(e as Error).message}`),
      );
    });
    return;
  }
  log.warn("pin", `${prefix}storage ${id} git: ${r.problem}`);
}

async function pinStorageUnitInner(id: string, onPhase?: PhaseNote): Promise<void> {
  const row = getStorageRow(id);
  if (!row || row.type === "local" || row.type === "repo") return;
  const root = expandHome(row.root);
  onPhase?.("opening its git backbone");

  // Git backbone (git_backbone.mdx §6): if this storage's dedicated Git repo is ON, FETCH + auto-MERGE the
  // user's other computers' SDL edits BEFORE we touch anything, so the incoming devices/manifest/analysis
  // are merged in first. This pull happens EVERY pass even when we have nothing to change (devices.mdx
  // §12), so edits made on another computer land here. A merge conflict or auth failure is surfaced and we
  // continue over IPFS. The commit + push of THIS device's own changes happens AFTER the reconcile below.
  const gitRemote = getGitBackboneRemote(id);
  const gitBackbone = gitRemote ? await GitBackbone.resolve(id, gitRemote.remote) : null;
  const gitResult: GitCycleResult = { ran: gitBackbone !== null };
  if (!gitBackbone) {
    // NO SILENT NULLS (storage_company.mdx §11.2). The git-only cycle warns here; this path did not, so a
    // storage with no resolvable backbone reported `ran:false` — indistinguishable from "not attempted" —
    // while its text accumulated locally forever.
    log.warn(
      "pin",
      `storage ${id} (${row.type}) has NO resolvable git backbone — its tracking text is written locally ` +
        `but will NEVER be committed or pushed. ` +
        `${gitRemote ? `The remote "${gitRemote.remote}" did not resolve to a working copy.` : `No dedicated repo is configured and ${root} has no .git directory.`}`,
    );
  }
  if (gitBackbone) {
    await gitBackbone.pull(gitResult, onPhase).catch((e) => {
      gitResult.problem = `Git pull failed: ${(e as Error).message}`;
    });
    reportGitProblem("", id, gitRemote?.remote ?? null, gitResult);
    // Fold in what the pull delivered (storage_company.mdx §8.4.3: reconcile runs on EVERY backbone pull,
    // not just the git-only cycle). Without this a full pin pass fetches the SDL's text and drops the
    // `repos/<repoUid>/` subtrees on the floor for that cycle — the peer's file stays invisible until some
    // later pass happens to be the other kind.
    onPhase?.("folding in what your other computers pushed");
    await reconcileMirroredRepos(root).catch((e) =>
      log.warn("pin", `storage ${id}: reconciling mirrored repos failed: ${(e as Error).message}`),
    );
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
    onPhase?.("reading its tracked-file index");
    const decisions: Record<string, Decision> = {};
    for (const f of readStorageIndex(root)) decisions[f.path] = "sync";

    // The set of real mapped-dir keys (read once) tells resolveStorageAbs whether a path's first segment is
    // a grafted hierarchy vs. a plain SDL-relative path.
    const mappedKeys = new Set(readMappedDirsForRoot(root).mapped.map((m) => m.key));

    await runUnitPin(
      {
        kind: "storage",
        name: `storage:${id}`,
        label: computerLabel(),
        decisions,
        fetchMissing: true,
        resolveAbs: (rel) => resolveStorageAbs(root, rel, mappedKeys),
        manifest: readCommittedManifest(root), // <root>/manifest.yaml — an SDL has no .lfbridge/ (§0.4)
        // A REAL, PERSISTED status (pin/s/<id>/status.yaml, machine-local). This used to be a throwaway
        // `UnitStatusSchema.parse({})` with a no-op writer, which silently disabled the deleted-file rule for
        // every SDL: `classifyAbsent` carries the grace period in `status.orphans`, so with nothing persisted
        // each pass re-stamped a deleted file as "first seen absent just now". The 24h grace could never
        // lapse (decisions.mdx §12), the decision never returned to Undecided, and this computer went on
        // pinning bytes for a file the user had deleted. `markUnitError` wrote nowhere for the same reason.
        status: getStorageUnitStatus(id),
        writeManifest: (m) => writeCommittedManifest(root, m),
        writeStatus: (s) => writeStorageUnitStatus(id, s),
      },
      undefined,
      // A storage's byte work is a full unit pin — route its phase line into the SAME per-unit detail slot
      // the git steps above use, so the pass card keeps naming the real current step.
      onPhase
        ? (pr) => {
            if (pr.note !== undefined) onPhase(pr.note);
          }
        : undefined,
    );
  } else {
    log.info("pin", `Storage ${id}: pinned=false — device info kept current, no byte work.`);
  }

  // Git backbone (git_backbone.mdx §6 steps 5–6): after the reconcile has refreshed this device's own files
  // (device file, manifest, analysis), STAGE the self-owned SDL text, COMMIT, and PUSH — with a
  // fetch-merge-push retry on a non-fast-forward reject. Big bytes are git-ignored, so only the small
  // text is ever committed. A push/auth problem is surfaced (logged) and never blocks the IPFS work.
  if (gitBackbone) {
    await gitBackbone.commitAndPush(gitResult, onPhase).catch((e) => {
      gitResult.problem = `Git push failed: ${(e as Error).message}`;
    });
    if (gitResult.problem) reportGitProblem("", id, gitRemote?.remote ?? null, gitResult);
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
  return withStorageGitLock(id, () => syncStorageTextInner(id, "device-reg")).then((r) => {
    // The cycle's pull may have landed other computers' device files — the Devices page learns live.
    // Throttled: the device pass runs one cycle per storage in a burst.
    bumpTopicThrottled(DEVICES_TOPIC);
    // `undefined` = this call collapsed into an already-queued pass (git-lock.ts), which does a superset
    // of this work and reports its own problems — so the honest result here is "ran, nothing to report".
    return r ?? { ran: true };
  });
}

/**
 * Commit + push ONE storage's SDL text — the GIT-ONLY cycle, with no IPFS byte work in the middle
 * (storage_personal.mdx §18.2: no unbounded operation may sit between the pull and the push, so the
 * conflict window stays inside its 60s budget instead of spanning an unbounded `runUnitPin`).
 *
 * This is the entry point for THE WRITE IS THE TRIGGER (§18.5.3.1): sync-trigger.service.ts calls it a
 * debounced ~20s after an artifact lands. It is deliberately the SAME cycle the device worker runs, exposed
 * under an honest name — before this existed, transcripts and AI descriptions reached the server only as
 * STOWAWAYS on `ensureDeviceRegistered`, a function whose stated purpose is to write one small YAML
 * (§18.5.1). Artifacts must never again depend on the device worker: AC-30's test is that deleting the
 * device worker tomorrow leaves artifact delivery intact.
 */
export function syncStorageText(id: string, onPhase?: PhaseNote): Promise<GitCycleResult> {
  // `undefined` = collapsed into an already-queued pass on this storage's lock (git-lock.ts) — that pass
  // runs the same pull→reconcile→commit→push cycle and reports its own problems. Callers read `.problem`
  // off this result (backbone-freshness, sync-trigger), so never let the collapse hand them undefined.
  if (storageGitLockBusy(id)) onPhase?.("waiting for the git cycle already running on this storage");
  return withStorageGitLock(id, () => syncStorageTextInner(id, "sync", onPhase)).then((r) => r ?? { ran: true });
}

async function syncStorageTextInner(id: string, tag: string, onPhase?: PhaseNote): Promise<GitCycleResult> {
  const result: GitCycleResult = { ran: false };
  const row = getStorageRow(id);
  if (!row || row.type === "local" || row.type === "repo") return result;
  const root = expandHome(row.root);

  const gitRemote = getGitBackboneRemote(id);
  const gitBackbone = gitRemote ? await GitBackbone.resolve(id, gitRemote.remote) : null;
  result.ran = gitBackbone !== null;

  // §18.5.2 F1 / AC-31 — NO SILENT NULLS. A storage that is discovered but has no resolvable backbone used
  // to return here having written a device file that nothing would ever commit: no log, no warning, and a
  // `ran:false` indistinguishable from "not attempted". That is the first and worst of the six forever-cases
  // — artifacts accumulate on disk forever with no diagnostic anywhere. Say so, once it matters.
  if (!gitBackbone) {
    log.warn(
      "pin",
      `${tag} storage ${id} (${row.type}) has NO resolvable git backbone — its text (device file, transcripts, ` +
        `AI descriptions) is written locally but will NEVER be committed or pushed. ` +
        `${gitRemote ? `The remote "${gitRemote.remote}" did not resolve to a working copy.` : `No dedicated repo is configured and ${root} has no .git directory.`}`,
    );
    // Still refresh the local device file below so it is ready the moment a backbone is turned on.
  }

  // 1. PULL first — fetch + auto-merge before we modify anything (never on a storage without a backbone).
  if (gitBackbone) {
    await gitBackbone.pull(result, onPhase).catch((e) => {
      result.problem = `Git pull failed: ${(e as Error).message}`;
    });
    reportGitProblem(`${tag} `, id, gitRemote?.remote ?? null, result);
    // 1b. FOLD IN what the pull just delivered (storage_company.mdx §8.4.3). Every `repos/<repoUid>/` subtree
    //     another of the user's computers pushed is merged into this machine's Local Storage — which is what
    //     turns "the Tower pinned a file" into a row, a metric, and a To-Do item over here. Runs on EVERY
    //     pull, never on demand; best-effort, so a bad subtree can never fail the git cycle.
    onPhase?.("folding in what your other computers pushed");
    await reconcileMirroredRepos(root).catch((e) =>
      log.warn("pin", `${tag} storage ${id}: reconciling mirrored repos failed: ${(e as Error).message}`),
    );
  }

  // 2. WRITE/UPDATE this device's own file (self-owned). Runs even without a backbone so the local file
  //    stays current and is ready to travel the moment the user turns Git on.
  try {
    writeSelfDevice(root);
  } catch (e) {
    log.warn("pin", `${tag} writeSelfDevice for storage ${id} failed: ${(e as Error).message}`);
  }

  // 3. COMMIT + PUSH this device's own SDL text (skips an empty commit; non-fast-forward retry inside).
  if (gitBackbone) {
    await gitBackbone.commitAndPush(result, onPhase).catch((e) => {
      result.problem = `Git push failed: ${(e as Error).message}`;
    });
    if (result.problem) reportGitProblem(`${tag} `, id, gitRemote?.remote ?? null, result);
    else if (result.pushed) log.info("pin", `${tag} storage ${id} git: pushed SDL text to remote`);
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
  warnOnDuplicateBackbones(ids);
  await runPool(ids, PIN_CONCURRENCY, async (id) => {
    try {
      await ensureDeviceRegistered(id);
    } catch (e) {
      log.error("pin", `device registration for storage ${id} failed: ${(e as Error).message}`);
    }
  });
}

/**
 * Two storages on THIS computer whose git backbones push to the SAME remote fight each other on every
 * single cycle: both write `devices/<self>.yaml` for the same device, both commit, and each push makes the
 * other's non-fast-forward. The retries mostly win it back, but the cycles they lose are exactly the
 * "sometimes it just doesn't pull and push" the user sees — and no message anywhere said why.
 *
 * We do NOT pick one and disable the other: which clone is the real one is the user's call, and quietly
 * dropping a configured storage would be worse than the churn. We name it, every pass, so it is visible in
 * the fault trail and in a debug export.
 */
function warnOnDuplicateBackbones(ids: string[]): void {
  const byRemote = new Map<string, string[]>();
  for (const id of ids) {
    let remote: string | null = null;
    try {
      remote = getGitBackboneRemote(id)?.remote ?? null;
    } catch {
      continue; // a storage we cannot resolve is reported elsewhere (the NO SILENT NULLS warnings)
    }
    if (!remote) continue;
    // Group by the URL the working copy actually pushes to — two different local clone paths of one
    // GitHub repo are the collision; two storages that merely share a path prefix are not.
    let url = remote;
    try {
      const found = fs.existsSync(path.join(expandHome(remote), ".git"))
        ? readGitRemoteUrl(expandHome(remote))
        : null;
      if (found) url = found;
    } catch {
      /* keep the raw remote as the key */
    }
    const list = byRemote.get(url) ?? [];
    list.push(id);
    byRemote.set(url, list);
  }
  for (const [url, list] of byRemote) {
    if (list.length < 2) continue;
    log.warn(
      "pin",
      `${list.length} storages on this computer share the git backbone ${url} (${list.join(", ")}) — ` +
        `they write the same device file and push to the same branch, so they will keep rejecting each ` +
        `other's pushes and losing cycles. Keep ONE of them and remove the others.`,
    );
  }
}

/** The `origin` URL of a working copy, or null. Sync + cheap — this runs once per device pass. */
function readGitRemoteUrl(dir: string): string | null {
  try {
    return (
      execFileSync(stableGitBin(), ["-C", dir, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** Pin one storage without letting a per-storage fault throw the pass. */
function pinStorageSafe(id: string, onPhase?: PhaseNote): Promise<void> {
  return pinStorageUnit(id, onPhase).catch((e) =>
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
    const storageIds = safeStorageIds();
    // REGISTER THE PASS (webapp.mdx §12 source B). This is the longest-running IPFS work the app does — the
    // 15-minute scheduled pass, the session catch-up, and the remainder after a manual Pin now all land here
    // — and it was the one piece of work that showed NOTHING in the dock. Bytes moved for minutes while the
    // app looked idle, which is indistinguishable from a sync that has stopped. One card, ticking per unit.
    // NOT "all units". The dock renders "Pinning <target>", and a user whose repo is literally NAMED `all`
    // then reads "Pinning all units" next to "Pinning all" and cannot tell the whole-computer pass from the
    // one repo — it reads as the same job listed twice. The label has to be a phrase no repo name can
    // collide with (webapp.mdx §12).
    await track("pin", "every repo and storage on this computer", async (report) => {
      let done = 0;
      const total = repos.length + 1 + storageIds.length; // repos + the computer unit + directory storages
      const tick = (): void => report({ done: ++done, total, unit: "units" });
      report({ done, total, unit: "units" });
      // "3 / 12 units" says how far the pass is, never WHICH unit is holding it up — and on a pass that
      // takes minutes per repo that is the only question worth asking. The note names the units in flight.
      const note = new WorkNote(report);
      // A THUNK, not a promise: a unit's own first phase line ("waiting for the git cycle already running
      // on this storage") is reported SYNCHRONOUSLY as it starts, so the item has to be on the line before
      // the work is called — an argument would evaluate the other way round and drop that first line.
      const unit = <T,>(key: string, label: string, work: () => Promise<T>): Promise<T> => {
        note.start(key, label);
        return work().finally(() => {
          note.finish(key);
          tick();
        });
      };
      await runPool(repos, PIN_CONCURRENCY, (f) => unit(`repo:${f}`, f, () => pinRepoSafe(f)));
      // The computer unit is part of the full pass too (storage.mdx §8).
      await unit("computer", "files outside any repo", () =>
        pinComputerUnit().catch((e) => log.error("pin", `pin computer unit failed: ${(e as Error).message}`)),
      );
      // Directory-based storages (personal/company/community) are units too: pin each through this
      // computer's device graft (devices.mdx §4) so its mapped-dir files resolve to the right local paths.
      // Bounded by the same limiter; per-storage failure is contained.
      await runPool(storageIds, PIN_CONCURRENCY, (id) =>
        unit(
          `storage:${id}`,
          `storage ${id}`,
          // The git half of a storage pass (fetch → merge → commit → push) IS "pulling changes down", and it
          // is where a slow pass usually sits. Its steps land as this unit's detail.
          () => pinStorageSafe(id, (t) => note.detail(`storage:${id}`, t)),
        ),
      );
      // Materialize each storage's ENABLED backing locations (storage_settings.mdx §6) — create-if-missing
      // + ensure .lfbridge/. Bounded by the same limiter as units; per-storage failure is contained so it
      // never throws the pass. Not a unit, so it does not tick.
      note.phase("checking each storage's backing locations");
      await runPool(storageIds, PIN_CONCURRENCY, ensureBackingSafe);
    });
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
    // CANONICAL keys (knowledge/ipfs.mdx §5.1) so a same-block pin in another base is not read as "missing"
    // and needlessly re-pulled. Callers MUST test membership as `pinset.has(ipfs.canonicalCid(cid))`.
    return new Set((await ipfs.listPins()).map((p) => ipfs.canonicalCid(p.cid)));
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
    manifest = readRepoTrackingManifest(repoRoot); // Local-Storage manifest (reconciled from the sync repo)
  } catch (e) {
    log.warn("pin", `missingPinnedFromPeers: cannot read committed manifest for ${repoRoot}: ${(e as Error).message}`);
    return [];
  }
  const pinset = await pinnedCidSet();
  const selfLabel = computerLabel();
  const out: MissingPinnedFile[] = [];
  for (const entry of manifest.files) {
    if (!entry.cid) continue; // no CID → nothing to pull
    // Confined: this list is what the pull-down popup ACTS on, so a key that does not land inside the repo
    // must never become an offer. Dropping it here is also what keeps it out of `pullMissing` below.
    const abs = joinRelConfined(repoRoot, entry.path);
    if (abs === null) {
      log.warn("pin", `missingPinnedFromPeers: ${repoRoot}: manifest entry "${entry.path}" is not inside the repo — ignored`);
      continue;
    }
    if (pinset.has(ipfs.canonicalCid(entry.cid))) continue; // pinned on this node → this computer really holds it
    // ON DISK BUT NOT PINNED HERE IS STILL A PULL-DOWN. This used to `continue` on `fs.existsSync(abs)`, which
    // made the repo metric and the CLI answer two different numbers for one question: the CLI's `pull_down`
    // (files-query.service.ts) counts `decision === "sync" && pinnedHere === false` as well, so on 2026-08-10
    // the Tower's CLI said 11 and its API said 10 — and the API's number UNDERCOUNTED the real gap. A file
    // whose bytes are here but whose CID was never pinned into this node is NOT a second copy: drop the IPFS
    // node and it is gone, and no peer can fetch it from us. `pullMissing`'s local-bytes fast path pins exactly
    // this case in place with no network, so listing it here is also actionable, not just honest.
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
  opts: { compress?: boolean; by?: string | null; label?: string } = {},
): Promise<{ pulled: number; failed: number; errors: string[] }> {
  // A PULL IS THE LONGEST-RUNNING THING A USER EVER WATCHES, and it had NO progress registration at all.
  // The interactive pull showed only the browser's optimistic card (a spinner, no counts, no phase) and the
  // three BACKGROUND callers — auto-sync-in, pull-retry, and the To Do apply — showed literally nothing:
  // bytes moved for minutes while the app looked idle. Registering here rather than at each call site is
  // deliberate — the job then exists no matter which of the four entry points started it.
  return track("pin", opts.label ?? path.basename(repoRoot), (report) =>
    pullMissingInner(repoRoot, checkedPaths, opts, report),
  );
}

/**
 * The bookkeeping every SUCCESSFUL pull owes, whatever route the bytes took (fetched over IPFS, or already
 * on disk and pinned in place). Best-effort throughout (repo_tracking_scheme.mdx §3.2/§4) — a sidecar,
 * history, or compress-queue failure must never turn a pull that worked into a pull that reports failure.
 */
function recordPullTracking(
  repoRoot: string,
  rel: string,
  abs: string,
  entry: ManifestFile,
  by: string | null,
  compress: boolean,
): void {
  try {
    appendFileEvent(repoRoot, rel, { kind: "pull", by }); // on_device defaults to this computer
    appendFileEvent(repoRoot, rel, { kind: "ipfs_pin", by, cid: entry.cid });
    appendHistory(repoRoot, {
      verb: "PULL",
      by,
      fields: { cid: entry.cid ?? "", size: entry.size },
      summary: `Pulled ${path.basename(rel)} down over IPFS`,
    });
  } catch (e) {
    log.warn("pin", `pullMissing: tracking write skipped for ${rel}: ${(e as Error).message}`);
  }
  // Optional compress axis (§10.8.12 B/C): the bytes are on disk now, so hand the file to the background
  // compress queue. Only images/videos compress; anything else is left as-is. Recoverable "trash"
  // disposition (compression.mdx §8 default) so an original is never hard-deleted here.
  if (!compress) return;
  const kind = mediaKindForName(path.basename(rel));
  const mediaKind = kind === "image" ? "image" : kind === "video" ? "video" : null;
  if (!mediaKind) return;
  try {
    enqueue([{ op: "compress", path: abs, overwrite: false, compress: { deleteOriginal: "trash", mediaKind } }]);
  } catch (e) {
    log.warn("pin", `pullMissing: could not enqueue compress for ${rel}: ${(e as Error).message}`);
  }
}

async function pullMissingInner(
  repoRoot: string,
  checkedPaths: string[],
  opts: { compress?: boolean; by?: string | null },
  report: PinReport,
): Promise<{ pulled: number; failed: number; errors: string[] }> {
  const note = new WorkNote(report);
  // Determinate from the first paint: the user checked N files and every one of them ticks exactly once,
  // whether it lands or fails.
  let settled = 0;
  const tick = (): void => report({ done: ++settled, total: checkedPaths.length, unit: "files" });
  report({ done: 0, total: checkedPaths.length, unit: "files" });
  note.phase("reading this repo's file list");
  let manifest: Manifest;
  try {
    // The SAME manifest `missingPinnedFromPeers` built the list from (storage_company.mdx §8.6). This read
    // `readCommittedManifest` — the SDL-only `<root>/manifest.yaml` — which for a WORKING repo does not
    // exist, so every CID lookup missed and every checked file in the batch failed. A pull action must never
    // read a different manifest than the list it is acting on.
    manifest = readRepoTrackingManifest(repoRoot);
  } catch (e) {
    log.warn("pin", `pullMissing: cannot read tracking manifest for ${repoRoot}: ${(e as Error).message}`);
    return { pulled: 0, failed: checkedPaths.length, errors: [(e as Error).message] };
  }
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  note.phase("reading this computer's pin list");
  const pinset = await pinnedCidSet();
  note.phase("");
  const by = opts.by ?? null;
  let pulled = 0;
  let failed = 0;
  const errors: string[] = []; // first few per-file failure reasons — the route surfaces these to the popup
  let healed = false; // any wrapper-directory CID rewritten below → persist the manifest afterwards

  // Bounded fan-out through the same global IPFS limiter the pin pass uses, so many pulls don't stampede
  // the daemon. Each file's failure is contained; one bad CID never fails the rest.
  await Promise.all(
    checkedPaths.map((rel) =>
      ipfsLimiter.run(async () => {
        note.start(rel, `pulling ${path.basename(rel)}`);
        const entry = byPath.get(rel);
        if (!entry || !entry.cid) {
          failed++;
          if (errors.length < 3) errors.push(`${rel}: no manifest CID`);
          log.warn("pin", `pullMissing: no manifest CID for ${rel} in ${repoRoot} — skipping`);
          return;
        }
        // Confined — this is the call that WRITES the bytes (`catToFile` mkdir -p's and streams to disk), and
        // `entry.path` came off a shared, git-merged manifest. `checkedPaths` normally arrives from
        // `missingPinnedFromPeers` (already confined), but the route accepts a caller-supplied list, so the
        // check belongs where the write happens rather than only where the offer was built.
        const abs = joinRelConfined(repoRoot, entry.path);
        if (abs === null) {
          failed++;
          if (errors.length < 3) errors.push(`${rel}: not inside this repo`);
          log.warn("pin", `pullMissing: refusing ${rel} in ${repoRoot} — the manifest key does not resolve inside the repo`);
          return;
        }
        try {
          // ── LOCAL-BYTES FAST PATH ──────────────────────────────────────────────────────────────────
          // "Pull down" does NOT always mean "fetch bytes we don't have". A file whose bytes are already
          // on this disk but whose CID was never pinned INTO this node counts as pull-down too (a decided
          // sync file with pinnedHere=false — files-query.service.ts). Sending that file through the DHT
          // is wrong twice over: the network round trip is pointless, and when the peer that first pinned
          // it is offline the provider pre-flight below FAILS it — so a file sitting right there on disk
          // reports "no computer is currently providing this file" and the metric never drains. Observed
          // 2026-08-10: 30 such files on Bryan_Laptop, every one already on disk, stuck for a week.
          //
          // Adding the LOCAL bytes pins them (Kubo `add` pins recursively) with no network at all. When the
          // resulting CID differs from the manifest's — two add profiles over identical content — that is
          // recorded as a CID equivalence, exactly as the regular pin pass's adopt path does, so the pair is
          // never re-added on the next run.
          if (fs.existsSync(abs) && !pinset.has(ipfs.canonicalCid(entry.cid))) {
            note.detail(rel, "the bytes are already here — pinning locally");
            const localCid = await ipfs.addFile(abs);
            pinset.add(ipfs.canonicalCid(localCid));
            pinset.add(ipfs.canonicalCid(entry.cid));
            if (ipfs.canonicalCid(localCid) !== ipfs.canonicalCid(entry.cid)) {
              noteCidEquivalence(entry.cid, localCid);
            }
            pulled++;
            log.info("pin", `Pinned ${rel} in place (bytes already on disk) <- ${localCid}`);
            recordPullTracking(repoRoot, rel, abs, entry, by, !!opts.compress);
            return;
          }
          // Same wrapper-directory self-heal as the pin pass's fetch-missing: unwrap a legacy directory CID
          // to the file inside it BEFORE pinning or cat-ing, and record the corrected CID (written back to
          // the tracking manifest after the fan-out) so the dead CID is never retried again.
          const fileCid = await ipfs.resolveFileCid(entry.cid, path.basename(entry.path));
          if (fileCid !== entry.cid) {
            log.info("pin", `pullMissing: healed wrapper-directory CID for ${rel}: ${entry.cid} -> ${fileCid}`);
            entry.cid = fileCid;
            healed = true;
          }
          if (!pinset.has(ipfs.canonicalCid(entry.cid))) {
            // PRE-FLIGHT (warnings.mdx §10.8.12 C): is any computer actually providing these bytes right
            // now? The only holder is often a laptop that is asleep/offline — without this check the
            // pin/add below wedges for its full 3 × 10-minute stall budget per file while the user watches
            // a metric that "never updates". A clean zero-provider answer fails the file in seconds with a
            // message that names the peer; an inconclusive probe (null) proceeds — absence of evidence
            // from a quick DHT query must never block a pull that would have worked.
            note.detail(rel, "looking for a computer that has it");
            const avail = await ipfs.hasProvider(entry.cid);
            if (avail === false) {
              const holder = entry.pinned_by.find((d) => d !== computerLabel()) ?? "the computer holding it";
              throw new Error(
                `no computer is currently providing this file — ${holder} looks offline. Bring it online and try again.`,
              );
            }
            // Tight interactive IDLE budget (2 min × 2 attempts): a user is watching this pull. A transfer
            // that is MOVING keeps resetting the guard (never cut off); one that goes quiet for 2 minutes
            // mid-flight is dead and fails fast.
            //
            // DISCOVERY IS NOT IDLENESS and gets its own 6 minutes. The 2-minute number was being applied to
            // the phase BEFORE any byte exists — Kubo walking the DHT and dialling a NAT'd peer through a
            // relay, reporting `Progress:0` the whole way — so a pull with a perfectly good provider was
            // hung up on at 2:00 and again at 4:00, and the user was told "the transfer never started" when
            // in truth we never let it. Observed live on 2026-08-05: 13 files aborted in two bursts, the
            // daemon logging `context canceled` for every one of them.
            try {
              // Kubo reports only the DAG-node count while a fetch runs; `approxFetchedBytes` turns it into
              // the "≈310 MB of 734 MB (42%)" reading, marked approximate because that is what it is.
              note.detail(rel, "waiting for the transfer to start");
              await ipfs.pinAdd(entry.cid, {
                stallMs: 2 * 60_000,
                discoveryMs: 6 * 60_000,
                attempts: 2,
                onNodes: (n) =>
                  note.detailLazy(rel, () =>
                    bytesDetail(ipfs.approxFetchedBytes(n, entry.size), entry.size, true),
                  ),
              });
            } catch (e) {
              if (/abort|stall/i.test((e as Error).message ?? "") || (e as Error).name === "AbortError") {
                const holder = entry.pinned_by.find((d) => d !== computerLabel()) ?? "the computer holding it";
                throw new Error(
                  `the transfer never started — ${holder} looks offline. Bring it online and try again.`,
                );
              }
              throw e;
            }
            pinset.add(ipfs.canonicalCid(entry.cid));
          }
          if (!fs.existsSync(abs)) {
            // Already unwrapped above — don't pay `resolveFileCid` a second time per file.
            await ipfs.catToFile(entry.cid, abs, {
              resolved: true,
              onBytes: (b) => note.detailLazy(rel, () => `writing to disk · ${bytesDetail(b, entry.size)}`),
            }); // the pinned bytes → the working tree
          }
          pulled++;
          log.info("pin", `Pulled ${rel} <- ${entry.cid} (added by ${entry.pinned_by.find((d) => d !== computerLabel()) ?? "a peer"})`);
        } catch (e) {
          failed++;
          if (errors.length < 3) errors.push(`${path.basename(rel)}: ${(e as Error).message}`);
          log.warn("pin", `pullMissing: pull failed for ${rel} (${entry.cid}): ${(e as Error).message}`);
          return;
        }

        recordPullTracking(repoRoot, rel, abs, entry, by, !!opts.compress);
      }).finally(() => {
        note.finish(rel);
        tick(); // every exit path counts — the bar must reach its total even on an all-failed batch
      }),
    ),
  );

  // Persist any healed CIDs. Best-effort: a manifest write failure must not fail an otherwise-good pull —
  // the bytes are already on disk; the worst case is that the heal is redone on the next pull.
  if (healed) {
    try {
      note.phase("saving the corrected file list");
      writeRepoTrackingManifest(repoRoot, manifest);
    } catch (e) {
      log.warn("pin", `pullMissing: could not persist healed CIDs for ${repoRoot}: ${(e as Error).message}`);
    }
  }

  log.info("pin", `pullMissing ${path.basename(repoRoot)}: pulled ${pulled}, failed ${failed} (compress=${Boolean(opts.compress)}).`);
  return { pulled, failed, errors };
}

