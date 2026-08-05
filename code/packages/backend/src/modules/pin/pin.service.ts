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
import { ManifestSchema, UnitStatusSchema, mediaKindForName, type Manifest, type ManifestFile, type UnitStatus, type Decision, type PinCounts, type MissingPinnedFile } from "@lfb/shared";
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
import { getStoragePinned, readMappedDirsForRoot, getGitBackboneRemote } from "../storage/storage-settings.service.js";
import { GitBackbone, type GitCycleResult } from "../git/git.service.js";
import { stableGitBin } from "../git/git-bin.js";
import { withStorageGitLock } from "../git/git-lock.js";
// The sync-repo mirror: send (mirrorToSyncRepo, via writeRepoTrackingManifest), receive (reconcile), and the
// per-entry merge that keeps a peer's pin claim alive (storage_company.mdx §8.4.2/§8.4.3/§8.6).
import {
  ensureSyncRepoMarker,
  reconcileFromSyncRepo,
  reconcileMirroredRepos,
  mergeManifests,
} from "../storage/tracking-sync.service.js";
import { recordDecision } from "../storage/decisions.service.js";
import { appendFileEvent, readSidecar } from "../storage/file-sidecar.service.js";
import { appendHistory } from "../storage/history-log.service.js";
import { enqueue } from "../jobqueue/jobqueue.service.js";
import { track } from "../progress/progress.registry.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { joinRel, healWindowsPath } from "../../shared/rel-path.js";
import { noteCidEquivalence, pinsetHasContent } from "./cid-equivalence.service.js";
import { classifyAbsent } from "./orphans.service.js";
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
  return { eligible: 0, added: 0, pinned: 0, fetched: 0, skipped: 0, failed: 0, missing: 0, orphaned: 0, staled: 0 };
}

