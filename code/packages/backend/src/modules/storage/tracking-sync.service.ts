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
import { RepoStorageDocSchema, type Manifest, type ManifestFile } from "@lfb/shared";
import { repoStateDir, resolveStateSyncRepo, syncRepoMarkerPath, readSyncRepoMarker } from "./tracking-root.service.js";
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
import { resolveOwnerDedicatedRepo } from "./artifact-placement.service.js";
import { noteArtifactWritten } from "../pin/sync-trigger.service.js";
import { normalizeManifestPaths } from "../pin/manifest-normalize.js";
import { isStrayPathName, copyHealed, caseIndex, resolveCasing } from "./sidecar-heal.js";
import { statOrNull } from "../../shared/fs-probe.js";
// The additive copy for the two shapes that had no merge: the per-file sidecars and the per-device history
// logs. Both directions route through it, so neither leg can stamp over the other side's events.
import { copyTrackedFile } from "./tracked-file-merge.js";
// The working-tree gate — a LEAF module (logging + path only), so no cycle with the git service.
import { deferWhileBusy } from "../git/worktree-gate.js";
import { bumpTopics } from "../events/state-events.service.js";
import { log } from "../../shared/logging.js";
// Name this section in the event-loop stall report. Both legs of the mirror are SYNCHRONOUS walks over
// ~29,000 tracked files, which is what `loop-watch` used to report as an anonymous multi-second freeze
// (performance.mdx P-45/P-46).
import { blocking, recordCooperative } from "../../shared/blocking.js";

// Machine-local files under `repos/<repoKey>/` that must NOT travel to the sync repo.
const LOCAL_ONLY = new Set([".sync-repo", ".durable-artifact"]);

/**
 * The SHARED documents that are MERGED in both directions and therefore never plain-copied in either.
 * Both legs of the mirror hold them out of the tree walk and hand them to `mergeManifestInto` /
 * `syncLedgerInto` instead — which is what lets the (expensive, multi-megabyte) merges be skipped
 * independently of the (cheap) tree copy when nothing has moved (performance.mdx P-45).
 *
 * `repo_storage.yaml` is the third merged-on-the-way-IN document and is listed in `reconcileFromSyncRepo`'s
 * own skip set; on the way OUT it is copied and then scrubbed of machine-local fields, so it stays here.
 */
const MERGED_NEVER_COPIED: ReadonlySet<string> = new Set(["manifest.yaml", "decisions.yaml"]);

/** The same set on the way IN, plus `repo_storage.yaml` — which the reconcile leg merges FIELD-WISE (it
 *  must preserve this computer's own machine-local fields) while the mirror leg copies and then scrubs it. */
const RECONCILE_MERGED_NEVER_COPIED: ReadonlySet<string> = new Set([
  "manifest.yaml",
  "decisions.yaml",
  "repo_storage.yaml",
]);

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
 * Returns the resolved sync-repo ROOT (not the per-repo subtree), or null when this repo does not mirror.
 */
export function ensureSyncRepoMarker(
  repoRoot: string,
  remote: string | null,
  enabled?: boolean,
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
      else if (e.isFile()) changed = copyTrackedFile(s, d, childRel) || changed;
    } catch (err) {
      // Skip an unreadable/unwritable leaf; never fail the whole mirror — BUT make it observable. A file
      // that silently stops copying between the user's computers is the exact failure this module exists to
      // prevent, so a per-leaf copy failure must reach error.err (the top-level caller still returns true).
      log.warn("storage", `copyTree: failed to copy ${s} -> ${d}: ${(err as Error).message}`);
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
  return blocking("storage.mirror", () => drainSync(mirrorGen(repoRoot)), repoRoot);
}

/**
 * The mirror, INTERRUPTIBLE — same generator, drained in {@link SLICE_MS} slices with the event loop
 * handed back between them. Every ASYNCHRONOUS caller should prefer this: the walk is the same work either
 * way, but this version cannot be the reason a page spins (performance.mdx P-47).
 */
