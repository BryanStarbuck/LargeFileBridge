// The ADDITIVE company/Personal SYNC-REPO mirror for a repo's Category-B tracking state
// (artifact_placement_policy.mdx §4-§5). Category B (`repo_storage.yaml`, `files/<rel>.yaml` sidecars,
// `history/<device>.txt`, `decisions.yaml`, `manifest.yaml`, compression records) is ALWAYS written to Local
// Storage `~/T/_large_files_bridge/repos/<repoKey>/` first (the authoritative working copy). When the owning
// company/Personal storage has a sync repo configured AND the per-repo toggle is on, that subtree is ALSO
// mirrored to `<syncRepo>/repos/<repoKey>/` so it travels between the user's computers — in addition to Local
// Storage, not instead of it. The storage's git backbone (backbone_resilience.mdx) commits + pushes the sync
// repo; this module only copies files into its working tree. Default OFF: absent the marker, every call here
// is a best-effort no-op. LOGS (launcher.log / log.log / error.err) live only in the state root and are NEVER
// under `repos/<repoKey>/`, so they are never mirrored (artifact_placement_policy.mdx §8).
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import YAML from "yaml";
import {
  RepoStorageDocSchema,
  DecisionPolicyDocSchema,
  type DecisionPolicyDoc,
  type Manifest,
  type ManifestFile,
} from "@lfb/shared";
import { repoStateDir, resolveStateSyncRepo, syncRepoMarkerPath, readSyncRepoMarker } from "./tracking-root.service.js";
// The fleet-deletion ledger merge (deletion.mdx §6). Imported from the pin module because the ledger's
// semantics — append-only, widest scope wins, absence never lifts — belong with the feature, not with the
// transport that happens to carry it.
import { readDeletions, serializeDeletions, mergeDeletions } from "../pin/deletions.service.js";
import { repoUidFor, repoSlugFor } from "./repo-identity.js";
import { namedKeyDir, isDirForKey } from "../../shared/store/keyed-dir.js";
// THIS computer's device label — the identity a manifest's `pinned_by` is keyed by. Both directions of
// the mirror hand it to `mergeManifests` so an arriving claim about US is never adopted (ipfs.mdx §1.1).
import { computerLabel } from "../store-model/config.service.js";
// The per-entry merge lives in a LEAF module so units.service can fold both manifests on the read path
// without dragging this service (and its storage.service dependency) into an import cycle.
import { mergeManifests, serializeManifest } from "./manifest-merge.js";
import { supersededCid } from "../pin/superseded-cids.service.js";
export { mergeManifests } from "./manifest-merge.js";
// The decision-ledger union merge is a LEAF for the same reason — the ledger, like the manifest, is
// SHARED state that must union, never last-writer-copy (decisions.mdx §5; the 2026-07-20 "not backed up:
// 22 here / 0 there" defect where wholesale ledger copies erased events the copy source didn't know).
import { unionLedgerEvents, parseLedgerBestEffort, serializeLedger, ledgerIsUnreadable } from "./ledger-merge.js";
import { resolveOwnerDedicatedRepo, syncRepoAdmitsRemote } from "./artifact-placement.service.js";
import { noteArtifactWritten } from "../pin/sync-trigger.service.js";
import { normalizeManifestPaths } from "../pin/manifest-normalize.js";
import { isStrayPathName, copyHealed, caseIndex, resolveCasing } from "./sidecar-heal.js";
// THE SYNC FENCE (database.mdx §2.2, migration 0012) — the only module in the app allowed to hold both a
// Postgres handle and a designated serializer. Importing it here does NOT give this file a database: every
// entry point is `dbEnabled()`-guarded and `tryDb`-wrapped, so on a machine with no Postgres — the default
// — both calls below return instantly and this module behaves exactly as it did before (R2).
import { recordSdlIngestForRepo, syncFenceBeforeMirror } from "./doc-render.service.js";

import { resolveStateDir } from "../../config/state-dir.js";
// The additive copy for the two shapes that had no merge: the per-file sidecars and the per-device history
// logs. Both directions route through it, so neither leg can stamp over the other side's events.
import { copyTrackedFile } from "./tracked-file-merge.js";
import { parseYamlHealingUnionDamage } from "./union-damage.js";
// The working-tree gate — a LEAF module (logging + path only), so no cycle with the git service.
import { deferWhileBusy, busyRootFor } from "../git/worktree-gate.js";
import { bumpTopics } from "../events/state-events.service.js";
import { log } from "../../shared/logging.js";
// Name this section in the event-loop stall report. Both legs of the mirror are SYNCHRONOUS walks over
// ~29,000 tracked files, which is what `loop-watch` used to report as an anonymous multi-second freeze
// (performance.mdx P-45/P-46).
import { blocking, recordCooperative } from "../../shared/blocking.js";

// Machine-local files under `repos/<repoKey>/` that must NOT travel to the sync repo.
//
// THE FOUR ADDITIONS BELOW WERE LIVE DATA-LOSS BUGS (database.mdx §2.1). This set and
// `MERGED_NEVER_COPIED` are applied by `copyTreeGen` ONLY at `rel === ""` (:196); everything else falls
// through to `fs.copyFileSync` in BOTH directions. All four of these documents sit at the tracking ROOT
// (`repoStateDir(root)` / `resolveTrackingRoot`), so they were in scope of the gate and simply were not
// named in it — which made them plain last-writer-wins copies between computers:
//
//   * `files.yaml` is MACHINE-LOCAL CONTENT sitting in a mirrored path. It is derived from THIS computer's
//     disk, so two computers holding different subsets overwrite each other on every cycle — the exact
//     ping-pong the `repo_storage.yaml` `counts:` scrub was written to stop (see :386-390 below).
//   * `decisions.conflicted.yaml` / `manifest.conflicted.yaml` are a quarantine of THIS machine's FAILED
//     merge (decisions.service.ts:78, manifest.service.ts:42). Their whole value is being the local
//     evidence of a local failure; a peer's copy overwriting ours destroys the only thing they are for.
//
// `decisions_policy.yaml` is deliberately NOT here — it is SHARED user intent and needs a merge, not a
// hold-out. It is in `MERGED_NEVER_COPIED` and folded by `mergePolicyInto`.
const LOCAL_ONLY = new Set([
  ".sync-repo",
  ".durable-artifact",
  ".lfbridge-moved", // migrate-repo-lfbridge-to-sync.ts LFBRIDGE_MOVED_LATCH — this computer's pending commit
  "files.yaml",
  "decisions.conflicted.yaml",
  "manifest.conflicted.yaml",
]);

/**
 * The SHARED documents that are MERGED in both directions and therefore never plain-copied in either.
 * Both legs of the mirror hold them out of the tree walk and hand them to `mergeManifestInto` /
 * `syncLedgerInto` instead — which is what lets the (expensive, multi-megabyte) merges be skipped
 * independently of the (cheap) tree copy when nothing has moved (performance.mdx P-45).
 *
 * `repo_storage.yaml` is the third merged-on-the-way-IN document and is listed in `reconcileFromSyncRepo`'s
 * own skip set; on the way OUT it is copied and then scrubbed of machine-local fields, so it stays here.
 */
const MERGED_NEVER_COPIED: ReadonlySet<string> = new Set([
  "manifest.yaml",
  "decisions.yaml",
  // The FLEET DELETION ledger (deletion.mdx §4, §6). Merged for a reason stronger than the others': a COPY
  // here is how a deleted file comes back. The mirror is shared, so a peer that has not yet seen a tombstone
  // pushes a ledger without it; last-writer-wins would erase the record on the way through and every device
  // would happily re-fetch the bytes on its next pass. `mergeDeletions` only ever ADDS — absence never lifts
  // a tombstone — which is precisely the invariant a copy cannot hold.
  "deletions.yaml",
  // SHARED user intent (decisions.mdx §9/§14): the per-repo default-decision mode plus attribution. It
  // used to fall through to `fs.copyFileSync` in both directions, so the last computer to mirror silently
  // imposed its policy on the fleet — and, worse, an OLDER policy arriving on the reconcile leg could
  // overwrite a NEWER local one, because a copy has no idea which is which. It is folded by
  // `mergePolicyInto` instead: newest `set_at` wins, ties by `set_by` lexical, which is a TOTAL ORDER, so
  // every computer converges on the same document without anyone having to mirror last (database.mdx §2.1).
  "decisions_policy.yaml",
  // `repo_storage.yaml` belongs here too, and did not use to. The mirror leg COPIED it and then rewrote it
  // in place to reset the machine-local fields — so the mirror's copy, which by construction can never
  // equal the local one (that is the entire point of the scrub), was stamped over and rewritten on EVERY
  // pass, forever. The bytes came out the same, so git never committed it and nothing was ever visibly
  // wrong; what it cost was two writes per repo per pass and a moved mtime, which is the identity every
  // memo in this module is keyed on. Projecting straight from the local file instead is one write, and it
  // converges (performance.mdx P-45).
  "repo_storage.yaml",
]);

/** The same set on the way IN — the reconcile leg merges `repo_storage.yaml` FIELD-WISE, because it must
 *  preserve THIS computer's own machine-local fields against the scrubbed copy arriving from the mirror. */
const RECONCILE_MERGED_NEVER_COPIED: ReadonlySet<string> = MERGED_NEVER_COPIED;

// Read-only views for sync-fence.spec.ts. Exported so a test can assert the gate's CONTENTS — removing a
// name from either set is a silent cross-computer data-loss regression, and the only way to catch it is to
// name the members (database.mdx §2.1).
export const LOCAL_ONLY_FOR_TEST: ReadonlySet<string> = LOCAL_ONLY;
export const MERGED_NEVER_COPIED_FOR_TEST: ReadonlySet<string> = MERGED_NEVER_COPIED;

/** Turn the per-repo sync-repo mirror ON (write the marker) or OFF (remove it). The marker is THREE lines —
 *  the owning storage's sync-repo absolute path, then this repo's `repoUid` (its machine-independent
 *  identity, storage_company.mdx §8.4.1), then its remote-derived `repoSlug` — because the mirror subtree is
 *  `<syncRepo>/repos/<repoSlug>-<repoUid>/` and a path-derived key would differ on every computer. The slug
 *  is naming only (artifact_placement_policy.mdx §3.1); the uid remains the identity. Called from the
 *  per-repo settings PATCH when the toggle flips (repo_settings.mdx) and from `ensureSyncRepoMarker()`.
 *  Best-effort; a marker write failure just leaves the repo Local-Storage-only. */
