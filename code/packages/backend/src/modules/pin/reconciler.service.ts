// THE RECONCILER — make the three records of "do we have this file" agree.
//
// A tracked file is described in three independent places, and nothing was checking them against each
// other as a set:
//
//   1. the MANIFEST's `pinned_by` — who claims to hold the bytes;
//   2. the IPFS PINSET — what this node actually holds;
//   3. the WORKING TREE — what is actually on disk.
//
// Every pass we already run tends one edge of that triangle. `runUnitPin` re-derives our own claim from the
// pinset, but only for a repo with `pinned: true`. `healSelfPinClaims` covers the opt-out case, but only
// the claim axis. `missingPinnedFromPeers` reads the gap but never repairs it. Nothing looked at all three
// together, so a file could sit indefinitely claimed-but-absent, on-disk-but-unpinned, or pinned under a
// CID that is not a file at all — and every surface downstream (Pull down, the pin icon, Not backed up)
// reported that stale state as fact.
//
// IT VALIDATES RECORDS; IT DOES NOT MOVE BYTES. Nothing here adds a file to IPFS, fetches one, or writes
// one back to the working tree — those already have owners (`runUnitPin`'s add/fetch-missing, the
// pull-retry pass, auto-sync-in), and a second mover would race them for the same files under a different
// set of rules. The only outward call this pass makes is `add --only-hash`, which computes what a local
// file's CID WOULD be without storing a block or creating a pin: a read, used to recognise bytes we already
// hold under a CID no string comparison can reach.
//
// So a disagreement it cannot settle by editing a record is REPORTED, not acted on. "On disk but not
// pinned" ends as a dropped claim plus a file the pin pass will pick up; it does not end with this pass
// pinning it.
//
// WHAT IT WILL NOT DO. Two invariants are stronger than "make the records agree", and this pass yields to
// both:
//
//   • A PEER'S CLAIM IS NOT OURS TO EDIT. We can verify exactly one computer's bytes — this one. Every
//     write below touches our own label and nothing else. An entry only disappears when the LAST claim on
//     it was ours and we just proved it false.
//   • A DELETE MUST STILL MEAN SOMETHING (decisions.mdx §12). "Pinned here but not on disk" is the exact
//     signature of a user deleting a synced file, and restoring it from our own pin is the surprise
//     re-pinning §12 forbids. `orphans.service.ts` owns that judgement, holds a grace period, and this pass
//     leaves every path it is holding strictly alone.
//
// PERIODIC AND IN-PROCESS. A plain re-arming timer, like `startAutoSyncIn` — no OS scheduler, no service
// install, nothing for the user to set up. The due time is persisted for the same reason pull-retry
// persists its own (a restart must resume the wait, not reset it: restarting is what a person does when
// they are trying to make a stuck transfer move, and a reset schedule means a long pass NEVER runs).
import fs from "node:fs";
import path from "node:path";
import type { Manifest, ManifestFile } from "@lfb/shared";
import { computerLabel } from "../store-model/config.service.js";
import {
  listRepoFolders,
  getRepoConfig,
  getRepoManifest,
  writeRepoManifest,
  repoBumpTopics,
} from "../store-model/units.service.js";
import { readRepoTrackingManifest, writeRepoTrackingManifest } from "./manifest.service.js";
import { mergeManifests } from "../storage/tracking-sync.service.js";
import { reconcile as reconcileDecisionEnum } from "../storage/decisions.service.js";
import { pinnedCidSet, setPinClaim, type PinReport } from "./pin.service.js";
import { dropCidEquivalence, equivalenceKeys, pinsetHasContent } from "./cid-equivalence.service.js";
import { noteSupersededCid } from "./superseded-cids.service.js";
import { recordCidCorrection } from "./cid-correction.js";
import { withUnitLock, unitLockBusy } from "./unit-lock.js";
import { bumpTopics } from "../events/state-events.service.js";
import { joinRelConfined } from "../../shared/rel-path.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { expandHome } from "../../shared/home-path.js";
import { track } from "../progress/progress.registry.js";
import { WorkNote, yieldToLoop } from "../progress/work-note.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { log } from "../../shared/logging.js";

/** Every 6 hours. Long on purpose: this repairs slow-moving drift, and it competes with real transfers. */
const RECONCILE_MS = Number(process.env.LFB_RECONCILE_MS) || 6 * 60 * 60 * 1000;