export async function mirrorToSyncRepoYielding(repoRoot: string): Promise<boolean> {
  return drainYielding("storage.mirror.yielding", repoRoot, mirrorGen(repoRoot));
}

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
    yield* copyTreeGen(localStateDir, dst, "", MERGED_NEVER_COPIED);
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
      mergeManifestInto(JOB_MIRROR_MANIFEST, mirrorManifestFile, localManifestFile, mirrorManifestFile, repoRoot);
    } catch (e) {
      log.warn("storage", `mirrorToSyncRepo(${repoRoot}): manifest merge write failed: ${(e as Error).message}`);
    }
    try {
      syncLedgerInto(mirrorLedgerFile, localLedgerFile, JOB_MIRROR_LEDGER, repoRoot);
    } catch (e) {
      log.warn("storage", `mirrorToSyncRepo(${repoRoot}): ledger union write failed: ${(e as Error).message}`);
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
    scrubVolatileRepoStorage(path.join(dst, "repo_storage.yaml"));
    noteArtifactWritten(dst, "tracking-state");
    return true;
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

/** Rewrite a MIRROR copy of repo_storage.yaml with every {@link MACHINE_LOCAL_REPO_STORAGE} field reset to
 *  its schema default, serialized exactly like writeRepoStorage (deterministic key order) so an
 *  otherwise-unchanged doc is byte-stable across mirrors. Best-effort: an unparseable file is left as copied. */
function scrubVolatileRepoStorage(file: string): void {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = RepoStorageDocSchema.safeParse(YAML.parse(raw) ?? {});
    if (!parsed.success) return;
    const defaults = RepoStorageDocSchema.parse({ repo_storage: {} }).repo_storage;
    for (const key of MACHINE_LOCAL_REPO_STORAGE) {
      (parsed.data.repo_storage as Record<string, unknown>)[key] = (defaults as Record<string, unknown>)[key];
    }
    // writeIfDifferent, not writeFileSync: the scrub is a RECONCILIATION, so on the overwhelming majority
    // of passes it re-derives the bytes already on disk. Writing them anyway re-stamps the mtime, which is
    // the identity every memo in this module is keyed on — an unconditional write here would invalidate the
    // very caches that stop the multi-megabyte merges from re-running (performance.mdx P-45), and would
    // re-touch a file in the sync repo's working tree on every pass for nothing.
    writeIfDifferent(file, YAML.stringify(parsed.data, { sortMapEntries: true }));
  } catch {
    /* missing/unreadable mirror copy — nothing to scrub */
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
    const parsed = YAML.parse(raw) as Partial<Manifest> | null;
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
  ino: number;
  size: number;
  mtimeMs: number;
}
/** `job|dstFile|srcFile` -> the identities BOTH files had when that job last COMPLETED. */
const workMemo = new Map<string, { dst: FileId | null; src: FileId | null }>();

function fileId(file: string): FileId | null {
  const st = statOrNull(file);
  return st && { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
}
const sameFileId = (a: FileId | null, b: FileId | null): boolean =>
  a != null && b != null && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Job names — one per (kind of merge, direction), so two directions can never share a memo entry. */
const JOB_LEDGER = "ledger-union";
const JOB_MIRROR_LEDGER = "mirror-ledger";
const JOB_MIRROR_MANIFEST = "mirror-manifest";
const JOB_RECONCILE_MANIFEST = "reconcile-manifest";

const memoKey = (job: string, dstFile: string, srcFile: string): string => `${job}|${dstFile}|${srcFile}`;

/**
 * True when this (job, dst, src) triple ran to completion before and NEITHER file has moved since — i.e.
 * re-running it is provably a no-op. A file that is ABSENT on either side is never "settled": it has no
 * identity to compare, and absence is exactly the case that still needs the work done.
 */
function pairSettled(job: string, dstFile: string, srcFile: string): boolean {
  const seen = workMemo.get(memoKey(job, dstFile, srcFile));
  return !!seen && sameFileId(seen.dst, fileId(dstFile)) && sameFileId(seen.src, fileId(srcFile));
}

/** Record that this job just completed, against the bytes NOW on disk. Call AFTER the write. */
function markPairSettled(job: string, dstFile: string, srcFile: string): void {
  workMemo.set(memoKey(job, dstFile, srcFile), { dst: fileId(dstFile), src: fileId(srcFile) });
}

/** Forget a job's memo so the next pass re-tries it. Used when a leg REFUSED to run (an unparseable
 *  mirror): a refusal is not a completion, and it must keep re-announcing itself until a human fixes it. */
function forgetPair(job: string, dstFile: string, srcFile: string): void {
  workMemo.delete(memoKey(job, dstFile, srcFile));
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
  const merged = unionLedgerEvents(parseLedgerBestEffort(dstRaw), parseLedgerBestEffort(readFileOrNull(srcFile)));
  const changed = writeIfDifferent(dstFile, serializeLedger(merged));
  // AFTER the write — the memo must describe the bytes now on disk, not the ones we started from.
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

/** TEST-ONLY: forget every memoized merge, in every direction. */
export function resetLedgerSyncMemo(): void {
  workMemo.clear();
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
  // `repo_storage.yaml` needs no special case here: both copies are scrubbed mirrors, so whichever the
  // canonical already has stands, and copyTreeExcept below leaves it alone.
  // Everything else — sidecars and history logs — merges per entry inside copyTrackedFile.
  copyTreeExcept(src, dst, new Set(["manifest.yaml", "decisions.yaml", "repo_storage.yaml"]));
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
        // written (the default-ON case on a fresh computer) still receives its peer's state.
        ensureSyncRepoMarker(repoPath, cfg.repo.remote ?? null, cfg.sync_repo?.enabled);
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