export function setSyncRepoMarker(repoRoot: string, syncRepoRoot: string | null, remote?: string | null): void {
  const marker = syncRepoMarkerPath(repoRoot);
  try {
    if (syncRepoRoot && syncRepoRoot.trim()) {
      const uid = repoUidFor(remote ?? null);
      const slug = repoSlugFor(remote ?? null);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${path.resolve(syncRepoRoot.trim())}\n${uid ?? ""}\n${slug ?? ""}\n`);
    } else {
      fs.rmSync(marker, { force: true });
    }
  } catch (e) {
    log.warn("storage", `setSyncRepoMarker(${repoRoot}) failed: ${(e as Error).message}`);
  }
}

/**
 * Make sure this repo's sync-repo marker reflects the CURRENT owning storage — the default-ON half of
 * storage_company.mdx §8.4.2. Called on the scan/pin path for every repo, so the mirror works out of the box
 * instead of waiting for a user to find a toggle.
 *
 * `enabled === false` is an explicit OPT-OUT and always wins (the toggle survives; it just changed polarity).
 * Otherwise we resolve the owning storage's sync repo from the repo's REMOTE ORG first, and write the marker
 * when — and only when — the repo has a remote to derive a shared identity from. No remote ⇒ no marker ⇒
 * Local-Storage-only, which is the honest answer: there is no key the user's other computers could agree on.
 *
 * `observedSyncRepo` is a sync repo the caller has DIRECT EVIDENCE holds this repo's subtree — the receive
 * path passes the sdl root it is standing in, having just matched `repos/<slug>-<uid>/` there. It is a
 * FALLBACK, not an override: owner config still wins when it resolves. What it changes is the `!target`
 * case, which used to DELETE the marker unconditionally. On the receive path that deletion is self-defeating
 * and permanent: `reconcileFromSyncRepo` reads the marker to find its source, so clearing it makes the fold
 * we were about to do impossible, and the outbound mirror stops with it. Owner resolution comes back null for
 * ordinary reasons — the storage is not mapped yet, the repo sits outside every mapped directory, the storage
 * root is not a git tree — and none of them are evidence that the peer state sitting in front of us is not
 * ours. A pull that can see the subtree must not be able to un-configure the repo that owns it.
 *
 * Returns the resolved sync-repo ROOT (not the per-repo subtree), or null when this repo does not mirror.
 */
export function ensureSyncRepoMarker(
  repoRoot: string,
  remote: string | null,
  enabled?: boolean,
  observedSyncRepo?: string | null,
): string | null {
  if (enabled === false) {
    setSyncRepoMarker(repoRoot, null);
    return null;
  }
  if (!repoUidFor(remote)) {
    // No parseable remote → nothing shared to key on. Clear any stale marker so we never mirror into a
    // subtree keyed by a value that cannot travel.
    if (readSyncRepoMarker(repoRoot)) setSyncRepoMarker(repoRoot, null);
    return null;
  }
  let target: string | null = null;
  try {
    target = resolveOwnerDedicatedRepo(repoRoot, remote);
  } catch (e) {
    log.warn("storage", `ensureSyncRepoMarker(${repoRoot}): owner resolve failed: ${(e as Error).message}`);
    return null;
  }
  const current = readSyncRepoMarker(repoRoot);
  const uid = repoUidFor(remote);
  const slug = repoSlugFor(remote);
  // Owner config first; the caller's observed sync repo only fills the gap it leaves behind.
  if (!target && observedSyncRepo && observedSyncRepo.trim()) target = path.resolve(observedSyncRepo.trim());
  // THE CONFIDENTIALITY FENCE (artifact_placement_policy.mdx §0.6): a company sync repo only ever receives a
  // repo whose remote org it claims — whichever branch above produced the target. Fails closed: no marker.
  if (target && !syncRepoAdmitsRemote(target, remote)) {
    log.error("storage", `ensureSyncRepoMarker(${repoRoot}): REFUSED ${target} — remote ${remote} is not claimed by that company`);
    target = null;
  }
  if (!target) {
    if (current) setSyncRepoMarker(repoRoot, null);
    return null;
  }
  // The slug is part of the comparison so a marker written by a build that predates §3.1 (two lines, no
  // slug) is upgraded on the very next scan pass rather than staying nameless forever.
  if (
    !current ||
    path.resolve(current.syncRepo) !== path.resolve(target) ||
    current.repoUid !== uid ||
    current.repoSlug !== slug
  ) {
    setSyncRepoMarker(repoRoot, target, remote);
    log.info(
      "storage",
      `repo ${repoRoot} mirrors tracking state to ${target}/repos/${namedKeyDir(slug, uid ?? "")}`,
    );
  }
  return target;
}

/** The Category-A content artifacts — see the skip in {@link copyTreeGen}. */
const CONTENT_ARTIFACT_RE = /\.(transcription|ai_description|ai_description_rejected|ocr)$/;
function isContentArtifactName(name: string): boolean {
  return CONTENT_ARTIFACT_RE.test(name);
}

/**
 * ONE walk, driven two ways — the fix for "the mirror is one uninterrupted synchronous stretch".
 *
 * The walk itself is unavoidable: the mirror is a RECONCILIATION to current state, not a queue of changes,
 * so it has to look at all ~29,000 tracked files across 105 repos to know which ones have not moved. The
 * memos (P-45) made each look cheap; they could not make the STRETCH interruptible, and an uninterrupted
 * stretch is precisely what the event loop cannot tolerate — while it runs, no HTTP response, no stream
 * chunk and no timer is served, which is what the user reports as "the pages are spinning".
 *
 * A generator solves it without forking the code. `copyTreeGen` yields once per entry; the SYNCHRONOUS
 * driver drains it in a tight loop (byte-for-byte the old behaviour, for the write-path callers that
 * cannot await), and the ASYNCHRONOUS driver drains it in time-boxed slices, handing the loop back between
 * them. Both drive the SAME code, so the two can never drift — which is the failure mode a hand-written
 * async copy of this function would have had.
 *
 * `rel` is the path SO FAR from the per-repo state-dir root, and it is the whole reason this signature is
 * not just `(src, dst)`: it is what lets `copyTrackedFile` recognise a `files/<rel>.yaml` sidecar or a
 * `history/<device>.txt` log and MERGE it instead of stamping over it (tracked-file-merge.ts). Every other
 * shape still gets the plain copy it always got.
 *
 * `skip` applies at the TOP level only — the shared documents that are merged rather than copied
 * (`MERGED_NEVER_COPIED`, and the reconcile leg's own set). Nested paths are never named in it.
 */
function* copyTreeGen(src: string, dst: string, rel: string, skip: ReadonlySet<string>): Generator<void, boolean, void> {
  let entries: fs.Dirent[];
  let changed = false;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return false;
  }
  fs.mkdirSync(dst, { recursive: true });
  // One listing of the destination, reused for every entry: a name that differs from an existing one ONLY
  // in case must reuse that established spelling, or a case-sensitive peer plants a second directory that
  // no Mac or Windows clone can hold apart from the first (sidecar-heal.ts, "case collisions").
  const dstCasing = caseIndex(dst);
  for (const e of entries) {
    if (rel === "" && (LOCAL_ONLY.has(e.name) || skip.has(e.name))) continue;
    const name = resolveCasing(dstCasing, e.name);
    const s = path.join(src, e.name);
    const d = path.join(dst, name);
    const childRel = rel === "" ? name : `${rel}/${name}`;
    try {
      // A `\` in the NAME is a whole relative path that lost its separators (§6.1b). Copying it verbatim
      // is what makes the bad spelling travel — and a `\` filename cannot be checked out on Windows at
      // all, so mirroring it breaks the clone for the machine that produced it. Heal it here instead.
      // The INGRESS direction matters just as much: this is the leg that put the strays back on this disk
      // two minutes after they were deleted, because a peer on an older build kept re-adding them.
      // Normalizing on arrival makes the bounce one-way — the peer can keep sending it, it stops here.
      if (e.isFile() && isStrayPathName(e.name)) {
        changed = copyHealed(s, dst, e.name) || changed;
        yield;
        continue;
      }
      if (e.isDirectory()) changed = (yield* copyTreeGen(s, d, childRel, NO_SKIP)) || changed;
      else if (e.isFile() && isContentArtifactName(e.name)) {
        // A Category-A artifact (.ocr / .transcription / .ai_description) written straight into the mirror
        // (artifact-placement.service.ts `workingRepoArtifactBase`). It already lives where it travels —
        // the company repo's own git carries it — and it is not tracking state, so it is never copied down
        // into Local Storage (thousands of duplicate files per repo) nor back up again.
      } else if (e.isFile()) changed = copyTrackedFile(s, d, childRel) || changed;
    } catch (err) {
      // Skip an unreadable/unwritable leaf; never fail the whole mirror — BUT make it observable. A file
      // that silently stops copying between the user's computers is the exact failure this module exists to
      // prevent, so a per-leaf copy failure must reach error.err (the top-level caller still returns true).
      // A SOURCE THAT VANISHED MID-WALK IS NOT A FAULT. `readdirSync` snapshots the directory, and the
      // fleet-deletion reaper (deletion.mdx §7.2 step 6) removes a deleted file's sidecars from this very
      // mirror — so a delete running alongside a mirror/reconcile legitimately races the walk. The entry is
      // simply gone, which is the outcome the copy was heading for anyway. Logged at DEBUG so it stays
      // visible without dressing a normal race as a warning the user should act on.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(s)) {
        log.debug("storage", `copyTree: source vanished mid-walk (deleted concurrently): ${s}`);
      } else {
        log.warn("storage", `copyTree: failed to copy ${s} -> ${d}: ${(err as Error).message}`);
      }
    }
    // ONE yield point per entry. The synchronous driver ignores it; the asynchronous one uses it to hand
    // the event loop back. Per-ENTRY rather than per-DIRECTORY on purpose: one repo here holds 20,062 of
    // the 29,287 sidecars, and most of them live under a single `files/` subtree — a per-directory yield
    // would leave that whole subtree as one unbroken stretch and buy nothing.
    yield;
  }
  return changed;
}

const NO_SKIP: ReadonlySet<string> = new Set<string>();

/** Drain the walk synchronously — identical behaviour to the recursive function this replaced. Used by the
 *  write-path callers (`writeRepoStorage` → `mirrorToSyncRepo`), which are synchronous top to bottom and
 *  cannot await anything (worktree-gate.ts's header explains why that call chain is shaped that way). */
function drainSync(gen: Generator<void, boolean, void>): boolean {
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/** How long one slice of an interruptible walk may hold the loop before handing it back. 8 ms is about
 *  half a 60 Hz frame: short enough that a request queued behind it is answered promptly, long enough that
 *  the `setImmediate` round-trips are a rounding error against ~59,000 entries. */
const SLICE_MS = Math.max(1, Number(process.env.LFB_WALK_SLICE_MS) || 8);

/** Hand the event loop back: run every already-queued I/O callback, timer and pending HTTP response, then
 *  resume. `setImmediate` (the check phase) rather than a promise microtask, which would NOT yield —
 *  microtasks drain before the loop ever advances, so `await Promise.resolve()` in a tight loop blocks
 *  exactly as hard as no await at all. This is the difference between an interruptible walk and a
 *  decorative one. */
const handBackTheLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Drain the walk in time-boxed slices, giving the event loop a turn between them. Used by every
 * ASYNCHRONOUS caller — the pin pass and the backbone's `reconcileMirroredRepos`, which is where the
 * multi-second stretches were actually being spent.
 *
 * The accumulated SYNCHRONOUS time is reported to the window tally through `recordCooperative`, which
 * never warns: 1.4 s taken in 8 ms slices is real CPU and belongs in the ranking, but it did not block
 * anything, and treating it like a stall would devalue the warnings that are one.
 */
async function drainYielding<T>(label: string, detail: string, gen: Generator<void, T, void>): Promise<T> {
  const began = performance.now();
  let handedBack = 0;
  let sliceStarted = performance.now();
  let step = gen.next();
  while (!step.done) {
    if (performance.now() - sliceStarted >= SLICE_MS) {
      const pausedAt = performance.now();
      await handBackTheLoop();
      handedBack += performance.now() - pausedAt;
      sliceStarted = performance.now();
    }
    step = gen.next();
  }
  recordCooperative(label, performance.now() - began - handedBack, detail);
  return step.value;
}

/** Recursively copy `src` → `dst`, skipping named top-level entries and the machine-local files.
 *  Best-effort. Both legs of the mirror reach the walk through this — the shared documents are MERGED and
 *  are named in `skip` (see `MERGED_NEVER_COPIED`), never copied. */
function copyTreeExcept(src: string, dst: string, skip: ReadonlySet<string>): boolean {
  return drainSync(copyTreeGen(src, dst, "", skip));
}

/**
 * Mirror this repo's Local-Storage Category-B subtree into the owning storage's sync repo at
 * `<syncRepo>/repos/<repoKey>/`, so it travels. No-op (returns false) when no sync repo is configured for the
 * repo, or when the sync-repo path is missing/unwritable (artifact_placement_policy.mdx §7.1: skip the mirror,
 * WARN, keep Local Storage authoritative — never fall back to the working repo). Called best-effort after a
 * Category-B write (e.g. from `writeRepoStorage`) and on demand.
 */
export function mirrorToSyncRepo(repoRoot: string): boolean {
  const key = path.resolve(repoRoot);
  // A pass is already draining for this repo. Mark it dirty and return: the drain re-runs once when it
  // finishes, which is the same coalescing `deferWhileBusy` does and for the same reason — the mirror is a
  // reconciliation to current state, never a queue of work items, so N writes want ONE more pass.
  const inFlight = mirrorInFlight.get(key);
  if (inFlight) {
    inFlight.again = true;
    return false;
  }
  return blocking("storage.mirror", () => driveMirrorBudgeted(key), key);
}

/**
 * Mirror NOW, on this thread, to completion — the deterministic twin of {@link mirrorToSyncRepo}.
 *
 * WHY BOTH EXIST. `mirrorToSyncRepo`'s budget is WALL-CLOCK, which makes its sync/async boundary a
 * property of how busy the machine is rather than of the work: the same small tree finishes inline on an
 * idle box and hands off on a loaded one. For production that is exactly right — the caller wants "get
 * this mirrored, don't hold my thread" and has no use for the boundary. For a CALLER THAT NEEDS THE
 * ANSWER it is not right at all, and the flakiness is not hypothetical: `mirror-cost.spec.ts` asserts on
 * the return value and on the mirror's contents immediately afterwards, and under a full-suite load a
 * different test failed on each run.
 *
 * So the choice is explicit instead of accidental. This is the same split the reconcile has already had
 * since P-47 — `reconcileFromSyncRepo` (sync, what the specs assert through) beside
 * `reconcileFromSyncRepoYielding` (interruptible, what production runs) — and it is safe for the same
 * reason: ONE generator backs both drivers, so the behaviour under test cannot drift from the behaviour
 * that ships. The interruptible driver has its own test ("the mirror hands the loop back past its
 * budget").
 */
export function mirrorToSyncRepoNow(repoRoot: string): boolean {
  const key = path.resolve(repoRoot);
  return blocking("storage.mirror", () => drainSync(mirrorGen(key)), key);
}

/** How long a mirror pass may hold the caller's thread before the REST of it is finished cooperatively.
 *
 *  The budget is what lets one entry point serve two very different callers without a second code path:
 *  a small tree (every test in this suite, a repo with a handful of sidecars) finishes inside the budget
 *  and behaves exactly as the old synchronous pass did, returning the real `changed` answer; the 3,649-
 *  sidecar repo on the reference machine spends 50 ms here and the remaining ~450 ms in 8 ms slices with
 *  the event loop handed back between them. 50 ms is chosen so the sync leg cannot be the reason a request
 *  misses a frame, while being long enough that the ordinary small pass never pays a `setImmediate`. */
const MIRROR_SYNC_BUDGET_MS = Math.max(1, Number(process.env.LFB_MIRROR_SYNC_BUDGET_MS) || 50);

/** Repos whose mirror is draining asynchronously right now. `again` records that a write arrived while the
 *  drain ran, so exactly one more pass follows it however many writes landed. */
const mirrorInFlight = new Map<string, { again: boolean }>();

/** TEST-ONLY: is a cooperative mirror drain still in flight? */
export function mirrorDrainsInFlight(): number {
  return mirrorInFlight.size;
}

/**
 * Drain `mirrorGen` on the caller's thread for at most {@link MIRROR_SYNC_BUDGET_MS}, then hand the
 * remainder to {@link finishMirrorCooperatively}. Returns the pass's real `changed` answer when it
 * completed here, and `false` when it was handed off — the continuation owns the announcement in that case
 * (it is made inside the generator), so a `false` here means "not decided yet", never "nothing changed".
 */
function driveMirrorBudgeted(key: string): boolean {
  const gen = mirrorGen(key);
  const began = performance.now();
  let step = gen.next();
  while (!step.done) {
    if (performance.now() - began >= MIRROR_SYNC_BUDGET_MS) {
      mirrorInFlight.set(key, { again: false });
      void finishMirrorCooperatively(key, gen);
      return false;
    }
    step = gen.next();
  }
  return step.value;
}

/**
 * Finish a mirror pass in 8 ms slices, RE-CHECKING THE WORKING-TREE GATE at every slice boundary.
 *
 * THE GATE CHECK IS THE WHOLE REASON THIS FUNCTION IS SHAPED LIKE THIS, and it is the "change to make
 * deliberately, with its own test" that performance.mdx P-47 declined to make speculatively. The mirror
 * writes INTO the sync repo's working tree, and `deferWhileBusy`'s check at the START of the pass was sound
 * only while the pass was atomic: an interruptible mirror can begin before a git cycle and still be writing
 * when one starts, which is the "Your local changes to the following files would be overwritten by merge"
 * abort that worktree-gate.ts exists to prevent. So the moment the destination goes busy, this pass is
 * ABANDONED mid-tree and re-armed through `deferWhileBusy`, which runs it again — whole — once the cycle
 * releases the tree.
 *
 * A half-mirrored tree is safe to abandon for two independent reasons: the mirror is a reconciliation, so
 * the re-run converges on the same result from wherever it stopped; and a cycle that finds LFB's own files
 * dirty COMMITS them as a checkpoint before merging (`checkpointOwnWrites`, and `repos/` is in
 * `SDL_ROOT_PAYLOAD`), so partial mirrored text is a checkpoint commit rather than a refused merge.
 *
 * Why this had to happen at all: `blocking` measured `storage.mirror` holding the event loop for 0.8 s
 * typically and 79 s at worst on the reference machine (131 WARNs in one day of `error.err`), while the
 * browser reported `PAGE STILL SPINNING … waiting on ["authInit"], ["securityConfig"]` for the same
 * windows. Nothing is answered while this walk runs — not a request, not a stream chunk, not a timer — so
 * every one of those seconds is a second of blank spinner in the tab. See performance.mdx P-53.
 */
async function finishMirrorCooperatively(key: string, gen: Generator<void, boolean, void>): Promise<void> {
  const dst = resolveStateSyncRepo(key);
  let synchronousMs = 0;
  try {
    let sliceStarted = performance.now();
    let step = gen.next();
    while (!step.done) {
      if (performance.now() - sliceStarted >= SLICE_MS) {
        synchronousMs += performance.now() - sliceStarted;
        await handBackTheLoop();
        if (dst && busyRootFor(dst)) {
          deferWhileBusy(dst, `mirror:${key}`, () => void mirrorToSyncRepo(key));
          log.info("storage", `mirrorToSyncRepo(${key}): ${dst} entered a git cycle mid-pass — re-armed for when it releases`);
          return;
        }
        sliceStarted = performance.now();
      }
      step = gen.next();
    }
    synchronousMs += performance.now() - sliceStarted;
  } catch (e) {
    log.warn("storage", `mirrorToSyncRepo(${key}): cooperative drain failed: ${(e as Error).message}`);
  } finally {
    // Cooperative time is ranked but NEVER warned (see `recordCooperative`): it is real CPU and belongs in
    // the window's report, and it blocked nothing.
    recordCooperative("storage.mirror", synchronousMs, key);
    const state = mirrorInFlight.get(key);
    mirrorInFlight.delete(key);
    if (state?.again) void mirrorToSyncRepo(key);
  }
}

// WHY THE MIRROR IS A BUDGETED PASS AND THE RECONCILE IS A PLAIN YIELDING ONE. The two directions are not
// symmetric, and the asymmetry is a safety one, not a taste one:
//
//   * The RECONCILE reads the sync repo and writes LOCAL STORAGE. Nothing it writes is inside a git working
//     tree, so a pass that spans several event-loop turns cannot collide with a git cycle. It is also
//     called from INSIDE the cycle (`reconcileMirroredRepos`, right after the pull), where the worktree
//     gate is already held on our behalf — so yielding there is if anything safer than not yielding.
//   * The MIRROR writes INTO the sync repo's working tree, so an interruptible pass has to keep asking
//     whether a cycle started while it was away. That is what `finishMirrorCooperatively` does at every
//     slice boundary, and abandoning the pass when the answer changes is what makes it safe.
//
// The claim that stood here before — "after P-45 the mirror is ~30 ms on the largest repo here anyway, so
// the pressure that motivated the reconcile's driver does not exist on this side" — was true of a settled
// fleet and false of this one. It measured a pass whose memos were warm; in production the memos were being
// invalidated on every cycle by the very git merge this mirror was announcing (see the `noteArtifactWritten`
// gate in `mirrorGen`), so the real pass was 0.8 s typical and 79 s at worst.

function* mirrorGen(repoRoot: string): Generator<void, boolean, void> {
  const dst = resolveStateSyncRepo(repoRoot);
  if (!dst) return false;
  // NEVER write into a working copy that git is mid-cycle in (worktree-gate.ts). This copy runs on the SCAN
  // path — synchronously, from `writeRepoStorage`, with no idea a backbone cycle is in flight — and landing
  // between that cycle's fetch and its merge is precisely what made git refuse the merge ("Your local
  // changes to the following files would be overwritten by merge: repos/<uid>/repo_storage.yaml"), aborting
  // the whole storage sync. Defer instead: the cycle runs this exact mirror the moment it releases the tree.
  // Keyed by repo, so N scans during one cycle collapse into ONE mirror at the end (the mirror is a
  // reconciliation to current state, never a queue of work items).
  if (deferWhileBusy(dst, `mirror:${path.resolve(repoRoot)}`, () => void mirrorToSyncRepo(repoRoot))) {
    log.info("storage", `mirrorToSyncRepo(${repoRoot}): ${dst} is mid-git-cycle — deferred until it releases`);
    return false;
  }
  // THE SYNC FENCE, BEFORE THE WALK (database.mdx §2.2/§2.3, migration 0012).
  //
  // This is the ONE place Postgres is allowed anywhere near the mirror, and it is deliberately in FRONT of
  // it rather than inside it: everything below this line still reads and writes FILES, exactly as before,
  // because `mirrorToSyncRepo` copies THE FILE and a query result cannot be copied (database.mdx §6.2).
  // What the fence does is make sure the file it is about to copy is current, and record what we hold — so
  // the mirror's own `sameBytes` short-circuits and `mirror-memo`'s identity check have something true to
  // fire against.
  //
  // FIRE AND FORGET, and it must be: this generator is drained SYNCHRONOUSLY by `drainSync` on the write
  // path (`writeRepoStorage` → here), which has no `await` to give — see the header of `drainSync` and
  // worktree-gate.ts. `syncFenceBeforeMirror` never throws (it is wrapped in `tryDb`) and answers instantly
  // with `dbEnabled() === false`, which is every machine that has never provisioned Postgres.
  //
  // IT DOES NOT WRITE ANYTHING TODAY. The render equality gate is non-zero on this corpus (15,868 of 29,136
  // sidecars, on `lfb.file.size_bytes` / `modified_at`), so `renderWritesArmed()` is off and the fence
  // records and reports rather than rendering into the mirror's source. §2.3: zero diffs, or the cutover
  // does not happen.
  void syncFenceBeforeMirror(repoRoot);
  try {
    const localStateDir = repoStateDir(repoRoot);
    const mirrorLedgerFile = path.join(dst, "decisions.yaml");
    const localLedgerFile = path.join(localStateDir, "decisions.yaml");
    const mirrorManifestFile = path.join(dst, "manifest.yaml");
    const localManifestFile = path.join(localStateDir, "manifest.yaml");

    // THE TWO SHARED DOCUMENTS ARE MERGED, NEVER COPIED — so they are held OUT of the tree copy entirely.
    //
    // They used to go through it: `copyTree` stamped this computer's copy over the mirror's, and the merge
    // legs below then put the union back. That worked, but it made the copy and the merge INSEPARABLE —
    // skipping the (expensive) merge would have left the plain overwrite standing, i.e. the wholesale
    // last-writer-wins erase this block exists to prevent. Excluding them here is what makes the merge legs
    // independently skippable, which is what the memo needs (performance.mdx P-45), and it is also simply
    // the truthful shape: `reconcileFromSyncRepo` has always excluded the same three names on the way in.
    //
    // The mirror's ledger may hold events THIS machine has not reconciled yet — a peer's push, or (two
    // clones of one remote share ONE `repos/<repoUid>/` subtree) the other clone's decisions — and the
    // manifest is the same kind of thing: SHARED state whose entries arrive from several computers.
    // Measured on the live `all` repo, back when the manifest WAS copied: commit a6cf284e6 deleted 6
    // entries and 13 pin claims one commit after the peer that owned them pushed them, and 8 commits in
    // that file's history dropped entries that way. `mergeManifests` has always documented "absence is
    // NEVER a delete"; the mirror simply never called it.
    // THE ANSWER IS THE POINT, not a by-product. Every leg below reports whether it changed the mirror's
    // bytes, and this pass must report the OR of them — see the `noteArtifactWritten` call at the end for
    // what a false "yes" costs.
    let changed = yield* copyTreeGen(localStateDir, dst, "", MERGED_NEVER_COPIED);
    // Between the walk and the two merges: each merge is ATOMIC (a multi-megabyte YAML parse cannot be
    // sliced), so the yields have to sit at the seams between them.
    yield;

    // Both legs pass `repoRoot` as the mirror guard: a destination that exists but will not parse is
    // REFUSED (and loudly reported) rather than replaced — see `refuseUnparseableMirror`.
    try {
      // THE MIRROR IS THE WIRE, so our own label is stripped from it here too. Without that the union
      // hands us back the very self-claim we may have just dropped locally, and no correction to this
      // computer's own claim could ever be published — it would be re-adopted on the way out.
      // `incomingIsWire` is the other half: every OTHER computer's claim passes through FROM the mirror
      // rather than being re-unioned from our copy, so this machine can never re-publish a peer's
      // withdrawn claim (manifest-merge.ts).
      changed = mergeManifestInto(JOB_MIRROR_MANIFEST, mirrorManifestFile, localManifestFile, mirrorManifestFile, repoRoot) || changed;
    } catch (e) {
      log.warn("storage", `mirrorToSyncRepo(${repoRoot}): manifest merge write failed: ${(e as Error).message}`);
    }
    try {
      // The deletion ledger, OUT to the mirror (deletion.mdx §4). A throw here leaves BOTH copies untouched:
      // an unreadable ledger must never be published over a good one.
      changed =
        mergeDeletionsInto(
          JOB_MIRROR_DELETIONS,
          path.join(dst, "deletions.yaml"),
          path.join(localStateDir, "deletions.yaml"),
          path.join(dst, "deletions.yaml"),
        ) || changed;
    } catch (e) {
      log.warn("storage", `mirrorToSyncRepo(${repoRoot}): deletions merge failed: ${(e as Error).message}`);
    }
    try {
      changed = syncLedgerInto(mirrorLedgerFile, localLedgerFile, JOB_MIRROR_LEDGER, repoRoot) || changed;
    } catch (e) {
      log.warn("storage", `mirrorToSyncRepo(${repoRoot}): ledger union write failed: ${(e as Error).message}`);
    }
    try {
      // The SHARED policy travels by FOLD, not copy (see `mergePolicyInto`). Same direction as the ledger:
      // local is the source, the mirror is the destination — but the rule is symmetric, so the reconcile
      // leg applying it in reverse converges on the same document rather than fighting this one.
      changed =
        mergePolicyInto(
          path.join(dst, "decisions_policy.yaml"),
          path.join(localStateDir, "decisions_policy.yaml"),
          JOB_MIRROR_POLICY,
        ) || changed;
    } catch (e) {
      log.warn("storage", `mirrorToSyncRepo(${repoRoot}): policy merge write failed: ${(e as Error).message}`);
    }
    // Announce the write so the owning SDL's git backbone commits + pushes it (storage_company.mdx §8.7).
    // Without this the mirrored text sits in the SDL's working tree until the 10-minute device worker
    // happens by — a decision the user just made would take minutes to reach their other computer, and
    // "it eventually shows up" is indistinguishable from "it is broken" while you are staring at the screen.
    // The trigger resolves the SDL by root prefix, and `dst` IS inside the SDL, so it lands correctly here
    // (the case it cannot resolve is a path inside a working repo — not this one).
    // Scrub the MACHINE-LOCAL fields from the MIRRORED repo_storage.yaml. `last_scan.at` re-stamps on EVERY
    // scan, and every backbone pull triggers scans — so mirroring it verbatim made each storage's
    // auto-commit re-dirty the other storage's sync repo in an endless last_scan ping-pong (the 2026-08-04
    // "two sync repos fighting" defect; same churn shape as backbone_resilience.mdx's device-file fix).
    // `counts:` is the SAME KIND OF FIELD and was missed: `refreshCounts` derives it from THIS computer's
    // file index, so two computers holding different subsets of a repo's big files each overwrote the
    // other's number on every cycle — a commit per repo per cycle, forever, from a value that was never
    // shared state to begin with. With both held at their schema defaults here, the mirror's bytes change
    // only when genuinely shared state (name, policy, enlist provenance) does.
    changed =
      projectRepoStorageToMirror(path.join(localStateDir, "repo_storage.yaml"), path.join(dst, "repo_storage.yaml")) ||
      changed;
    // ONLY ANNOUNCE A WRITE WHEN THERE WAS ONE (performance.mdx P-52).
    //
    // This call used to be unconditional, and the cost of that was the whole churn engine this module
    // spends its life defending against. `noteArtifactWritten` arms the owning SDL's git backbone on a
    // 20 s debounce, so a mirror pass that changed NOTHING still scheduled a fetch + merge for that
    // storage. The merge then rewrote the mirror's own files — same bytes, new inode and new mtime — which
    // is precisely the identity every memo in this module is keyed on (`sameBytes`'s equality memo,
    // `pairSettled`'s merge memo). So the next pass found every memo cold, re-read and re-merged all
    // 3,649 sidecars of the largest repo, announced again, and the loop closed: measured on the reference
    // machine as `storage.mirror` 104 calls a minute and stalls of 0.8 s typical / 79 s worst, while
    // nothing in the product had changed at all.
    //
    // `changed` is now the OR of every leg (the tree walk, the three merges, the repo_storage projection),
    // and every one of those already answers the precise question "did the destination's bytes move" —
    // `writeIfDifferent` and `copyTrackedFile`'s `sameBytes` short-circuit are what make that answer
    // trustworthy. A settled pass is therefore silent, which is what lets the memos stay warm.
    if (changed) noteArtifactWritten(dst, "tracking-state");
    return changed;
  } catch (e) {
    log.warn("storage", `mirrorToSyncRepo(${repoRoot}) failed (path missing/unwritable): ${(e as Error).message}`);
    return false;
  }
}

/**
 * Is this SHARED mirror document one we must refuse to touch? `unreadable` comes from the caller's OWN
 * parse (`readManifestChecked` / `ledgerIsUnreadable`), so this guard costs no extra read and — the point —
 * no extra `YAML.parse`.
 *
 * "Unreadable" means conflict markers, a truncated write, or text that is not the document at all. It does
 * NOT mean EMPTY: a valid `files: []` / `events: []` is the shape every freshly-created mirror subtree
 * starts in, and refusing to write into one would mean a new mirror could never be seeded.
 *
 * A file that really is unreadable is not ours to discard. It used to be discarded and then put back —
 * `copyTree` stamped our copy over it and a repair step restored the bytes — which worked but meant the
 * destroying copy and the merge could never be skipped independently. Now the merged documents are held
 * out of the tree copy entirely (see `MERGED_NEVER_COPIED`), so refusing here means the bytes were never
 * touched at all, and a human or the next git merge can settle it.
 */
function refuseUnparseableMirror(file: string, unreadable: boolean, repoRoot: string): boolean {
  if (!unreadable) return false;
  log.error(
    "storage",
    `mirrorToSyncRepo(${repoRoot}): ${file} exists but could not be parsed (conflict markers or corrupt) — ` +
      `left the mirror's own bytes untouched rather than overwriting them with this computer's copy. ` +
      `Resolve it in the sync repo; nothing from this machine was merged into it this pass.`,
  );
  return true;
}

/**
 * The `repo_storage.yaml` fields that describe THIS COMPUTER rather than the repo. They are reset to their
 * schema defaults in the mirror copy (so they never travel) and preserved from the local copy on reconcile
 * (so an arriving copy never blanks them here). Anything shared — `name`, `policy`, `enlisted` — is absent
 * from this list and travels normally.
 */
const MACHINE_LOCAL_REPO_STORAGE = ["last_scan", "counts"] as const;

/**
 * PROJECT the local `repo_storage.yaml` into the mirror with every {@link MACHINE_LOCAL_REPO_STORAGE} field
 * reset to its schema default, serialized exactly like `writeRepoStorage` (deterministic key order) so an
 * otherwise-unchanged doc is byte-stable across mirrors. Best-effort: an unparseable local file leaves the
 * mirror's copy alone.
 *
 * It reads the LOCAL file and writes the MIRROR one. It used to do both to the mirror's own copy — the tree
 * walk copied the file across and this rewrote it in place — and that arrangement could not converge by
 * construction: the mirror's copy is the scrubbed one, the local copy carries a live `last_scan`, so they
 * always differ, so the copy fired and this rewrote it, twice per repo per pass, forever. The bytes came
 * out identical either way (so git never committed anything and nothing looked wrong), but the mtime moved
 * every time — and the mtime is the identity every memo in this module is keyed on (performance.mdx P-45).
 */
function projectRepoStorageToMirror(localFile: string, mirrorFile: string): boolean {
  try {
    const parsed = RepoStorageDocSchema.safeParse(YAML.parse(fs.readFileSync(localFile, "utf8")) ?? {});
    if (!parsed.success) return false;
    const defaults = RepoStorageDocSchema.parse({ repo_storage: {} }).repo_storage;
    for (const key of MACHINE_LOCAL_REPO_STORAGE) {
      (parsed.data.repo_storage as Record<string, unknown>)[key] = (defaults as Record<string, unknown>)[key];
    }
    // Returns whether the mirror's bytes moved — the caller ORs it into the pass's answer, which is what
    // decides whether a git cycle is announced at all (see `mirrorGen`).
    return writeIfDifferent(mirrorFile, YAML.stringify(parsed.data, { sortMapEntries: true }));
  } catch {
    /* missing/unreadable local copy — nothing to project */
    return false;
  }
}

/** Read a file's text, or null when missing/unreadable — the best-effort read both ledger merges use. */
function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Read a manifest YAML best-effort; a missing/corrupt/half-merged file yields an empty manifest rather than
 *  throwing, so one bad copy never blocks the whole reconcile. */
function readManifestBestEffort(file: string, unit: Manifest["unit"]): Manifest {
  return readManifestChecked(file, unit).manifest;
}

/**
 * Did this manifest FAIL to parse, as opposed to parsing fine and holding no entries?
 *
 * `readManifestBestEffort` answers an EMPTY manifest to both questions, and the mirror's "refuse to
 * overwrite what we could not read" guard has to tell them apart: a valid `files: []` is the shape every
 * freshly-created mirror subtree starts in, and reading it as corrupt refuses to seed that mirror forever
 * while reporting a data-loss ERROR for a file that is perfectly fine (performance.mdx P-45).
 *
 * Absent or blank is NOT unreadable — there is nothing there to protect.
 */
function readManifestChecked(file: string, unit: Manifest["unit"]): { manifest: Manifest; unreadable: boolean } {
  const empty: Manifest = { schema_version: 1, unit, files: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { manifest: empty, unreadable: false }; // absent — nothing to protect, nothing to merge
  }
  if (!raw.trim()) return { manifest: empty, unreadable: false };
  try {
    if (raw.includes("<<<<<<<")) return { manifest: empty, unreadable: true }; // conflict markers — half-merged
    // Heal line-union damage before judging the document unreadable — `manifest.yaml` carries the same
    // `merge=union` attribute as the ledger and fails the same way (union-damage.ts).
    const parsed = parseYamlHealingUnionDamage(raw).doc as Partial<Manifest> | null;
    if (!parsed || !Array.isArray(parsed.files)) return { manifest: empty, unreadable: true };
    // Same POSIX-separator heal as the primary reader (manifest.service.ts): a Windows peer's mirrored
    // copy carries `\` paths, and merging those unnormalized would re-introduce duplicate spellings of
    // the same file into Local Storage on every reconcile.
    return {
      manifest: normalizeManifestPaths(
        { schema_version: parsed.schema_version ?? 1, unit: parsed.unit ?? unit, files: parsed.files as ManifestFile[] },
        file,
      ),
      unreadable: false,
    };
  } catch {
    return { manifest: empty, unreadable: true }; // not YAML at all
  }
}

/**
 * Reconcile a pulled sync-repo subtree back into Local Storage (artifact_placement_policy.mdx §5,
 * storage_company.mdx §8.4.3). `manifest.yaml` is MERGED per entry (`mergeManifests`), `decisions.yaml` by
 * event union, `repo_storage.yaml` field-wise; the per-file sidecars and per-device history logs are
 * MERGED by `copyTrackedFile` (tracked-file-merge.ts). Only shapes with no shared state left — anything
 * neither side appends to concurrently — are still a plain copy. Best-effort; no-op when no sync repo is
 * configured for this repo.
 *
 * "Append-only" was long treated as licence to copy. It is not: two computers appending to one list
 * produce two supersets of a common prefix, and a copy in either direction keeps one and deletes the
 * other's tail — which is how sidecar events written between mirrors were being lost.
 *
 * This used to be a wholesale `copyTree` — and had ZERO callers, so a mirrored manifest that did arrive was
 * never folded in at all. Both halves of that are fixed: the merge is real, and the pin pass calls it on
 * every backbone pull.
 */
/**
 * Write `content` to `file` only when that would actually change it, and say whether it did.
 *
 * The three merged documents below are RECONCILIATIONS: on a computer where nothing arrived, the merge
 * result is byte-identical to what is already on disk. Writing it anyway is not merely wasted I/O — the
 * return value of `reconcileFromSyncRepo` is what tells `reconcileMirroredRepos` to run the EXPENSIVE fold
 * (a full unit-manifest merge, a ledger re-parse, and a UI topic bump) for that repo, so "I wrote a file"
 * masquerading as "something arrived" made all of that run for every repo on every pass. See the caller.
 */
function writeIfDifferent(file: string, content: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === content) return false;
  } catch {
    /* absent or unreadable — fall through and write it */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return true;
}

// ── the ledger union, run at most ONCE per (unchanged src, unchanged dst) pair ────────────────────────
//
// `writeIfDifferent` stops the WRITE when nothing changed; it cannot stop the work in front of it. The
// union parses BOTH ledgers, and on this machine `charlie-kirk/decisions.yaml` is 3.1 MB and `all` is
// 1.9 MB — so every mirror and every reconcile paid two multi-megabyte YAML parses plus a `serializeLedger`
// to re-derive a file it then declined to write. A CPU profile of the live backend attributed 1.38 s to
// `parseLedgerBestEffort` and 0.25 s to `serializeLedger`, on a loop that was already blocking for seconds.
//
// The union is a pure function of the two files' CONTENTS, so if neither file has changed since the last
// time we ran it, the destination already holds the answer. Identity is (ino, size, mtime) — the same
// revalidation `foreign-pin.service.ts` uses — and the DESTINATION's identity is recorded AFTER the write,
// so a pass that did write is memoized against what it actually left on disk.
//
// This is a cache of OUR OWN completed work, not of the data: any edit to either file on any path (a local
// decision, a git merge, a peer's push landing in the mirror) changes its mtime and the union runs again.
interface FileId {
  ino: string;
  size: string;
  mtimeNs: string;
}
/** `job|dstFile|srcFile` -> the identities BOTH files had when that job last COMPLETED. */
const workMemo = new Map<string, { dst: FileId | null; src: FileId | null }>();

/**
 * Identity at NANOSECOND resolution, and as strings so the whole memo is JSON — see `loadMemo` for why it
 * has to survive a restart. `bigint: true` reports the filesystem's native nanosecond timestamp (and is
 * measurably FASTER than a plain stat, because it allocates no `Date`); millisecond resolution would let a
 * rewrite that lands in the same millisecond at the same size read as "unchanged", and a memo that answers
 * "unchanged" about a file that changed is silent data loss between the user's computers.
 */
function fileId(file: string): FileId | null {
  try {
    const st = fs.statSync(file, { bigint: true });
    return { ino: st.ino.toString(), size: st.size.toString(), mtimeNs: st.mtimeNs.toString() };
  } catch {
    return null;
  }
}
const sameFileId = (a: FileId | null, b: FileId | null): boolean =>
  a != null && b != null && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

/** Job names — one per (kind of merge, direction), so two directions can never share a memo entry. */
const JOB_LEDGER = "ledger-union";
const JOB_POLICY = "policy-merge";
const JOB_MIRROR_POLICY = "mirror-policy";
const JOB_MIRROR_LEDGER = "mirror-ledger";
const JOB_MIRROR_MANIFEST = "mirror-manifest";
const JOB_RECONCILE_MANIFEST = "reconcile-manifest";
const JOB_MIRROR_DELETIONS = "mirror-deletions";
const JOB_RECONCILE_DELETIONS = "reconcile-deletions";

const memoKey = (job: string, dstFile: string, srcFile: string): string => `${job}|${dstFile}|${srcFile}`;

// ── the memo OUTLIVES THE PROCESS ────────────────────────────────────────────────────────────────────
//
// An in-memory memo makes a SETTLED app quiet and leaves a RESTARTED one paying the full price: measured
// on this machine, the first reconcile pass after a boot costs 7.5 s of CPU across 105 repos, and every
// millisecond of it re-derives documents that are already correct on disk. The app restarts constantly —
// `just run`, a `tsx watch` reload, a launchd boot, a crash — so "quiet after the first minute" is a
// promise the user rarely gets to collect on. Both halves of the report this pass came from were during
// exactly that window.
//
// The memo describes FILES, not process state: "this job ran to completion while these two files had these
// identities". That statement stays true across a restart, so it should be written down. Nanosecond
// (ino, size, mtimeNs) is what makes it safe — any edit by anyone (a local decision, a git merge, a peer's
// push into the mirror) moves an mtime, the identity stops matching, and the work runs again.
//
// It is a CACHE, so every failure mode degrades to "do the work": a missing file, corrupt JSON, a schema
// bump, a path that moved. Nothing here is ever authoritative and nothing is ever waited on.
const MEMO_SCHEMA = 2;
const memoFile = (): string => path.join(resolveStateDir(), "mirror-memo.json");
let memoLoaded = false;
let memoDirty = false;
let memoSaveTimer: NodeJS.Timeout | null = null;

/** Load once, lazily — never at import time, so a test that points `LFB_STATE_DIR` somewhere new still
 *  gets that directory's memo rather than the one the first import happened to see. */
function loadMemo(): void {
  if (memoLoaded) return;
  memoLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(memoFile(), "utf8")) as {
      schema?: number;
      entries?: Record<string, { dst: FileId | null; src: FileId | null }>;
    };
    if (raw.schema !== MEMO_SCHEMA || !raw.entries) return;
    for (const [k, v] of Object.entries(raw.entries)) workMemo.set(k, v);
    log.info("storage", `mirror memo: ${workMemo.size} settled merge(s) restored — a restart re-derives nothing that has not moved`);
  } catch {
    /* absent/corrupt — an empty memo simply means the first pass does the work, which is always correct */
  }
}

/** Persist, DEBOUNCED. The pass marks hundreds of pairs settled in a burst; one write at the end of it is
 *  the whole point. Unref'd, so it can never hold the process open, and best-effort throughout. */
function saveMemoSoon(): void {
  memoDirty = true;
  if (memoSaveTimer) return;
  memoSaveTimer = setTimeout(() => {
    memoSaveTimer = null;
    flushMemo();
  }, 5_000);
  memoSaveTimer.unref?.();
}

/** Write the memo now, if it has changed. Called by the debounce and available for an orderly shutdown. */
export function flushMemo(): void {
  if (!memoDirty) return;
  memoDirty = false;
  try {
    const file = memoFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: MEMO_SCHEMA, entries: Object.fromEntries(workMemo) }));
    fs.renameSync(tmp, file); // atomic — a half-written cache read as whole would be the one unsafe shape
  } catch (e) {
    log.warn("storage", `mirror memo save failed (harmless — the next pass just re-derives): ${(e as Error).message}`);
  }
}

/**
 * True when this (job, dst, src) triple ran to completion before and NEITHER file has moved since — i.e.
 * re-running it is provably a no-op. A file that is ABSENT on either side is never "settled": it has no
 * identity to compare, and absence is exactly the case that still needs the work done.
 */
function pairSettled(job: string, dstFile: string, srcFile: string): boolean {
  loadMemo();
  const seen = workMemo.get(memoKey(job, dstFile, srcFile));
  return !!seen && sameFileId(seen.dst, fileId(dstFile)) && sameFileId(seen.src, fileId(srcFile));
}

/** Record that this job just completed, against the bytes NOW on disk. Call AFTER the write. */
function markPairSettled(job: string, dstFile: string, srcFile: string): void {
  loadMemo();
  workMemo.set(memoKey(job, dstFile, srcFile), { dst: fileId(dstFile), src: fileId(srcFile) });
  saveMemoSoon();
}

/** Forget a job's memo so the next pass re-tries it. Used when a leg REFUSED to run (an unparseable
 *  mirror): a refusal is not a completion, and it must keep re-announcing itself until a human fixes it. */
function forgetPair(job: string, dstFile: string, srcFile: string): void {
  loadMemo();
  if (workMemo.delete(memoKey(job, dstFile, srcFile))) saveMemoSoon();
}

/**
 * Union `srcFile`'s events into `dstFile`, writing only when the bytes change. Returns whether `dstFile`
 * changed. Skips the whole parse/union/serialize when neither file has moved since this pair last ran.
 *
 * `guardDstFor` names the repo when `dstFile` is the MIRROR copy: an unreadable mirror is refused rather
 * than replaced (see `refuseUnparseableMirror`). The reconcile direction writes to LOCAL Storage and passes
 * nothing, keeping its long-standing self-heal — an unreadable local copy IS repaired from the mirror.
 */
function syncLedgerInto(dstFile: string, srcFile: string, job: string = JOB_LEDGER, guardDstFor?: string): boolean {
  if (pairSettled(job, dstFile, srcFile)) return false;
  const dstRaw = readFileOrNull(dstFile);
  if (guardDstFor !== undefined && refuseUnparseableMirror(dstFile, ledgerIsUnreadable(dstRaw), guardDstFor)) {
    forgetPair(job, dstFile, srcFile); // a refusal is not a completion — re-announce it every pass
    return false;
  }
  const merged = unionLedgerEvents(parseLedgerBestEffort(dstRaw, dstFile), parseLedgerBestEffort(readFileOrNull(srcFile), srcFile));
  const changed = writeIfDifferent(dstFile, serializeLedger(merged));
  // AFTER the write — the memo must describe the bytes now on disk, not the ones we started from.
  markPairSettled(job, dstFile, srcFile);
  return changed;
}

/**
 * Fold the SHARED default-decision policy (decisions.mdx §9/§14) into `dstFile`, at most once per
 * (unchanged dst, unchanged src) pair — the same memo discipline as the ledger above.
 *
 * WHY A FOLD AND NOT A COPY. This document travelled as a plain `fs.copyFileSync` in BOTH directions until
 * database.mdx §2.1 caught it: `LOCAL_ONLY` / `MERGED_NEVER_COPIED` are applied by `copyTreeGen` only at
 * `rel === ""`, and this name was in neither set. A copy cannot tell an older policy from a newer one, so
 * the reconcile leg could — and on a fleet where one machine mirrors more often, reliably would — drop a
 * deliberate policy change on the floor. Losing SHARED USER INTENT silently is the worst failure class this
 * module has, and it is exactly what the ledger union and the manifest merge exist to prevent.
 *
 * THE CONFLICT RULE IS A TOTAL ORDER, which is the only property that makes it safe:
 *   1. a document with `set_at` beats one without (an unset policy is the schema default — never a choice);
 *   2. newer `set_at` wins;
 *   3. ties break on `set_by` lexically, with a set `set_by` beating a null one.
 * Every computer applies the same rule to the same two inputs and lands on the same document, so nobody has
 * to mirror last to win, and the pass converges instead of ping-ponging. This mirrors `foldLedger`'s
 * tie-break discipline (decisions.service.ts:145-176) and, like it, uses plain `<`/`>` on the VALUE and
 * never `localeCompare` — two computers must not disagree because of collation (database.mdx §2.2 R3).
 *
 * Whole-document, not field-wise, on purpose: `media` and `other` are a coherent pair with `attribution`,
 * and interleaving fields from two machines can synthesize a policy neither person ever chose.
 */
function policyRank(doc: DecisionPolicyDoc | null): [number, string, string] | null {
  if (!doc) return null;
  // `set_at` absent ⇒ this is the schema default, not a decision. Rank 0 so any real choice outranks it.
  return [doc.set_at ? 1 : 0, doc.set_at ?? "", doc.set_by ?? ""];
}

function parsePolicyBestEffort(raw: string | null): DecisionPolicyDoc | null {
  if (raw === null) return null;
  try {
    const parsed = DecisionPolicyDocSchema.safeParse(YAML.parse(raw) ?? {});
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // unparseable: treated as ABSENT, so the other side's real policy survives
  }
}

/**
 * The pure conflict rule, exported so it can be tested without a filesystem. `mine` wins every tie, so a
 * caller that passes (local, incoming) never rewrites a document that is not strictly beaten — which is what
 * keeps a settled fleet from re-writing (and therefore re-committing) the same policy forever.
 */
export function pickPolicy(mine: DecisionPolicyDoc | null, theirs: DecisionPolicyDoc | null): DecisionPolicyDoc | null {
  const a = policyRank(mine);
  const b = policyRank(theirs);
  if (!a) return theirs;
  if (!b) return mine;
  for (let i = 0; i < 3; i++) {
    if (a[i] === b[i]) continue;
    return a[i] > b[i] ? mine : theirs;
  }
  return mine; // fully equal — keep what is already there so the write is skipped
}

function mergePolicyInto(dstFile: string, srcFile: string, job: string = JOB_POLICY): boolean {
  if (pairSettled(job, dstFile, srcFile)) return false;
  const winner = pickPolicy(
    parsePolicyBestEffort(readFileOrNull(dstFile)),
    parsePolicyBestEffort(readFileOrNull(srcFile)),
  );
  let changed = false;
  if (winner) changed = writeIfDifferent(dstFile, YAML.stringify(winner, { sortMapEntries: true }));
  // AFTER the write, for the same reason the ledger memo is stamped late.
  markPairSettled(job, dstFile, srcFile);
  return changed;
}

/**
 * Merge the local and mirror manifests and write the result to `dstFile`, at most once per (unchanged dst,
 * unchanged other side) pair. `mergeManifests` is ASYMMETRIC — `mine` keeps this computer's own `pinned_by`
 * claims while `incoming` is read as the WIRE — so BOTH legs pass (local, mirror) in that order no matter
 * which side they write; the legs differ only in their destination, and the merged document is the same one.
 *
 * The manifest is the other multi-megabyte document in this module (0.9 MB on `charlie-kirk`, 110 ms per
 * `YAML.parse`) and it was the one merge with no memo at all: `writeIfDifferent` declined the WRITE while
 * both parses and the serialize in front of it ran in full, on every mirror AND every reconcile, for every
 * repo, forever (performance.mdx P-45).
 *
 * `guardDstFor` carries the same "refuse, never replace" rule as the ledger above, and for the same reason.
 */
function mergeManifestInto(
  job: string,
  dstFile: string,
  localFile: string,
  mirrorFile: string,
  guardDstFor?: string,
): boolean {
  // The destination is always one of the two inputs, so "neither input moved" is exactly "this (dst, the
  // OTHER one) pair has not moved" — one memo entry covers both.
  const other = dstFile === localFile ? mirrorFile : localFile;
  if (pairSettled(job, dstFile, other)) return false;
  const localRead = readManifestChecked(localFile, "repo");
  const mirrorRead = readManifestChecked(mirrorFile, "repo");
  const local = localRead.manifest;
  const mirror = mirrorRead.manifest;
  if (guardDstFor !== undefined) {
    const dstRead = dstFile === localFile ? localRead : mirrorRead;
    if (refuseUnparseableMirror(dstFile, dstRead.unreadable, guardDstFor)) {
      forgetPair(job, dstFile, other);
      return false;
    }
  }
  const merged = mergeManifests(local, mirror, computerLabel(), {
    incomingIsWire: true, // the mirror is the SHARED copy — a peer's claim is ITS statement, not ours
    supersededCid, // …but a wrapper CID we PROVED wrong must never ride back in from either side
  });
  const changed = writeIfDifferent(dstFile, serializeManifest(merged));
  markPairSettled(job, dstFile, other);
  return changed;
}

/**
 * Fold two `deletions.yaml` into `dstFile` (deletion.mdx §6). The twin of {@link mergeManifestInto}, and it
 * runs in BOTH directions for the same reason the ledger does.
 *
 * It deliberately has no `guardDstFor`-style "refuse, never replace" leg: `readDeletions` already THROWS on
 * a half-merged or unparseable document, and the caller treats that throw as "leave both files alone."
 * Writing a partially-understood deletion ledger is the one outcome that must never happen — every record
 * we fail to carry is a file that comes back on every computer.
 */
function mergeDeletionsInto(job: string, dstFile: string, localFile: string, mirrorFile: string): boolean {
  const other = dstFile === localFile ? mirrorFile : localFile;
  if (pairSettled(job, dstFile, other)) return false;
  const merged = mergeDeletions(readDeletions(localFile), readDeletions(mirrorFile));
  // A UNIT WITH NO DELETIONS HAS NO FILE — not an empty list (deletion.mdx §4). Without this, every one of
  // the ~105 repos on this machine gains a `deletions: []` stub on the first pass after upgrading, each one
  // a new file committed and pushed to the backbone to say nothing at all. Absence of the file already IS
  // absence of tombstones, and it is the only absence in this feature that means anything.
  if (merged.deletions.length === 0 && !fs.existsSync(dstFile)) {
    markPairSettled(job, dstFile, other);
    return false;
  }
  const changed = writeIfDifferent(dstFile, serializeDeletions(merged));
  markPairSettled(job, dstFile, other);
  return changed;
}

/** TEST-ONLY: forget every memoized merge, in every direction — including the copy on disk, so a test that
 *  points `LFB_STATE_DIR` at a fresh directory starts genuinely cold. */
export function resetLedgerSyncMemo(): void {
  workMemo.clear();
  memoLoaded = false;
  memoDirty = false;
  if (memoSaveTimer) clearTimeout(memoSaveTimer);
  memoSaveTimer = null;
}

export function reconcileFromSyncRepo(repoRoot: string): boolean {
  return blocking("storage.reconcile", () => drainSync(reconcileGen(repoRoot)), repoRoot);
}

/**
 * The reconcile, INTERRUPTIBLE — same generator, drained in {@link SLICE_MS} slices. This is the leg the
 * backbone runs for all 105 repos on every pull, and the one `loop-watch` named as the multi-second stall:
 * `storage.reconcile 3776ms/105 calls, worst 1466ms on charlie-kirk` (performance.mdx P-47).
 */
export async function reconcileFromSyncRepoYielding(repoRoot: string): Promise<boolean> {
  return drainYielding("storage.reconcile.yielding", repoRoot, reconcileGen(repoRoot));
}

function* reconcileGen(repoRoot: string): Generator<void, boolean, void> {
  const src = resolveStateSyncRepo(repoRoot);
  if (!src) return false;
  const dst = repoStateDir(repoRoot);
  // Did anything ACTUALLY arrive? Reported honestly — see `writeIfDifferent` and the caller.
  let changed = false;
  try {
    if (!fs.existsSync(src)) return false;
    // 1. the manifest — a MERGE, never a copy (§8.4.3)
    const incomingManifest = path.join(src, "manifest.yaml");
    if (fs.existsSync(incomingManifest)) {
      // Memoized on (local, incoming) identity, and written through the CANONICAL serializer — this file is
      // also written by manifest.service, and two spellings of one document make each writer re-dirty what
      // the other just wrote (§6). No `guardDstFor`: the destination here is LOCAL Storage, and an
      // unreadable local copy is exactly the one that SHOULD be repaired from the mirror.
      changed =
        mergeManifestInto(JOB_RECONCILE_MANIFEST, path.join(dst, "manifest.yaml"), path.join(dst, "manifest.yaml"), incomingManifest) ||
        changed;
    }
    // 2. the decision ledger — ALSO a merge, never a copy (decisions.mdx §5). A copy replaces the local
    // log with whatever the mirror last held; events recorded here but not yet mirrored (or erased from
    // the mirror by another writer's copy) would vanish, leaving frozen-cache decisions with no ledger
    // event that could ever travel — the "not backed up: 22 here / 0 there" defect. Union keeps both
    // sides; foldLedger resolves any conflict deterministically on read.
    const incomingLedger = path.join(src, "decisions.yaml");
    if (fs.existsSync(incomingLedger)) {
      changed = syncLedgerInto(path.join(dst, "decisions.yaml"), incomingLedger) || changed;
    }
    // 1a. the FLEET DELETION ledger — a MERGE, never a copy (deletion.mdx §6). This is the leg that carries
    // another computer's deletion TO this one, and it is what makes `lfb delete` mean anything beyond the
    // machine it was typed on. A failure is logged and the local ledger left exactly as it was: enforcing a
    // stale-but-real set of tombstones is always safer than enforcing a half-read one.
    const incomingDeletions = path.join(src, "deletions.yaml");
    if (fs.existsSync(incomingDeletions)) {
      try {
        changed =
          mergeDeletionsInto(
            JOB_RECONCILE_DELETIONS,
            path.join(dst, "deletions.yaml"),
            path.join(dst, "deletions.yaml"),
            incomingDeletions,
          ) || changed;
      } catch (e) {
        log.warn("storage", `reconcile: deletions merge failed for ${dst}: ${(e as Error).message}`);
      }
    }
    // 2a. the SHARED default-decision policy — a FOLD, for the same reason as the ledger. This is the leg
    // that used to lose intent: a copy on the way IN replaced a policy this computer had just set with
    // whatever the mirror happened to hold, with no comparison of which was newer (database.mdx §2.1).
    const incomingPolicy = path.join(src, "decisions_policy.yaml");
    if (fs.existsSync(incomingPolicy)) {
      changed = mergePolicyInto(path.join(dst, "decisions_policy.yaml"), incomingPolicy) || changed;
    }
    // 2b. repo_storage.yaml — a MERGE that PRESERVES this computer's own {@link MACHINE_LOCAL_REPO_STORAGE}
    // fields. The mirror's copy is scrubbed of them on purpose (see mirrorToSyncRepo); a wholesale copy
    // would blank this machine's `last_scan` stamp on every pull, making the stale-scan trigger re-scan
    // constantly — which re-stamps and re-mirrors, i.e. the exact churn loop the scrub exists to break —
    // and would replace this machine's `counts` with a peer's view of a different set of files on disk.
    const incomingStorage = path.join(src, "repo_storage.yaml");
    if (fs.existsSync(incomingStorage)) {
      try {
        const incoming = RepoStorageDocSchema.safeParse(YAML.parse(fs.readFileSync(incomingStorage, "utf8")) ?? {});
        if (incoming.success) {
          const localFile = path.join(dst, "repo_storage.yaml");
          const local = RepoStorageDocSchema.safeParse(YAML.parse(readFileOrNull(localFile) ?? "") ?? {});
          if (local.success) {
            for (const key of MACHINE_LOCAL_REPO_STORAGE) {
              (incoming.data.repo_storage as Record<string, unknown>)[key] = (
                local.data.repo_storage as Record<string, unknown>
              )[key];
            }
          }
          changed = writeIfDifferent(localFile, YAML.stringify(incoming.data, { sortMapEntries: true })) || changed;
        }
      } catch (e) {
        log.warn("storage", `reconcile: repo_storage fold failed for ${dst}: ${(e as Error).message}`);
      }
    }
    // 3. everything else — the per-file sidecars and per-device history logs are MERGED inside
    //    `copyTrackedFile`; only shapes with nothing shared to lose are still copied outright.
    changed = (yield* copyTreeGen(src, dst, "", RECONCILE_MERGED_NEVER_COPIED)) || changed;
    // 4. RECORD THE INGEST (migration 0012). `doc_render.ingested_sha256` is the bytes of each arriving
    //    document, and `sdl_ingest` is the per-(SDL, unit) watermark plus the running tally of events and
    //    pin claims that have reached us. Neither is read by anything on this path: they are the evidence
    //    half of the fence — the input to `doc_render_dirty`, the mirror's pre-pass work list.
    //
    //    AFTER the merges, so the hashes describe the documents this pass actually consumed, and
    //    fire-and-forget for the same reason as the mirror leg (this generator has a SYNCHRONOUS driver).
    //    The counts are only computed for a document whose sha MOVED, so a settled fleet — where nothing
    //    arrives — pays one SELECT and four `statSync` per repo and never re-parses a 3 MB ledger.
    const marker = readSyncRepoMarker(repoRoot);
    if (marker) void recordSdlIngestForRepo(repoRoot, marker.syncRepo, src);
    return changed;
  } catch (e) {
    log.warn("storage", `reconcileFromSyncRepo(${repoRoot}) failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Fold every mirrored repo subtree that just arrived in `sdlRoot` back into this computer's Local Storage —
 * the RECEIVE half of storage_company.mdx §8.4.3, called right after the SDL's git fetch + merge.
 *
 * Reconcile must run on EVERY backbone pull, not on demand: a merge that only happens when someone clicks
 * something is a merge that does not happen. Each local repo is matched to an incoming subtree by `repoUid`
 * (the normalized remote), which is exactly why the key had to stop being a path hash — the Tower wrote
 * `repos/<uid>/` and the laptop must find that same directory.
 *
 * Best-effort and non-throwing: this runs inside the git cycle, and a bad repo unit must never fail the pull.
 * Returns how many repos were folded in.
 */
/**
 * FOLD DUPLICATE SPELLINGS of one repo's mirror subtree into a single directory (artifact_placement_policy.mdx
 * §3.1a). Returns how many extra directories were absorbed and removed.
 *
 * WHY THIS EXISTS. §3.1 renamed `repos/83e62afc2c80/` to `repos/charlie-kirk-83e62afc2c80/`. A computer still
 * on the pre-§3.1 build keeps writing the BARE name, pushes it, and after the merge the shared repo holds
 * BOTH spellings for one repo. That is not merely untidy — it is silent data loss in a specific direction:
 * `resolveStateSyncRepo` resolves to ONE directory and prefers the named one, so from that moment every
 * event the older computer mirrors into the bare twin is invisible to every updated computer. Measured on
 * the Act3 company repo 2026-08-20: 67 duplicated subtrees, 19,417 files.
 *
 * So a duplicate must be MERGED, never chosen between, and merged with the SAME rules a pulled subtree gets
 * (§8.4.3): union the manifest, union the decision ledger, merge sidecars and history logs per entry. Only
 * once the extra's content is folded in is the extra removed — the delete is the last step, never the first.
 *
 * Idempotent and self-limiting: on a fully-updated fleet nothing ever writes a second spelling, so this finds
 * nothing and costs one readdir per pull.
 */
function foldDuplicateMirrorSubtrees(mirrorDir: string): number {
  let folded = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(mirrorDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return 0;
  }
  // Group by the 12-hex key every spelling ends with. A directory that is not key-shaped is not ours.
  const groups = new Map<string, string[]>();
  for (const name of entries) {
    const key = /(?:^|-)([0-9a-f]{12})$/.exec(name)?.[1];
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(name);
  }
  for (const [key, names] of groups) {
    if (names.length < 2) continue;
    // The NAMED spelling is canonical — it is what every updated computer resolves to. If somehow several
    // are named, keep the one this build would produce, else the first, so the choice is deterministic.
    const named = names.filter((n) => n !== key).sort();
    const canonical = named[0] ?? names[0]!;
    for (const extra of names) {
      if (extra === canonical) continue;
      const src = path.join(mirrorDir, extra);
      const dst = path.join(mirrorDir, canonical);
      try {
        mergeSubtree(src, dst);
        fs.rmSync(src, { recursive: true, force: true });
        folded++;
        log.info("storage", `folded duplicate mirror subtree ${extra} into ${canonical} (key ${key})`);
      } catch (e) {
        // Never delete what we could not fold — the duplicate simply survives to the next pull.
        log.warn("storage", `fold of ${extra} into ${canonical} failed, leaving both: ${(e as Error).message}`);
      }
    }
  }
  return folded;
}

/** Merge one mirror subtree into another, by the §8.4.3 rules. Both sides are MIRROR copies (already
 *  scrubbed of machine-local fields), so this is a pure union — there is no local state to protect. */
function mergeSubtree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  const incomingManifest = path.join(src, "manifest.yaml");
  if (fs.existsSync(incomingManifest)) {
    const dstManifest = path.join(dst, "manifest.yaml");
    const merged = mergeManifests(
      readManifestBestEffort(dstManifest, "repo"),
      readManifestBestEffort(incomingManifest, "repo"),
      computerLabel(),
      { incomingIsWire: true, supersededCid },
    );
    writeIfDifferent(dstManifest, serializeManifest(merged));
  }
  const incomingLedger = path.join(src, "decisions.yaml");
  if (fs.existsSync(incomingLedger)) {
    syncLedgerInto(path.join(dst, "decisions.yaml"), incomingLedger);
  }
  const incomingPolicy = path.join(src, "decisions_policy.yaml");
  if (fs.existsSync(incomingPolicy)) {
    mergePolicyInto(path.join(dst, "decisions_policy.yaml"), incomingPolicy);
  }
  // `repo_storage.yaml` needs no special case here: both copies are scrubbed mirrors, so whichever the
  // canonical already has stands, and copyTreeExcept below leaves it alone.
  // Everything else — sidecars and history logs — merges per entry inside copyTrackedFile.
  copyTreeExcept(src, dst, new Set(["manifest.yaml", "decisions.yaml", "repo_storage.yaml", "decisions_policy.yaml"]));
}

export async function reconcileMirroredRepos(sdlRoot: string): Promise<number> {
  const mirrorDir = path.join(path.resolve(sdlRoot), "repos");
  if (!fs.existsSync(mirrorDir)) return 0;
  // FIRST, heal any duplicate spellings that arrived in this pull (§3.1a). Must run BEFORE the per-repo
  // match below: that match resolves to ONE directory, so an unfolded twin's events would be skipped and
  // then silently overwritten on the next mirror out.
  const foldedDupes = foldDuplicateMirrorSubtrees(mirrorDir);
  if (foldedDupes) log.info("storage", `reconcile: folded ${foldedDupes} duplicate mirror subtree(s) in ${sdlRoot}`);
  let folded = 0;
  try {
    // LAZY import — units.service → repo-storage.service → (here) is a cycle if imported statically.
    const { listRepoFolders, getRepoConfig, getRepoManifest, writeRepoManifest, repoBumpTopics } = await import(
      "../store-model/units.service.js"
    );
    const { readRepoTrackingManifest } = await import("../pin/manifest.service.js");
    // Membership is tested on the KEY SUFFIX, never on the exact name (artifact_placement_policy.mdx §3.1).
    // The mirror subtree is now `<slug>-<uid>` (`charlie-kirk-83e62afc2c80`), so an exact `has(uid)` would
    // match NOTHING after the rename and this receive path would go quietly dead — every pulled subtree
    // silently unreconciled, which is the same shape as the §8.4.1 defect that made the mirror unfindable
    // in the first place. Both spellings must resolve, in both directions, for a mixed fleet.
    const present = fs.readdirSync(mirrorDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    if (present.length === 0) return 0;
    const hasSubtreeFor = (uid: string): boolean => present.some((name) => isDirForKey(name, uid));
    for (const folder of listRepoFolders()) {
      try {
        const cfg = getRepoConfig(folder);
        const repoPath = cfg.repo.path;
        const uid = repoUidFor(cfg.repo.remote ?? null);
        if (!repoPath || !uid || !hasSubtreeFor(uid)) continue;
        // Make sure this repo points at THIS sync repo before folding, so a repo whose marker was never
        // written (the default-ON case on a fresh computer) still receives its peer's state. `mirrorDir` is
        // passed as the observed sync repo BECAUSE that is what we are standing in: `hasSubtreeFor(uid)`
        // just proved this repo's subtree is here. Without it the owner lookup — null whenever the storage
        // is unmapped, the repo sits outside every mapped directory, or the storage root is not a git tree —
        // deleted the marker instead, and the fold two lines below was skipped for want of the source we
        // had already found.
        ensureSyncRepoMarker(repoPath, cfg.repo.remote ?? null, cfg.sync_repo?.enabled, path.resolve(sdlRoot));
        // YIELDING, not the synchronous driver. This loop runs the reconcile for all 105 repos on
        // every backbone pull, and `loop-watch` named exactly this as the multi-second stall:
        // `storage.reconcile 3776ms/105 calls, worst 1466ms on charlie-kirk`. Same work, same
        // generator — handed back to the event loop every few milliseconds so a page load queued
        // behind it is answered instead of spinning (performance.mdx P-47).
        if (!(await reconcileFromSyncRepoYielding(repoPath))) continue;
        folded++;
        // A fold is THE moment a peer's file becomes visible here (storage_company.mdx §8.9). Bump the
        // repo's topic explicitly rather than relying on the `writeRepoManifest` below to do it: that call
        // is wrapped in its own try/catch, and a page that stays stale because the notification rode on the
        // one step that failed is the exact silent-staleness this bus exists to eliminate.
        bumpTopics(repoBumpTopics(folder));
        // §8.6 — the merge must land in BOTH manifests. The reconcile above writes Local Storage (what the
        // Pull-down list and the mirror read); the One-Repo FILE ROWS read the unit manifest. Updating only
        // one leaves the user with a Pull-down count that no row explains, or a row that cannot be pulled.
        try {
          // Both sides are LOCAL documents, so peer claims union normally — but our own label still must not
          // be re-adopted from the tracking copy. This was the one `mergeManifests` call site of five left
          // without a `selfLabel` when that rule was introduced.
          writeRepoManifest(
            folder,
            mergeManifests(getRepoManifest(folder), readRepoTrackingManifest(repoPath), computerLabel(), {
              supersededCid, // the unit copy is local, and local is exactly where a disproved CID hides
            }),
          );
        } catch (e) {
          log.warn("storage", `reconcile: unit manifest fold for ${folder} failed: ${(e as Error).message}`);
        }
        // Project the just-merged ledger onto the frozen `decisions:` cache NOW (decisions.mdx §7) — the
        // pin engine reads that cache, so without this a teammate's arriving "Add to IPFS" sat invisible
        // until the next scan happened to call reconcile. LAZY import: decisions.service statically
        // imports this module (mirrorToSyncRepo), so a static import here is a cycle.
        try {
          const { reconcile: reconcileDecisions } = await import("./decisions.service.js");
          const { changed } = await reconcileDecisions(folder);
          if (changed.length > 0) {
            log.info("storage", `reconcile: ${changed.length} decision(s) updated from the mirrored ledger for ${folder}`);
          }
        } catch (e) {
          log.warn("storage", `reconcile: decision projection for ${folder} failed: ${(e as Error).message}`);
        }
      } catch (e) {
        log.warn("storage", `reconcileMirroredRepos: repo unit ${folder} skipped: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    log.warn("storage", `reconcileMirroredRepos(${sdlRoot}) failed: ${(e as Error).message}`);
  }
  if (folded > 0) log.info("storage", `reconciled ${folded} mirrored repo(s) from ${sdlRoot}`);
  return folded;
}