/** Never at boot. The daemon this pass interrogates is usually still coming up, and a pass that reads a
 *  half-started node reads an incomplete pinset — which is the one input that must never be guessed. */
const BOOT_DELAY_MS = Number(process.env.LFB_RECONCILE_BOOT_MS) || 5 * 60_000;

/** Wrapper-CID probes per repo per pass. Each is a network round trip on a CID we cannot resolve locally,
 *  and a repo full of them would spend the whole pass proving the same thing over and over. */
const MAX_CID_PROBES = Number(process.env.LFB_RECONCILE_CID_PROBES) || 25;

/** Equivalence pairs re-examined per pass (see `auditCidEquivalences`). One `files/stat` each. */
const MAX_EQUIVALENCE_AUDIT = Number(process.env.LFB_RECONCILE_EQUIV_AUDIT) || 200;

/** …and a SHORT cap on each of those, because the audit's question is only ever answerable from blocks we
 *  already hold. A CID whose node is not here reads as "cannot say", which is the safe answer anyway — so
 *  waiting the full RPC timeout for it would just make the pass long for no extra knowledge. */
const EQUIVALENCE_STAT_MS = Number(process.env.LFB_RECONCILE_EQUIV_STAT_MS) || 5_000;

export interface ReconcileCounts {
  /** Manifest entries examined. */
  checked: number;
  /** Our own `pinned_by` claim removed — we do not hold these bytes and the file is not here. */
  claimsDropped: number;
  /** Our own claim added — we DO hold the bytes and had not said so. */
  claimsAdded: number;
  /** Our own claim LEFT ALONE because this pass could not settle whether we hold the bytes (see STEP 2). */
  claimsUnverified: number;
  /** Entries deleted outright: our dropped claim was the last one on them. */
  entriesRemoved: number;
  /** A recorded CID that is not a file was replaced with one that is. */
  cidsHealed: number;
  /** Same bytes, different add profile → recorded as equivalent rather than re-probed forever. */
  equivalences: number;
  /** Recorded CIDs that are not files and cannot be resolved here — reported, never guessed at. */
  unresolvableCids: number;
  /** Frozen `decisions:` enum entries re-projected from the ledger. */
  decisionsFixed: number;
  /** Entries whose check threw. Never fatal — the next pass tries again. */
  failed: number;
}

const zero = (): ReconcileCounts => ({
  checked: 0,
  claimsDropped: 0,
  claimsAdded: 0,
  claimsUnverified: 0,
  entriesRemoved: 0,
  cidsHealed: 0,
  equivalences: 0,
  unresolvableCids: 0,
  decisionsFixed: 0,
  failed: 0,
});

function add(a: ReconcileCounts, b: ReconcileCounts): ReconcileCounts {
  const out = zero();
  for (const k of Object.keys(out) as Array<keyof ReconcileCounts>) out[k] = a[k] + b[k];
  return out;
}

/** True when this pass changed anything worth telling an open page about. `claimsUnverified` is NOT one:
 *  leaving a record exactly as we found it is the absence of a change, and counting it would rewrite both
 *  manifests (and commit them) every pass on any repo big enough to exhaust the probe budget. */
function changed(c: ReconcileCounts): boolean {
  return c.claimsDropped + c.claimsAdded + c.entriesRemoved + c.cidsHealed + c.equivalences > 0;
}

// ── The schedule, as a durable fact ───────────────────────────────────────────

interface ReconcileState {
  lastRunAt: string | null;
  lastCounts: ReconcileCounts | null;
}

function stateFile(): string {
  return path.join(resolveStateDir(), "reconciler-state.json");
}

function readState(): ReconcileState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object") return parsed as ReconcileState;
  } catch {
    // absent or unparseable — "never run" is the right reading either way
  }
  return { lastRunAt: null, lastCounts: null };
}

function writeState(next: ReconcileState): void {
  try {
    const file = stateFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    // Losing this costs one reset wait, never a repair.
    log.debug("pin", `recording reconcile schedule failed: ${(e as Error).message}`);
  }
}

/** How long to wait before the next run: the REMAINDER of the interval already served, floored at the boot
 *  delay so a restart loop can never turn this into a hot loop. */