/** How a tracked pin run reports what it is doing, so the dock shows real counts, not a bare spinner. */
export type PinReport = (p: { done?: number; total?: number; unit?: string }) => void;

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
  //
  // CANONICAL membership (knowledge/ipfs.mdx §5.1): the pinset is keyed by CANONICAL (CIDv1 base32) CIDs so a
  // block pinned as `Qm…` is not invisible to a `bafy…` manifest CID for the SAME block — `pin ls` is
  // base-sensitive, so a raw string Set silently missed those. Always test membership as
  // `pinset.has(ipfs.canonicalCid(cid))`.
  let pinset: Set<string>;
  try {
    pinset = new Set((await ipfs.listPins()).map((p) => ipfs.canonicalCid(p.cid)));
  } catch (e) {
    // A failed/timed-out `pin ls` must NEVER be read as "nothing is pinned" — an empty pinset here makes
    // every previously-pinned file look pin-lost and re-uploads the whole unit. Skip this pass instead;
    // the next scheduled pass retries with a healthy daemon.
    markUnitError(t, `pin ls failed — skipping pin pass: ${(e as Error).message}`);
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

  // Decided files with NO bytes here, gathered during the add phase and classified after it (below): either
  // never-here (a second computer's pull-down offer) or gone-from-a-computer-that-held-them (a delete).
  const absentHere: string[] = [];

  await Promise.all(
    toAdd.map(([rel]) =>
      ipfsLimiter.run(async () => {
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
          const already = await ipfs.contentPinnedCid(abs);
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
          const cid = await ipfs.addFile(abs); // add streams the bytes and pins recursively (pin=true)
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
      }).finally(tick), // every exit path counts, so the bar reaches its total even on an all-no-op pass
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
    await Promise.all(
      fetchTargets.map((entry) =>
        ipfsLimiter.run(async () => {
          if (!entry.cid) return;
          const abs = t.resolveAbs(entry.path);
          if (abs === null) return;
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
              if ((await ipfs.hasProvider(entry.cid)) === false) {
                counts.failed++;
                log.warn("pin", `fetch skipped for ${entry.path}: no computer is currently providing it (holder offline?)`);
                return;
              }
              await ipfs.pinAdd(entry.cid); // hold a local copy first…
              pinset.add(ipfs.canonicalCid(entry.cid));
              counts.pinned++;
            }
            await ipfs.catToFile(entry.cid, abs); // …then write the bytes to the resolved local path
            counts.fetched++;
            log.info("pin", `Fetched ${entry.path} -> ${abs} (${entry.cid})`);
          } catch (e) {
            counts.failed++;
            log.warn("pin", `fetch failed for ${entry.path}: ${(e as Error).message}`);
          }
        }).finally(tick),
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

  t.writeStatus({ ...t.status, last_pin_at: new Date().toISOString(), last_error: null, orphans });
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
export async function pinRepoFolder(
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
  ensureSyncRepoMarker(repoPath, cfg.repo.remote ?? null, cfg.sync_repo?.enabled);
  reconcileFromSyncRepo(repoPath);
  // §8.6 — the two manifests must not disagree. The reconcile lands in Local Storage; the One-Repo file rows
  // read the UNIT manifest, so fold the peer's entries across before the pass rather than leaving a
  // Pull-down count that no row can explain.
  const unitManifest = mergeManifests(getRepoManifest(folder), readRepoTrackingManifest(repoPath));
  return runUnitPin(
    {
      kind: "repo",
      name: folder,
      label: computerLabel(),
      decisions: cfg.decisions,
      fetchMissing: cfg.pin.fetch_missing,
      // joinRel, not path.join: a manifest key is POSIX (repo__list_syns.mdx §6.1), and this is the
      // function that decides WHERE a fetched file's bytes are written. `path.join(root, 'a\\b.mp4')` on
      // macOS/Linux writes one file literally named `a\b.mp4` at the repo root — the 2026-08-04 defect.
      resolveAbs: (rel) => joinRel(repoPath, rel),
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
  return joinRel(root, key); // pre-mapped-dir model: the file lives under the SDL root
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
export function pinStorageUnit(id: string): Promise<void> {
  return withStorageGitLock(id, () => pinStorageUnitInner(id));
}

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
    await gitBackbone.pull(gitResult).catch((e) => {
      gitResult.problem = `Git pull failed: ${(e as Error).message}`;
    });
    reportGitProblem("", id, gitRemote?.remote ?? null, gitResult);
    // Fold in what the pull delivered (storage_company.mdx §8.4.3: reconcile runs on EVERY backbone pull,
    // not just the git-only cycle). Without this a full pin pass fetches the SDL's text and drops the
    // `repos/<repoUid>/` subtrees on the floor for that cycle — the peer's file stays invisible until some
    // later pass happens to be the other kind.
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
      manifest: readCommittedManifest(root), // <root>/manifest.yaml — an SDL has no .lfbridge/ (§0.4)
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
export function syncStorageText(id: string): Promise<GitCycleResult> {
  // `undefined` = collapsed into an already-queued pass on this storage's lock (git-lock.ts) — that pass
  // runs the same pull→reconcile→commit→push cycle and reports its own problems. Callers read `.problem`
  // off this result (backbone-freshness, sync-trigger), so never let the collapse hand them undefined.
  return withStorageGitLock(id, () => syncStorageTextInner(id, "sync")).then((r) => r ?? { ran: true });
}

async function syncStorageTextInner(id: string, tag: string): Promise<GitCycleResult> {
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
    await gitBackbone.pull(result).catch((e) => {
      result.problem = `Git pull failed: ${(e as Error).message}`;
    });
    reportGitProblem(`${tag} `, id, gitRemote?.remote ?? null, result);
    // 1b. FOLD IN what the pull just delivered (storage_company.mdx §8.4.3). Every `repos/<repoUid>/` subtree
    //     another of the user's computers pushed is merged into this machine's Local Storage — which is what
    //     turns "the Tower pinned a file" into a row, a metric, and a To-Do item over here. Runs on EVERY
    //     pull, never on demand; best-effort, so a bad subtree can never fail the git cycle.
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
    await gitBackbone.commitAndPush(result).catch((e) => {
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
    const storageIds = safeStorageIds();
    // REGISTER THE PASS (webapp.mdx §12 source B). This is the longest-running IPFS work the app does — the
    // 15-minute scheduled pass, the session catch-up, and the remainder after a manual Pin now all land here
    // — and it was the one piece of work that showed NOTHING in the dock. Bytes moved for minutes while the
    // app looked idle, which is indistinguishable from a sync that has stopped. One card, ticking per unit.
    await track("pin", "all units", async (report) => {
      let done = 0;
      const total = repos.length + 1 + storageIds.length; // repos + the computer unit + directory storages
      const tick = (): void => report({ done: ++done, total, unit: "units" });
      report({ done, total, unit: "units" });
      await runPool(repos, PIN_CONCURRENCY, (f) => pinRepoSafe(f).finally(tick));
      // The computer unit is part of the full pass too (storage.mdx §8).
      await pinComputerUnit()
        .catch((e) => log.error("pin", `pin computer unit failed: ${(e as Error).message}`))
        .finally(tick);
      // Directory-based storages (personal/company/community) are units too: pin each through this
      // computer's device graft (devices.mdx §4) so its mapped-dir files resolve to the right local paths.
      // Bounded by the same limiter; per-storage failure is contained.
      await runPool(storageIds, PIN_CONCURRENCY, (id) => pinStorageSafe(id).finally(tick));
      // Materialize each storage's ENABLED backing locations (storage_settings.mdx §6) — create-if-missing
      // + ensure .lfbridge/. Bounded by the same limiter as units; per-storage failure is contained so it
      // never throws the pass. Not a unit, so it does not tick.
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
    const abs = path.join(repoRoot, entry.path);
    if (fs.existsSync(abs)) continue; // already on disk here → not missing
    if (pinset.has(ipfs.canonicalCid(entry.cid))) continue; // already pinned on this node → bytes are here
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
): Promise<{ pulled: number; failed: number; errors: string[] }> {
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
  const pinset = await pinnedCidSet();
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
        const entry = byPath.get(rel);
        if (!entry || !entry.cid) {
          failed++;
          if (errors.length < 3) errors.push(`${rel}: no manifest CID`);
          log.warn("pin", `pullMissing: no manifest CID for ${rel} in ${repoRoot} — skipping`);
          return;
        }
        const abs = path.join(repoRoot, entry.path);
        try {
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
            const avail = await ipfs.hasProvider(entry.cid);
            if (avail === false) {
              const holder = entry.pinned_by.find((d) => d !== computerLabel()) ?? "the computer holding it";
              throw new Error(
                `no computer is currently providing this file — ${holder} looks offline. Bring it online and try again.`,
              );
            }
            // Tight interactive stall budget (2 min idle × 2 attempts): a user is watching this pull. A
            // transfer that is MOVING keeps resetting the guard (never cut off); one with zero bytes for
            // 2 minutes — a stale DHT provider record for an offline laptop that slipped past the
            // pre-flight — fails in ~4 minutes instead of the background pass's 30.
            try {
              await ipfs.pinAdd(entry.cid, { stallMs: 2 * 60_000, attempts: 2 }); // fetch + hold locally (no re-add)
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
            await ipfs.catToFile(entry.cid, abs); // write the pinned bytes to the working tree (a real copy)
          }
          pulled++;
          log.info("pin", `Pulled ${rel} <- ${entry.cid} (added by ${entry.pinned_by.find((d) => d !== computerLabel()) ?? "a peer"})`);
        } catch (e) {
          failed++;
          if (errors.length < 3) errors.push(`${path.basename(rel)}: ${(e as Error).message}`);
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

  // Persist any healed CIDs. Best-effort: a manifest write failure must not fail an otherwise-good pull —
  // the bytes are already on disk; the worst case is that the heal is redone on the next pull.
  if (healed) {
    try {
      writeRepoTrackingManifest(repoRoot, manifest);
    } catch (e) {
      log.warn("pin", `pullMissing: could not persist healed CIDs for ${repoRoot}: ${(e as Error).message}`);
    }
  }

  log.info("pin", `pullMissing ${path.basename(repoRoot)}: pulled ${pulled}, failed ${failed} (compress=${Boolean(opts.compress)}).`);
  return { pulled, failed, errors };
}