export function nextReconcileDelayMs(now = Date.now(), lastRunAt = readState().lastRunAt): number {
  const last = typeof lastRunAt === "string" ? Date.parse(lastRunAt) : NaN;
  if (!Number.isFinite(last)) return BOOT_DELAY_MS;
  return Math.max(BOOT_DELAY_MS, RECONCILE_MS - (now - last));
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Whether a pass is in flight right now. */
export function reconcilerRunning(): boolean {
  return running;
}

/** Arm the periodic reconciler. Idempotent; safe to call at boot. Nothing to install, nothing to configure. */
export function startReconciler(): void {
  if (timer) return;
  const waitMs = nextReconcileDelayMs();
  timer = setTimeout(() => {
    timer = null;
    void runReconcile()
      .catch((e) => log.warn("pin", `reconcile pass failed: ${(e as Error).message}`))
      .finally(() => startReconciler());
  }, waitMs);
  timer.unref?.(); // a background timer must never hold the process open at shutdown
  log.info("pin", `reconciler armed (${Math.round(waitMs / 60_000)} min)`);
}

/** TEST-ONLY: disarm, so a suite does not leave a timer behind. */
export function stopReconciler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

// ── One entry's verdict ───────────────────────────────────────────────────────

/**
 * Repair ONE manifest entry in place. Returns the counts it moved; mutates `entry` and reports whether the
 * entry should be dropped from the manifest entirely.
 *
 * `pinset` gains any equivalence discovered here, so a later entry over the same bytes is not re-probed.
 */
async function reconcileEntry(
  entry: ManifestFile,
  ctx: {
    repoRoot: string;
    label: string;
    pinset: Set<string>;
    decisions: Record<string, string>;
    probes: { left: number };
    note: WorkNote;
  },
): Promise<{ counts: ReconcileCounts; drop: boolean }> {
  const counts = zero();
  const { repoRoot, label, pinset, decisions, note } = ctx;
  counts.checked = 1;

  // A key that does not land inside the repo is not placeable on this computer — the same known-but-absent
  // answer the pull path gives. Never write through it.
  const abs = joinRelConfined(repoRoot, entry.path);
  if (abs === null) return { counts, drop: false };

  const onDisk = fs.existsSync(abs);
  const claimed = entry.pinned_by.includes(label);
  const heldHere = entry.cid ? pinsetHasContent(pinset, entry.cid) : false;
  const decidedSync = decisions[entry.path] === "sync";

  // ── An entry with no CID says nothing about any of the three records. It is only actionable when it is
  //    also unclaimed and absent, at which point it is a row that can never resolve to anything.
  if (!entry.cid) {
    if (!onDisk && entry.pinned_by.length === 0) {
      counts.entriesRemoved = 1;
      return { counts, drop: true };
    }
    return { counts, drop: false };
  }

  // ── STEP 1 · DO WE ACTUALLY HOLD THESE BYTES? `pinsetHasContent` settles the encoding axis and any pair
  //    we have already recorded. It cannot settle the DAG-PROFILE axis — different add flags are a
  //    different multihash, and no string trick bridges that (§5.1 Layer 2) — so when the file is right
  //    here and looks unpinned, re-hash it under the profiles Kubo realistically produces and see whether
  //    one of THOSE is in the pinset. `add --only-hash` stores nothing and pins nothing; it is a read.
  //    Bounded per repo because it reads the whole file.
  let held = heldHere;
  // Did we actually ESTABLISH the answer? "Not in the pinset" is only half of it while the file is sitting
  // right there and the probe that would settle it did not run — see the claim rule below.
  let heldKnown = true;
  if (!held && onDisk) {
    if (ctx.probes.left <= 0) {
      heldKnown = false; // out of budget this pass; the file is here and we never looked
    } else {
      ctx.probes.left--;
      try {
        note.detail(entry.path, "checking whether these bytes are already pinned here");
        const found = await ipfs.contentPinnedCidDetailed(abs, pinset);
        if (found) {
          // WHICH RECORD IS WRONG decides which repair travels, and `recordCidCorrection` owns that one
          // decision for all three callers that reach it (cid-correction.ts). A wrapper DIRECTORY is
          // replaced here — on the one computer that holds the bytes, that is the single repair that
          // reaches the others; a second add profile leaves the fleet's record exactly as written.
          const verdict = await recordCidCorrection(entry.cid, found.cid, { path: entry.path });
          if (verdict === "superseded") {
            entry.cid = found.cid;
            counts.cidsHealed = 1;
          } else if (verdict === "equivalent") {
            counts.equivalences = 1;
          }
          pinset.add(ipfs.canonicalCid(found.cid));
          held = true;
        }
      } catch (e) {
        // The probe is how we know; a probe that threw leaves us not knowing, which is NOT the same as
        // "these bytes are not here". Recorded as unknown so the claim rule below leaves the record alone.
        heldKnown = false;
        log.debug("pin", `reconcile: content probe failed for ${entry.path}: ${(e as Error).message}`);
      }
    }
  }

  // ── STEP 2 · OUR CLAIM MUST EQUAL THE PINSET, IN BOTH DIRECTIONS. `pinned_by` means "this computer has
  //    these bytes pinned" and nothing else — not "the file is here", not "we intend to". A claim we cannot
  //    back tells a teammate a second copy exists when it does not; a pin we hold but never claimed tells
  //    them the opposite. This is the same rule `runUnitPin` applies, extended to every unit and both ways.
  //
  //    ONLY ON A SETTLED ANSWER, THOUGH. Dropping a claim is a WRITE to the shared manifest, and the pin
  //    pass re-adds it the moment its own (unbudgeted) adopt path recognises the bytes — so a claim dropped
  //    on "we did not check" is not a correction, it is one half of a loop. Measured on the live `all` repo:
  //    three entries alternating `pinned_by: []` / `[bryan-mac-pro]` across consecutive backbone commits,
  //    all day. Adding a claim needs no such caution: `held` is only ever true because we saw the pin.
  if (claimed !== held && (held || heldKnown)) {
    setPinClaim(entry, label, held);
    if (held) counts.claimsAdded = 1;
    else counts.claimsDropped = 1;
  } else if (claimed && !held && !heldKnown) {
    counts.claimsUnverified = 1;
  }

  // ── STEP 3 · AN ENTRY NOBODY CLAIMS AND NO ONE HAS. Only reachable by having just disproved OUR OWN last
  //    claim: nobody says they hold these bytes and no copy is here, so the row asserts nothing. Union
  //    merge makes being wrong recoverable — a peer that still holds it re-contributes the entry on its
  //    next mirror, which is exactly the confirmation we lacked.
  if (counts.claimsDropped === 1 && !onDisk && entry.pinned_by.length === 0) {
    counts.entriesRemoved = 1;
    return { counts, drop: true };
  }

  // ── STEP 4 · IS THE RECORDED CID EVEN A FILE? A wrapper-directory CID (§5.1 Layer 0) can never be
  //    `cat`-ed by any computer in the fleet, so the entry is unusable for everyone until it is corrected.
  //    Two corrections are possible WITHOUT moving bytes: unwrap it to the file inside, or — when the probe
  //    above found our own pin of these bytes — adopt that CID. Neither is available for a wrapper whose
  //    interior nodes are gone; that one is reported, because a guess here would write a CID nobody has.
  if (!held && !onDisk && decidedSync && ctx.probes.left > 0) {
    ctx.probes.left--;
    try {
      if ((await ipfs.dagNodeType(entry.cid)) === "directory") {
        const fileCid = await ipfs.resolveFileCid(entry.cid, path.basename(entry.path));
        if (ipfs.canonicalCid(fileCid) !== ipfs.canonicalCid(entry.cid)) {
          noteSupersededCid(entry.cid, fileCid); // proven by the walk, so the merge may rely on it
          entry.cid = fileCid;
          counts.cidsHealed = 1;
        }
      }
    } catch (e) {
      counts.unresolvableCids = 1;
      log.info(
        "pin",
        `reconcile: ${entry.path} records a CID that is not a file and cannot be unwrapped here (${(e as Error).message}) — it needs re-adding on a computer that holds the bytes`,
      );
    }
  }

  return { counts, drop: false };
}

// ── One repo ─────────────────────────────────────────────────────────────────

/**
 * Reconcile one repo's manifests against this node's pinset and working tree.
 *
 * Takes the SAME unit lock the pin pass takes. Both write the manifest wholesale from a snapshot taken at
 * entry, so running them concurrently would mean the loser's repairs are silently dropped and re-derived
 * next pass — the exact defect `unit-lock.ts` exists to prevent.
 */
export async function reconcileRepo(folder: string, report?: PinReport): Promise<ReconcileCounts> {
  const key = `repo:${folder}`;
  if (unitLockBusy(key)) report?.({ note: "waiting for the sync pass already running on this repo" });
  return withUnitLock(key, () => reconcileRepoInner(folder, report));
}

async function reconcileRepoInner(folder: string, report?: PinReport): Promise<ReconcileCounts> {
  const note = new WorkNote(report ?? (() => {}));
  const label = computerLabel();
  let cfg: ReturnType<typeof getRepoConfig>;
  try {
    cfg = getRepoConfig(folder);
  } catch (e) {
    log.warn("pin", `reconcile: skipped ${folder}: ${(e as Error).message}`);
    return zero();
  }
  const repoRoot = expandHome(cfg.repo.path);
  if (!repoRoot || !fs.existsSync(repoRoot)) return zero(); // an unmounted drive is not drift

  // THE ONE INPUT THAT MUST NEVER BE GUESSED. An unreachable node answers `null`, not "nothing is pinned" —
  // and with an empty pinset every rule above fires the wrong way: every claim reads false, every file
  // reads unpinned. A pass that cannot see the pinset does nothing at all.
  note.phase("reading this computer's pin list");
  const pinset = await pinnedCidSet();
  if (!pinset) {
    log.warn("pin", `reconcile: ${folder} skipped — IPFS could not list pins (pin state unknown, not empty)`);
    return zero();
  }

  note.phase("reading the file lists");
  await yieldToLoop();
  let manifest: Manifest;
  try {
    // Both records at once (storage_company.mdx §8.6). Reconciling one and leaving the other is how a
    // Pull-down count with no row to explain it happens, so the merged document is what we repair and both
    // copies are what we write.
    //
    // NO `selfLabel` HERE, deliberately — this is the fold of two LOCAL documents the merge's own docstring
    // carves out. Passing it would strip our own claims on the way in, and a claim this pass cannot SEE is
    // one it cannot count, disprove, or discover was the last one on an entry. Every self-claim that
    // survives this fold is then verified against the pinset below, which is the whole job.
    manifest = mergeManifests(getRepoManifest(folder), readRepoTrackingManifest(repoRoot));
  } catch (e) {
    log.warn("pin", `reconcile: ${folder} manifests unreadable: ${(e as Error).message}`);
    return zero();
  }

  const ctx = {
    repoRoot,
    label,
    pinset,
    decisions: cfg.decisions as Record<string, string>,
    probes: { left: MAX_CID_PROBES },
    note,
  };

  // THE OTHER RECORD ON THIS REPO. The machine-local frozen `decisions:` enum is a PROJECTION of the shared
  // ledger (decisions.mdx), and every read path — the pull-retry's `pendingFor`, the file rows, the tiles —
  // trusts the projection rather than re-folding. Drift there is the same class of defect as a stale pin
  // claim: a record asserting something no longer true. Re-projecting is idempotent and already owns its
  // own rules, so this pass calls it rather than re-deriving.
  let decisionsFixed = 0;
  try {
    note.phase("checking the decisions match the shared ledger");
    decisionsFixed = (await reconcileDecisionEnum(folder)).changed.length;
  } catch (e) {
    log.warn("pin", `reconcile: ${folder} decision projection failed: ${(e as Error).message}`);
  }

  const kept: ManifestFile[] = [];
  let counts = zero();
  let done = 0;
  report?.({ done: 0, total: manifest.files.length, unit: "files" });
  for (const entry of manifest.files) {
    note.start(entry.path, path.basename(entry.path));
    try {
      const r = await reconcileEntry(entry, ctx);
      counts = add(counts, r.counts);
      if (!r.drop) kept.push(entry);
    } catch (e) {
      counts.failed++;
      kept.push(entry); // a rule that threw must never be the reason an entry disappears
      log.warn("pin", `reconcile: ${folder}/${entry.path} failed: ${(e as Error).message}`);
    } finally {
      note.finish(entry.path);
      report?.({ done: ++done, total: manifest.files.length, unit: "files" });
    }
    if (done % 200 === 0) await yieldToLoop(); // the classification is sync — keep the poll served
  }

  counts.decisionsFixed = decisionsFixed;
  if (!changed(counts) && decisionsFixed === 0) {
    log.info("pin", `reconcile ${folder}: ${counts.checked} file(s) checked, everything already agrees.`);
    return counts;
  }

  if (!changed(counts)) {
    bumpTopics(repoBumpTopics(folder)); // the decision projection moved; the manifests did not
    log.info("pin", `reconcile ${folder}: re-projected ${decisionsFixed} decision(s); the file lists already agreed.`);
    return counts;
  }

  note.phase("saving the corrected file lists");
  const next: Manifest = { ...manifest, generated_at: new Date().toISOString(), files: kept };
  try {
    writeRepoManifest(folder, next);
  } catch (e) {
    log.warn("pin", `reconcile: ${folder} unit manifest write failed: ${(e as Error).message}`);
  }
  try {
    writeRepoTrackingManifest(repoRoot, next);
  } catch (e) {
    log.warn("pin", `reconcile: ${folder} tracking manifest write failed: ${(e as Error).message}`);
  }
  bumpTopics(repoBumpTopics(folder));
  log.info(
    "pin",
    `reconcile ${folder}: ${counts.checked} checked — dropped ${counts.claimsDropped} claim(s), added ${counts.claimsAdded}, ` +
      `left ${counts.claimsUnverified} unverified, ` +
      `removed ${counts.entriesRemoved} entry(ies), healed ${counts.cidsHealed} CID(s), recorded ${counts.equivalences} ` +
      `equivalence(s), ${counts.unresolvableCids} CID(s) need re-adding elsewhere, re-projected ${counts.decisionsFixed} ` +
      `decision(s), ${counts.failed} failed.`,
  );
  return counts;
}

// ── The pass ─────────────────────────────────────────────────────────────────

/**
 * RE-EXAMINE WHAT THE EQUIVALENCE MAP CLAIMS, because a wrong pair there is permanent and silent.
 *
 * `pinsetHasContent` answers true through the map, and that answer satisfies every path that would ever
 * have looked at the recorded CID again — this pass's own probe first among them. So a pair recorded for a
 * CID that is not a file at all cannot be found by the code that repairs those; the machine holding it goes
 * on publishing a wrapper CID no computer can `cat`, while the peers that DID prove it keep correcting it
 * back. That is the charlie-kirk loop in one sentence (cid-correction.ts has the measurements), and it
 * outlives the fix that stops new pairs being written, because the bad pairs are already on disk.
 *
 * Dropping the pair is the whole repair: it re-opens the question, and the entry's next pass through
 * `reconcileEntry` answers it properly — with the walk `superseded_cids.yaml` demands. Nothing is invented
 * here, and a CID the node cannot describe is left exactly as it is.
 */
async function auditCidEquivalences(): Promise<number> {
  let dropped = 0;
  const all = equivalenceKeys();
  const keys = all.slice(0, MAX_EQUIVALENCE_AUDIT);
  // Never let a cap read as "all clear" (performance.mdx P-37): say what was left for the next pass.
  if (all.length > keys.length) {
    log.info("pin", `equivalence audit: checking ${keys.length} of ${all.length} pair(s) this pass`);
  }
  for (const key of keys) {
    try {
      if ((await ipfs.dagNodeType(key, EQUIVALENCE_STAT_MS)) !== "directory") continue;
      if (dropCidEquivalence(key)) {
        dropped++;
        log.info(
          "pin",
          `equivalence for ${key} dropped — it is a wrapper directory, not a second spelling of the file; ` +
            `the entries that record it will be corrected and the correction published`,
        );
      }
    } catch (e) {
      log.debug("pin", `equivalence audit skipped ${key}: ${(e as Error).message}`);
    }
  }
  return dropped;
}

/**
 * Reconcile every registered repo. Serial across repos on purpose: each one takes its unit lock and the
 * byte work inside shares the global transfer ceiling, so fanning out here would only queue deeper.
 */
export async function runReconcile(opts: { folders?: string[] } = {}): Promise<ReconcileCounts> {
  if (running) {
    log.info("pin", "reconcile: a pass is already running — skipping this tick");
    return zero();
  }
  running = true;
  let total = zero();
  try {
    const folders = opts.folders ?? listRepoFolders();
    if (folders.length === 0) return total;
    await track("pin", "checking your files match IPFS", async (report) => {
      let doneRepos = 0;
      report({ done: 0, total: folders.length, unit: "repos" });
      // BEFORE the repos, so a pair dropped here is re-answered by this same pass rather than in six hours.
      await auditCidEquivalences().catch((e) =>
        log.warn("pin", `reconcile: equivalence audit failed: ${(e as Error).message}`),
      );
      for (const folder of folders) {
        try {
          total = add(total, await reconcileRepo(folder, report));
        } catch (e) {
          log.warn("pin", `reconcile: ${folder} failed: ${(e as Error).message}`);
        } finally {
          report({ done: ++doneRepos, total: folders.length, unit: "repos" });
        }
      }
    });
  } finally {
    running = false;
    writeState({ lastRunAt: new Date().toISOString(), lastCounts: total });
  }
  return total;
}
